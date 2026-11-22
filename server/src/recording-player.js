import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { archivedName } from './recordings.js'

const COOKIE = 'guidatv_player'
const SESSION_SECONDS = 12 * 3600
const digest = value => createHash('sha256').update(value).digest()

export function playerSession(password) {
  const passwordHash = digest(password)
  const secret = randomBytes(32)
  const sign = expires => createHmac('sha256', secret).update(expires).digest('base64url')
  let failures = 0, resetAt = 0
  return {
    authenticated(req) {
      const cookie = req.headers.cookie?.split(/;\s*/).find(group => group.startsWith(`${COOKIE}=`))
      const [, expires, signature] = /^guidatv_player=(\d+)\.([\w-]{43})$/.exec(cookie || '') || []
      return Number(expires) > Date.now() && timingSafeEqual(Buffer.from(signature), Buffer.from(sign(expires)))
    },
    login(req) {
      const now = Date.now()
      if (now >= resetAt) { failures = 0; resetAt = now + 60000 }
      if (failures >= 8) return { status: 429 }
      let password
      try { password = decodeURIComponent(req.headers['x-playback-password'] || '') } catch { return { status: 401 } }
      if (!timingSafeEqual(passwordHash, digest(password))) {
        failures++
        return { status: 401 }
      }
      const expires = String(now + SESSION_SECONDS * 1000)
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https'
      return { status: 200, cookie: `${COOKIE}=${expires}.${sign(expires)}; Max-Age=${SESSION_SECONDS}; Path=/api/recordings; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}` }
    },
  }
}

export function byteRange(header, size) {
  if (!header) return { start: 0, end: size - 1 }
  const [, first, last] = /^bytes=(\d*)-(\d*)$/.exec(header) || []
  if (!first && !last) return null
  const start = first ? Number(first) : Math.max(0, size - Number(last))
  const end = first && last ? Math.min(size - 1, Number(last)) : size - 1
  return start < size && start <= end ? { start, end } : null
}

export function recordingMedia(recordings, isAuthenticated, json) {
  let playing = 0
  return async (id, req, res) => {
    if (!isAuthenticated(req)) return json(res, { error: 'Accedi al player' }, 401, 'no-store')
    const row = recordings.getById(id)
    if (row?.status !== 'saved' || !/\.mp4$/i.test(row.filename)) {
      return json(res, { error: 'Video non disponibile' }, 404, 'no-store')
    }
    const archive = recordings.archiveFor(row)
    if (!archive) return json(res, { error: 'Video non disponibile' }, 404, 'no-store')
    const filename = archivedName(row)
    if (/[\x00-\x1f"\\/]/.test(filename)) return json(res, { error: 'Video non disponibile' }, 404, 'no-store')
    if (playing >= 4) return json(res, { error: 'Player occupato, riprova tra poco' }, 503, 'no-store')

    playing++
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    res.setTimeout(30000, () => res.destroy())
    try {
      const signal = AbortSignal.any([recordings.abort.signal, abort.signal])
      const size = await archive.fileSize(recordings.directory, filename, signal)
      if (!size) return json(res, { error: 'Video assente sul NAS' }, 404, 'no-store')
      const range = byteRange(req.headers.range, size)
      const headers = {
        'accept-ranges': 'bytes', 'content-type': 'video/mp4', 'cache-control': 'private, no-store',
        'cross-origin-resource-policy': 'same-origin',
      }
      if (!range) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
        return res.end()
      }
      const { start, end } = range
      const length = end - start + 1
      headers['content-length'] = length
      const partial = Boolean(req.headers.range)
      if (partial) headers['content-range'] = `bytes ${start}-${end}/${size}`
      if (req.method === 'HEAD') {
        res.writeHead(partial ? 206 : 200, headers)
        return res.end()
      }
      const reader = archive.read(filename, start, length, signal)
      reader.on('error', () => reader.stdout.destroy())
      const chunks = reader.stdout[Symbol.asyncIterator]()
      const first = await chunks.next()
      if (first.done) throw Error('Lettura SMB non disponibile')
      res.writeHead(partial ? 206 : 200, headers)
      await pipeline((async function* () {
        let count = first.value.length
        yield first.value
        for await (const chunk of chunks) { count += chunk.length; yield chunk }
        if (count !== length) throw Error('Lettura SMB incompleta')
      })(), res)
    } catch {
      if (res.destroyed) return
      if (res.headersSent) res.destroy()
      else json(res, { error: 'Lettura del NAS non riuscita' }, 502, 'no-store')
    } finally {
      playing--
      abort.abort()
    }
  }
}
