import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remuxMp4 } from '../src/ffmpeg.js'

test('ritenta un errore ADTS ricodificando solo l’audio', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'guidatv-ffmpeg-'))
  const previousPath = process.env.PATH
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  })
  await writeFile(join(directory, 'ffmpeg'), `#!/bin/sh
case "$*" in
  *broken.ts*'-c copy'*) printf '[aac_adtstoasc @ 0x1] Error parsing ADTS frame header!\\n' >&2; exit 1 ;;
  *broken.ts*'-c:v copy -c:a aac'*) result='audio ricodificato' ;;
  *valid.ts*'-c copy'*) result='copia diretta' ;;
  *other.ts*'-c copy'*) printf 'Errore video\\n' >&2; exit 1 ;;
  *) exit 2 ;;
esac
for output do :; done
printf '%s' "$result" > "$output"
`, { mode: 0o700 })
  process.env.PATH = `${directory}:${previousPath || '/usr/bin:/bin'}`
  const output = join(directory, 'recording.mp4')
  await remuxMp4(['valid.ts'], output)
  assert.equal(await readFile(output, 'utf8'), 'copia diretta')
  await remuxMp4(['broken.ts'], output)
  assert.equal(await readFile(output, 'utf8'), 'audio ricodificato')
  await assert.rejects(remuxMp4(['other.ts'], output), /Errore video/)
})
