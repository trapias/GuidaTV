import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTime, parseXmltv, groupOf } from '../src/xmltv.js'
import { Store } from '../src/store.js'
import channelLogos from '../src/logos.json' with { type: 'json' }

const XML = `<?xml version="1.0"?><tv>
<channel id="rai1"><display-name>RAI 1</display-name></channel>
<programme start="20261117100000 +0100" stop="20261117110000 +0100" channel="rai1"><title lang="it">Uno &amp; Mattina</title><desc>Desc</desc><category>News</category></programme>
<programme start="20261117110000 +0100" stop="20261117120000 +0100" channel="rai1"><title>Cosa è successo</title></programme>
<programme start="20261117110000 +0100" stop="20261117120000 +0100" channel="rai1"><title>Duplicato</title></programme>
<programme start="20261117120000 +0100" stop="20261117110000 +0100" channel="rai1"><title>Invalido</title></programme>
</tv>`

test('parseTime gestisce offset', () => {
  assert.equal(parseTime('20261117100000 +0100'), Date.UTC(2026, 10, 17, 9))
})
test('parseXmltv: entità, duplicati e intervalli invalidi', () => {
  const ch = parseXmltv(XML).get('rai1')
  assert.equal(ch.programmes.length, 2)
  assert.equal(ch.programmes[0].t, 'Uno & Mattina')
  assert.equal(ch.group, 'Rai')
})
test('store: now e search senza accenti', () => {
  const st = new Store({ epgUrl: '', dataDir: '', log: console })
  st.apply(XML)
  const at = Date.UTC(2026, 10, 17, 9, 30)
  assert.equal(st.now(at).rai1.cur[2], 'Uno & Mattina')
  assert.equal(st.now(at).rai1.next[2], 'Cosa è successo')
  assert.equal(st.search('e successo', at - 1e7).length, 1)
  assert.equal(st.search('cosa e', at - 1e7).length, 1)
})
test('store: preferisce il logo XMLTV e usa il catalogo quando manca', () => {
  const st = new Store({ epgUrl: '', dataDir: '' })
  st.apply(`<tv>
    <channel id="rai1"><display-name>Rai 1</display-name>
      <icon src="data:image/png,skip" />
      <icon src="https://example.com/rai1.png?v=1&amp;s=2" />
    </channel>
    <channel id="canale5"><display-name>Canale 5</display-name></channel>
    <channel id="locale"><display-name>Canale locale</display-name></channel>
  </tv>`)
  const [rai, mediaset, locale] = st.listChannels()
  assert.equal(rai.logo, 'https://example.com/rai1.png?v=1&s=2')
  assert.ok(mediaset.logo)
  assert.equal(mediaset.logo, channelLogos.canale5)
  assert.equal(locale.logo, null)
})
test('groupOf', () => {
  assert.equal(groupOf('Canale 5'), 'Mediaset')
  assert.equal(groupOf('Sky Cinema Uno'), 'Cinema')
  assert.equal(groupOf('Sky Sport 251'), 'Sport')
})
