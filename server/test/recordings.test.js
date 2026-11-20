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
