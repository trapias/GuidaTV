import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Recordings } from '../src/recordings.js'

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
