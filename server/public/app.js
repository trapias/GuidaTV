// Guida TV – frontend senza dipendenze né build.
const $ = s => document.querySelector(s)
const main = $('#main'), chipsEl = $('#chips'), qEl = $('#q'), sheet = $('#sheet'), statusEl = $('#status')

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('gtv.' + k)) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem('gtv.' + k, JSON.stringify(v)) } catch {} },
}
const state = {
  channels: [], byId: new Map(), nowData: {},
  favs: new Set(store.get('favs', [])),
  view: store.get('view', 'now'),
  group: store.get('group', 'Tutti'),
  day: 0,
  query: '',
  player: { mode: /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'scheme' : 'm3u', tpl: 'vlc://{url}', ...store.get('player', {}) },
}
let timers = []

// ---------- util ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (v === true) el.setAttribute(k, '')
    else if (v !== false && v != null) el.setAttribute(k, v)
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid))
  return el
}
const api = async path => {
  const r = await fetch('/api/' + path)
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}
const fmt = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
const fmtDay = ms => new Date(ms).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })
const dayStart = off => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + off); return d.getTime() }
const hue = s => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) % 360; return x }
const initials = n => n.replace(/[^\p{L}\p{N} +!]/gu, '').split(/\s+/).filter(Boolean).slice(0, 3).map(w => w[0]).join('').toUpperCase()
const lcnBadge = ch => ch.lcn ? h('span', { class: 'lcn', title: 'Numero sul telecomando (digitale terrestre)' }, ch.lcn) : null
function logo(ch) {
  const badge = h('div', { class: 'logo', 'aria-hidden': 'true', style: `background:hsl(${hue(ch.name)} 55% 42%)` }, initials(ch.name))
  if (!ch.logo) return badge
  return h('img', {
    class: 'logo channel-image',
    alt: '',
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
    onerror: e => e.currentTarget.replaceWith(badge),
    src: ch.logo,
  })
}
let statusT
const showStatus = (msg, ms = 0) => {
  statusEl.textContent = msg; statusEl.hidden = !msg
  clearTimeout(statusT); if (msg && ms) statusT = setTimeout(() => { statusEl.hidden = true }, ms)
}
const clear = () => { timers.forEach(clearInterval); timers = []; main.replaceChildren() }

function toggleFav(id) {
  state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id)
  store.set('favs', [...state.favs])
  renderChips()
  if (state.group === 'Preferiti' && !state.favs.size) setGroup('Tutti')
}
const starBtn = ch => {
  const b = h('button', { class: 'star' + (state.favs.has(ch.id) ? ' on' : ''), 'aria-label': 'Preferito', title: 'Preferito' }, state.favs.has(ch.id) ? '★' : '☆')
  b.addEventListener('click', e => {
    e.stopPropagation(); toggleFav(ch.id)
    const on = state.favs.has(ch.id); b.classList.toggle('on', on); b.textContent = on ? '★' : '☆'
    if (state.group === 'Preferiti') render()
  })
  return b
}

// ---------- player esterno ----------
const MODES = {
  m3u: 'Scarica .m3u (si apre col player associato, es. VLC)',
  scheme: 'Schema URL personalizzato (es. vlc:// su iOS/Android)',
  copy: 'Copia l\'indirizzo dello stream',
}
const savePlayer = () => store.set('player', state.player)
async function play(ch) {
  if (ch.web) { // link ufficiale (app RaiPlay su iPhone via universal link, o sito): non serve il player esterno
    const a = h('a', { href: ch.web, target: '_blank', rel: 'noopener' }); document.body.append(a); a.click(); a.remove(); return
  }
  const { mode, tpl } = state.player
  try {
    if (mode === 'm3u') {
      const a = h('a', { href: `/api/play.m3u?c=${encodeURIComponent(ch.id)}`, download: `${ch.id}.m3u` })
      document.body.append(a); a.click(); a.remove()
      return showStatus(`Apro ${ch.name} nel player…`, 3000)
    }
    const s = await api(`stream?c=${encodeURIComponent(ch.id)}`)
    if (mode === 'copy') {
      try { await navigator.clipboard.writeText(s.url) } catch { return prompt('Copia l\'indirizzo dello stream:', s.url) }
      return showStatus('Indirizzo copiato', 3000)
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(tpl) || /^(javascript|data|vbscript):/i.test(tpl)) return showStatus('Schema del player non valido (vedi ⚙)', 5000)
    location.href = tpl.replaceAll('{urlenc}', encodeURIComponent(s.url)).replaceAll('{url}', s.url).replaceAll('{name}', encodeURIComponent(s.name))
  } catch { showStatus('Stream non disponibile', 4000) }
}
const playBtn = ch => !ch.live ? null : ch.web
  ? h('a', { class: 'playb web', href: ch.web, target: '_blank', rel: 'noopener', 'aria-label': 'Guarda sul sito/app ufficiale',
      title: 'Apre l\'app o il sito ufficiale', onclick: e => e.stopPropagation() }, '↗')
  : h('button', { class: 'playb', 'aria-label': 'Guarda in diretta', title: 'Guarda in diretta nel player esterno',
      onclick: e => { e.stopPropagation(); play(ch) } }, '▶')

function openSettings() {
  const mode = h('select', { id: 'pmode' }, Object.entries(MODES).map(([v, l]) => h('option', { value: v, selected: v === state.player.mode }, l)))
  const tpl = h('input', { id: 'ptpl', type: 'text', value: state.player.tpl, spellcheck: 'false', autocapitalize: 'off', placeholder: 'vlc://{url}' })
  const row = h('label', { class: 'frow' }, 'Schema', tpl, h('small', {}, 'Segnaposto: {url} indirizzo, {urlenc} codificato, {name} nome canale.'))
  const sync = () => { row.hidden = mode.value !== 'scheme' }
  mode.addEventListener('change', sync); sync()
  const save = h('button', { class: 'btn pri', onclick: () => {
    state.player = { mode: mode.value, tpl: tpl.value.trim() || 'vlc://{url}' }; savePlayer(); sheet.close()
  } }, 'Salva')
  sheet.replaceChildren(h('div', { class: 'sh' }, h('h2', {}, 'Player esterno'),
    h('p', {}, 'Il pulsante ▶ compare sui canali con uno stream configurato sul server. Questa scelta vale solo per questo dispositivo.'),
    h('label', { class: 'frow' }, 'Come aprire lo stream', mode), row,
    h('div', { class: 'acts' }, save, h('button', { class: 'btn', onclick: () => sheet.close() }, 'Annulla'))))
  sheet.showModal()
}
$('#settings').addEventListener('click', openSettings)

// ---------- ordinamento ----------
const TOP = ['rai1', 'rai2', 'rai3', 'rete4', 'canale5', 'italia1', 'la7', 'tv8', 'nove', '20mediaset', 'rai4', 'iris', 'la5', 'rai5', 'raimovie', 'raipremium', 'cine34', 'focus', 'topcrime', 'boing', 'raigulp', 'raiyoyo', 'raistoria', 'raisport', 'la7d', 'mediasetextra', 'dmax', 'realtime', 'cielo', 'rainews24', 'skytg24', 'tgcom24']
const rank = c => { const i = TOP.indexOf(c.id); return i < 0 ? 1000 + Math.max(0, GROUP_ORDER.indexOf(c.group)) : i }
const byTelecomando = (a, b) => (a.lcn || 1e4) - (b.lcn || 1e4) || rank(a) - rank(b) || a.name.localeCompare(b.name, 'it', { numeric: true })

// ---------- filtri ----------
const GROUP_ORDER = ['Rai', 'Mediaset', 'Altri free', 'Sport', 'Cinema', 'Serie TV', 'News', 'Sky', 'Altri']
const PROGRAMME_FILTERS = new Map([
  ['Cinema', 'movie'],
  ['Serie TV', 'series'],
  ['News', 'news'],
])
function visibleChannels() {
  const { group } = state
  if (group === 'Tutti' || PROGRAMME_FILTERS.has(group)) return state.channels
  if (group === 'Preferiti') return state.channels.filter(c => state.favs.has(c.id))
  return state.channels.filter(c => c.group === group)
}
function renderChips() {
  const present = new Set(state.channels.map(c => c.group))
  const groups = ['Tutti', ...(state.favs.size ? ['Preferiti'] : []), ...GROUP_ORDER.filter(g => present.has(g) || PROGRAMME_FILTERS.has(g))]
  chipsEl.replaceChildren(...groups.map(g => h('button', {
    class: 'chip' + (g === state.group ? ' on' : ''),
    'aria-pressed': String(g === state.group),
    onclick: () => setGroup(g),
  }, g === 'Preferiti' ? '★ Preferiti' : g)))
}
function setGroup(g) { state.group = g; store.set('group', g); renderChips(); render() }

// ---------- vista: adesso ----------
async function viewNow() {
  const list = visibleChannels()
  if (!list.length) return main.append(h('div', { class: 'empty' }, 'Nessun canale in questo filtro.'))
  const type = PROGRAMME_FILTERS.get(state.group)
  const cards = h('div', { class: 'cards' })
  const empty = h('div', { class: 'empty', hidden: true }, 'Nessun programma di questo tipo in onda.')
  main.append(cards, empty)
  const draw = () => {
    const now = Date.now()
    const matches = []
    for (const ch of list) {
      const d = state.nowData[ch.id] || {}
      const cur = d.cur && d.cur[0] <= now && d.cur[1] > now ? d.cur : null
      if (type && cur?.[5] !== type) continue
      const next = cur ? d.next : (d.next || d.cur)
      const pct = cur ? Math.min(100, ((now - cur[0]) / (cur[1] - cur[0])) * 100) : 0
      matches.push(h('div', { class: 'card', onclick: () => cur ? openDetail(ch.id, cur[0]) : next && openDetail(ch.id, next[0]) },
        h('div', { class: 'head' }, lcnBadge(ch), logo(ch), h('span', { class: 'cname' }, ch.name), playBtn(ch), starBtn(ch)),
        cur ? [
          h('div', { class: 'ctitle' }, cur[2]),
          h('div', { class: 'csub' }, cur[3] || cur[4] || ' '),
          h('div', { class: 'bar-p' }, h('i', { style: `width:${pct}%` })),
          h('div', { class: 'times' }, h('span', {}, fmt(cur[0])), h('span', {}, `${Math.max(0, Math.round((cur[1] - now) / 60000))} min`), h('span', {}, fmt(cur[1]))),
        ] : h('div', { class: 'csub' }, 'Nessun dato in onda'),
        next && (!type || next[5] === type) && h('div', { class: 'next' }, h('b', {}, fmt(next[0])), ' ', next[2]),
      ))
    }
    cards.replaceChildren(...matches)
    empty.hidden = matches.length > 0
  }
  draw()
  timers.push(setInterval(async () => { try { state.nowData = await api('now'); draw() } catch {} }, 60000))
}

// ---------- vista: griglia ----------
const schedCache = new Map()
async function viewGrid() {
  const list = visibleChannels()
  const type = PROGRAMME_FILTERS.get(state.group)
  const days = h('div', { class: 'days' }, [0, 1, 2, 3].map(o => h('button', {
    class: 'chip' + (o === state.day ? ' on' : ''), onclick: () => { state.day = o; render() },
  }, o === 0 ? 'Oggi' : o === 1 ? 'Domani' : new Date(dayStart(o)).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' }))))
  main.append(days)
  if (!list.length) return main.append(h('div', { class: 'empty' }, 'Nessun canale in questo filtro.'))

  const from = dayStart(state.day), to = dayStart(state.day + 1)
  const key = `${from}`
  let sched = schedCache.get(key)
  if (!sched || Date.now() - sched.t > 5 * 60000) {
    sched = { t: Date.now(), data: await api(`schedule?from=${from}&to=${to}`) }
    schedCache.set(key, sched)
  }
  if (!days.isConnected) return
  const ppm = innerWidth < 600 ? 3 : 4, colW = innerWidth < 600 ? 92 : 150, laneW = 1440 * ppm
  const grid = h('div', { class: 'grid', style: `width:${colW + laneW}px` })
  const head = h('div', { class: 'ghead' }, h('div', { class: 'corner', style: `width:${colW}px` }),
    h('div', { class: 'lane', style: `width:${laneW}px` }, Array.from({ length: 24 }, (_, i) => h('div', { class: 'hour', style: `left:${i * 60 * ppm}px` }, `${String(i).padStart(2, '0')}:00`))))
  grid.append(head)
  const liveEls = []
  for (const ch of list) {
    const lane = h('div', { class: 'lane', style: `width:${laneW}px` })
    for (const [s, e, t, , , programmeType] of sched.data[ch.id] || []) {
      if (type && programmeType !== type) continue
      const l = (Math.max(s, from) - from) / 60000 * ppm
      const width = (Math.min(e, to) - Math.max(s, from)) / 60000 * ppm - 2
      if (!type && width < 3) continue
      const w = Math.max(3, width)
      const el = h('div', { class: 'prog', style: `left:${l}px;width:${w}px`, title: `${fmt(s)} ${t}`, onclick: () => openDetail(ch.id, s) },
        h('div', { class: 'pt' }, t), w > 70 && h('div', { class: 'ps' }, `${fmt(s)}–${fmt(e)}`))
      el.dataset.s = s; el.dataset.e = e; liveEls.push(el)
      lane.append(el)
    }
    if (type && !lane.childElementCount) continue
    grid.append(h('div', { class: 'grow' }, h('div', { class: 'gch', style: `width:${colW}px`, onclick: () => ch.live && play(ch), title: ch.live ? 'Guarda in diretta' : '' }, lcnBadge(ch), logo(ch), h('span', {}, ch.name), ch.live && h('i', { class: 'dot' })), lane))
  }
  if (type && !liveEls.length) return main.append(h('div', { class: 'empty' }, 'Nessun programma di questo tipo nel giorno selezionato.'))
  const wrap = h('div', { class: 'gridwrap' }, grid)
  main.append(wrap)

  const mark = () => {
    const now = Date.now()
    for (const el of liveEls) el.classList.toggle('live', +el.dataset.s <= now && +el.dataset.e > now)
    line?.style && (line.style.left = `${colW + (now - from) / 60000 * ppm}px`)
  }
  let line = null
  if (state.day === 0) { line = h('div', { class: 'nowline' }); grid.append(line); timers.push(setInterval(mark, 30000)) }
  mark()
  wrap.scrollLeft = Math.max(0, (state.day === 0 ? (Date.now() - from) / 60000 : 17.5 * 60) * ppm - 60)
}

// ---------- vista: ricerca ----------
let searchSeq = 0
async function viewSearch() {
  const seq = ++searchSeq
  const box = h('div', { class: 'results' }, h('div', { class: 'empty' }, 'Ricerca…'))
  main.append(box)
  let hits
  try { hits = await api(`search?q=${encodeURIComponent(state.query)}`) } catch { return showStatus('Ricerca non riuscita') }
  if (seq !== searchSeq) return
  if (!hits.length) return box.replaceChildren(h('div', { class: 'empty' }, `Nessun risultato per “${state.query}”.`))
  const out = []
  let lastDay = ''
  for (const r of hits) {
    const day = fmtDay(r.s)
    if (day !== lastDay) { out.push(h('div', { class: 'dayh' }, day)); lastDay = day }
    const ch = state.byId.get(r.c)
    out.push(h('div', { class: 'res', onclick: () => openDetail(r.c, r.s) },
      h('span', { class: 'rt' }, fmt(r.s)),
      h('div', { class: 'rm' }, h('div', { class: 'rn' }, r.t), h('div', { class: 'rc' }, [ch?.lcn && `${ch.lcn}`, ch?.name, r.sub || r.cat].filter(Boolean).join(' · ')))))
  }
  box.replaceChildren(...out)
}

// ---------- dettaglio ----------
async function openDetail(chId, s) {
  let p
  try { p = await api(`programme?c=${encodeURIComponent(chId)}&s=${s}`) } catch { return showStatus('Dettaglio non disponibile') }
  const ch = state.byId.get(chId)
  const close = h('button', { class: 'btn', onclick: () => sheet.close() }, 'Chiudi')
  const live = ch?.live && h('button', { class: 'btn', onclick: () => play(ch) }, ch.web ? '↗ Guarda sul sito/app ufficiale' : '▶ Guarda in diretta')
  const ics = h('button', { class: 'btn pri', onclick: () => downloadIcs(p, ch) }, 'Aggiungi al calendario')
  sheet.replaceChildren(h('div', { class: 'sh' },
    p.img && h('img', { src: p.img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: e => e.target.remove() }),
    h('h2', {}, p.t),
    p.sub && h('div', {}, p.sub),
    h('div', { class: 'meta' }, `${ch?.lcn ? ch.lcn + ' · ' : ''}${ch?.name ?? chId} · ${fmtDay(p.s)} · ${fmt(p.s)}–${fmt(p.e)}${p.cat ? ' · ' + p.cat : ''}`),
    p.desc && h('p', {}, p.desc),
    h('div', { class: 'acts' }, live, ics, close)))
  sheet.showModal()
}
sheet.addEventListener('click', e => { if (e.target === sheet) sheet.close() })

function downloadIcs(p, ch) {
  const z = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const esc = s => String(s || '').replace(/[\;,]/g, m => '\\' + m).replace(/\n/g, '\\n')
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GuidaTV//IT', 'BEGIN:VEVENT',
    `UID:${p.s}-${ch?.id}@guidatv`, `DTSTAMP:${z(Date.now())}`, `DTSTART:${z(p.s)}`, `DTEND:${z(p.e)}`,
    `SUMMARY:${esc(p.t)} (${esc(ch?.name)})`, `DESCRIPTION:${esc(p.desc)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', `DESCRIPTION:${esc(p.t)}`, 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  const a = h('a', { href: URL.createObjectURL(new Blob([body], { type: 'text/calendar' })), download: 'programma.ics' })
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

// ---------- regia ----------
async function render() {
  clear()
  try {
    if (state.query.length >= 2) await viewSearch()
    else if (state.view === 'grid') await viewGrid()
    else await viewNow()
  } catch (e) { console.error(e); showStatus('Errore nel caricamento dei dati') }
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  state.view = b.dataset.view; store.set('view', state.view)
  qEl.value = ''; state.query = ''
  syncTabs(); render()
}))
const syncTabs = () => document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === state.view))
let deb
qEl.addEventListener('input', () => {
  clearTimeout(deb)
  deb = setTimeout(() => { state.query = qEl.value.trim(); render() }, 250)
})
qEl.addEventListener('keydown', e => { if (e.key === 'Escape') { qEl.value = ''; state.query = ''; render() } })

async function init() {
  syncTabs()
  main.append(h('div', { class: 'empty' }, 'Caricamento…'))
  try {
    const [channels, nowData, health] = await Promise.all([api('channels'), api('now'), api('health')])
    state.channels = channels.filter(c => c.n > 0).sort(byTelecomando)
    state.byId = new Map(state.channels.map(c => [c.id, c]))
    state.nowData = nowData
    if (!state.channels.length) {
      main.replaceChildren(h('div', { class: 'empty' }, 'La guida non è ancora pronta: il primo download può richiedere qualche minuto. Riprova tra poco.'))
      return setTimeout(init, 20000)
    }
    if (state.group === 'Preferiti' && !state.favs.size) state.group = 'Tutti'
    if (!health.ok) showStatus('Attenzione: la guida non è aggiornata')
    renderChips(); render()
  } catch (e) {
    console.error(e); main.replaceChildren(h('div', { class: 'empty' }, 'Server non raggiungibile.')); setTimeout(init, 15000)
  }
}
// al ritorno sulla scheda riallinea i dati "adesso"
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.channels.length) { try { state.nowData = await api('now'); if (!sheet.open) render() } catch {} }
})
init()
