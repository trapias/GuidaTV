import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

function isTailscale(host) {
  const address = (host || '').replace(/^\[|\]$|^::ffff:|\.$/gi, '').toLowerCase()
  const ipv4 = /^100\.(\d+)\.\d+\.\d+$/.exec(address)
  return address.endsWith('.ts.net') || address.startsWith('fd7a:115c:a1e0:') ||
    (ipv4 && Number(ipv4[1]) >= 64 && Number(ipv4[1]) <= 127)
}

export class SmbArchive {
  constructor({ share, ip, credentials, tailscaleHost }) {
    const [, host, folder, subfolder] = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(share) || []
    this.path = subfolder ? subfolder.split('/').filter(Boolean) : []
    this.args = [host && folder ? `//${host}/${folder}` : share, '-A', credentials, '-t', '20']
    if (ip) this.args.push('-I', ip)
    if (this.path.length) this.args.push('-D', this.path.join('\\'))
    this.localHost = host
    this.folder = folder
    this.readHost = ip || host
    this.credentials = credentials
    this.tailscaleHost = tailscaleHost
  }

  async command(cmd, cwd, signal, timeout = 30000, maxBuffer = 65536) {
    const result = await exec('smbclient', [...this.args, '-c', cmd], { cwd, signal, timeout, maxBuffer })
    // Alcuni comandi SMB stampano l'errore pur terminando con codice 0.
    const output = `${result.stdout}\n${result.stderr}`
      .replace(/^NT_STATUS_(?:INVALID_DEVICE_REQUEST|NOT_SUPPORTED) getting shadow copy data[^\r\n]*/gm, '')
    const status = output.match(/\bNT_STATUS_[A-Z0-9_]+\b/)
    if (status) throw Object.assign(new Error(status[0]), result)
    return result
  }

  async files(directory, signal) {
    const { stdout } = await this.command('ls', directory, signal, 8000, 8 * 1024 * 1024)
    if (!/^\s*\d+ blocks of size \d+\. \d+ blocks available\s*$/m.test(stdout)) {
      throw new Error('Elenco SMB incompleto')
    }
    const files = new Set()
    for (const [, name, attributes] of stdout.matchAll(/^ {2}(.+?\.(?:mp4|ts)) +([A-Z]*) +\d+ {2}[^\r\n]+$/gim)) {
      if (!attributes.toUpperCase().includes('D')) files.add(name.toLowerCase())
    }
    return files
  }

  url(filename, requestHost, remoteAddress) {
    const hostname = URL.parse(`http://${requestHost || ''}`)?.hostname
    const remote = isTailscale(hostname) || isTailscale(remoteAddress)
    const host = remote ? this.tailscaleHost : this.localHost
    if (!host || !this.folder) return null
    const path = [this.folder, ...this.path, filename].map(encodeURIComponent).join('/')
    return `smb://${host}/${path}`
  }

  async fileSize(directory, filename, signal) {
    try {
      const { stdout } = await this.command(`allinfo "${filename}"`, directory, signal)
      const size = stdout.match(/^stream: \[::\$DATA\],\s*(\d+) bytes\s*$/m)
      if (!size) throw new Error('Dimensione del file SMB non disponibile')
      return Number(size[1])
    } catch (err) {
      if (/NT_STATUS_(?:OBJECT_NAME_NOT_FOUND|NO_SUCH_FILE)/.test(err.stdout + err.stderr)) return null
      throw err
    }
  }

  read(filename, start, length, signal) {
    const script = fileURLToPath(new URL('./smb-read.py', import.meta.url))
    const host = this.readHost.replace(/^\[|\]$/g, '')
    const path = [this.folder, ...this.path].join('\\')
    return spawn('python3', [script, this.credentials, host, path, filename, start, length],
      { signal, stdio: ['ignore', 'pipe', 'ignore'] })
  }

  async checkWrite(directory, signal) {
    const local = `guidatv-check-${randomUUID()}.tmp`
    const staged = `${local}.part`
    const path = join(directory, local)
    await writeFile(path, 'GuidaTV\n', { flag: 'wx', mode: 0o600 })
    try {
      await this.command(`put "${local}" "${staged}"`, directory, signal, 8000)
      await this.command(`rename "${staged}" "${local}"`, directory, signal, 8000)
      if (await this.fileSize(directory, local, signal) !== 8) throw new Error('File di prova non verificato')
      await this.command(`del "${local}"`, directory, signal, 8000)
    } catch (error) {
      await Promise.allSettled([local, staged].map(name => this.command(`del "${name}"`, directory, undefined, 5000)))
      throw error
    } finally {
      await unlink(path).catch(() => {})
    }
  }

  async stage(directory, localName, filename, signal, preserveExisting = false) {
    const expected = (await stat(join(directory, localName))).size
    const existing = await this.fileSize(directory, filename, signal)
    if (existing !== null && (existing === expected || preserveExisting)) return null
    if (existing !== null) throw new Error('Il file SMB ha una dimensione diversa dalla registrazione locale')

    const staged = `${filename}.part`
    if (await this.fileSize(directory, staged, signal) !== expected) {
      await this.command(`put "${localName}" "${staged}"`, directory, signal, 7200000)
      if (await this.fileSize(directory, staged, signal) !== expected) throw new Error('Trasferimento SMB incompleto')
    }
    return expected
  }

  async promote(directory, filename, expected, signal) {
    if (expected === null) return
    await this.command(`rename "${filename}.part" "${filename}"`, directory, signal)
    if (await this.fileSize(directory, filename, signal) !== expected) throw new Error('File finale SMB non verificato')
  }

  async publish(directory, localName, filename, signal, metadata) {
    const expected = await this.stage(directory, localName, filename, signal)
    if (metadata) {
      const sidecar = `${filename}.vsmeta`
      const size = await this.stage(directory, metadata, sidecar, signal, true)
      await this.promote(directory, sidecar, size, signal)
    }
    await this.promote(directory, filename, expected, signal)
  }
}
