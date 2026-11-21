import { spawn } from 'node:child_process'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { streamInputArgs } from './ffmpeg.js'

export async function fileSize(path) {
  try { return (await stat(path)).size } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
}

export function captureDynamic(row, source, directory) {
  const abort = new AbortController()
  let child, killTimer, stoppedAt, failure, reason
  let hasMedia = false
  let forcedStop = false
  const stop = (error, at) => {
    if (abort.signal.aborted) return false
    if (error) reason = error
    stoppedAt = at
    abort.abort()
    if (child?.kill('SIGINT')) {
      killTimer = setTimeout(() => { forcedStop = child?.kill('SIGKILL') === true }, 5000)
    }
    return true
  }
  const timer = setTimeout(() => stop(), Math.max(0, row.captureTo - Date.now()))
  const done = (async () => {
    await mkdir(directory, { recursive: true })
    let retry = 10000
    for (let attempt = 0; !abort.signal.aborted && Date.now() < row.captureTo; attempt++) {
      const path = join(directory, `${attempt}.ts`)
      let stream
      try {
        stream = await source.resolve(abort.signal)
        if (attempt && stream.hls) stream = { ...stream, liveStartIndex: -1 }
      } catch (error) {
        if (!abort.signal.aborted) failure = error.message
      }
      if (abort.signal.aborted) break
      if (stream) {
        if (!hasMedia && Date.now() > row.start + 5000) reason ||= 'Registrazione avviata dopo l’inizio'
        const processStarted = Date.now()
        child = spawn('ffmpeg', [...streamInputArgs(stream), '-y', path], { stdio: 'ignore' })
        const { code, signal } = await new Promise(resolve => {
          child.once('error', () => resolve({ code: null }))
          child.once('close', (code, signal) => resolve({ code, signal }))
        })
        clearTimeout(killTimer)
        child = null
        const bytes = await fileSize(path)
        if (bytes) hasMedia = true
        else await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
        if (abort.signal.aborted) {
          if (code !== 0 && code !== 255 && !(forcedStop && signal === 'SIGKILL')) reason ||= 'Lo stream si è interrotto'
          break
        }
        failure = bytes ? 'Lo stream si è interrotto' : 'Nessun video ricevuto da TV8'
        if (bytes && Date.now() - processStarted >= 60000) retry = 10000
      }
      if (Date.now() >= row.start && Date.now() < row.end) reason ||= failure
      if (Date.now() >= row.end && !hasMedia) break
      const remaining = row.captureTo - Date.now()
      if (remaining <= 5000) break
      try { await delay(Math.min(retry, remaining), undefined, { signal: abort.signal }) } catch (error) {
        if (!abort.signal.aborted) throw error
      }
      retry = Math.min(retry * 2, 60000)
    }
    return { stoppedAt, reason, failure }
  })().finally(() => { clearTimeout(timer); clearTimeout(killTimer) })
  return { stop, done }
}
