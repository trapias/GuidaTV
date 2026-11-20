import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recordings } from '../src/recordings.js'
import { SmbArchive } from '../src/smb.js'

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

    queue.archiveCheck.expires = 0
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
