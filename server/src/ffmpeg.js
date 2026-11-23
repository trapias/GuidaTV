import { execFile } from 'node:child_process'
import { unlink, writeFile } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export function streamInputArgs(stream) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', '+genpts', '-rw_timeout', '15000000',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5']
  if (stream.ua) args.push('-user_agent', stream.ua)
  if (stream.referrer) args.push('-referer', stream.referrer)
  if (stream.liveStartIndex != null) args.push('-live_start_index', String(stream.liveStartIndex))
  return [...args, '-i', stream.url, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'mpegts']
}

export async function remuxMp4(inputs, output, signal) {
  const list = inputs.length > 1 ? `${output}.ffconcat` : null
  try {
    if (list) {
      await writeFile(list, inputs.map(input => `file ${relative(dirname(list), input)}\n`).join(''))
    }
    const mux = codecs => exec('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      ...(list ? ['-f', 'concat', '-safe', '1', '-i', list] : ['-i', inputs[0]]),
      '-map', '0:v:0', '-map', '0:a:0', ...codecs, '-movflags', '+faststart', '-f', 'mp4', output,
    ], { signal })
    return await mux(['-c', 'copy']).catch(error => {
      if (signal?.aborted || !/\[aac_adtstoasc\b/.test(error.stderr)) throw error
      return mux(['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-abort_on', 'empty_output_stream'])
    })
  } finally {
    if (list) await unlink(list).catch(() => {})
  }
}

export async function mediaDuration(path) {
  try {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', path], { timeout: 5000 })
    const seconds = Number(stdout.trim())
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null
  } catch { return null }
}
