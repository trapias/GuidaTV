import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import base from './lcn.json' with { type: 'json' }

const clean = o => Object.fromEntries(Object.entries(o).filter(([k, v]) => !k.startsWith('_') && Number.isInteger(v) && v > 0))

// LCN predefiniti + eventuali correzioni in <dataDir>/lcn.json
export async function loadLcn(dataDir, log = console) {
  const map = clean(base)
  try {
    Object.assign(map, clean(JSON.parse(await readFile(join(dataDir, 'lcn.json'), 'utf8'))))
  } catch (e) { if (e.code !== 'ENOENT') log.warn(`lcn.json ignorato: ${e.message}`) }
  return map
}
