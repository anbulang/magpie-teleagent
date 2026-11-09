import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readCookieValues } from '../lib/portal.mjs'

// Real SQLite fixtures, entirely local: neither desktop cookies nor the network.
describe('内置 SQLite cookie 读取器', () => {
  let root, file, db, previousPath

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-sqlite-'))
    file = path.join(root, 'Cookies')
    db = new Database(file)
    db.exec("CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT DEFAULT 'agent.teleai.com.cn'); CREATE TABLE meta (key TEXT, value INTEGER); INSERT INTO meta VALUES ('version', 24)")
    previousPath = process.env.PATH
    process.env.PATH = path.join(root, 'no-commands') // Windows 上不要求预先安装 sqlite3 命令。
  })

  afterEach(() => {
    db.close(true)
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('没有 sqlite3 命令也能读取明文 cookie，源数据库保持不变', () => {
    db.query('INSERT INTO cookies (name, value, encrypted_value) VALUES (?, ?, ?)').run('operationToken', 'fixture|cookie', new Uint8Array())
    db.query('INSERT INTO cookies (name, value, encrypted_value) VALUES (?, ?, ?)').run('irrelevant', 'not-returned', new Uint8Array())
    const before = fs.readFileSync(file)
    const mtime = fs.statSync(file).mtimeMs
    const tmpDir = path.join(root, 'scratch')
    fs.mkdirSync(tmpDir)
    expect(readCookieValues(file, { tmpDir })).toEqual({ operationToken: 'fixture|cookie' })
    expect(fs.readFileSync(file)).toEqual(before)
    expect(fs.statSync(file).mtimeMs).toBe(mtime)
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })

  it('读取尚未 checkpoint 的 WAL 中的新登录 cookie', () => {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
    db.query('INSERT INTO cookies (name, value, encrypted_value) VALUES (?, ?, ?)').run('operationToken', 'fresh-login', new Uint8Array())
    expect(fs.existsSync(`${file}-wal`)).toBe(true)
    const before = fs.readFileSync(file)
    const walBefore = fs.readFileSync(`${file}-wal`)
    expect(readCookieValues(file)).toEqual({ operationToken: 'fresh-login' })
    expect(fs.readFileSync(file)).toEqual(before)
    expect(fs.readFileSync(`${file}-wal`)).toEqual(walBefore)
  })

  it('只有加密 cookie 时明确诊断为不支持，绝不把密文当登录凭据', () => {
    db.query('INSERT INTO cookies (name, value, encrypted_value) VALUES (?, ?, ?)').run('operationToken', '', Buffer.from('v10-private-cookie'))
    const logs = []
    expect(readCookieValues(file, { platform: 'darwin', log: (step, detail) => logs.push({ step, ...detail }) })).toBeNull()
    expect(logs[0]?.code).toBe('cookie_encrypted')
    expect(logs[0]?.error).toContain('加密')
    expect(JSON.stringify(logs)).not.toContain('private-cookie')
  })

  it('忽略同名但属于其他域名的 cookie', () => {
    db.query('INSERT INTO cookies VALUES (?, ?, ?, ?)').run('operationToken', 'unrelated-token', new Uint8Array(), 'unrelated.example')
    expect(readCookieValues(file)).toBeNull()
  })

  function windowsCookie({ host = '.agent.teleai.com.cn', hashedHost = host, version = 24, prefix = 'v10' } = {}) {
    const key = Buffer.alloc(32, 0x42)
    fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({
      os_crypt: { encrypted_key: Buffer.from('DPAPIfixture-key').toString('base64') },
    }))
    db.query("UPDATE meta SET value = ? WHERE key = 'version'").run(version)
    const cookie = Buffer.from('windows-fixture-cookie')
    const plain = version >= 24
      ? Buffer.concat([crypto.createHash('sha256').update(hashedHost).digest(), cookie])
      : cookie
    const nonce = Buffer.alloc(12, 0x11)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    const encrypted = Buffer.concat([Buffer.from(prefix), nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
    db.query('INSERT INTO cookies VALUES (?, ?, ?, ?)').run('operationToken', '', encrypted, host)
    return { platform: 'win32', dataRoot: root, exec: () => key.toString('base64') }
  }

  it('Windows v24 cookie 解密并验证域名哈希后才返回明文', () => {
    const options = windowsCookie()
    expect(readCookieValues(file, options)).toEqual({ operationToken: 'windows-fixture-cookie' })
  })

  it('Windows 旧版 cookie 不误删前 32 个字节', () => {
    const options = windowsCookie({ version: 23 })
    expect(readCookieValues(file, options)).toEqual({ operationToken: 'windows-fixture-cookie' })
  })

  it('Windows cookie 的域名哈希不匹配则拒绝使用', () => {
    const options = windowsCookie({ hashedHost: 'unrelated.example' })
    const logs = []
    expect(readCookieValues(file, { ...options, log: (step, detail) => logs.push({ step, ...detail }) })).toBeNull()
    expect(logs[0]?.code).toBe('cookie_host_mismatch')
    expect(JSON.stringify(logs)).not.toContain('windows-fixture-cookie')
  })

  it('Windows 不认识的 cookie 加密格式返回明确的安全错误', () => {
    const options = windowsCookie({ prefix: 'v20' })
    const logs = []
    expect(readCookieValues(file, { ...options, log: (step, detail) => logs.push({ step, ...detail }) })).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0].code).toBeTruthy()
    expect(JSON.stringify(logs)).not.toContain('windows-fixture-cookie')
  })

  it.skipIf(process.platform !== 'win32')('Windows 原生 DPAPI + SQLite 完整读取加密 cookie', () => {
    const options = windowsCookie()
    const command = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $wrapped=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($wrapped))"
    const wrapped = Buffer.from(execFileSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      input: Buffer.alloc(32, 0x42).toString('base64'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, windowsHide: true,
    }).trim(), 'base64')
    fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({
      os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), wrapped]).toString('base64') },
    }))
    expect(readCookieValues(file, { platform: options.platform, dataRoot: options.dataRoot })).toEqual({ operationToken: 'windows-fixture-cookie' })
  }, 15000)

  it('库损坏时返回不可用并清理临时快照', () => {
    db.close(true)
    fs.writeFileSync(file, 'not a SQLite database')
    const tmpDir = path.join(root, 'scratch')
    fs.mkdirSync(tmpDir)
    const logs = []
    expect(readCookieValues(file, { tmpDir, log: (step, detail) => logs.push({ step, ...detail }) })).toBeNull()
    expect(logs).toHaveLength(1)
    expect(fs.readdirSync(tmpDir)).toEqual([])
  })
})

let nodeExecutable = ''
let sqliteCLI = false
try {
  nodeExecutable = execFileSync('node', ['-e', "require('node:sqlite'); process.stdout.write(process.execPath)"], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch { /* Bun-only installations do not require a separate Node runtime. */ }
try {
  execFileSync('sqlite3', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  sqliteCLI = true
} catch { /* Optional fallback for Node 20; never a prerequisite for Bun. */ }

it.skipIf(!nodeExecutable)('Node 内置 SQLite 可在没有 sqlite3 命令时读取同一夹具', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-node-sqlite-'))
  const file = path.join(root, 'Cookies')
  const db = new Database(file)
  try {
    db.exec("CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT DEFAULT 'agent.teleai.com.cn'); CREATE TABLE meta (key TEXT, value INTEGER); INSERT INTO meta VALUES ('version', 24)")
    db.query('INSERT INTO cookies (name, value, encrypted_value) VALUES (?, ?, ?)').run('operationToken', 'node-fixture', new Uint8Array())
    db.close(true)
    const moduleURL = new URL('../lib/portal.mjs', import.meta.url).href
    const script = `import { readCookieValues } from ${JSON.stringify(moduleURL)}; process.stdout.write(JSON.stringify(readCookieValues(process.argv[1])))`
    const out = execFileSync(nodeExecutable, ['--input-type=module', '-e', script, file], {
      encoding: 'utf8', env: { ...process.env, PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(JSON.parse(out)).toEqual({ operationToken: 'node-fixture' })
  } finally {
    db.close(true)
    fs.rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(!nodeExecutable || !sqliteCLI)('无 node:sqlite 时保留只读 sqlite3 回退', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-cli-sqlite-'))
  const file = path.join(root, 'Cookies')
  const db = new Database(file)
  try {
    db.exec("CREATE TABLE cookies (name TEXT, value TEXT, encrypted_value BLOB, host_key TEXT DEFAULT 'agent.teleai.com.cn'); CREATE TABLE meta (key TEXT, value INTEGER); INSERT INTO meta VALUES ('version', 24)")
    db.query('INSERT INTO cookies (name, value, encrypted_value) VALUES (?, ?, ?)').run('operationToken', 'cli-fixture', new Uint8Array())
    db.close(true)
    const moduleURL = new URL('../lib/portal.mjs', import.meta.url).href
    const script = `import { readCookieValues } from ${JSON.stringify(moduleURL)}; process.stdout.write(JSON.stringify(readCookieValues(process.argv[1])))`
    const out = execFileSync(nodeExecutable, ['--no-experimental-sqlite', '--input-type=module', '-e', script, file], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(JSON.parse(out)).toEqual({ operationToken: 'cli-fixture' })
  } finally {
    db.close(true)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
