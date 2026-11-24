import { readFile, rename, writeFile } from 'node:fs/promises'

const API = 'https://api.themoviedb.org/3/search/movie'
const WEB = 'https://www.themoviedb.org/search/movie'
const MAX_PAGE = 1024 * 1024
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = text => text.replace(/&(?:#x([\da-f]+)|#(\d+)|(\w+));/gi, (all, hex, dec, name) =>
  hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : ENTITIES[name.toLowerCase()] ?? all)
const CARD = /<a [^>]*data-media-type="movie"[^>]*href="\/movie\/(\d+)[^"]*"[^>]*><h2[^>]*><span>([^<]*)<\/span>(?:<span[^>]*>\s*\(([^<]*)\)<\/span>)?<\/h2><\/a><span class="release_date[^"]*">([^<]*)<\/span>/g
const MISS_TTL = 7 * 86400000
const MAX_ENTRIES = 5000

const key = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Senza credenziali legge la pagina di ricerca pubblica; con una chiave API v3 o un token v4 (JWT) usa l'API.
export function createTmdb({ credential = '', cacheFile, fetchImpl = fetch, now = Date.now } = {}) {
  const bearer = credential.includes('.')
  const cache = new Map()
  const pending = new Map()
  let loaded, saving = Promise.resolve()

  const load = () => loaded ||= (async () => {
    if (!cacheFile) return
    try { for (const [k, v] of Object.entries(JSON.parse(await readFile(cacheFile, 'utf8')))) cache.set(k, v) } catch { /* nessuna cache */ }
  })()
  const save = () => {
    if (!cacheFile) return
    saving = saving.then(async () => {
      try {
        await writeFile(cacheFile + '.tmp', JSON.stringify(Object.fromEntries(cache)))
        await rename(cacheFile + '.tmp', cacheFile)
      } catch { /* la cache è solo un'ottimizzazione */ }
    })
  }

  // Solo corrispondenze esatte del titolo (e dell'anno, con tolleranza di uno, se noto): meglio nessun link che quello di un altro film.
  const pick = (candidates, title, year) => {
    const wanted = key(title)
    return candidates.find(c => (!year || !c.year || Math.abs(c.year - year) <= 1) && (key(c.title) === wanted || key(c.original) === wanted))
  }
  const link = hit => hit ? `https://www.themoviedb.org/movie/${hit.id}` : null

  async function searchApi(title, year) {
    const url = new URL(API)
    url.searchParams.set('query', title)
    url.searchParams.set('language', 'it-IT')
    if (!bearer) url.searchParams.set('api_key', credential)
    const response = await fetchImpl(url, {
      headers: bearer ? { Authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(6000),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`TMDB: HTTP ${response.status}`) }
    const { results = [] } = await response.json()
    return link(pick(results.filter(r => Number.isInteger(r.id)).map(r => ({
      id: r.id, title: r.title, original: r.original_title, year: Number(/^\d{4}/.exec(r.release_date)?.[0]) || null })), title, year))
  }

  async function searchWeb(title, year) {
    const url = new URL(WEB)
    url.searchParams.set('query', title)
    url.searchParams.set('language', 'it-IT')
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'GuidaTV' }, // TMDB rifiuta gli User-Agent che imitano un browser
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`TMDB: HTTP ${response.status}`) }
    const page = (await response.text()).slice(0, MAX_PAGE)
    const candidates = [...page.matchAll(CARD)].map(m => ({
      id: Number(m[1]), title: decode(m[2]), original: decode(m[3] || ''), year: Number(/(\d{4})\s*$/.exec(decode(m[4]))?.[1]) || null }))
    return link(pick(candidates, title, year))
  }
  const search = credential ? searchApi : searchWeb

  return {
    async lookup(title, year) {
      title = String(title || '').trim().slice(0, 200)
      year = /^(?:18|19|20|21)\d{2}$/.test(year) ? Number(year) : 0
      if (!title) return null
      await load()
      const id = `${key(title)}|${year}`
      const hit = cache.get(id)
      if (hit && (hit.url || now() - hit.at < MISS_TTL)) return hit.url
      if (pending.has(id)) return pending.get(id)
      const request = search(title, year).then(url => {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value)
        cache.set(id, { url, at: now() })
        save()
        return url
      }).finally(() => pending.delete(id))
      pending.set(id, request)
      return request
    },
  }
}
