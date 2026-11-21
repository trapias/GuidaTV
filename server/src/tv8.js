const SKY_LIVE = 'https://video.sky.it/api/v1/getLivestream?id=7&isMobile=false'
const CDN = 'https://hlslive-web-gcdn-skycdn-it.akamaized.net'

export async function resolveTv8(signal) {
  const timeout = AbortSignal.timeout(8000)
  let data
  try {
    const response = await fetch(SKY_LIVE, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' })
    if (!response.ok) throw new Error(String(response.status))
    data = await response.json()
  } catch {
    throw new Error('Impossibile ottenere la diretta TV8 da Sky')
  }
  const url = URL.parse(data?.streaming_url || '')
  if (data?.currentStatus !== 1 || url?.origin !== CDN || url.username || url.password ||
    url.pathname !== '/TACT/11223/tv8web/master.m3u8' || !url.searchParams.get('hdnts')) {
    throw new Error('Diretta TV8 non disponibile')
  }
  return { url: url.href, hls: true }
}
