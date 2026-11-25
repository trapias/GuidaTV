const SPORTS_URL = 'https://www.primevideo.com/-/it/sports'
const ORIGIN = new URL(SPORTS_URL).origin
const APP_DETAIL = 'https://app.primevideo.com/detail'
const TTL = 20 * 60000
const RETRY = 60000
const MAX_PAGE = 4 * 1024 * 1024
const DAY = 86400000
const MONTHS = 'gen feb mar apr mag giu lug ago set ott nov dic'.split(' ')
const WEEKDAYS = 'dom lun mar mer gio ven sab'.split(' ')
const localDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome', year: 'numeric', month: 'numeric', day: 'numeric',
})

function startTime(badge, pageTime, live) {
  const clock = /\b([01]?\d|2[0-3]):([0-5]\d) (CET|CEST)$/i.exec(badge)
  if (!clock) return null
  const [, hour, minute, zone] = clock
  const offset = zone.toUpperCase() === 'CEST' ? 2 : 1
  const date = Object.fromEntries(localDate.formatToParts(pageTime)
    .filter(part => part.type !== 'literal').map(({ type, value }) => [type, Number(value)]))
  const prefix = badge.slice(0, clock.index)
  if (/^(?:(?:oggi|domani) alle ore |in diretta alle ore )?$/i.test(prefix)) {
    const day = date.day + Number(/^domani/i.test(prefix))
    const start = Date.UTC(date.year, date.month - 1, day, Number(hour) - offset, Number(minute))
    return live && !prefix && start > pageTime ? start - DAY : start
  }

  const absolute = /^(\w{3}) (\d{1,2}) (\w{3})\.? (?:(\d{4}) )?$/i.exec(prefix)
  if (!absolute) return null
  const [, weekday, day, month, year] = absolute
  const monthIndex = MONTHS.indexOf(month.toLowerCase())
  if (monthIndex < 0) return null
  // Le schede del palinsesto di solito omettono l'anno, anche a cavallo di dicembre.
  for (const candidate of year ? [Number(year)] : [date.year, date.year + 1]) {
    const calendar = new Date(Date.UTC(candidate, monthIndex, Number(day), Number(hour), Number(minute)))
    const start = calendar.getTime() - offset * 3600000
    if (calendar.getUTCMonth() === monthIndex && WEEKDAYS[calendar.getUTCDay()] === weekday.toLowerCase() &&
        start >= pageTime - DAY && start <= pageTime + 180 * DAY) return start
  }
  return null
}

export function parsePrimeEvents(html, pageTime) {
  const script = /<script\b[^>]*\sid=["']dv-web-page-hydration-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)
  const containers = script && JSON.parse(script[1])?.init?.preparations?.body?.containers
  if (!Array.isArray(containers)) throw new Error('Palinsesto Prime Video non disponibile')
  const events = new Map()
  for (const container of containers) {
    if (!Array.isArray(container?.entities)) continue
    for (const card of container.entities) {
      if (card?.entityType !== 'EVENT') continue
      const status = card.liveInfo?.status
      if (status !== 'UPCOMING' && status !== 'LIVE') continue
      const live = status === 'LIVE'
      const provider = card.entitlementCues?.providerLogo?.imageUrl
      if (typeof provider !== 'string' || !provider.includes('/benefit-id/m-r/Prime/logos/')) continue
      const t = typeof card.displayTitle === 'string' && card.displayTitle.trim()
      const link = typeof card.link?.url === 'string' && URL.parse(card.link.url, ORIGIN)
      const id = link && link.origin === ORIGIN && /^\/-\/it\/detail\/([\w-]+)\/?$/.exec(link.pathname)?.[1]
      const badge = card.liveInfo.timeBadge
      const s = typeof badge === 'string' ? startTime(badge.trim(), pageTime, live) : null
      if (!id || !t || (!live && !s) || (events.get(id)?.live && !live)) continue
      const gti = card.titleID
      const appUrl = typeof gti === 'string' && /^amzn1\.dv\.gti\.[\da-f-]{36}$/i.test(gti)
        ? `${APP_DETAIL}?${new URLSearchParams({ gti, territory: 'IT', source: 'pvweb' })}` : undefined
      events.set(id, { id, t, s, live, url: `${ORIGIN}/detail/${id}`, appUrl })
    }
  }
  return [...events.values()].sort((a, b) => Number(b.live) - Number(a.live) || a.s - b.s || a.t.localeCompare(b.t, 'it'))
}

async function readPage(response) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Prime Video: HTTP ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let html = '', size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return html + decoder.decode()
      size += value.byteLength
      if (size > MAX_PAGE) throw new Error('Pagina Prime Video troppo grande')
      html += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export function createPrimeVideo({ fetchImpl = fetch, now = Date.now } = {}) {
  let events, pending, nextRefresh = 0, stale = false
  async function refresh() {
    try {
      const response = await fetchImpl(SPORTS_URL, {
        headers: { 'Accept-Language': 'it-IT,it;q=0.9', 'User-Agent': 'GuidaTV' },
        signal: AbortSignal.timeout(8000),
      })
      const pageTime = Date.parse(response.headers.get('date'))
      events = parsePrimeEvents(await readPage(response), Number.isFinite(pageTime) ? pageTime : now())
      const checkedAt = now()
      nextRefresh = checkedAt + TTL
      for (const event of events) {
        const check = event.live || event.s <= checkedAt ? checkedAt + RETRY : event.s
        nextRefresh = Math.min(nextRefresh, check)
      }
      stale = false
    } catch {
      nextRefresh = now() + RETRY
      stale = true
    }
  }
  return async function listEvents() {
    if (now() >= nextRefresh) {
      pending ||= refresh().finally(() => { pending = undefined })
      await pending
    }
    return { events: events?.filter(event => event.live || event.s > now()) ?? [], stale, available: Boolean(events) }
  }
}
