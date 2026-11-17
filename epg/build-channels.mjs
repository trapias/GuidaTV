// Unisce i channels.xml delle sorgenti italiane di iptv-org/epg in un unico
// channels.xml senza duplicati. Priorità: Rai > Mediaset > Sky > Superguida.
// Uso: node epg/build-channels.mjs   (scarica i file da GitHub)
import { writeFileSync } from 'node:fs'

const RAW = 'https://raw.githubusercontent.com/iptv-org/epg/master/sites'
const SOURCES = ['raiplay.it', 'mediasetinfinity.mediaset.it', 'guidatv.sky.it', 'superguidatv.it']
const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const keyOf = name =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\+\s*24/g, 'plus24').replace(/\+\s*1/g, 'plus1')
    .replace(/\b(hd|4k|dtt|sd)\b/g, '').replace(/hd-?\d*$/, '')
    .replace(/[^a-z0-9]/g, '')

// Canali che non interessano (radio, shopping, estero in altre lingue, DAZN a pagamento...)
const EXCLUDE = /radio|^rtl 102|virgin|^r101|monte carlo|^qvc|value 24|raiplay|al jazeera|nhk|france 24|bbc world|^cnn|^fox (news|business)|bloomberg|i24|russia today|euronews|^sky sport (uno|arena)?$/i

const seen = new Map()
for (const site of SOURCES) {
  const xml = await (await fetch(`${RAW}/${site}/${site}.channels.xml`)).text()
  for (const m of xml.matchAll(/<channel ([^>]*)>([^<]*)<\/channel>/g)) {
    const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], decode(a[2])]))
    let name = decode(m[2]).trim()
    if (site === 'guidatv.sky.it' && /^sky sport$/i.test(name)) {
      const n = attrs.xmltv_id.match(/SkySport(\d+)/)
      if (n) name = `Sky Sport ${n[1]}`
    }
    if (EXCLUDE.test(name) && !/^sky sport (uno|arena)$/i.test(name)) continue
    const key = keyOf(name)
    if (!key || seen.has(key)) continue
    seen.set(key, { site, site_id: attrs.site_id, lang: attrs.lang || 'it', name: name.replace(/\s+HD\b/i, '').trim(), key })
  }
}

const rows = [...seen.values()]
  .sort((a, b) => a.name.localeCompare(b.name, 'it'))
  .map(c => `  <channel site="${c.site}" site_id="${esc(c.site_id)}" lang="${c.lang}" xmltv_id="${c.key}">${esc(c.name)}</channel>`)
writeFileSync(new URL('./channels.xml', import.meta.url), `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${rows.join('\n')}\n</channels>\n`)
const bySite = {}
for (const c of seen.values()) bySite[c.site] = (bySite[c.site] || 0) + 1
console.log(rows.length, 'canali', bySite)
