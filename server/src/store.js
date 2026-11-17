import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { parseXmltv } from './xmltv.js'

const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export class Store {
  constructor({ epgUrl, dataDir, log = console }) {
    this.epgUrl = epgUrl
    this.cacheFile = join(dataDir, 'guide.xml')
    this.dataDir = dataDir
    this.log = log
    this.channels = new Map()
    this.hash = ''
    this.loadedAt = 0
    this.lastError = ''
  }

  apply(xml) {
    const channels = parseXmltv(xml)
    if (channels.size === 0) throw new Error('guide.xml senza canali')
    for (const ch of channels.values()) for (const p of ch.programmes) p.k = fold(`${p.t} ${p.sub}`)
    this.channels = channels
    this.hash = createHash('sha1').update(xml).digest('hex')
    this.loadedAt = Date.now()
  }

  async loadCache() {
    try {
      this.apply(await readFile(this.cacheFile, 'utf8'))
      this.log.info(`cache caricata: ${this.channels.size} canali`)
    } catch { /* nessuna cache */ }
  }

  async refresh() {
    try {
      const res = await fetch(this.epgUrl, { signal: AbortSignal.timeout(60000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const xml = await res.text()
      if (createHash('sha1').update(xml).digest('hex') === this.hash) { this.lastError = ''; return false }
      this.apply(xml)
      await mkdir(this.dataDir, { recursive: true })
      await writeFile(this.cacheFile + '.tmp', xml)
      await rename(this.cacheFile + '.tmp', this.cacheFile)
      this.lastError = ''
      this.log.info(`guida aggiornata: ${this.channels.size} canali`)
      return true
    } catch (e) {
      this.lastError = String(e.message || e)
      this.log.warn(`aggiornamento fallito (si usa l'ultima guida valida): ${this.lastError}`)
      return false
    }
  }

  listChannels() {
    return [...this.channels.values()].map(({ id, name, group, programmes }) => ({
      id, name, group, n: programmes.length,
    }))
  }

  // programmi che si sovrappongono a [from,to)
  schedule(from, to, ids) {
    const out = {}
    for (const ch of this.channels.values()) {
      if (ids && !ids.has(ch.id)) continue
      out[ch.id] = ch.programmes
        .filter(p => p.e > from && p.s < to)
        .map(p => [p.s, p.e, p.t, p.sub, p.cat])
    }
    return out
  }

  now(at) {
    const out = {}
    for (const ch of this.channels.values()) {
      const i = ch.programmes.findIndex(p => p.e > at)
      if (i < 0) { out[ch.id] = { cur: null, next: null }; continue }
      const f = p => p && [p.s, p.e, p.t, p.sub, p.cat]
      const cur = ch.programmes[i].s <= at ? ch.programmes[i] : null
      const next = cur ? ch.programmes[i + 1] : ch.programmes[i]
      out[ch.id] = { cur: f(cur), next: f(next) }
    }
    return out
  }

  programme(id, s) {
    const p = this.channels.get(id)?.programmes.find(x => x.s === s)
    return p ? { s: p.s, e: p.e, t: p.t, sub: p.sub, cat: p.cat, desc: p.desc, img: p.img } : null
  }

  search(q, from, limit = 120) {
    const terms = fold(q).split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    const hits = []
    for (const ch of this.channels.values()) {
      for (const p of ch.programmes) {
        if (p.e <= from) continue
        if (terms.every(t => p.k.includes(t))) hits.push({ c: ch.id, s: p.s, e: p.e, t: p.t, sub: p.sub, cat: p.cat })
      }
    }
    return hits.sort((a, b) => a.s - b.s).slice(0, limit)
  }

  health() {
    let first = Infinity, last = 0, progs = 0
    for (const ch of this.channels.values()) {
      progs += ch.programmes.length
      if (ch.programmes.length) {
        first = Math.min(first, ch.programmes[0].s)
        last = Math.max(last, ch.programmes.at(-1).e)
      }
    }
    return {
      ok: this.channels.size > 0 && last > Date.now(),
      channels: this.channels.size, programmes: progs,
      loadedAt: this.loadedAt, coverageFrom: Number.isFinite(first) ? first : 0, coverageTo: last,
      lastError: this.lastError,
    }
  }
}
