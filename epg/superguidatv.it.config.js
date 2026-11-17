// Parser aggiornato per superguidatv.it (il sito è stato riscritto in Qwik e lo
// scraper upstream di iptv-org/epg non trova più i programmi). Montato nel
// container al posto del config originale, vedi docker-compose.yml.
const cheerio = require('cheerio')
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')
dayjs.extend(utc)
dayjs.extend(timezone)

module.exports = {
  site: 'superguidatv.it',
  days: 3,
  url({ channel, date }) {
    const diff = date.diff(dayjs().utc().startOf('day'), 'd')
    const day = { 0: 'oggi', 1: 'domani', 2: 'dopodomani' }[diff]
    return `https://www.superguidatv.it/programmazione-canale/${day}/guida-programmi-tv-${channel.site_id}/`
  },
  parser({ content, date }) {
    const $ = cheerio.load(content)
    const rows = []
    $('p.sgtv-w-20').each((_, el) => {
      const time = $(el).text().trim()
      if (!/^\d{2}:\d{2}$/.test(time)) return
      const info = $(el).parent().next()
      const title = info.children('p').eq(0).text().trim()
      const meta = info.children('p').eq(1).text().trim()
      if (!title) return
      const dur = meta.match(/\((\d+)['’]\)/)
      rows.push({ time, title, category: meta.replace(/\s*\(\d+['’]\)\s*$/, '').trim(), dur: dur ? Number(dur[1]) : null })
    })

    const programs = []
    let day = date
    let prev = null
    for (const r of rows) {
      let start = dayjs.tz(`${day.format('YYYY-MM-DD')} ${r.time}`, 'YYYY-MM-DD HH:mm', 'Europe/Rome').utc()
      if (prev && start.isBefore(prev.start)) { day = day.add(1, 'day'); start = start.add(1, 'day') }
      if (prev && !prev.stop) prev.stop = start
      const p = { title: r.title, category: r.category || null, start, stop: r.dur ? start.add(r.dur, 'minute') : null }
      programs.push(p)
      prev = p
    }
    for (const p of programs) if (!p.stop) p.stop = p.start.add(30, 'minute')
    return programs
  },
}
