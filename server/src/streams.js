import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Stessa normalizzazione di epg/build-channels.mjs, così "Rai 1 HD" / "Rai1.it@HD" -> "rai1".
const keyOf = name =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\+\s*24/g, 'plus24').replace(/\+\s*1/g, 'plus1')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/\b(hd|4k|dtt|sd|italy|italia hd)\b/g, '').replace(/hd-?\d*$/, '')
    .replace(/[^a-z0-9]/g, '')
const ALIAS = { '20': '20mediaset', twentyseven: '27twentyseven', la7cinema: 'la7d' }

// #EXTINF:-1 tvg-id="X" http-user-agent="..." ...,Nome  + righe #EXTVLCOPT/#EXTHTTP opzionali + URL
export function parseM3u(text) {
  const out = []
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF')) {
      const attrs = Object.fromEntries([...line.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]))
      cur = { attrs, name: line.slice(line.lastIndexOf(',') + 1).trim(), ua: attrs['http-user-agent'] || '', referrer: attrs['http-referrer'] || '', mux: attrs.mux === '1' }
    } else if (cur && line.startsWith('#EXTVLCOPT:')) {
      const [k, ...v] = line.slice(11).split('=')
      if (k === 'http-user-agent') cur.ua = v.join('=')
      if (k === 'http-referrer') cur.referrer = v.join('=')
    } else if (cur && line && !line.startsWith('#')) {
      if (/^https?:\/\//i.test(line)) out.push({ ...cur, url: line })
      cur = null
    }
  }
  return out
}

// Associa le voci della playlist ai canali della guida (id = chiave normalizzata).
export function matchStreams(entries, channelIds) {
  const map = new Map()
  const ids = new Set(channelIds)
  for (const e of entries) {
    const fromTvg = (e.attrs['tvg-id'] || '').split(/[.@]/)[0]
    const cands = [fromTvg, e.name].filter(Boolean).map(keyOf).map(k => ALIAS[k] || k)
    const id = cands.find(k => ids.has(k))
    if (!id || map.has(id)) continue // vale la prima voce: l'ordine della playlist è la priorità
    map.set(id, { url: e.url, ua: e.ua, referrer: e.referrer, mux: e.mux })
  }
  return map
}

export async function loadPlaylist(source, dataDir) {
  if (!source) source = join(dataDir, 'streams.m3u')
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseM3u(await res.text())
  }
  try { return parseM3u(await readFile(source, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
}

const q = s => s.replace(/[\r\n]/g, ' ')
// Playlist di una sola voce: i player (VLC in testa) la aprono direttamente.
export function singleM3u(name, s, url = s.url) {
  return ['#EXTM3U', `#EXTINF:-1,${q(name)}`,
    s.ua && `#EXTVLCOPT:http-user-agent=${q(s.ua)}`, s.referrer && `#EXTVLCOPT:http-referrer=${q(s.referrer)}`,
    url, ''].filter(x => x !== '' && x !== false && x != null).join('\r\n') + '\r\n'
}
