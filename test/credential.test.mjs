/**
 * 凭据读取的单元测试。
 *
 * **不碰真实钥匙串、不碰真实账号**：用临时 HOME 造假的 `token.json`，
 * 钥匙串密码和 `security` 命令都用注入的假实现。
 *
 * 真实凭据的解密链路（safeStorage v10）在这里用一个自己加密的样本验证：
 * 只要加解密对称、claims 能解析、过期能识别，就覆盖了插件这条路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  appPaths,
  currentScope,
  decryptSafeStorage,
  parseClaims,
  diagnoseCredential,
  listCredentialScopes,
  readKeychainPassword,
  CredentialState,
} from '../lib/credential.mjs'

let home = ''

/** 造一个 safeStorage v10 凭据（与 Electron 同样的 KDF/IV） */
function sealV10(plain, password) {
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), 'saltysalt', 1003, 16, 'sha1')
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), body]).toString('base64')
}

/** 造一个 JWT（只填 claims，签名随便） */
function jwt(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'HS256' })}.${enc(claims)}.sig`
}

function writeAccount(scope, { password = 'pw-1', claims, raw } = {}) {
  const dir = path.join(home, '.local', 'share', 'TeleAgent', 'users', scope, 'app-auth')
  fs.mkdirSync(dir, { recursive: true })
  const plain = raw ?? `tenant:${jwt(claims ?? { accountName: '示例账号', accountId: '123', exp: Math.floor(Date.now() / 1000) + 86400 * 20 })}`
  const encryptedToken = raw === undefined ? sealV10(plain, password) : plain
  fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({
    version: 1,
    encryptedToken,
    encrypted: true,
    scheme: 'safe_storage',
  }))
  return dir
}

const okKeychain = { ok: true, password: 'pw-1' }

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'te-magpie-cred-'))
  // 让 appPaths 指向临时目录
  process.env.TELEAGENT_DATA = path.join(home, '.local', 'share', 'TeleAgent')
  process.env.TELEAGENT_CONFIG = path.join(home, '.config', 'TeleAgent')
})

afterEach(() => {
  delete process.env.TELEAGENT_DATA
  delete process.env.TELEAGENT_CONFIG
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('appPaths', () => {
  it('默认指向 TeleAgent 的 XDG 位置', () => {
    delete process.env.TELEAGENT_DATA
    delete process.env.TELEAGENT_CONFIG
    const p = appPaths('/Users/someone')
    expect(p.data).toBe('/Users/someone/.local/share/TeleAgent')
    expect(p.config).toBe('/Users/someone/.config/TeleAgent')
    process.env.TELEAGENT_DATA = path.join(home, '.local', 'share', 'TeleAgent')
    process.env.TELEAGENT_CONFIG = path.join(home, '.config', 'TeleAgent')
  })

  it('可以用 TELEAGENT_DATA 覆盖（测试与非常规安装）', () => {
    expect(appPaths(home).data).toBe(path.join(home, '.local', 'share', 'TeleAgent'))
  })
})

describe('currentScope', () => {
  it('优先读 current-owner.json', () => {
    const data = path.join(home, '.local', 'share', 'TeleAgent')
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(data, 'current-owner.json'), JSON.stringify({ ownerDir: 'v1_public_9' }))
    expect(currentScope(data)).toBe('v1_public_9')
  })

  it('没有 owner 文件时选 token.json 最新的账号', async () => {
    const data = path.join(home, '.local', 'share', 'TeleAgent')
    writeAccount('v1_public_1')
    await new Promise((r) => setTimeout(r, 12))
    writeAccount('v1_public_2')
    expect(currentScope(data)).toBe('v1_public_2')
  })

  it('一个账号都没有时抛错（由调用方翻译成「未登录」）', () => {
    const data = path.join(home, '.local', 'share', 'TeleAgent')
    fs.mkdirSync(data, { recursive: true })
    expect(() => currentScope(data)).toThrow()
  })
})

describe('decryptSafeStorage', () => {
  it('能解自己封的样本', () => {
    const sealed = sealV10('tenant:jwt', 'pw-1')
    expect(decryptSafeStorage(sealed, 'pw-1')).toBe('tenant:jwt')
  })

  it('密码不对时抛 DECRYPT_FAILED', () => {
    const sealed = sealV10('tenant:jwt', 'pw-1')
    try {
      decryptSafeStorage(sealed, 'wrong')
      throw new Error('应该抛错')
    } catch (error) {
      expect(error.code).toBe(CredentialState.DECRYPT_FAILED)
    }
  })

  it('不是 v10 前缀时抛 DECRYPT_FAILED', () => {
    try {
      decryptSafeStorage(Buffer.from('v99xx').toString('base64'), 'pw-1')
      throw new Error('应该抛错')
    } catch (error) {
      expect(error.code).toBe(CredentialState.DECRYPT_FAILED)
    }
  })
})

describe('parseClaims', () => {
  it('剥掉 "<tenant>:" 前缀', () => {
    const token = `Em9xR4:${jwt({ accountId: '42' })}`
    expect(parseClaims(token).accountId).toBe('42')
  })

  it('没有前缀也能解析', () => {
    expect(parseClaims(jwt({ accountId: '43' })).accountId).toBe('43')
  })

  it('不是 JWT 时抛 TOKEN_MALFORMED', () => {
    try {
      parseClaims('not-a-jwt')
      throw new Error('应该抛错')
    } catch (error) {
      expect(error.code).toBe(CredentialState.TOKEN_MALFORMED)
    }
  })
})

describe('diagnoseCredential', () => {
  it('缺少 TeleAgent 数据目录 → DATA_MISSING（若不是 macOS 会是 NOT_MACOS）', () => {
    const d = diagnoseCredential(home, { keychain: okKeychain })
    if (process.platform !== 'darwin') {
      expect(d.state).toBe(CredentialState.NOT_MACOS)
    } else {
      expect(d.state).toBe(CredentialState.DATA_MISSING)
      expect(d.remedy).toBeTruthy()
    }
    expect(d.ok).toBe(false)
  })

  it('没有 token.json → TOKEN_FILE_MISSING / NOT_SIGNED_IN', () => {
    fs.mkdirSync(path.join(home, '.local', 'share', 'TeleAgent', 'users'), { recursive: true })
    const d = diagnoseCredential(home, { keychain: okKeychain })
    if (process.platform !== 'darwin') {
      expect(d.state).toBe(CredentialState.NOT_MACOS)
    } else {
      expect([CredentialState.NOT_SIGNED_IN, CredentialState.TOKEN_FILE_MISSING]).toContain(d.state)
      expect(d.ok).toBe(false)
    }
  })

  it('钥匙串没有条目 → KEYCHAIN_MISSING，并给出可执行建议', () => {
    writeAccount('v1_public_2092131099330392064')
    const d = diagnoseCredential(home, {
      scope: 'v1_public_2092131099330392064',
      keychain: { ok: false, state: CredentialState.KEYCHAIN_MISSING },
    })
    if (process.platform !== 'darwin') {
      expect(d.state).toBe(CredentialState.NOT_MACOS)
    } else {
      expect(d.state).toBe(CredentialState.KEYCHAIN_MISSING)
      expect(d.remedy).toContain('钥匙串')
    }
  })

  it('正常凭据 → ok，带账号名与剩余天数', () => {
    const scope = 'v1_public_2092131099330392064'
    writeAccount(scope)
    const d = diagnoseCredential(home, { scope, keychain: okKeychain })
    if (process.platform !== 'darwin') {
      expect(d.state).toBe(CredentialState.NOT_MACOS)
      return
    }
    expect(d.ok).toBe(true)
    expect(d.state).toBe(CredentialState.OK)
    expect(d.accountName).toBe('示例账号')
    expect(d.scope).toBe(scope)
    expect(d.daysLeft).toBeGreaterThan(10)
    expect(d.token).toContain(':')
  })

  it('过期凭据 → EXPIRED，且说明无法自动续期', () => {
    const scope = 'v1_public_2092131099330392064'
    writeAccount(scope, { claims: { accountName: '过期账号', exp: Math.floor(Date.now() / 1000) - 3600 } })
    const d = diagnoseCredential(home, { scope, keychain: okKeychain })
    if (process.platform !== 'darwin') return
    expect(d.ok).toBe(false)
    expect(d.state).toBe(CredentialState.EXPIRED)
    expect(d.remedy).toContain('重新登录')
    // token 仍然返回来（用于诊断/日志），但 ok 是 false
    expect(d.token).toBeTruthy()
  })

  it('凭据文件损坏 → DECRYPT_FAILED（不抛）', () => {
    const scope = 'v1_public_1'
    const dir = path.join(home, '.local', 'share', 'TeleAgent', 'users', scope, 'app-auth')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'token.json'), '{ not json')
    const d = diagnoseCredential(home, { scope, keychain: okKeychain })
    if (process.platform !== 'darwin') return
    expect(d.ok).toBe(false)
    expect(d.state).toBe(CredentialState.DECRYPT_FAILED)
  })

  it('永不抛错（缺 app / 缺目录 / 缺文件都返回结构）', () => {
    for (const scope of ['', 'v1_public_missing']) {
      const d = diagnoseCredential(home, { scope: scope || undefined, keychain: okKeychain })
      expect(typeof d).toBe('object')
      expect(typeof d.state).toBe('string')
      expect(typeof d.detail).toBe('string')
    }
  })
})

describe('listCredentialScopes', () => {
  it('只列有 token.json 的账号，新的在前', async () => {
    fs.mkdirSync(path.join(home, '.local', 'share', 'TeleAgent', 'users', 'v1_public_empty'), { recursive: true })
    writeAccount('v1_public_1')
    await new Promise((r) => setTimeout(r, 12))
    writeAccount('v1_public_2')
    const scopes = listCredentialScopes(home)
    expect(scopes).toEqual(['v1_public_2', 'v1_public_1'])
  })

  it('目录不存在时返回空数组（不抛）', () => {
    expect(listCredentialScopes(home)).toEqual([])
  })
})

describe('readKeychainPassword', () => {
  it('区分「没有条目」与「被拒绝」', () => {
    const notFound = () => { const e = new Error('Command failed'); e.stderr = 'security: SecKeychainSearchCopyNext: could not be found.'; throw e }
    const denied = () => { const e = new Error('Command failed'); e.stderr = 'User interaction is not allowed. (-25308)'; throw e }
    const ok = () => Buffer.from('pw\n')
    if (process.platform !== 'darwin') {
      expect(readKeychainPassword({ exec: ok }).state).toBe(CredentialState.NOT_MACOS)
      return
    }
    expect(readKeychainPassword({ exec: notFound }).state).toBe(CredentialState.KEYCHAIN_MISSING)
    expect(readKeychainPassword({ exec: denied }).state).toBe(CredentialState.KEYCHAIN_DENIED)
    expect(readKeychainPassword({ exec: ok })).toEqual({ ok: true, password: 'pw' })
  })
})
