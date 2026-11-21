import { XMLParser } from 'fast-xml-parser'
import { programmeType } from './programme-type.js'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#t',
  isArray: name => name === 'channel' || name === 'programme',
  processEntities: true,
})

// "20261116234600 +0000" -> epoch ms
export function parseTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])?(\d{2})?(\d{2})?/.exec(s || '')
  if (!m) return NaN
  const [, Y, Mo, D, H, Mi, S = '0', sign, oh = '00', om = '00'] = m
  const off = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60000
  return Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S) - off
}

const text = v => (v == null ? '' : typeof v === 'object' ? (Array.isArray(v) ? text(v[0]) : (v['#t'] ?? '')) : String(v)).toString().trim()

function episodeNumber(values) {
  for (const entry of Array.isArray(values) ? values : [values]) {
    if (entry?.['@system'] !== 'xmltv_ns') continue
    const [season, episode, part] = text(entry).split('.').map(field => field.split('/')[0].trim())
    if (/^\d+$/.test(season ?? '') && /^\d+$/.test(episode ?? '')) {
      return [Number(season) + 1, Number(episode) + 1, part && Number(part) + 1].filter(Boolean).join('.')
    }
  }
  for (const entry of Array.isArray(values) ? values : [values]) {
    if (entry?.['@system'] !== 'onscreen') continue
    const match = /^(?:S(\d+)\s*E(\d+)|(\d+)\s*x\s*(\d+))$/i.exec(text(entry))
    if (match) return [Number(match[1] ?? match[3]), Number(match[2] ?? match[4])].join('.')
  }
  return null
}

function channelLogo(icon) {
  for (const entry of Array.isArray(icon) ? icon : [icon]) {
    const src = entry?.['@src']
    if (typeof src !== 'string') continue
    const url = URL.parse(src)
    if (url?.protocol === 'https:' || url?.protocol === 'http:') return url.href
  }
  return null
}

// Raggruppamento per i filtri della UI, dedotto dal nome del canale.
export function groupOf(name) {
  const n = name.toLowerCase()
  if (/^rai\b|^rai ?(news|sport)|^italiana/.test(n)) return 'Rai'
  if (/canale 5|italia ?[12]|rete 4|20 mediaset|iris|la ?5|mediaset|focus|top ?crime|tgcom|cine34|boing|cartoonito|27|twenty/.test(n)) return 'Mediaset'
  if (/^la7|tv8|^nove|^real time|^dmax|^discovery|^cielo|^warner|^giallo|^k2|^frisbee|^food|^hgtv|^motor|^rt doc|^tv2000|^sportitalia|^super!?$|^supertennis|^deejay|^mtv|^vh1|^comedy|^paramount|^nick|^cartoon network|^boomerang|^dea|^history|^nat|^eurosport|^dazn/.test(n)) return 'Altri free'
  if (/^sky (sport|calcio)|^dazn|^eurosport|supertennis|^aci|^top calcio|^milan tv|^inter tv|^lazio/.test(n)) return 'Sport'
  if (/^sky cinema|^premium cinema|^primafila|^premium (action|crime|stories)/.test(n)) return 'Cinema'
  if (/^sky tg24|news|^sky news|^class|^cnbc|^tgcom/.test(n)) return 'News'
  if (/^sky /.test(n)) return 'Sky'
  return 'Altri'
}

export function parseXmltv(xml) {
  const doc = parser.parse(xml)
  const tv = doc.tv || {}
  const channels = new Map()
  for (const c of tv.channel || []) {
    const id = c['@id']
    if (!id) continue
    const name = text(c['display-name']) || id
    channels.set(id, { id, name, group: groupOf(name), logo: channelLogo(c.icon), programmes: [] })
  }
  for (const p of tv.programme || []) {
    const ch = channels.get(p['@channel'])
    if (!ch) continue
    const s = parseTime(p['@start'])
    const e = parseTime(p['@stop'])
    const t = text(p.title)
    if (!t || Number.isNaN(s) || Number.isNaN(e) || e <= s) continue
    const categories = (Array.isArray(p.category) ? p.category : [p.category]).map(text).filter(Boolean)
    const releaseYear = /^((?:18|19|20|21)\d{2})(?:\d{2}(?:\d{2})?)?$/.exec(text(p.date))?.[1]
    ch.programmes.push({
      s, e, t,
      sub: text(p['sub-title']),
      episode: episodeNumber(p['episode-num']),
      cat: categories[0] || '',
      type: programmeType(ch.id, t, categories),
      releaseYear: releaseYear ? Number(releaseYear) : null,
      desc: text(p.desc),
      img: text(p.image),
    })
  }
  for (const ch of channels.values()) {
    ch.programmes.sort((a, b) => a.s - b.s)
    // elimina duplicati esatti (stesso inizio)
    ch.programmes = ch.programmes.filter((p, i, a) => i === 0 || p.s !== a[i - 1].s)
  }
  return channels
}
