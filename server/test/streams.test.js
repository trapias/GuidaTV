import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseM3u, matchStreams, singleM3u } from '../src/streams.js'
import { loadLcn } from '../src/lcn.js'

const M3U = `#EXTM3U
#EXTINF:-1 tvg-id="Rai1.it@HD" http-user-agent="UA/1",Rai 1 HD (1080p)
http://a/rai1.m3u8
#EXTINF:-1 tvg-id="Rai1.it@SD",Rai 1 bis
http://a/dup.m3u8
#EXTINF:-1 tvg-id="20.it@SD",20 [Geo-blocked]
#EXTVLCOPT:http-referrer=http://r/
https://a/20.m3u8
#EXTINF:-1,La7d (720p)
https://a/la7d.m3u8
#EXTINF:-1,Sconosciuto
https://a/x.m3u8
#EXTINF:-1,Senza url
`

test('parseM3u legge attributi, opzioni VLC e scarta voci senza URL', () => {
  const e = parseM3u(M3U)
  assert.equal(e.length, 5)
  assert.equal(e[0].ua, 'UA/1')
  assert.equal(e[2].referrer, 'http://r/')
})

test('matchStreams associa per tvg-id/nome, alias, prima voce vince', () => {
  const m = matchStreams(parseM3u(M3U), ['rai1', '20mediaset', 'la7d'])
  assert.equal(m.get('rai1').url, 'http://a/rai1.m3u8')
  assert.equal(m.get('20mediaset').url, 'https://a/20.m3u8')
  assert.equal(m.get('la7d').url, 'https://a/la7d.m3u8')
  assert.equal(m.size, 3)
})

test('singleM3u è una playlist valida con opzioni e senza injection di righe', () => {
  const t = singleM3u('Rai\n#EXTINF x', { url: 'http://a/b.m3u8', ua: 'UA', referrer: '' })
  assert.match(t, /^#EXTM3U\r\n#EXTINF:-1,Rai #EXTINF x\r\n#EXTVLCOPT:http-user-agent=UA\r\nhttp:\/\/a\/b\.m3u8\r\n$/)
})

test('loadLcn: predefiniti presenti, file mancante ok', async () => {
  const m = await loadLcn('/nonexistent')
  assert.equal(m.rai1, 1); assert.equal(m.nove, 9); assert.ok(!('_nota' in m))
})
