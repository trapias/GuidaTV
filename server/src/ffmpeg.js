import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export function streamInputArgs(stream) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', '+genpts', '-rw_timeout', '15000000',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5']
  if (stream.ua) args.push('-user_agent', stream.ua)
  if (stream.referrer) args.push('-referer', stream.referrer)
  return [...args, '-i', stream.url, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'mpegts']
}

export function remuxMp4(input, output, signal) {
  return exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output,
  ], { signal })
}
