import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { findAppResources, readAsarFile, readInstalledVersion } from '../lib/installation.mjs'

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-install-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

// ASAR uses a padded Chromium pickle; the file body starts after that padding.
function makeAsar(files, { padding = true } = {}) {
  const entries = {}
  const bodies = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content)
    let node = entries
    const parts = name.split('/')
    for (const part of parts.slice(0, -1)) {
      node[part] ??= { files: {} }
      node = node[part].files
    }
    node[parts.at(-1)] = { size: body.length, offset: String(offset) }
    bodies.push(body)
    offset += body.length
  }
  const header = Buffer.from(JSON.stringify({ files: entries }))
  const pad = padding ? (4 - header.length % 4) % 4 : 0
  const pickle = Buffer.alloc(16)
  pickle.writeUInt32LE(4, 0)
  pickle.writeUInt32LE(header.length + pad + 8, 4)
  pickle.writeUInt32LE(header.length + pad + 4, 8)
  pickle.writeUInt32LE(header.length, 12)
  const asar = path.join(dir, 'app.asar')
  fs.writeFileSync(asar, Buffer.concat([pickle, header, Buffer.alloc(pad), ...bodies]))
  return asar
}

describe('findAppResources', () => {
  const mac = { platform: 'darwin', home: '/Users/test', env: {} }
  const win = { platform: 'win32', home: 'C:\\Users\\test', env: {} }
  const files = (...names) => (file) => names.includes(file)

  it('finds macOS system and user Applications bundles by their ASAR', () => {
    expect(findAppResources({ ...mac, exists: files('/Applications/TeleAgent.app/Contents/Resources/app.asar') }))
      .toBe('/Applications/TeleAgent.app/Contents/Resources')
    expect(findAppResources({ ...mac, exists: files('/Users/test/Applications/TeleAgent.app/Contents/Resources/app.asar') }))
      .toBe('/Users/test/Applications/TeleAgent.app/Contents/Resources')
  })

  it('finds Windows per-user installation using LOCALAPPDATA', () => {
    const resources = 'D:\\Profile\\Local\\Programs\\TeleAgent\\resources'
    expect(findAppResources({ ...win, env: { LOCALAPPDATA: 'D:\\Profile\\Local' }, exists: files(`${resources}\\app.asar`) }))
      .toBe(resources)
  })

  it('uses the Windows home directory when LOCALAPPDATA is unavailable', () => {
    const resources = 'C:\\Users\\test\\AppData\\Local\\Programs\\TeleAgent\\resources'
    expect(findAppResources({ ...win, exists: files(`${resources}\\app.asar`) })).toBe(resources)
  })

  it('finds machine-wide Windows installs in each Program Files environment location', () => {
    for (const variable of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'PROGRAMFILES']) {
      const resources = 'D:\\Apps\\TeleAgent\\resources'
      expect(findAppResources({ ...win, env: { [variable]: 'D:\\Apps' }, exists: files(`${resources}\\app.asar`) }))
        .toBe(resources)
    }
  })

  it('finds conventional Program Files locations when the variables are missing', () => {
    const resources = 'C:\\Program Files (x86)\\TeleAgent\\resources'
    expect(findAppResources({ ...win, exists: files(`${resources}\\app.asar`) })).toBe(resources)
  })

  it('accepts an explicit Windows install directory, executable, resources directory, or ASAR', () => {
    const resources = 'E:\\Custom Apps\\TeleAgent\\resources'
    for (const appPath of ['E:\\Custom Apps\\TeleAgent', 'E:\\Custom Apps\\TeleAgent\\TeleAgent.exe', resources, `${resources}\\app.asar`]) {
      expect(findAppResources({ ...win, env: { TELEAGENT_APP_PATH: appPath }, exists: files(`${resources}\\app.asar`) }))
        .toBe(resources)
    }
  })

  it('prioritizes an explicit app bundle and does not silently ignore an invalid override', () => {
    const exists = files('/Applications/TeleAgent.app/Contents/Resources/app.asar', '/Volumes/Apps/TeleAgent.app/Contents/Resources/app.asar')
    expect(findAppResources({ ...mac, env: { TELEAGENT_APP_PATH: '/Volumes/Apps/TeleAgent.app' }, exists }))
      .toBe('/Volumes/Apps/TeleAgent.app/Contents/Resources')
    expect(findAppResources({ ...mac, env: { TELEAGENT_APP_PATH: '/missing/TeleAgent.app' }, exists })).toBeUndefined()
  })

  it('does not mistake an empty installation directory or a macOS install for a Windows install', () => {
    const exists = files('C:\\Users\\test\\AppData\\Local\\Programs\\TeleAgent', '/Applications/TeleAgent.app/Contents/Resources/app.asar')
    expect(findAppResources({ ...win, exists })).toBeUndefined()
    expect(findAppResources({ platform: 'linux', env: {}, exists })).toBeUndefined()
  })
})

describe('readAsarFile', () => {
  it('reads a packed file after header padding instead of including padding in its content', () => {
    const asar = makeAsar({ 'package.json': '{"version":"2.7.1"}' })
    const raw = fs.readFileSync(asar)
    expect(raw.readUInt32LE(4) + 8).toBeGreaterThan(raw.readUInt32LE(12) + 16)
    expect(readAsarFile(asar, 'package.json')?.toString()).toBe('{"version":"2.7.1"}')
  })

  it('selects the matching runtime from nested entries', () => {
    const asar = makeAsar({ 'package.json': '{}', 'dist-electron/main-runtime-abc.js': 'runtime source' })
    expect(readAsarFile(asar, (name) => /^dist-electron\/main-runtime-.+\.js$/.test(name))?.toString())
      .toBe('runtime source')
  })

  it('rejects truncated file bodies and invalid entry offsets', () => {
    let asar = makeAsar({ 'package.json': '{"version":"2.7.1"}' })
    fs.truncateSync(asar, fs.statSync(asar).size - 1)
    expect(readAsarFile(asar, 'package.json')).toBeUndefined()

    asar = makeAsar({ 'package.json': '{}' })
    const invalid = fs.readFileSync(asar)
    const offset = invalid.indexOf(Buffer.from('"offset":"0"'))
    invalid[offset + '"offset":"'.length] = 45 // Negative offset is never an ASAR file position.
    fs.writeFileSync(asar, invalid)
    expect(readAsarFile(asar, 'package.json')).toBeUndefined()
  })

  it('bounds reads and handles malformed or missing archives without throwing', () => {
    const asar = makeAsar({ 'package.json': '12345' })
    expect(readAsarFile(asar, 'package.json', { maxBytes: 4 })).toBeUndefined()
    expect(readAsarFile(asar, 'missing.json')).toBeUndefined()
    fs.writeFileSync(asar, Buffer.from('bad archive'))
    expect(readAsarFile(asar, 'package.json')).toBeUndefined()
    expect(readAsarFile(path.join(dir, 'missing.asar'), 'package.json')).toBeUndefined()
  })
})

describe('readInstalledVersion', () => {
  it('reads the installed package version directly from ASAR', () => {
    makeAsar({ 'package.json': '{"name":"TeleAgent","version":"3.2.1-beta.2"}' })
    expect(readInstalledVersion({ resources: dir })).toBe('3.2.1-beta.2')
  })

  it('returns undefined for missing, malformed, or invalid package metadata', () => {
    for (const metadata of ['not JSON', '{}', '{"version":42}', '{"version":"2.7.1\\nHeader: bad"}', '{"version":"2.7.1\\n"}']) {
      makeAsar({ 'package.json': metadata })
      expect(readInstalledVersion({ resources: dir })).toBeUndefined()
    }
    expect(readInstalledVersion({ platform: 'win32', env: {}, exists: () => false })).toBeUndefined()
  })
})
