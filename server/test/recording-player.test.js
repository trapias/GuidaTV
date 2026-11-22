import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import { byteRange, playerSession, recordingMedia } from '../src/recording-player.js'

test('il player richiede una sessione, supporta la ricerca e rifiuta file sconosciuti', async () => {
  const password = 'password fittizia di test'
  const session = playerSession(password)
  const login = session.login({ headers: { 'x-playback-password': encodeURIComponent(password) }, socket: {} })
  assert.equal(login.status, 200)
  assert.match(login.cookie, /HttpOnly; SameSite=Strict/)
  assert.equal(session.login({ headers: {} }).status, 401)
  const cookie = login.cookie.split(';')[0]
  assert.equal(session.authenticated({ headers: { cookie: cookie.replace(/\.[\w-]/, '.!') } }), false)
  const filename = 'Città - parziale.mp4'
  const contents = Buffer.from('0123456789')
  const recordings = {
    getById: id => id === 'known' ? { filename: 'Città.mp4', status: 'saved', partial: 1 } : null,
    abort: new AbortController(),
    archiveFor: () => ({
      async fileSize(_, name) { assert.equal(name, filename); return contents.length },
      read(name, start, length) {
        assert.equal(name, filename)
        const output = new EventEmitter()
        output.stdout = Readable.from([contents.subarray(start, start + length)])
        return output
      },
    }),
  }
  const media = recordingMedia(recordings, session.authenticated, (res, body, status) => {
    res.writeHead(status)
    res.end(JSON.stringify(body))
  })
  const server = createServer((req, res) => media(req.url.slice(1), req, res))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(`${origin}/known`)).status, 401)
    assert.equal((await fetch(`${origin}/unknown`, { headers: { cookie } })).status, 404)
    const segment = await fetch(`${origin}/known`, { headers: { cookie, range: 'bytes=3-6' } })
    assert.equal(segment.status, 206)
    assert.equal(segment.headers.get('content-range'), 'bytes 3-6/10')
    assert.equal(await segment.text(), '3456')
    assert.equal((await fetch(`${origin}/known`, { headers: { cookie, range: 'bytes=10-' } })).status, 416)
    assert.deepEqual(byteRange('bytes=-2', 10), { start: 8, end: 9 })
    assert.equal(byteRange('bytes=0-1,5-6', 10), null)
  } finally { server.close() }
})
