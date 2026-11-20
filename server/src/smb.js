import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
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
    this.args = [share, '-A', credentials, '-t', '20']
    if (ip) this.args.push('-I', ip)
    const [, host, folder] = /^\/\/([^/]+)\/([^/]+)$/.exec(share) || []
    this.localHost = host
    this.folder = folder
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
    return `smb://${host}/${encodeURIComponent(this.folder)}/${encodeURIComponent(filename)}`
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

  async publish(directory, localName, filename, signal) {
    const expected = (await stat(join(directory, localName))).size
    const existing = await this.fileSize(directory, filename, signal)
    if (existing === expected) return
    if (existing !== null) throw new Error('Il file SMB ha una dimensione diversa dalla registrazione locale')

    await this.command(`put "${localName}" "${filename}.part"`, directory, signal, 7200000)
    if (await this.fileSize(directory, `${filename}.part`, signal) !== expected) throw new Error('Trasferimento SMB incompleto')
    await this.command(`rename "${filename}.part" "${filename}"`, directory, signal)
    if (await this.fileSize(directory, filename, signal) !== expected) throw new Error('File finale SMB non verificato')
  }
}
