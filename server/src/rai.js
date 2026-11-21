import { XMLParser } from 'fast-xml-parser'

const RAI_PLAY = 'https://www.raiplay.it'
const MEDIAPOLIS = 'https://mediapolis.rai.it'
const CDN = /^rai[a-z0-9-]+(?:-live\.akamaized\.net|-push\.cdn\.netrw\.it)$/
const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text',
  parseTagValue: false, processEntities: false,
})

export const raiChannels = [
  'rai1', 'rai2', 'rai3', 'rai4', 'rai5', 'raimovie', 'raipremium', 'raigulp',
  'raiyoyo', 'raistoria', 'rainews24', 'raisport', 'italiana',
]

export function raiRelinker(source) {
  const url = typeof source === 'string' && URL.parse(source)
  if (url?.origin !== MEDIAPOLIS || url.username || url.password ||
    url.pathname !== '/relinker/relinkerServlet.htm' || !/^\d+$/.test(url.searchParams.get('cont') || '')) {
    return null
  }
  url.searchParams.set('output', '64')
  return url
}

export function raiLiveStream(xml) {
  const metadata = parser.parse(xml).Mediapolis
  if (metadata?.is_live !== 'Y' || metadata.license_url !== '{}') return null
  const content = [metadata.url].flat().find(item => item?.['@type'] === 'content')?.['#text']
  const url = typeof content === 'string' && URL.parse(content)
  if (url?.protocol !== 'https:' || url.username || url.password || url.port ||
    !CDN.test(url.hostname) || !url.pathname.endsWith('.m3u8') || !url.searchParams.get('hdnea')) {
    return null
  }
  return { url: url.href, hls: true }
}

export async function resolveRai(channel, signal) {
  const timeout = AbortSignal.timeout(8000)
  const options = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' }
  let stream
  try {
    const page = await fetch(`${RAI_PLAY}/dirette/${channel}.json`, options)
    if (page.ok) {
      const config = await page.json()
      const source = raiRelinker(config.video?.content_url)
      if (source) {
        const response = await fetch(source, options)
        if (response.ok) stream = raiLiveStream(await response.text())
      }
    }
  } catch {
    throw new Error('Impossibile ottenere la diretta da RaiPlay')
  }
  if (!stream) throw new Error('Diretta RaiPlay non disponibile per la registrazione')
  return stream
}
