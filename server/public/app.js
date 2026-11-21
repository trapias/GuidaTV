// Guida TV – frontend senza dipendenze né build.
const $ = s => document.querySelector(s)
const main = $('#main'), chipsEl = $('#chips'), qEl = $('#q'), sheet = $('#sheet'), statusEl = $('#status')
const isMac = /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints < 2

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('gtv.' + k)) ?? d } catch { return d } },
  set(k, v) { try { localStorage.setItem('gtv.' + k, JSON.stringify(v)) } catch {} },
}
const state = {
  channels: [], recordableChannels: [], byId: new Map(), nowData: {},
  favs: new Set(store.get('favs', [])),
  view: store.get('view', 'now'),
  group: store.get('group', 'Tutti'),
  day: 0, recordingEnabled: false, epgRefreshEnabled: false, browserPlayer: false,
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
const api = async (path, options) => {
  const r = await fetch('/api/' + path, options)
  const data = await r.json()
  if (!r.ok) throw Object.assign(new Error(data?.error || `${path}: HTTP ${r.status}`), { data })
  return data
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
const clickLink = props => {
  const a = h('a', props)
  document.body.append(a); a.click(); a.remove()
}
function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  clickLink({ href: url, download: filename })
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
async function openPlayer(name, playlist, stream, report = showStatus) {
  const { mode, tpl } = state.player
  try {
    if (mode === 'm3u') {
      playlist()
      return report(`Apro ${name} nel player…`, 3000)
    }
    const s = typeof stream === 'function' ? await stream() : stream
    if (mode === 'copy') {
      try { await navigator.clipboard.writeText(s.url) } catch { return prompt('Copia l\'indirizzo:', s.url) }
      return report('Indirizzo copiato', 3000)
    }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(tpl) || /^(javascript|data|vbscript):/i.test(tpl)) return report('Schema del player non valido (vedi ⚙)', 5000)
    location.href = tpl.replaceAll('{urlenc}', encodeURIComponent(s.url)).replaceAll('{url}', s.url).replaceAll('{name}', encodeURIComponent(s.name))
  } catch { report('Riproduzione non disponibile', 4000) }
}
function play(ch) {
  if (ch.web) return clickLink({ href: ch.web, target: '_blank', rel: 'noopener' })
  const channel = encodeURIComponent(ch.id)
  return openPlayer(ch.name, () => clickLink({ href: `/api/play.m3u?c=${channel}`, download: `${ch.id}.m3u` }),
    () => api(`stream?c=${channel}`))
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
  const recordingSource = isMac && h('select', { id: 'mac-recording-source' },
    h('option', { value: 'finder', selected: !state.player.macSmb }, 'Cartella montata nel Finder'),
    h('option', { value: 'smb', selected: state.player.macSmb }, 'Indirizzo SMB'))
  const folder = isMac && h('input', { type: 'text', value: state.player.macFolder || '', placeholder: '/Volumes/TV',
    spellcheck: 'false', autocapitalize: 'off', pattern: '/.*' })
  const sourceRow = isMac && h('label', { class: 'frow' }, 'Playlist delle registrazioni su Mac', recordingSource)
  const folderRow = isMac && h('label', { class: 'frow' }, 'Percorso del volume montato (facoltativo)', folder,
    h('small', {}, 'Monta la condivisione nel Finder. Lascia vuoto per usare il suo nome sotto /Volumes.'))
  const sync = () => {
    row.hidden = mode.value !== 'scheme'
    if (isMac) {
      sourceRow.hidden = mode.value !== 'm3u'
      folderRow.hidden = sourceRow.hidden || recordingSource.value === 'smb'
    }
  }
  mode.addEventListener('change', sync)
  recordingSource && recordingSource.addEventListener('change', sync)
  sync()
  const save = h('button', { class: 'btn pri', onclick: () => {
    if (folder && !folderRow.hidden && !folder.reportValidity()) return
    state.player = { ...state.player, mode: mode.value, tpl: tpl.value.trim() || 'vlc://{url}' }
    if (isMac) {
      state.player.macSmb = recordingSource.value === 'smb'
      state.player.macFolder = folder.value.trim()
    }
    savePlayer()
    sheet.close()
  } }, 'Salva')
  const guideRefresh = state.epgRefreshEnabled && guideRefreshControl()
  sheet.replaceChildren(h('div', { class: 'sh' }, h('h2', {}, 'Impostazioni'),
    h('p', {}, 'Questa scelta vale per le dirette e le registrazioni su questo dispositivo.'),
    h('label', { class: 'frow' }, 'Come aprire lo stream', mode), row, sourceRow, folderRow,
    h('div', { class: 'acts' }, save, h('button', { class: 'btn', onclick: () => sheet.close() }, 'Annulla')),
    guideRefresh, h('button', { class: 'btn', onclick: openSetup }, 'Verifica configurazione')))
  sheet.showModal()
}
$('#settings').addEventListener('click', openSettings)

function openSetup() {
  const status = h('div', { class: 'meta', role: 'status' }, 'Controllo configurazione…')
  const info = h('dl', { class: 'setup-info' })
  const test = h('button', { class: 'btn', disabled: true, onclick: () => load('POST') }, 'Prova scrittura sul NAS')
  async function load(method) {
    test.disabled = true
    if (method === 'POST') status.textContent = 'Prova di scrittura in corso…'
    try {
      const { guide, recording, nas, freeBytes, player, playerConfigured, channels } = await api('setup', { method })
      const date = time => new Date(time).toLocaleString('it-IT')
      const rows = [
        ['Guida TV', guide.loadedAt
          ? `${guide.ok ? 'Disponibile' : 'Ultima copia disponibile'} · ${guide.channels} canali · ${date(guide.loadedAt)}`
          : 'In attesa del primo palinsesto'],
        ['Aggiornamento su richiesta', guide.refreshEnabled ? 'Disponibile' : 'Disattivato'],
        ['Scrittura sul NAS', !recording ? 'Registrazioni disattivate' : nas
          ? `${nas.ok ? 'Riuscita' : 'Fallita: controlla condivisione, credenziali e permessi'} · ${date(nas.at)}` : 'Da verificare'],
        ['Spazio locale', freeBytes == null ? 'Non disponibile' : `${(freeBytes / 2 ** 30).toLocaleString('it-IT', { maximumFractionDigits: 1 })} GiB liberi`],
        ['Player nel browser', player ? 'Attivo, con password' : playerConfigured ? 'Controlla il file browser.password' : 'Disattivato'],
      ]
      const names = channels.sort((a, b) => (a.lcn || Infinity) - (b.lcn || Infinity) || a.name.localeCompare(b.name, 'it'))
        .map(ch => ch.lcn ? `${ch.lcn} ${ch.name}` : ch.name)
      info.replaceChildren(...rows.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)]),
        h('dt', {}, `Canali registrabili (${names.length})`), h('dd', {}, names.join(' · ') || 'Nessuno'))
      status.textContent = ''
      test.disabled = !recording
    } catch (error) {
      status.textContent = error.message
      test.disabled = false
    }
  }
  sheet.replaceChildren(h('div', { class: 'sh' }, h('h2', {}, 'Verifica configurazione'), status, info, test,
    h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: openSettings }, 'Indietro'))))
  load('GET')
}

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
let appliedGuide
function guideRefreshControl(onComplete) {
  const progress = h('progress', { hidden: true, 'aria-label': 'Avanzamento aggiornamento guida' })
  const message = h('div', { class: 'meta', role: 'status' })
  const report = text => { if (text !== message.textContent) message.textContent = text }
  const button = h('button', { class: 'btn', disabled: true, onclick: () => track('POST') }, 'Aggiorna guida')
  const options = () => ({ cache: 'no-store', signal: AbortSignal.timeout(10000) })
  const read = method => api('epg/refresh', { ...options(), method })

  async function track(method) {
    button.disabled = true
    if (method === 'POST') {
      progress.hidden = false
      progress.removeAttribute('value')
      report('Preparo l’aggiornamento della guida…')
    }
    try {
      let job = await read(method)
      let failures = 0
      while (job.status === 'running') {
        if (!button.isConnected || !sheet.open) return
        progress.hidden = false
        const { done, total } = job.progress || {}
        if (total > 0) {
          progress.max = total
          progress.value = done
          if (!failures) report(done < total ? `Elaborate ${done} richieste di palinsesto su ${total}.` : 'Salvo e carico la guida aggiornata…')
        } else if (!failures) {
          progress.removeAttribute('value')
          report('Preparo lo scaricamento dei palinsesti…')
        }
        await new Promise(resolve => setTimeout(resolve, 2000))
        if (!button.isConnected || !sheet.open) return
        try {
          job = await read('GET')
          failures = 0
        } catch (error) {
          if (++failures >= 3) throw error
          report('Connessione interrotta. Verifico di nuovo lo stato…')
        }
      }
      if (!button.isConnected || !sheet.open) return
      if (job.status === 'error') return report(job.error)
      if (job.status !== 'complete') return
      if (job.startedAt !== appliedGuide) {
        report('Carico la guida aggiornata…')
        await loadGuideData(options())
        appliedGuide = job.startedAt
        schedCache.clear()
        renderChips()
        render()
      }
      onComplete?.()
      report(job.updated ? 'Guida aggiornata.' : 'Guida verificata.')
    } catch (err) {
      report(err.data?.error || 'Impossibile verificare l’aggiornamento. Riprova tra poco.')
    } finally {
      progress.hidden = true
      button.disabled = false
    }
  }
  queueMicrotask(() => track('GET'))
  return h('div', { class: 'guide-refresh' }, button, progress, message)
}

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

// ---------- registrazioni ----------
const recordingLabels = {
  scheduled: 'Programmata', recording: 'In registrazione', waiting: 'In attesa di trasferimento',
  saved: 'Salvata sul NAS', failed: 'Registrazione fallita',
}
const recordingStatus = job => [
  job.archiveVerified === false ? 'NAS non verificabile' :
    job.status === 'recording' && job.stoppedAt != null ? 'Chiusura in corso' : recordingLabels[job.status],
  job.partial && 'Parziale', job.error,
].filter(Boolean).join(' · ')
const captureTime = (time, reference) => new Date(time).toDateString() === new Date(reference).toDateString()
  ? fmt(time) : `${fmtDay(time)} alle ${fmt(time)}`
const captureWindow = (from, to, reference) => `${captureTime(from, reference)} – ${captureTime(to, reference)}`
function recordingTime(job) {
  if (job.stoppedAt != null) return `Stop richiesto alle ${captureTime(job.stoppedAt, job.start)}`
  if (job.status === 'scheduled' || job.status === 'recording') {
    return `Cattura prevista ${captureWindow(job.captureFrom, job.captureTo, job.start)}`
  }
}
function recordingMetrics(job) {
  const parts = []
  if (job.durationMs >= 1000) {
    const seconds = Math.round(job.durationMs / 1000)
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor(seconds / 60) % 60
    parts.push(`Video ${[hours && `${hours} h`, minutes && `${minutes} min`, seconds % 60 && `${seconds % 60} s`].filter(Boolean).join(' ')}`)
  }
  if (job.bytes > 0) {
    const size = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 })
    const gb = job.bytes >= 1000000000
    parts.push(`${size.format(job.bytes / (gb ? 1000000000 : 1000000))} ${gb ? 'GB' : 'MB'}`)
  }
  if (job.status === 'waiting' && job.uploadAfter > Date.now()) {
    parts.push(`Nuovo tentativo dalle ${captureTime(job.uploadAfter, Date.now())}`)
  }
  return parts.join(' · ')
}
const cancelRecording = job => api(`recordings?id=${encodeURIComponent(job.id)}`, { method: 'DELETE' })
const stopRecording = job => api(`recordings?action=stop&id=${encodeURIComponent(job.id)}`, { method: 'POST' })
async function extendRecording(job, minutes) {
  const query = new URLSearchParams({ action: 'extend', id: job.id, until: job.captureTo, minutes })
  const request = () => api(`recordings?${query}`, { method: 'POST' })
  try { return await request() } catch (error) {
    const { conflicts, limit } = error.data || {}
    if (!conflicts) throw error
    const titles = conflicts.map(other => other.title).join(', ')
    if (!confirm(`L’estensione supererebbe il limite di ${limit} registrazioni contemporanee. In sovrapposizione: ${titles}. Vuoi estendere comunque?`)) return
    query.set('confirm', conflicts.map(other => other.id).sort().join(','))
    return request()
  }
}
const watchRecording = job => {
  const query = new URLSearchParams({ action: 'watch', id: job.id, enabled: job.watchGuide ? 0 : 1 })
  return api(`recordings?${query}`, { method: 'PATCH' })
}
function recordingPlaylistUrl(playUrl) {
  if (!isMac || state.player.macSmb) return playUrl
  const path = new URL(playUrl).pathname
  if (!state.player.macFolder) return `file:///Volumes${path}`
  const folder = state.player.macFolder.replace(/\/+$/, '').split('/').map(encodeURIComponent).join('/')
  return `file://${folder}${path.slice(path.lastIndexOf('/'))}`
}

const recordingPlay = (job, report) => job?.playUrl && h('button', {
  class: 'btn', 'aria-label': `Riproduci ${job.title}`, onclick: () => {
    const name = job.title.replace(/[\r\n]+/g, ' ')
    return openPlayer(name, () => downloadFile(`registrazione-${job.id.slice(0, 8)}.m3u`,
      `#EXTM3U\n#EXTINF:-1,${name}\n${recordingPlaylistUrl(job.playUrl)}\n`, 'audio/x-mpegurl;charset=utf-8'), { name, url: job.playUrl }, report)
  },
}, '▶ Riproduci')

function recordingBrowserButton(job, onOpen) {
  return state.browserPlayer && job?.status === 'saved' && job.archiveVerified && /\.mp4$/i.test(job.filename) &&
    h('button', { class: 'btn', onclick: e => onOpen(e.currentTarget) }, '▶ Nel browser')
}

function recordingPlayerView(job, onBack) {
  const feedback = h('p', { class: 'meta', role: 'status' }, 'Verifico l’accesso al player…')
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password' })
  const video = h('video', { class: 'recording-video', controls: true, playsinline: true, preload: 'metadata', hidden: true,
    onerror: () => { if (video.hasAttribute('src')) feedback.textContent = 'Video non disponibile o formato audio/video non supportato dal browser.' } })
  const stop = () => { video.removeAttribute('src'); video.load() }
  function showVideo() {
    if (!video.isConnected || !sheet.open) return
    form.hidden = true
    video.hidden = false
    video.src = `/api/recordings/media?id=${encodeURIComponent(job.id)}`
    feedback.textContent = ''
  }
  const submit = h('button', { class: 'btn pri', type: 'submit' }, 'Accedi')
  const form = h('form', { class: 'recording-form', hidden: true, onsubmit: async e => {
    e.preventDefault()
    submit.disabled = true
    try {
      await api('recordings/player', { method: 'POST', headers: { 'X-Playback-Password': encodeURIComponent(password.value) } })
      password.value = ''
      showVideo()
    } catch (error) { feedback.textContent = error.message } finally { submit.disabled = false }
  } }, h('label', { class: 'frow' }, 'Password del player web', password), submit)
  sheet.addEventListener('close', stop, { once: true })
  api('recordings/player').then(session => {
    if (session.authenticated) showVideo()
    else {
      form.hidden = false
      feedback.textContent = ''
      if (password.isConnected) password.focus()
    }
  }).catch(error => { feedback.textContent = error.message })
  return [feedback, video, form, h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => {
    sheet.removeEventListener('close', stop)
    stop()
    onBack()
  } }, 'Indietro'))]
}
const recordingOrder = { recording: 0, waiting: 1, scheduled: 2, saved: 3, failed: 3 }
const RECORDINGS_PER_PAGE = 10
let recordingTimer
let recordingDialogOpen = false
let badgeRequest
function refreshRecordingBadge() {
  badgeRequest ||= api('recordings?view=outcomes').then(outcomes => {
    const ids = outcomes.map(row => row.id)
    if (recordingDialogOpen) store.set('recordingOutcomes', ids)
    const seen = new Set(store.get('recordingOutcomes', []))
    const count = ids.filter(id => !seen.has(id)).length
    const button = $('#recordings')
    button.textContent = count ? `Registrazioni (${count})` : 'Registrazioni'
    button.setAttribute('aria-label', count ? `Registrazioni, ${count} nuovi avvisi` : 'Registrazioni')
  }).catch(() => {}).finally(() => { badgeRequest = null })
}
function openRecordings() {
  const list = h('div', { class: 'results recording-list' }, 'Caricamento…')
  const message = h('div', { class: 'meta', role: 'status', hidden: true })
  const report = text => { message.textContent = text; message.hidden = !text }
  let jobs
  let page = 0
  let pending
  const search = h('input', {
    class: 'recording-search', type: 'search', placeholder: 'Cerca titolo o canale',
    'aria-label': 'Cerca titolo o canale', hidden: true,
    oninput: () => { page = 0; draw() },
  })
  const previous = h('button', { class: 'btn', onclick: () => changePage(-1) }, 'Precedente')
  const next = h('button', { class: 'btn', onclick: () => changePage(1) }, 'Successiva')
  const pageLabel = h('span', { class: 'meta', 'aria-live': 'polite' })
  const pages = h('div', { class: 'recording-pages', hidden: true }, previous, pageLabel, next)
  function changePage(direction) {
    page += direction
    draw()
    list.scrollTop = 0
  }
  function action(job, label, request) {
    return h('button', { class: 'btn', onclick: async e => {
      const button = e.currentTarget
      button.disabled = true
      try {
        await request(job)
        report('')
        await pending
        await load()
      } catch (err) { report(err.message) } finally { button.disabled = false }
    } }, label)
  }
  function pane(title, source, render) {
    const closeEditor = () => {
      editor.remove()
      panel.hidden = false
      const target = source.isConnected ? source : close
      target.focus()
    }
    const heading = h('h2', { tabindex: '-1' }, title)
    const editor = h('div', { class: 'sh' }, heading, render(closeEditor))
    panel.hidden = true
    sheet.append(editor)
    heading.focus()
  }
  const saved = closeEditor => async () => {
    closeEditor()
    report('Prenotazione salvata')
    await pending
    await load()
  }
  function edit(job, source, useGuide = false) {
    const programme = useGuide ? job.guideChange : { s: job.start, e: job.end }
    const params = { id: job.id }
    if (useGuide) Object.assign(params, { guideStart: programme.s, guideEnd: programme.e })
    pane(useGuide ? 'Aggiorna dal palinsesto' : 'Modifica registrazione', source, onCancel => [
      h('p', {}, job.title),
      job.kind === 'manual' ? manualRecordingForm({ job, onCancel, onSaved: saved(onCancel) }) : recordingForm({
      programme,
      margins: { before: (job.start - job.captureFrom) / 60000, after: (job.captureTo - job.end) / 60000 },
      params, method: 'PATCH', label: 'Salva modifiche', confirmLabel: 'Salva comunque', onCancel, onSaved: saved(onCancel),
      }),
    ])
  }
  function openSeries(source) {
    pane('Serie seguite', source, closeEditor => {
      const results = h('div', { class: 'results' }, 'Caricamento…')
      const feedback = h('div', { class: 'meta', role: 'status' })
      const loadSeries = async () => {
        try {
          const rules = await api('recordings?view=series')
          results.replaceChildren(...(rules.length ? rules.map(rule => h('div', { class: 'res' },
            h('div', { class: 'rm' }, h('div', { class: 'rn' }, rule.title), h('div', { class: 'rc' }, rule.channelName)),
            h('button', { class: 'btn', onclick: async e => {
              const button = e.currentTarget
              button.disabled = true
              try {
                await api(`recordings?action=series&id=${encodeURIComponent(rule.id)}`, { method: 'DELETE' })
                feedback.textContent = 'Le puntate già in coda restano prenotate.'
                await loadSeries()
              } catch (err) { feedback.textContent = err.message } finally { button.disabled = false }
            } }, 'Smetti di seguire'),
          )) : [h('div', { class: 'empty' }, 'Nessuna serie seguita.')]))
        } catch (err) { results.textContent = err.message }
      }
      loadSeries()
      return [results, feedback, h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: closeEditor }, 'Indietro'))]
    })
  }
  function draw() {
    const query = search.value.trim().toLowerCase()
    const matches = jobs.filter(job => `${job.title} ${job.channelName}`.toLowerCase().includes(query))
    const pageCount = Math.max(1, Math.ceil(matches.length / RECORDINGS_PER_PAGE))
    page = Math.min(page, pageCount - 1)
    pages.hidden = pageCount === 1
    previous.disabled = page === 0
    next.disabled = page + 1 === pageCount
    pageLabel.textContent = `${page + 1} / ${pageCount}`
    search.hidden = jobs.length === 0 && !search.value

    const rows = matches.slice(page * RECORDINGS_PER_PAGE, (page + 1) * RECORDINGS_PER_PAGE)
    list.replaceChildren(...(rows.length ? rows.map(job => h('div', { class: 'res' },
      h('div', { class: 'rm' },
        h('div', { class: 'rn' }, job.title),
        h('div', { class: 'rc' }, `${job.channelName} · ${fmtDay(job.start)} · ${fmt(job.start)}–${fmt(job.end)}`),
        h('div', { class: 'rc' }, recordingStatus(job)),
        h('div', { class: 'rc' }, recordingTime(job)),
        h('div', { class: 'rc' }, recordingMetrics(job)),
        job.status === 'scheduled' && Boolean(job.watchGuide) && h('div', { class: 'rc' }, job.guideCheckedAt
          ? `Guida ricontrollata il ${fmtDay(job.guideCheckedAt)} alle ${fmt(job.guideCheckedAt)}`
          : 'Ricontrollo della guida prima della cattura'),
        job.guideChange && h('div', { class: 'rc' },
          `Nuovo orario in guida ${captureWindow(job.guideChange.s, job.guideChange.e, job.start)} · ${job.guideChange.covered ? 'Coperto dalla cattura' : 'Fuori dalla finestra di cattura'}`)),
      recordingPlay(job, report),
      recordingBrowserButton(job, source => pane(job.title, source, onBack => recordingPlayerView(job, onBack))),
      job.status === 'scheduled' && h('div', { class: 'recording-actions' },
        h('button', { class: 'btn', onclick: e => edit(job, e.currentTarget) }, 'Modifica'),
        job.guideChange && h('button', { class: 'btn', onclick: e => edit(job, e.currentTarget, true) }, 'Aggiorna prenotazione'),
        state.epgRefreshEnabled && job.kind === 'guide' && action(job, job.watchGuide ? 'Disattiva ricontrollo' : 'Ricontrolla guida', watchRecording),
        action(job, job.seriesId ? 'Salta puntata' : 'Annulla', cancelRecording)),
      job.status === 'failed' && action(job, 'Rimuovi', cancelRecording),
      job.status === 'recording' && job.stoppedAt == null && h('div', { class: 'recording-actions' },
        action(job, '+15 min', row => extendRecording(row, 15)), action(job, '+30 min', row => extendRecording(row, 30)),
        action(job, 'Ferma e salva', stopRecording)),
    )) : [h('div', { class: 'empty' }, query ? 'Nessun risultato.' : 'Nessuna registrazione.')]))
  }
  let lastResult
  const load = () => pending ||= api('recordings').then(result => {
    if (!list.isConnected || !sheet.open) return
    const snapshot = JSON.stringify(result)
    if (snapshot === lastResult) return
    lastResult = snapshot
    search.disabled = false
    jobs = result.sort((a, b) => recordingOrder[a.status] - recordingOrder[b.status] ||
      (a.status === 'scheduled' ? a.start - b.start : b.start - a.start))
    draw()
  }).catch(() => {
    if (list.isConnected && sheet.open) {
      lastResult = undefined
      search.disabled = true
      pages.hidden = true
      list.textContent = 'Registrazioni non disponibili.'
    }
  }).finally(() => { pending = null })
  const close = h('button', { class: 'btn', autofocus: true, onclick: () => sheet.close() }, 'Chiudi')
  const tools = h('div', { class: 'recording-tools' },
    h('button', { class: 'btn', onclick: e => pane('Registra per orario', e.currentTarget, onCancel =>
      manualRecordingForm({ onCancel, onSaved: saved(onCancel) })) }, 'Registra per orario'),
    h('button', { class: 'btn', onclick: e => openSeries(e.currentTarget) }, 'Serie seguite'))
  const guideRefresh = state.epgRefreshEnabled && guideRefreshControl(() => Promise.resolve(pending).then(load))
  const panel = h('div', { class: 'sh recordings-sheet' }, h('h2', {}, 'Registrazioni'), tools, guideRefresh, search, list, pages, message,
    h('div', { class: 'acts' }, close))
  sheet.replaceChildren(panel)
  sheet.showModal()
  recordingDialogOpen = true
  refreshRecordingBadge()
  load()
  clearInterval(recordingTimer)
  recordingTimer = setInterval(load, 5000)
}
$('#recordings').addEventListener('click', openRecordings)
sheet.addEventListener('close', () => {
  recordingDialogOpen = false
  clearInterval(recordingTimer)
})

function recordingForm({
  programme, margins, params, method = 'POST', label = 'Programma registrazione', confirmLabel = 'Programma comunque',
  onCancel, onSaved,
}) {
  const input = name => h('input', { type: 'number', name, min: '0', max: '60', step: '1', required: true, value: margins[name] })
  const before = input('before')
  const after = input('after')
  return bookingForm({
    controls: [before, after], method, label, confirmLabel, onCancel, onSaved,
    fields: h('div', { class: 'recording-margins' }, h('label', { class: 'frow' }, 'Minuti prima', before),
      h('label', { class: 'frow' }, 'Minuti dopo', after)),
    values: () => ({
      params: { ...params, before: before.valueAsNumber, after: after.valueAsNumber },
      from: programme.s - before.valueAsNumber * 60000, to: programme.e + after.valueAsNumber * 60000,
      reference: programme.s,
    }),
  })
}

function localDateTime(time) {
  const date = new Date(time)
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function manualRecordingForm({ job, onCancel, onSaved }) {
  const nextMinute = Math.ceil(Date.now() / 60000) * 60000
  const channel = !job && h('select', { required: true },
    h('option', { value: '' }, 'Scegli un canale'),
    state.recordableChannels.map(ch => h('option', { value: ch.id }, ch.name)))
  const start = h('input', { type: 'datetime-local', required: true, value: localDateTime(job?.start ?? nextMinute) })
  const end = h('input', { type: 'datetime-local', required: true, value: localDateTime(job?.end ?? nextMinute + 3600000) })
  const title = h('input', { type: 'text', maxlength: '120', value: job?.title || '', placeholder: 'Registrazione manuale' })
  return bookingForm({
    controls: [channel, start, end, title].filter(Boolean), method: job ? 'PATCH' : 'POST',
    label: job ? 'Salva modifiche' : 'Programma registrazione', confirmLabel: job ? 'Salva comunque' : 'Programma comunque',
    onCancel, onSaved,
    fields: [channel && h('label', { class: 'frow' }, 'Canale', channel),
      h('label', { class: 'frow' }, 'Titolo facoltativo', title),
      h('div', { class: 'recording-margins' }, h('label', { class: 'frow' }, 'Inizio', start),
        h('label', { class: 'frow' }, 'Fine', end))],
    values: () => {
      const s = new Date(start.value).getTime()
      const e = new Date(end.value).getTime()
      return {
        params: { action: 'manual', ...(job ? { id: job.id } : { c: channel.value }), s, e, title: title.value },
        from: s, to: e, reference: s,
      }
    },
  })
}

function bookingForm({ controls, fields, values, method, label, confirmLabel, onCancel, onSaved }) {
  const estimate = h('p', { class: 'meta' })
  const feedback = h('div', { class: 'recording-feedback', role: 'status', hidden: true })
  const submit = h('button', { class: 'btn pri', type: 'submit' }, label)
  const cancel = h('button', { class: 'btn', type: 'button', onclick: onCancel }, 'Indietro')
  let confirmation
  const refresh = () => {
    confirmation = undefined
    submit.textContent = label
    feedback.hidden = true
    const { from, to, reference } = values()
    estimate.textContent = from < to ? `Cattura prevista ${captureWindow(from, to, reference)}` : ''
  }
  const form = h('form', { class: 'recording-form', oninput: refresh, onsubmit: async e => {
    e.preventDefault()
    const { params, reference } = values()
    const q = new URLSearchParams(params)
    if (confirmation) q.set('confirm', confirmation)
    for (const control of [...controls, submit, cancel]) control.disabled = true
    try {
      const job = await api(`recordings?${q}`, { method })
      await onSaved(job)
    } catch (err) {
      feedback.hidden = false
      if (err.data?.conflicts) {
        const { conflicts, limit } = err.data
        confirmation = conflicts.map(job => job.id).sort().join(',')
        submit.textContent = confirmLabel
        feedback.replaceChildren(h('p', {}, `In alcuni orari supereresti il limite di ${limit} registrazioni in contemporanea.`),
          h('ul', {}, conflicts.map(job => h('li', {},
            `${job.title} · ${job.channelName} · ${captureWindow(job.captureFrom, job.captureTo, reference)}`))))
        feedback.scrollIntoView({ block: 'nearest' })
      } else {
        feedback.textContent = err.message
      }
    } finally {
      for (const control of [...controls, submit, cancel]) control.disabled = false
    }
  } },
    fields, estimate, feedback, h('div', { class: 'acts' }, cancel, submit))
  refresh()
  return form
}

// ---------- dettaglio ----------
async function openDetail(chId, s) {
  let p
  try { p = await api(`programme?c=${encodeURIComponent(chId)}&s=${s}`) } catch { return showStatus('Dettaglio non disponibile') }
  const ch = state.byId.get(chId)
  const close = h('button', { class: 'btn', onclick: () => sheet.close() }, 'Chiudi')
  const live = ch?.live && h('button', { class: 'btn', onclick: () => play(ch) }, ch.web ? '↗ Guarda sul sito/app ufficiale' : '▶ Guarda in diretta')
  const ics = h('button', { class: 'btn pri', onclick: () => downloadIcs(p, ch) }, 'Aggiungi al calendario')
  const status = h('div', { class: 'meta', role: 'status' }, p.recording && recordingStatus(p.recording))
  const capture = p.recording && recordingTime(p.recording)
  const timing = h('div', { class: 'meta', hidden: !capture }, capture)
  const series = p.recordingMargins && ch?.recordable && h('button', {
    class: 'btn', disabled: p.followingSeries, onclick: async e => {
      const button = e.currentTarget
      button.disabled = true
      try {
        const q = new URLSearchParams({ action: 'series', c: chId, s })
        await api(`recordings?${q}`, { method: 'POST' })
        button.textContent = 'Serie seguita'
      } catch (err) {
        button.disabled = false
        status.textContent = err.message
      }
    },
  }, p.followingSeries ? 'Serie seguita' : 'Registra la serie')
  let form, record
  if (p.recordingMargins && ch?.recordable && p.e > Date.now() && !p.recording) {
    record = h('button', { class: 'btn', onclick: () => {
      record.hidden = true
      form.hidden = false
      form.scrollIntoView({ block: 'nearest' })
    } }, 'Registra')
    form = recordingForm({
      programme: p, margins: p.recordingMargins, params: { c: chId, s },
      onCancel: () => {
        form.hidden = true
        record.hidden = false
        record.focus()
      },
      onSaved: job => {
        form.hidden = true
        status.textContent = recordingStatus(job)
        timing.textContent = recordingTime(job) || ''
        timing.hidden = !timing.textContent
        close.focus()
      },
    })
    form.hidden = true
  }
  sheet.replaceChildren(h('div', { class: 'sh' },
    p.img && h('img', { src: p.img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: e => e.target.remove() }),
    h('h2', {}, p.t),
    p.sub && h('div', {}, p.sub),
    h('div', { class: 'meta' }, `${ch?.lcn ? ch.lcn + ' · ' : ''}${ch?.name ?? chId} · ${fmtDay(p.s)} · ${fmt(p.s)}–${fmt(p.e)}${p.cat ? ' · ' + p.cat : ''}`),
    p.desc && h('p', {}, p.desc),
    status, timing, form,
    h('div', { class: 'acts' }, live, record, series, recordingPlay(p.recording, text => { status.textContent = text }),
      recordingBrowserButton(p.recording, () => {
        const back = () => openDetail(chId, s)
        sheet.replaceChildren(h('div', { class: 'sh' }, h('h2', {}, p.recording.title), recordingPlayerView(p.recording, back)))
      }), ics, close)))
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
  downloadFile('programma.ics', body, 'text/calendar')
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

async function loadGuideData(options) {
  const [channels, nowData, health] = await Promise.all([api('channels', options), api('now', options), api('health', options)])
  state.channels = channels.filter(c => c.n > 0).sort(byTelecomando)
  state.recordableChannels = channels.filter(ch => ch.recordable).sort(byTelecomando)
  state.byId = new Map(state.channels.map(c => [c.id, c]))
  state.nowData = nowData
  state.recordingEnabled = health.recordingEnabled
  state.epgRefreshEnabled = health.epgRefreshEnabled
  state.browserPlayer = health.browserPlayer
  $('#recordings').hidden = !state.recordingEnabled
  return health
}

let recordingBadgeTimer
async function init() {
  syncTabs()
  main.append(h('div', { class: 'empty' }, 'Caricamento…'))
  try {
    const health = await loadGuideData()
    if (state.recordingEnabled && !recordingBadgeTimer) {
      refreshRecordingBadge()
      recordingBadgeTimer = setInterval(refreshRecordingBadge, 30000)
    }
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
