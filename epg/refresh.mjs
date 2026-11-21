import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, rename, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'

const PORT = 3000
const guide = 'public/guide.xml'
const temporary = 'public/guide.pending.xml'

if (process.argv[2] === 'request') {
  const response = await fetch(`http://127.0.0.1:${PORT}/refresh`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
} else {
  startServer()
}

function startServer() {
  let job = { status: 'idle' }
  const refresh = () => {
    if (job.status === 'running' || Date.now() - (job.finishedAt || 0) < 60000) return
    job = { status: 'running' }
    generate().then(() => {
      job = { status: 'complete', finishedAt: Date.now() }
    }).catch(error => {
      console.error('Aggiornamento EPG:', error.message)
      job = { status: 'error', finishedAt: Date.now() }
    })
  }
  createServer((req, res) => {
    if (req.url === '/refresh' && ['GET', 'POST'].includes(req.method)) {
      if (req.method === 'POST') refresh()
      res.writeHead(job.status === 'running' ? 202 : 200, {
        'content-type': 'application/json', 'cache-control': 'no-store',
      })
      return res.end(JSON.stringify(job))
    }
    if (req.url === '/guide.xml' && ['GET', 'HEAD'].includes(req.method)) {
      const file = createReadStream(guide)
      file.once('open', () => {
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' })
        if (req.method === 'HEAD') { file.destroy(); res.end() } else file.pipe(res)
      })
      file.once('error', () => {
        if (res.headersSent) res.destroy()
        else { res.writeHead(503); res.end() }
      })
      res.on('close', () => file.destroy())
      return
    }
    res.writeHead(404)
    res.end()
  }).listen(PORT, () => {
    if (process.env.RUN_AT_STARTUP === 'true') refresh()
  })
}

async function generate() {
  try {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    const selection = process.env.SITES ? ['--sites', process.env.SITES] : ['--channels', 'public/channels.xml']
    if (process.env.SITES && process.env.CLANG) selection.push('--lang', process.env.CLANG)
    const child = spawn(process.execPath, ['-r', '@swc-node/register', 'scripts/commands/epg/grab.ts',
      ...selection, '--output', temporary], { stdio: 'inherit', timeout: 15 * 60000 })
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`Grabber terminato con codice ${code}`)))
    })
    const xml = await readFile(temporary, 'utf8')
    if (!/<programme\s/.test(xml) || !xml.trimEnd().endsWith('</tv>')) throw new Error('Guida vuota o incompleta')
    await rename(temporary, guide)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
