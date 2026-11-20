import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import { loadLcn } from './lcn.js'
import { loadPlaylist, matchStreams, singleM3u } from './streams.js'
import { streamInputArgs } from './ffmpeg.js'
import { Recordings } from './recordings.js'
import { SmbArchive } from './smb.js'

const PORT = Number(process.env.PORT || 8080)
const EPG_URL = process.env.EPG_URL || 'http://epg:3000/guide.xml'
const DATA_DIR = process.env.DATA_DIR || '/data'
const REFRESH_MIN = Number(process.env.REFRESH_MIN || 20)
const PUBLIC_DIR = process.env.PUBLIC_DIR || fileURLToPath(new URL('../public', import.meta.url))

const STREAMS_SOURCE = process.env.STREAMS_M3U || '' // URL o file; default /data/streams.m3u
const store = new Store({ epgUrl: EPG_URL, dataDir: DATA_DIR, lcn: await loadLcn(DATA_DIR) })
const recordingShare = process.env.RECORDINGS_SMB
const validPadding = value => /^\d+$/.test(value ?? '') && Number(value) <= 60
const padding = (value, fallback) => {
  const minutes = Number(value ?? fallback)
  return (Number.isInteger(minutes) && minutes >= 0 && minutes <= 60 ? minutes : fallback) * 60000
}
const recordings = recordingShare && new Recordings({
  directory: join(DATA_DIR, 'recordings'),
  store,
  archive: new SmbArchive({
    share: recordingShare,
    ip: process.env.RECORDINGS_SMB_IP,
    tailscaleHost: process.env.RECORDINGS_SMB_TAILSCALE_HOST,
    credentials: process.env.RECORDINGS_SMB_CREDENTIALS || '/run/guidatv/smb.credentials',
  }),
  before: padding(process.env.RECORDINGS_BEFORE_MIN, 2),
  after: padding(process.env.RECORDINGS_AFTER_MIN, 10),
})

// Stream con audio/video su tracce HLS separate (Mediaset): VLC li desincronizza, quindi li uniamo
// in un unico MPEG-TS senza ricodificare (-c copy). Un ffmpeg per spettatore, chiuso alla disconnessione.
const MAX_MUX = Number(process.env.MAX_MUX || 4)
let muxing = 0
const playUrl = (req, id, s) => (s.mux ? `http://${req.headers.host}/api/live/${encodeURIComponent(id)}.ts` : s.url)
function liveMux(id, req, res) {
  const s = store.streams.get(id)
  if (!s?.mux) return json(res, { error: 'nessuno stream' }, 404)
  if (muxing >= MAX_MUX) return json(res, { error: 'troppi stream attivi' }, 503)
  const ff = spawn('ffmpeg', [...streamInputArgs(s), 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  muxing++
  let done = false
  const end = () => { if (done) return; done = true; muxing--; ff.kill('SIGKILL') }
  ff.stderr.on('data', d => console.warn(`ffmpeg ${id}: ${String(d).trim().slice(0, 300)}`))
  ff.on('error', e => { console.error('ffmpeg non avviabile:', e.message); end(); if (!res.headersSent) json(res, { error: 'ffmpeg non disponibile' }, 502); else res.destroy() })
  ff.on('close', () => { end(); res.end() })
  res.on('close', end)
  res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store' })
  ff.stdout.pipe(res)
}

async function loadStreams() {
  try {
    const entries = await loadPlaylist(STREAMS_SOURCE, DATA_DIR)
    store.streams = matchStreams(entries, store.channels.keys())
    if (entries.length) console.info(`stream: ${store.streams.size} canali associati (${entries.length} voci)`)
  } catch (e) { console.warn(`playlist stream non caricata: ${e.message}`) }
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
}

const json = (res, data, status = 200, cache = 'no-cache') => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache })
  res.end(JSON.stringify(data))
}
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d)

async function recordingApi(q, res, req) {
  if (!recordings) return json(res, { error: 'Registrazioni disattivate' }, 404)
  if (req.method === 'GET' || req.method === 'HEAD') {
    return json(res, await recordings.visible(recordings.list(), req.headers.host, req.socket.remoteAddress), 200, 'no-store')
  }
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return json(res, { error: 'Metodo non consentito' }, 405)
  const origin = URL.parse(req.headers.origin || '')
  if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host ||
    (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
    return json(res, { error: 'Richiesta da un’altra origine' }, 403)
  }
  if (req.method === 'DELETE') {
    return recordings.remove(q.get('id') || '') ? json(res, { ok: true }) : json(res, { error: 'Registrazione non annullabile' }, 409)
  }
  if (req.method === 'POST' && q.get('action') === 'stop') {
    return recordings.finish(q.get('id') || '') ? json(res, { ok: true }, 202) :
      json(res, { error: 'La registrazione non è in corso' }, 409)
  }
  const editing = req.method === 'PATCH'
  const scheduled = editing ? recordings.getById(q.get('id') || '') : null
  if (editing && !scheduled) return json(res, { error: 'Registrazione non trovata' }, 404)
  if (scheduled && scheduled.status !== 'scheduled') {
    return json(res, { error: 'Puoi modificare solo le registrazioni programmate' }, 409)
  }
  const id = scheduled?.channel ?? q.get('c')
  const start = scheduled?.start ?? num(q.get('s'), NaN)
  const programme = scheduled ? { s: scheduled.start, e: scheduled.end } : store.programme(id, start)
  if (!programme) return json(res, { error: 'Programma non trovato' }, 404)
  if (!scheduled) {
    const stream = store.streams.get(id)
    if (!stream || stream.web) return json(res, { error: 'Il canale non ha uno stream registrabile' }, 409)
  }
  const now = Date.now()
  if (programme.e <= now) return json(res, { error: 'Il programma è già terminato' }, 409)
  const before = q.get('before')
  const after = q.get('after')
  if ([before, after].some(value => value !== null && !validPadding(value))) {
    return json(res, { error: 'I margini devono essere minuti interi da 0 a 60' }, 400)
  }
  const existing = !editing && recordings.get(id, start)
  if (existing) return json(res, existing, 201, 'no-store')
  const defaults = scheduled ? {
    before: scheduled.start - scheduled.captureFrom,
    after: scheduled.captureTo - scheduled.end,
  } : recordings
  const margins = {
    before: before === null ? defaults.before : Number(before) * 60000,
    after: after === null ? defaults.after : Number(after) * 60000,
  }
  const conflicts = recordings.conflicts(programme, margins, { now, excludeId: scheduled?.id })
  if (conflicts.length && q.get('confirm') !== conflicts.map(job => job.id).sort().join(',')) {
    return json(res, { error: 'Le registrazioni si sovrappongono', conflicts, limit: recordings.limit }, 409, 'no-store')
  }
  if (scheduled) {
    const updated = recordings.reschedule(scheduled.id, margins, now)
    return updated ? json(res, updated, 200, 'no-store') : json(res, { error: 'Registrazione non modificabile' }, 409)
  }
  return json(res, recordings.add(id, store.channels.get(id).name, programme, margins), 201, 'no-store')
}

async function api(url, res, req) {
  const q = url.searchParams
  switch (url.pathname) {
    case '/api/health': return json(res, { ...store.health(), recordingEnabled: Boolean(recordings) })
    case '/api/channels': return json(res, store.listChannels())
    case '/api/live': return json(res, { error: 'usa /api/live/<id>.ts' }, 404)
    case '/api/stream': { // per i player con schema URL personalizzato
      const s = store.streams.get(q.get('c'))
      return s && !s.web ? json(res, { url: playUrl(req, q.get('c'), s), name: store.channels.get(q.get('c')).name }) : json(res, { error: 'nessuno stream' }, 404)
    }
    case '/api/play.m3u': { // un click: il sistema apre il file con il player associato (VLC)
      const id = q.get('c'), s = store.streams.get(id)
      if (!s || s.web) return json(res, { error: 'nessuno stream' }, 404)
      const name = store.channels.get(id).name
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl; charset=utf-8', 'content-disposition': `attachment; filename="${id}.m3u"`, 'cache-control': 'no-store' })
      return res.end(singleM3u(name, s, playUrl(req, id, s)))
    }
    case '/api/now': return json(res, store.now(num(q.get('at'), Date.now())))
    case '/api/schedule': {
      const from = num(q.get('from'), Date.now()), to = num(q.get('to'), from + 86400000)
      if (to - from > 4 * 86400000) return json(res, { error: 'intervallo troppo ampio' }, 400)
      const ids = q.get('channels') ? new Set(q.get('channels').split(',')) : null
      return json(res, store.schedule(from, to, ids))
    }
    case '/api/programme': {
      const p = store.programme(q.get('c'), num(q.get('s'), NaN))
      if (!p) return json(res, { error: 'non trovato' }, 404)
      const job = recordings && recordings.get(q.get('c'), p.s)
      const [recording = null] = job ? await recordings.visible([job], req.headers.host, req.socket.remoteAddress) : []
      const recordingMargins = recordings ? { before: recordings.before / 60000, after: recordings.after / 60000 } : undefined
      return json(res, { ...p, recording, recordingMargins })
    }
    case '/api/search': return json(res, store.search(q.get('q') || '', num(q.get('from'), Date.now())))
    default: return json(res, { error: 'non trovato' }, 404)
  }
}

async function serveStatic(pathname, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '') || 'index.html'
  if (rel.startsWith('..')) { res.writeHead(403); return res.end() }
  try {
    const file = join(PUBLIC_DIR, rel)
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache', // app su LAN: rivalida sempre, così gli aggiornamenti arrivano subito sui telefoni
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404')
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/api/recordings') return await recordingApi(url.searchParams, res, req)
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end() }
    if (url.pathname.startsWith('/api/')) {
      const m = /^\/api\/live\/([^/]+)\.ts$/.exec(url.pathname)
      if (m) return liveMux(decodeURIComponent(m[1]), req, res)
      return await api(url, res, req)
    }
    return await serveStatic(url.pathname, res)
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, { error: 'errore interno' }, 500)
  }
})

await store.loadCache()
if (recordings) await recordings.start()
server.listen(PORT, () => console.log(`GuidaTV in ascolto su :${PORT}`))

// L'epg può metterci minuti ad essere pronto al primo avvio: ritenta spesso finché non c'è una guida.
let loops = 0
const loop = async () => {
  await store.refresh()
  if (loops++ % 18 === 0 || !store.streams.size) await loadStreams() // ~ogni 6h, o finché non c'è nulla
  setTimeout(loop, (store.channels.size ? REFRESH_MIN : 1) * 60000)
}
loop()
async function shutdown() {
  server.close()
  if (recordings) await recordings.stop()
  process.exit(0)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, shutdown)
