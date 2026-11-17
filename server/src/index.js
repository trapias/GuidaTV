import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'

const PORT = Number(process.env.PORT || 8080)
const EPG_URL = process.env.EPG_URL || 'http://epg:3000/guide.xml'
const DATA_DIR = process.env.DATA_DIR || '/data'
const REFRESH_MIN = Number(process.env.REFRESH_MIN || 20)
const PUBLIC_DIR = process.env.PUBLIC_DIR || fileURLToPath(new URL('../public', import.meta.url))

const store = new Store({ epgUrl: EPG_URL, dataDir: DATA_DIR })
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
}

const json = (res, data, status = 200, cache = 'no-cache') => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache })
  res.end(JSON.stringify(data))
}
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d)

async function api(url, res) {
  const q = url.searchParams
  switch (url.pathname) {
    case '/api/health': return json(res, store.health())
    case '/api/channels': return json(res, store.listChannels())
    case '/api/now': return json(res, store.now(num(q.get('at'), Date.now())))
    case '/api/schedule': {
      const from = num(q.get('from'), Date.now()), to = num(q.get('to'), from + 86400000)
      if (to - from > 4 * 86400000) return json(res, { error: 'intervallo troppo ampio' }, 400)
      const ids = q.get('channels') ? new Set(q.get('channels').split(',')) : null
      return json(res, store.schedule(from, to, ids))
    }
    case '/api/programme': {
      const p = store.programme(q.get('c'), num(q.get('s'), NaN))
      return p ? json(res, p) : json(res, { error: 'non trovato' }, 404)
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
      'cache-control': rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404')
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end() }
    if (url.pathname.startsWith('/api/')) return await api(url, res)
    return await serveStatic(url.pathname, res)
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, { error: 'errore interno' }, 500)
  }
})

await store.loadCache()
server.listen(PORT, () => console.log(`GuidaTV in ascolto su :${PORT}`))

// L'epg può metterci minuti ad essere pronto al primo avvio: ritenta spesso finché non c'è una guida.
const loop = async () => {
  await store.refresh()
  setTimeout(loop, (store.channels.size ? REFRESH_MIN : 1) * 60000)
}
loop()
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
