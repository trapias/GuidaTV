import assert from 'node:assert/strict'
import test from 'node:test'
import { createTmdb } from '../src/tmdb.js'

const card = (id, title, original, date) => `<a class="flex w-full" data-id="x" data-media-type="movie" data-media-adult="false" href="/movie/${id}-slug?language=it-IT"><img></a>` +
  `<a class="font-normal" data-id="x" data-media-type="movie" data-media-adult="false" href="/movie/${id}-slug?language=it-IT"><h2 class="a"><span>${title}</span>${original ? `<span class="font-light"> (${original})</span>` : ''}</h2></a><span class="release_date w-full font-light"> ${date}</span>`
const page = html => async () => new Response(`<html>${html}</html>`, { status: 200 })
const json = results => async () => new Response(JSON.stringify({ results }), { status: 200 })

test('senza chiave legge la pagina pubblica e confronta titolo e anno', async () => {
  let calls = 0, request
  const tmdb = createTmdb({ fetchImpl: async url => {
    calls++
    request = url
    return page(card(604, 'Matrix Reloaded', 'The Matrix Reloaded', '15 maggio, 2003') +
      card(603, 'Matrix', 'The Matrix', '7 maggio, 1999') + card(9, 'Tom &amp; Jerry', '', '1 gennaio, 1992'))()
  } })
  assert.equal(await tmdb.lookup('MATRIX', 1999), 'https://www.themoviedb.org/movie/603')
  assert.equal(request.searchParams.get('query'), 'MATRIX')
  assert.equal(await tmdb.lookup('Matrix', 2003), null) // anno diverso
  assert.equal(await tmdb.lookup('Matrix', 1998), 'https://www.themoviedb.org/movie/603') // tolleranza di un anno
  assert.equal(await tmdb.lookup('The Matrix', 1999), 'https://www.themoviedb.org/movie/603') // titolo originale
  assert.equal(await tmdb.lookup('Tom & Jerry'), 'https://www.themoviedb.org/movie/9')
  assert.equal(calls, 5)
  assert.equal(await tmdb.lookup('Matrix', 1999), 'https://www.themoviedb.org/movie/603')
  assert.equal(calls, 5) // cache
})

test('con una chiave usa l\'API', async () => {
  let request
  const tmdb = createTmdb({ credential: 'chiave', fetchImpl: async (url, init) => {
    request = { url, init }
    return json([{ id: 1, title: 'Altro', original_title: 'Other' }, { id: 603, title: 'Matrix', original_title: 'The Matrix', release_date: '1999-03-30' }])()
  } })
  assert.equal(await tmdb.lookup('matrix', 1999), 'https://www.themoviedb.org/movie/603')
  assert.equal(request.url.searchParams.get('api_key'), 'chiave')
  const bearer = createTmdb({ credential: 'a.b.c', fetchImpl: async (_, init) => {
    assert.equal(init.headers.Authorization, 'Bearer a.b.c')
    return json([])()
  } })
  assert.equal(await bearer.lookup('Film'), null)
})

test('cache negativa temporanea; gli errori non vengono memorizzati', async () => {
  let calls = 0, time = 0, status = 200
  const tmdb = createTmdb({ now: () => time, fetchImpl: async () => { calls++; return new Response('<html></html>', { status }) } })
  assert.equal(await tmdb.lookup('Sconosciuto'), null)
  assert.equal(await tmdb.lookup('Sconosciuto'), null)
  assert.equal(calls, 1)
  time = 8 * 86400000
  await tmdb.lookup('Sconosciuto')
  assert.equal(calls, 2)
  status = 503
  await assert.rejects(tmdb.lookup('Altro'))
  await assert.rejects(tmdb.lookup('Altro'))
  assert.equal(calls, 4)
})
