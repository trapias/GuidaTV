import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrimeVideo, parsePrimeEvents } from '../src/prime-video.js'

const card = (id, timeBadge, fields = {}) => ({
  entityType: 'EVENT',
  displayTitle: id,
  titleID: 'amzn1.dv.gti.298e6ab6-1624-4e47-837a-1b3a79d14715',
  liveInfo: { status: 'UPCOMING', timeBadge },
  entitlementCues: { providerLogo: { imageUrl: 'https://m.media-amazon.com/benefit-id/m-r/Prime/logos/prime.png' } },
  link: { url: `/-/it/detail/${id}?ref_=test` },
  ...fields,
})
const page = (...entities) => {
  const data = { init: { preparations: { body: { containers: [{ entities }] } } } }
  return `<script id="dv-web-page-hydration-data" type="application/json">${JSON.stringify(data)}</script>`
}

test('importa solo i prossimi eventi inclusi con Prime, usando l’ora italiana e link ufficiali', () => {
  const at = Date.parse('2026-12-31T22:30:00Z')
  const derby = card('derby', 'ven 1 gen 20:00 CET')
  const results = parsePrimeEvents(page(
    derby, derby, card('tennis', 'Domani alle ore 12:00 CET'),
    card('esterno', 'ven 1 gen 20:00 CET', { link: { url: 'https://example.com/-/it/detail/esterno' } }),
    card('extra', 'ven 1 gen 20:00 CET', { entitlementCues: {} }),
    card('replica', 'ven 1 gen 20:00 CET', { liveInfo: { status: 'ENDED' } }),
    card('senza-data', 'Prossimamente'),
  ), at)
  assert.deepEqual(results.map(({ id, s, url }) => [id, new Date(s).toISOString(), url]), [
    ['tennis', '2027-01-01T11:00:00.000Z', 'https://www.primevideo.com/detail/tennis'],
    ['derby', '2027-01-01T19:00:00.000Z', 'https://www.primevideo.com/detail/derby'],
  ])
  const [summer] = parsePrimeEvents(page(card('evento', 'mer 12 ago 20:00 CEST')), Date.parse('2026-08-11T22:30:00Z'))
  assert.equal(summer.s, Date.parse('2026-08-12T18:00:00Z'))
  assert.equal(summer.appUrl, 'https://app.primevideo.com/detail?gti=amzn1.dv.gti.298e6ab6-1624-4e47-837a-1b3a79d14715&territory=IT&source=pvweb')
})

test('condivide il caricamento e ripropone gli eventi futuri in caso di errore temporaneo', async () => {
  const at = Date.parse('2026-11-25T19:00:00Z')
  let time = at, calls = 0, online = true
  const upcoming = createPrimeVideo({ now: () => time, fetchImpl: async () => {
    calls++
    if (!online) return new Response('Errore', { status: 503 })
    return new Response(page(card('partita', 'In diretta alle ore 20:30 CET')),
      { headers: { date: new Date(at).toUTCString() } })
  } })
  const [first, second] = await Promise.all([upcoming(), upcoming()])
  assert.equal(calls, 1)
  assert.equal(first.events.length, 1)
  assert.deepEqual(first, second)
  time += 21 * 60000
  online = false
  assert.deepEqual(await upcoming(), { ...first, stale: true })
  await upcoming()
  assert.equal(calls, 2)
  time += 10 * 60000
  assert.deepEqual(await upcoming(), { events: [], available: true, stale: true })
})

test('mantiene in cima gli eventi già iniziati e aggiorna lo stato all’orario di partenza', async () => {
  let time = Date.parse('2026-11-25T18:29:00Z')
  let phase = 'UPCOMING'
  const upcoming = card('PSG vs Roma', '19:30 CET', { link: { url: '/-/it/detail/match' } })
  const fixtures = createPrimeVideo({ now: () => time, fetchImpl: async () => {
    const current = { ...upcoming, liveInfo: { ...upcoming.liveInfo, status: phase } }
    return new Response(page(current, upcoming, card('futuro', 'Domani alle ore 21:00 CET')),
      { headers: { date: new Date(time).toUTCString() } })
  } })
  assert.equal((await fixtures()).events[0].live, false)
  time += 60000
  phase = 'LIVE'
  const { events } = await fixtures()
  assert.deepEqual(events.map(({ id, live }) => [id, live]), [['match', true], ['futuro', false]])
  time += 60000
  phase = 'ENDED'
  assert.deepEqual((await fixtures()).events.map(({ id }) => id), ['futuro'])
})
