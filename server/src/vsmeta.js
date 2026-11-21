import { createHash } from 'node:crypto'

const ARTWORK_HOSTS = new Set(['guidatv.sky.it', 'static2.mediasetplay.mediaset.it', 'www.raiplay.it'])
const MAX_ARTWORK = 2 * 1024 * 1024

export function movieMetadata(programme) {
  if (programme?.type !== 'movie') return null
  return {
    title: programme.t,
    summary: programme.desc || '',
    genre: programme.cat || '',
    year: programme.releaseYear || null,
    image: programme.img || '',
  }
}

function varint(value) {
  const bytes = []
  while (value > 127) {
    bytes.push((value % 128) + 128)
    value = Math.floor(value / 128)
  }
  bytes.push(value)
  return Buffer.from(bytes)
}

const integerField = (number, value) => Buffer.concat([varint(number * 8), varint(value)])
function bytesField(number, value) {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes])
}

// Tag del formato Video Station, verificati su un file esportato dal NAS.
export function encodeMovieMetadata({ title, summary, genre, year }, poster) {
  const fields = [integerField(1, 1), bytesField(2, title), bytesField(3, title)]
  if (year) fields.push(integerField(5, year))
  if (summary) fields.push(bytesField(8, summary))
  if (genre) fields.push(bytesField(10, bytesField(3, genre)))
  if (poster?.length) {
    fields.push(bytesField(17, poster.toString('base64').match(/.{1,76}/g).join('\n')),
      bytesField(18, createHash('md5').update(poster).digest('hex')))
  }
  return Buffer.concat(fields)
}

export async function moviePoster(source, signal) {
  const url = URL.parse(source || '')
  if (url?.protocol !== 'https:' || url.port || url.username || url.password || !ARTWORK_HOSTS.has(url.hostname)) return null
  try {
    const timeout = AbortSignal.timeout(6000)
    const response = await fetch(url, {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (!response.ok || !/^image\/jpeg(?:;|$)/i.test(response.headers.get('content-type') || '') ||
      Number(response.headers.get('content-length')) > MAX_ARTWORK) {
      await response.body?.cancel()
      return null
    }
    const parts = []
    let bytes = 0
    for await (const part of response.body) {
      bytes += part.length
      if (bytes > MAX_ARTWORK) return null
      parts.push(part)
    }
    const image = Buffer.concat(parts)
    return image.length > 3 && image[0] === 255 && image[1] === 216 ? image : null
  } catch { return null }
}
