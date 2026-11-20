import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { rename, stat, statfs, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { remuxMp4, streamInputArgs } from './ffmpeg.js'

const MIN_FREE = 1024 ** 3
const RETRY_MS = 60000
const ARCHIVE_CACHE_MS = 10000
const archivedName = row => row.partial ? row.filename.replace(/(\.(?:mp4|ts))$/, ' - parziale$1') : row.filename
const fileSize = async path => {
  try { return (await stat(path)).size } catch (err) { if (err.code === 'ENOENT') return 0; throw err }
}

function archiveName(title, channel, start, id) {
  const part = value => Array.from(value.replace(/[^\p{L}\p{N}() -]+/gu, ' ').trim().replace(/ +/g, ' ')).slice(0, 42).join('')
  const date = new Date(start).toLocaleString('sv-SE', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).replace(':', '-')
  return `${date} - ${part(channel)} - ${part(title)} [${id.slice(0, 8)}].mp4`
}

export class Recordings {
  constructor({ directory, store, archive, before, after, limit = 2, log = console }) {
    this.directory = directory
    this.store = store
    this.archive = archive
    this.before = before
    this.after = after
    this.limit = limit
    this.log = log
    this.active = new Map()
    this.abort = new AbortController()
    this.nextUpload = 0
    mkdirSync(directory, { recursive: true })
    this.db = new DatabaseSync(join(directory, 'jobs.sqlite'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, channelName TEXT NOT NULL, title TEXT NOT NULL,
        start INTEGER NOT NULL, end INTEGER NOT NULL, captureFrom INTEGER NOT NULL, captureTo INTEGER NOT NULL,
        filename TEXT NOT NULL, status TEXT NOT NULL, partial INTEGER NOT NULL DEFAULT 0, error TEXT,
        UNIQUE(channel, start)
      );
      UPDATE recordings SET filename = substr(filename, 1, length(filename) - 3) || '.mp4'
      WHERE status IN ('scheduled', 'recording', 'waiting') AND filename LIKE '%.ts';
    `)
  }

  list() {
    return this.db.prepare('SELECT * FROM recordings ORDER BY start DESC').all()
  }

  async visible(rows, requestHost, remoteAddress) {
    if (!rows.some(row => row.status === 'saved')) return rows
    if (!this.archiveCheck || Date.now() >= this.archiveCheck.expires) {
      const check = { expires: Infinity }
      check.result = this.archive.files(this.directory, this.abort.signal).then(files => {
        this.archiveFiles = files
        return { files, verified: true }
      }).catch(() => ({ files: this.archiveFiles, verified: false }))
        .finally(() => { check.expires = Date.now() + ARCHIVE_CACHE_MS })
      this.archiveCheck = check
    }
    const { files, verified } = await this.archiveCheck.result
    return rows.flatMap(row => {
      if (row.status !== 'saved') return [row]
      const filename = archivedName(row)
      if (files && !files.has(filename.toLowerCase())) return []
      return [{ ...row, archiveVerified: verified, playUrl: verified ? this.archive.url(filename, requestHost, remoteAddress) : null }]
    })
  }

  get(channel, start) {
    return this.db.prepare('SELECT * FROM recordings WHERE channel = ? AND start = ?').get(channel, start) || null
  }

  add(channel, name, programme) {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO recordings (id, channel, channelName, title, start, end, captureFrom, captureTo, filename, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
      ON CONFLICT(channel, start) DO NOTHING
    `).run(id, channel, name, programme.t, programme.s, programme.e, programme.s - this.before,
      programme.e + this.after, archiveName(programme.t, name, programme.s, id))
    return this.get(channel, programme.s)
  }

  remove(id) {
    return this.db.prepare("DELETE FROM recordings WHERE id = ? AND status IN ('scheduled', 'failed')").run(id).changes > 0
  }

  update(id, status, error = null, partial = 0) {
    this.db.prepare('UPDATE recordings SET status = ?, error = ?, partial = ? WHERE id = ?').run(status, error, partial, id)
  }

  localName(id) { return `${id}.ts` }

  async start() {
    for (const row of this.list()) {
      const path = join(this.directory, this.localName(row.id))
      if (row.status === 'saved') {
        await this.clean(path)
        await this.clean(join(this.directory, `${row.id}.mp4`))
      }
      if (row.status !== 'recording') continue
      if (await fileSize(path)) this.update(row.id, 'waiting', 'Registrazione interrotta dal riavvio', 1)
      else this.update(row.id, 'scheduled')
    }
    this.timer = setInterval(() => this.tick(), 2000)
    this.tick()
  }

  tick() {
    if (this.abort.signal.aborted || this.ticking) return
    this.ticking = this.processQueue().catch(err => this.log.error('Coda registrazioni:', err.message))
      .finally(() => { this.ticking = null })
  }

  async processQueue() {
    const space = await statfs(this.directory)
    if (this.abort.signal.aborted) return
    const diskFull = space.bavail * space.bsize < MIN_FREE
    if (diskFull) {
      for (const capture of this.active.values()) capture.stop('Spazio locale insufficiente')
    }

    const now = Date.now()
    const due = this.db.prepare("SELECT * FROM recordings WHERE status = 'scheduled' AND captureFrom <= ? ORDER BY captureFrom").all(now)
    for (const row of due) {
      if (row.end <= now) {
        this.update(row.id, 'failed', 'Il programma è terminato prima dell’avvio')
        continue
      }
      const stream = this.store.streams.get(row.channel)
      if (!diskFull && stream && !stream.web && this.active.size < this.limit) this.capture(row, stream)
    }

    if (this.upload || now < this.nextUpload) return
    const row = this.db.prepare("SELECT * FROM recordings WHERE status = 'waiting' ORDER BY start LIMIT 1").get()
    if (row) {
      this.upload = this.publish(row).catch(err => this.log.error('Trasferimento registrazione:', err.message))
        .finally(() => { this.upload = null })
    }
  }

  capture(row, stream) {
    const path = join(this.directory, this.localName(row.id))
    this.update(row.id, 'recording')
    const ff = spawn('ffmpeg', [...streamInputArgs(stream), '-y', path], { stdio: 'ignore' })
    let reason = Date.now() > row.start + 5000 ? 'Registrazione avviata dopo l’inizio' : null
    let killTimer
    const stop = error => {
      if (error) reason = error
      if (killTimer) return
      ff.kill('SIGINT')
      killTimer = setTimeout(() => ff.kill('SIGKILL'), 5000)
    }
    const timer = setTimeout(() => stop(), Math.max(0, row.captureTo - Date.now()))
    ff.on('error', () => { reason = 'Impossibile avviare FFmpeg' })
    const done = new Promise(resolve => ff.once('close', resolve)).then(async code => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (!await fileSize(path)) {
        this.update(row.id, 'failed', reason || 'Nessun video ricevuto')
        await this.clean(path)
      } else {
        if (Date.now() < row.captureTo - 5000 || (code !== 0 && code !== 255)) reason ||= 'Lo stream si è interrotto'
        this.update(row.id, 'waiting', reason, reason ? 1 : 0)
      }
    }).catch(err => this.log.error('Chiusura registrazione:', err.message))
      .finally(() => this.active.delete(row.id))
    this.active.set(row.id, { stop, done })
  }

  async publish(row) {
    const capture = join(this.directory, this.localName(row.id))
    const localName = `${row.id}.mp4`
    const mp4 = join(this.directory, localName)
    if (!await fileSize(mp4)) {
      const size = await fileSize(capture)
      if (!size) return this.update(row.id, 'failed', 'Il file locale è assente o vuoto')
      const space = await statfs(this.directory)
      if (space.bavail * space.bsize < MIN_FREE + size) {
        return this.retryUpload(row, 'Spazio locale insufficiente per preparare il file MP4')
      }
      const temporary = `${mp4}.part`
      try {
        await remuxMp4(capture, temporary, this.abort.signal)
        if (!await fileSize(temporary)) throw new Error('File MP4 vuoto')
        await rename(temporary, mp4)
      } catch (err) {
        await this.clean(temporary)
        if (!this.abort.signal.aborted) this.log.warn('Preparazione MP4:', err.message)
        return this.retryUpload(row, 'Preparazione MP4 non riuscita, copia locale conservata')
      }
    }

    const filename = archivedName(row)
    try {
      await this.archive.publish(this.directory, localName, filename, this.abort.signal)
    } catch {
      return this.retryUpload(row, 'NAS non disponibile, nuovo tentativo in attesa')
    }
    // Attendi l'eventuale verifica iniziata prima del trasferimento e invalida il suo risultato.
    const check = this.archiveCheck
    await check?.result
    this.archiveFiles?.add(filename.toLowerCase())
    if (this.archiveCheck === check) this.archiveCheck = null
    this.update(row.id, 'saved', row.partial ? row.error : null, row.partial)
    await this.clean(capture)
    await this.clean(mp4)
  }

  retryUpload(row, message) {
    this.nextUpload = Date.now() + RETRY_MS
    this.update(row.id, 'waiting', row.partial && row.error ? row.error : message, row.partial)
  }

  async clean(path) {
    try { await unlink(path) } catch (err) { if (err.code !== 'ENOENT') this.log.warn('Pulizia registrazione:', err.message) }
  }

  async stop() {
    clearInterval(this.timer)
    this.abort.abort()
    for (const capture of this.active.values()) capture.stop('Registrazione interrotta dal riavvio')
    await Promise.allSettled([this.ticking, this.upload, this.archiveCheck?.result, ...[...this.active.values()].map(capture => capture.done)])
    this.db.close()
  }
}
