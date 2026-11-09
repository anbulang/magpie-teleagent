import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAX_ASAR_BYTES = 64 * 1024 * 1024

/**
 * Locate an installed Electron resources directory by its app.asar.
 * TELEAGENT_APP_PATH may point to a bundle, install directory, exe, resources,
 * or app.asar. An explicit override is authoritative, including when missing.
 * Default Windows locations are installer candidates, not a fixed contract.
 */
export function findAppResources({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  exists = fs.existsSync,
  appPath,
} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const envValue = (name) => {
    const key = platform === 'win32'
      ? Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())
      : name
    return typeof env[key] === 'string' ? env[key].trim() : ''
  }
  const explicit = appPath ?? envValue('TELEAGENT_APP_PATH')
  const installs = []
  if (explicit) {
    installs.push(explicit)
  } else if (platform === 'darwin') {
    installs.push('/Applications/TeleAgent.app', paths.join(home, 'Applications', 'TeleAgent.app'))
  } else if (platform === 'win32') {
    const local = envValue('LOCALAPPDATA') || paths.join(home, 'AppData', 'Local')
    const drive = envValue('SystemDrive') || 'C:'
    installs.push(paths.join(local, 'Programs', 'TeleAgent'))
    for (const root of [
      envValue('ProgramW6432'),
      envValue('ProgramFiles') || paths.join(drive, '\\', 'Program Files'),
      envValue('ProgramFiles(x86)') || paths.join(drive, '\\', 'Program Files (x86)'),
    ]) {
      if (root) installs.push(paths.join(root, 'TeleAgent'))
    }
  }

  for (const install of new Set(installs)) {
    const extension = paths.extname(install).toLowerCase()
    const base = extension === '.exe' || extension === '.asar' ? paths.dirname(install) : install
    const candidates = platform === 'darwin'
      ? [paths.join(base, 'Contents', 'Resources'), paths.join(base, 'resources'), base]
      : [paths.join(base, 'resources'), base]
    for (const resources of candidates) {
      try {
        if (exists(paths.join(resources, 'app.asar'))) return resources
      } catch { /* Unreadable candidate; continue discovery. */ }
    }
  }
  return undefined
}

/** Read one packed ASAR entry without extracting or executing the archive. */
export function readAsarFile(asar, selectFile, { maxBytes = MAX_ASAR_BYTES } = {}) {
  let fd
  try {
    fd = fs.openSync(asar, 'r')
    const archiveSize = fs.fstatSync(fd).size
    const read = (length, position) => {
      if (!Number.isSafeInteger(length) || length < 0 || position + length > archiveSize) return undefined
      const buffer = Buffer.alloc(length)
      let total = 0
      while (total < length) {
        const count = fs.readSync(fd, buffer, total, length - total, position + total)
        if (count === 0) return undefined
        total += count
      }
      return buffer
    }
    const pickle = read(16, 0)
    if (!pickle || pickle.readUInt32LE(0) !== 4) return undefined
    const headerSize = pickle.readUInt32LE(4)
    const jsonLength = pickle.readUInt32LE(12)
    if (jsonLength === 0 || jsonLength > MAX_ASAR_BYTES
      || headerSize < jsonLength + 8 || headerSize > jsonLength + 11
      || pickle.readUInt32LE(8) !== headerSize - 4) return undefined
    const raw = read(jsonLength, 16)
    if (!raw) return undefined
    const header = JSON.parse(raw.toString('utf8'))
    const matches = typeof selectFile === 'string' ? (name) => name === selectFile : selectFile
    const find = (node, prefix = '', depth = 0) => {
      if (depth > 32) return undefined
      for (const [name, meta] of Object.entries(node?.files ?? {})) {
        const full = prefix ? `${prefix}/${name}` : name
        if (meta?.files) {
          const found = find(meta, full, depth + 1)
          if (found) return found
        } else if (matches(full)) {
          return meta
        }
      }
      return undefined
    }
    const entry = find(header)
    if (!entry || entry.unpacked || entry.link) return undefined
    const size = entry.size
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0
      || !Number.isSafeInteger(size) || size < 0 || size > maxBytes) return undefined
    if (typeof entry.offset !== 'string' || !/^\d+$/.test(entry.offset)) return undefined
    const offset = Number(entry.offset)
    const base = 8 + headerSize // The JSON pickle can have 0–3 bytes of padding.
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > archiveSize - base - size) return undefined
    return read(size, base + offset)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* Ignore close failures. */ } }
  }
}

/** Read version metadata on both platforms without invoking macOS defaults. */
export function readInstalledVersion(options = {}) {
  const resources = options.resources ?? findAppResources(options)
  if (!resources) return undefined
  const raw = readAsarFile(path.join(resources, 'app.asar'), 'package.json', { maxBytes: 1024 * 1024 })
  if (!raw) return undefined
  try {
    const version = JSON.parse(raw.toString('utf8'))?.version
    return typeof version === 'string' && /^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
      ? version : undefined
  } catch {
    return undefined
  }
}
