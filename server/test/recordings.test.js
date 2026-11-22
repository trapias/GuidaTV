import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recordings } from '../src/recordings.js'
import { SmbArchive } from '../src/smb.js'
import { encodeMovieMetadata } from '../src/vsmeta.js'
import { captureDynamic } from '../src/recording-capture.js'

test('la coda sopravvive al riavvio e conserva il video finché il NAS non lo riceve', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-recordings-'))
  let offline = true
  const archive = {
    async publish(_, localName, filename) {
      assert.match(localName, /^[\da-f-]+\.mp4$/)
      assert.match(filename, /Film parziale \[[a-f0-9]{8}\] - parziale\.mp4$/)
      if (offline) throw new Error('NAS offline')
    },
  }
  const options = { directory, store: { streams: new Map() }, archive, before: 120000, after: 600000 }
  let queue = new Recordings(options)
  try {
    const s = Date.now() + 3600000
    const programme = { t: 'Film parziale', s, e: s + 3600000 }
    const job = queue.add('iris', 'Iris', programme)
    assert.equal(queue.add('iris', 'Iris', programme).id, job.id)
    assert.equal(job.captureFrom, s - options.before)
    assert.equal(job.captureTo, programme.e + options.after)
    assert.match(job.filename, /\.mp4$/)
    queue.update(job.id, 'recording')
    queue.db.prepare('UPDATE recordings SET filename = ? WHERE id = ?').run(job.filename.replace(/\.mp4$/, '.ts'), job.id)
    const path = join(directory, queue.localName(job.id))
    const mp4 = join(directory, `${job.id}.mp4`)
    await writeFile(path, 'campione')
    await writeFile(mp4, 'campione MP4')
    await queue.stop()

    queue = null
    queue = new Recordings(options)
    await queue.start()
    await queue.ticking
    await queue.upload
    const pending = queue.get('iris', s)
    assert.equal(pending.status, 'waiting')
    assert.equal(pending.filename, job.filename)
    assert.equal(pending.partial, 1)
    assert.equal(queue.remove(job.id), false)
    assert.equal(await readFile(path, 'utf8'), 'campione')
    assert.equal(await readFile(mp4, 'utf8'), 'campione MP4')

    offline = false
    await queue.publish(pending)
    assert.equal(queue.get('iris', s).status, 'saved')
    await assert.rejects(readFile(path), { code: 'ENOENT' })
    await assert.rejects(readFile(mp4), { code: 'ENOENT' })
    const other = queue.add('iris', 'Iris', { ...programme, s: s + 120000 })
    assert.equal(queue.remove(other.id), true)
  } finally {
    await queue?.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('l’elenco verifica il NAS, riconosce i file parziali e usa l’host adatto al client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-archive-'))
  const archive = new SmbArchive({ share: '//nas.local/TV', tailscaleHost: '100.100.10.20' })
  const queue = new Recordings({ directory, archive, before: 0, after: 0 })
  try {
    const job = queue.add('iris', 'Iris', { t: 'Città', s: Date.now(), e: Date.now() + 3600000 })
    queue.update(job.id, 'saved', null, 1)
    const missing = queue.add('rai4', 'Rai 4', { t: 'File cancellato', s: job.start, e: job.end })
    queue.update(missing.id, 'saved')
    const scheduled = queue.add('iris', 'Iris', { t: 'In coda', s: job.end, e: job.end + 3600000 })
    const filename = job.filename.replace(/\.mp4$/, ' - parziale.mp4')
    let checks = 0
    archive.command = async cmd => {
      assert.equal(cmd, 'ls')
      checks++
      return { stdout: [
        `  ${filename}      A 1791650970  Fri Nov 20 11:26:59 2026`,
        `  ${missing.filename}      D        0  Fri Nov 20 11:26:59 2026`,
        '\t\t9687684568 blocks of size 1024. 3597514548 blocks available',
      ].join('\n') }
    }
    const rows = queue.list()
    const [local, remote, ip, ipv6, shortName] = await Promise.all([
      queue.visible(rows, '192.168.1.20:8085'),
      queue.visible(rows, 'river.example.ts.net:8085'),
      queue.visible(rows, '100.100.10.30:8085'),
      queue.visible(rows, '[fd7a:115c:a1e0::1]:8085'),
      queue.visible(rows, 'river:8085', '::ffff:100.100.10.40'),
    ])
    assert.equal(checks, 1)
    assert.deepEqual(local.map(row => row.id), [scheduled.id, job.id])
    assert.equal(local[1].playUrl, `smb://nas.local/TV/${encodeURIComponent(filename)}`)
    for (const result of [remote, ip, ipv6, shortName]) {
      assert.equal(result[1].playUrl, `smb://100.100.10.20/TV/${encodeURIComponent(filename)}`)
    }

    queue.archiveChecks.get(archive).expires = 0
    archive.command = async () => { throw new Error('NAS offline') }
    const offline = await queue.visible(rows, '192.168.1.20:8085')
    assert.deepEqual(offline.map(row => row.id), [scheduled.id, job.id])
    assert.equal(offline[1].archiveVerified, false)
    assert.equal(offline[1].playUrl, null)
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('i margini personalizzati contano solo quando le catture si sovrappongono davvero', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-overlap-'))
  const queue = new Recordings({ directory, before: 0, after: 0 })
  const start = Date.now() + 60000
  const minute = 60000
  const programme = (t, from, to) => ({ t, s: start + from * minute, e: start + to * minute })
  try {
    const first = queue.add('iris', 'Iris', programme('Primo', 0, 10), { before: minute, after: 2 * minute })
    const second = queue.add('rai4', 'Rai 4', programme('Secondo', 12, 20))
    assert.equal(first.captureFrom, start - minute)
    assert.equal(first.captureTo, start + 12 * minute)
    const third = programme('Terzo', 11, 13)
    assert.deepEqual(queue.conflicts(third, { before: 0, after: 0 }), [])

    queue.remove(second.id)
    const overlapping = queue.add('rai4', 'Rai 4', programme('Secondo', 12, 20), { before: minute })
    const conflicts = queue.conflicts(third, { before: 0, after: 0 })
    assert.deepEqual(conflicts.map(job => job.id), [first.id, overlapping.id])
    assert.deepEqual(queue.conflicts(third, { before: 0, after: 0 }, { now: start + 12 * minute }), [])
    queue.update(first.id, 'waiting')
    assert.deepEqual(queue.conflicts(third, { before: 0, after: 0 }), [])
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('una prenotazione resta la stessa dopo la modifica e non conta come concorrente di sé stessa', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-reschedule-'))
  const queue = new Recordings({ directory, before: 0, after: 0 })
  try {
    const now = Date.now()
    const programme = { t: 'Film', s: now + 3600000, e: now + 7200000 }
    const job = queue.add('iris', 'Iris', programme)
    const other = queue.add('rai4', 'Rai 4', programme)
    const margins = { before: 120000, after: 300000 }
    const options = { now, excludeId: job.id }
    assert.deepEqual(queue.conflicts(programme, margins, options), [])
    const third = queue.add('la5', 'La 5', programme)
    assert.deepEqual(new Set(queue.conflicts(programme, margins, options).map(row => row.id)), new Set([other.id, third.id]))

    const updated = queue.reschedule(job.id, margins, now)
    assert.deepEqual({ ...updated }, { ...job, captureFrom: job.start - margins.before, captureTo: job.end + margins.after })
    assert.deepEqual(queue.getById(job.id), updated)
    assert.equal(queue.reschedule(job.id, margins, job.end), null)
    queue.update(job.id, 'recording')
    assert.equal(queue.reschedule(job.id, { before: 0, after: 0 }, now), null)
    assert.equal(queue.getById(job.id).captureTo, updated.captureTo)
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('un trasferimento fallito conserva il proprio ritentativo e lascia passare il successivo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-retry-'))
  const attempted = []
  let first
  let offline = true
  const archive = {
    async publish(_, localName) {
      attempted.push(localName)
      if (localName === `${first.id}.mp4` && offline) throw new Error('File inaccessibile')
    },
  }
  const options = { directory, store: { streams: new Map() }, archive, before: 0, after: 0 }
  let queue = new Recordings(options)
  try {
    const start = Date.now()
    first = queue.add('iris', 'Iris', { t: 'Primo', s: start, e: start + 60000 })
    const next = queue.add('rai4', 'Rai 4', { t: 'Secondo', s: start + 60000, e: start + 120000 })
    for (const job of [first, next]) {
      await writeFile(join(directory, `${job.id}.mp4`), 'campione MP4')
      queue.update(job.id, 'waiting')
    }
    await queue.processQueue()
    await queue.upload
    const beforeRetry = queue.get(first.channel, first.start)
    assert.equal(beforeRetry.status, 'waiting')
    assert.ok(beforeRetry.uploadAfter > Date.now())
    await queue.stop()

    queue = new Recordings(options)
    await queue.processQueue()
    await queue.upload
    assert.equal(queue.get(first.channel, first.start).uploadAfter, beforeRetry.uploadAfter)
    assert.equal(queue.get(next.channel, next.start).status, 'saved')
    assert.deepEqual(attempted, [`${first.id}.mp4`, `${next.id}.mp4`])
    assert.equal(await readFile(join(directory, `${first.id}.mp4`), 'utf8'), 'campione MP4')

    offline = false
    queue.db.prepare('UPDATE recordings SET uploadAfter = 0 WHERE id = ?').run(first.id)
    await queue.processQueue()
    await queue.upload
    assert.equal(queue.get(first.channel, first.start).status, 'saved')
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('dopo un riavvio uno stop richiesto recupera il video o rimane fermo se è vuoto', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-stop-'))
  const options = { directory, store: { streams: new Map() }, archive: {}, before: 0, after: 60000 }
  let queue = new Recordings(options)
  try {
    const now = Date.now()
    const jobs = [now + 10000, now - 10000, now + 20000].map((end, i) =>
      queue.add(`canale${i}`, `Canale ${i}`, { t: 'Programma', s: now - 30000, e: end }))
    for (const job of jobs) {
      queue.update(job.id, 'recording')
      queue.db.prepare('UPDATE recordings SET stoppedAt = ? WHERE id = ?').run(now, job.id)
    }
    for (const job of jobs.slice(0, 2)) await writeFile(join(directory, queue.localName(job.id)), 'campione')
    await queue.stop()

    queue = new Recordings(options)
    queue.tick = () => {}
    await queue.start()
    const [early, afterEnd, empty] = jobs.map(job => queue.get(job.channel, job.start))
    assert.equal(early.status, 'waiting')
    assert.equal(early.partial, 1)
    assert.equal(afterEnd.status, 'waiting')
    assert.equal(afterEnd.partial, 0)
    assert.equal(empty.status, 'failed')
    assert.ok(jobs.every(job => queue.finish(job.id)))
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('le serie evitano repliche identificate, rispettano i salti e propongono gli spostamenti', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-series-'))
  const now = Date.now()
  const hour = 3600000
  const p = (delay, episode, t = 'Serie') => ({ t, s: now + delay, e: now + delay + 1800000, episode })
  const first = p(hour, '1.1')
  const repeat = p(6 * hour, '1.1')
  const second = p(25 * hour, '1.2')
  const channel = { name: 'Iris', programmes: [first, repeat, second] }
  const store = { channels: new Map([['iris', channel]]), streams: new Map([['iris', { url:'http://example.test/iris' }]]) }
  const options = { directory, store, before: 120000, after: 300000 }
  let queue = new Recordings(options)
  try {
    const rule = queue.follow('iris', channel.name, ' SERIE ')
    queue.syncSeries(now)
    queue.syncSeries(now)
    assert.deepEqual(queue.list().map(job => job.episode), ['1.2', '1.1'])
    const job = queue.get('iris', first.s)
    const moved = p(2 * hour, '1.1')
    channel.programmes = [moved, repeat, second]
    queue.syncSeries(now)
    assert.deepEqual(queue.change(job, now), { s: moved.s, e: moved.e })
    assert.equal(queue.get('iris', moved.s), null)
    const updated = queue.move(job, moved, { before: options.before, after: options.after }, now)
    assert.equal(updated.id, job.id)
    assert.equal(updated.captureTo, moved.e + options.after)
    assert.equal(queue.change(updated, now), null)

    assert.equal(queue.remove(queue.get('iris', second.s).id), true)
    const later = p(48 * hour, '1.2')
    const next = p(49 * hour, '1.3')
    channel.programmes.push(later, next)
    await queue.stop()
    queue = new Recordings(options)
    queue.syncSeries(now)
    assert.equal(queue.get('iris', later.s), null)
    assert.equal(queue.get('iris', next.s).seriesId, rule.id)
    assert.equal(queue.unfollow(rule.id), true)
    channel.programmes.push(p(72 * hour, '1.4'))
    queue.syncSeries(now)
    assert.equal(queue.list().length, 2)
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('il palinsesto lascia intatti orari manuali e corrispondenze ambigue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-manual-'))
  const now = Date.now()
  const start = now + 3600000
  const programme = { t: 'Film', s: start, e: start + 3600000 }
  const programmes = [1800000, 3600000].map(delta => ({ ...programme, s: programme.s + delta, e: programme.e + delta }))
  const channel = { programmes }
  const store = { channels: new Map([['iris', channel], ['rai4', channel]]) }
  const queue = new Recordings({ directory, store, before: 0, after: 0 })
  try {
    const guide = queue.add('iris', 'Iris', programme)
    const manual = queue.add('rai4', 'Rai 4', programme, { kind: 'manual' })
    assert.equal(queue.change(guide, now), null)
    channel.programmes = programmes.slice(0, 1)
    assert.equal(queue.change(guide, now).s, programmes[0].s)
    assert.equal(queue.change(manual, now), null)
    queue.update(manual.id, 'failed', 'Nessun video')
    assert.deepEqual(queue.outcomes(now).map(outcome => outcome.id), [manual.id])
    assert.equal(queue.outcomes(now + 31 * 86400000).length, 0)
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('una sorgente di registrazione può affiancare il sito ufficiale e recuperare più parti dopo il riavvio', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-dynamic-'))
  const website = { url: 'https://www.tv8.it/streaming', web: true }
  const source = { async resolve() { throw new Error('Non usato nel recupero') } }
  const store = { streams: new Map([['tv8', website], ['la7', website]]) }
  const queue = new Recordings({ directory, store, before: 0, after: 0, sources: new Map([['tv8', source]]) })
  try {
    assert.equal(queue.source('tv8'), source)
    assert.equal(queue.source('la7'), undefined)
    assert.equal(store.streams.get('tv8'), website)
    const start = Date.now() - 1000
    const job = queue.add('tv8', 'TV8', { t: 'Prova', s: start, e: start + 60000 })
    queue.update(job.id, 'recording')
    const parts = queue.partsDirectory(job.id)
    await mkdir(parts)
    await writeFile(join(parts, '10.ts'), 'secondo')
    await writeFile(join(parts, '2.ts'), 'primo')
    await writeFile(join(parts, '1.ts'), '')
    queue.tick = () => {}
    await queue.start()
    const result = queue.getById(job.id)
    assert.equal(result.status, 'waiting')
    assert.equal(result.partial, 1)
    assert.equal(result.bytes, 'primosecondo'.length)
    assert.deepEqual((await queue.captureFiles(job.id)).map(file => file.path), [join(parts, '2.ts'), join(parts, '10.ts')])
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Video Station riceve il file nativo del film prima della pubblicazione dell’MP4', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-vsmeta-'))
  const archive = new SmbArchive({ share: '//nas.local/TV' })
  const remote = new Map()
  const promoted = []
  archive.fileSize = async (_, filename) => remote.get(filename)?.length ?? null
  archive.command = async (command, cwd) => {
    const [, action, source, target] = /^(put|rename) "([^"]+)" "([^"]+)"$/.exec(command)
    if (action === 'put') {
      remote.set(target, await readFile(join(cwd, source)))
    } else {
      remote.set(target, remote.get(source))
      remote.delete(source)
      promoted.push(target)
    }
  }
  const start = Date.now()
  const film = { s: start + 60000, e: start + 3600000, t: 'Città', type: 'movie', desc: 'Trama', cat: 'Drammatico' }
  const options = { directory, archive, store: { programme: (_, s) => s === film.s ? film : null },
    before: 0, after: 0, videoStationMetadata: true }
  const queue = new Recordings(options)
  try {
    // Simula una prenotazione esistente, creata prima della migrazione.
    const job = queue.add('iris', 'Iris', { ...film, type: null })
    const local = `${job.id}.mp4`
    await writeFile(join(directory, local), 'campione MP4')
    await queue.publish(job)
    const sidecar = `${job.filename}.vsmeta`
    assert.deepEqual(promoted, [sidecar, job.filename])
    assert.equal(remote.get(sidecar).toString('hex'),
      '0801120643697474c3a01a0643697474c3a042055472616d61520c1a0a4472616d6d617469636f')
    assert.deepEqual(remote.get(sidecar), encodeMovieMetadata({ title: 'Città', summary: 'Trama', genre: 'Drammatico' }))
    assert.equal(queue.getById(job.id).status, 'saved')
    await assert.rejects(readFile(join(directory, `${job.id}.vsmeta`)), { code: 'ENOENT' })

    const preserved = Buffer.from('metadati personalizzati')
    remote.set(sidecar, preserved)
    await writeFile(join(directory, local), 'campione MP4')
    await writeFile(join(directory, 'prova.vsmeta'), 'metadati diversi')
    await archive.publish(directory, local, job.filename, undefined, 'prova.vsmeta')
    assert.deepEqual(remote.get(sidecar), preserved)
    assert.deepEqual(promoted, [sidecar, job.filename])

    const sport = queue.add('rai2', 'Rai 2', { ...film, t: 'Gara', type: 'sport' })
    assert.equal(await queue.prepareMovieSidecar(sport), null)
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('archivia i film nella seconda destinazione e conserva il nome dopo un ritentativo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-movie-archive-'))
  const tvFiles = new Set()
  const movieFiles = new Set(['300 (2007).mp4'])
  const mockArchive = (share, files) => Object.assign(new SmbArchive({ share }), {
    files: async () => new Set([...files].map(filename => filename.toLowerCase())),
    fileSize: async (_, filename) => files.has(filename) ? 1 : null,
    publish: async (_, __, filename) => { files.add(filename) },
  })
  const archive = mockArchive('//nas.local/TV', tvFiles)
  const movieArchive = mockArchive('//nas.local/Video/Film registrati', movieFiles)
  const options = { directory, archive, movieArchive, before: 0, after: 0 }
  let queue = new Recordings(options)
  try {
    const start = Date.now() + 60000
    const film = queue.add('iris', 'Iris', { t: '300', type: 'movie', releaseYear: 2007, s: start, e: start + 60000 })
    const tv = queue.add('tv8', 'TV8', { t: 'Gara', type: 'sport', s: start, e: start + 60000 })
    const match = await queue.reserveArchive(film)
    assert.equal(match.filename, `300 (2007) [${film.id.slice(0, 8)}].mp4`)
    queue.update(film.id, 'waiting')
    await queue.stop()
    queue = new Recordings(options)

    for (const job of [film, tv]) {
      await writeFile(join(directory, `${job.id}.mp4`), 'campione')
      await queue.publish(queue.getById(job.id))
    }
    assert.deepEqual([...movieFiles], ['300 (2007).mp4', match.filename])
    assert.deepEqual([...tvFiles], [tv.filename])
    const [savedFilm, savedTv] = await queue.visible([queue.getById(film.id), queue.getById(tv.id)], 'localhost')
    assert.equal(savedFilm.playUrl, `smb://nas.local/Video/Film%20registrati/${encodeURIComponent(match.filename)}`)
    assert.equal(savedTv.playUrl, `smb://nas.local/TV/${encodeURIComponent(tv.filename)}`)
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('estende solo la cattura attiva e conferma i conflitti nella finestra aggiunta', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-extend-'))
  const queue = new Recordings({ directory, before: 0, after: 0, limit: 1 })
  const now = Date.now()
  const job = queue.add('tv8', 'TV8', { t: 'Gara', s: now - 1000, e: now + 60000 })
  const other = queue.add('iris', 'Iris', { t: 'Film', s: job.captureTo, e: now + 3600000 })
  try {
    queue.update(job.id, 'recording')
    let deadline
    queue.active.set(job.id, { extend: until => { deadline = until; return true }, stop() {} })
    assert.deepEqual(queue.extendCapture(job.id, job.captureTo, 15, null, now).conflicts.map(row => row.id), [other.id])
    assert.equal(deadline, undefined)
    const { updated } = queue.extendCapture(job.id, job.captureTo, 15, other.id, now)
    assert.equal(updated.captureTo, job.captureTo + 15 * 60000)
    assert.equal(deadline, updated.captureTo)
    assert.deepEqual(queue.extendCapture(job.id, job.captureTo, 15, other.id, now), {})
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})

test('la cattura a sorgente risolta rispetta la nuova scadenza', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-extended-source-'))
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] })
  const now = Date.now()
  const row = { captureTo: now + 100, start: now, end: now + 10000 }
  let signal
  let ready
  const waiting = new Promise(resolve => { ready = resolve })
  const source = { resolve(requestSignal) {
    signal = requestSignal
    ready()
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } }
  const capture = captureDynamic(row, source, directory)
  try {
    await waiting
    assert.equal(capture.extend(now + 200), true)
    t.mock.timers.tick(100)
    assert.equal(signal.aborted, false)
    t.mock.timers.tick(100)
    assert.equal(signal.aborted, true)
    await capture.done
    assert.equal(capture.extend(now + 300), false)
  } finally {
    capture.stop()
    await capture.done
    await rm(directory, { recursive: true, force: true })
  }
})

test('il ricontrollo della guida rispetta la finestra e distingue gli orari coperti', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-watch-'))
  const now = Date.now(), minute = 60000
  const p = { t: 'Gara', s: now + 70 * minute, e: now + 120 * minute }
  const channel = { programmes: [p] }
  const store = { channels: new Map([['tv8', channel]]) }
  const queue = new Recordings({ directory, store, before: 10 * minute, after: 10 * minute })
  try {
    const job = queue.add('tv8', 'TV8', p)
    assert.deepEqual(queue.pendingGuideChecks(now), [])
    queue.watchGuide(job.id, true, now)
    assert.deepEqual(queue.pendingGuideChecks(now - 35 * minute), [])
    assert.deepEqual(queue.pendingGuideChecks(now + 46 * minute), [])
    const pending = queue.pendingGuideChecks(now)
    assert.deepEqual(pending.map(row => row.id), [job.id])
    channel.programmes = [{ ...p, s: p.s - 5 * minute }]
    assert.equal(queue.review(job, now).covered, true)
    channel.programmes = [{ ...p, s: p.s - 15 * minute }]
    assert.equal(queue.review(job, now).covered, false)
    queue.markGuideChecked(pending, now)
    assert.deepEqual(queue.pendingGuideChecks(now), [])
    assert.equal(queue.getById(job.id).captureFrom, job.captureFrom)
  } finally {
    await queue.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
