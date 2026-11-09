import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { appPaths, diagnoseCredential, CredentialState } from '../lib/credential.mjs'

describe('Windows 凭据诊断', () => {
  let home, data, previous
  const key = Buffer.alloc(32, 0x42)
  beforeEach(() => {
    previous = Object.fromEntries(['TELEAGENT_DATA', 'TELEAGENT_CONFIG'].map(k => [k, process.env[k]]))
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-win-credential-'))
    data = path.join(home, '用户 data')
    process.env.TELEAGENT_DATA = data
    process.env.TELEAGENT_CONFIG = path.join(home, 'config')
    fs.mkdirSync(path.join(data, 'users', 'v1_public_42', 'app-auth'), { recursive: true })
    fs.writeFileSync(path.join(data, 'current-owner.json'), JSON.stringify({ ownerDir: 'v1_public_42' }))
    fs.writeFileSync(path.join(data, 'Local State'), JSON.stringify({
      os_crypt: { encrypted_key: Buffer.from('DPAPIfixture-protected-key').toString('base64') },
    }))
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(home, { recursive: true, force: true })
  })
  function seal(exp = 4102444800) {
    const claims = Buffer.from(JSON.stringify({ accountId: '42', accountName: 'Windows 账号', exp })).toString('base64url')
    const token = `tenant:eyJhbGciOiJIUzI1NiJ9.${claims}.signature`
    const nonce = Buffer.alloc(12, 7)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    const encryptedToken = Buffer.concat([Buffer.from('v10'), nonce, cipher.update(token), cipher.final(), cipher.getAuthTag()]).toString('base64')
    fs.writeFileSync(path.join(data, 'users', 'v1_public_42', 'app-auth', 'token.json'), JSON.stringify({
      version: 1, encryptedToken, encrypted: true, scheme: 'safe_storage',
    }))
    return token
  }
  function unprotect() { return key.toString('base64') }

  it('通过 Windows 解密器读取当前账号，正常解析 JWT', () => {
    const token = seal()
    const result = diagnoseCredential(home, { platform: 'win32', exec: unprotect })
    expect(result.ok).toBe(true)
    expect(result.token).toBe(token)
    expect(result.accountName).toBe('Windows 账号')
    expect(result.scope).toBe('v1_public_42')
  })
  it('Windows token 过期仍返回 EXPIRED', () => {
    seal(1)
    expect(diagnoseCredential(home, { platform: 'win32', exec: unprotect }).state).toBe(CredentialState.EXPIRED)
  })
  it('Windows 密钥解锁失败时返回结构化错误，不泄漏子进程输出', () => {
    seal()
    const result = diagnoseCredential(home, { platform: 'win32', exec: () => {
      throw Object.assign(new Error('secret-fixture-token'), { stderr: 'secret-fixture-token' })
    } })
    expect(result.ok).toBe(false)
    expect(result.state).toBe(CredentialState.DECRYPT_FAILED)
    expect(JSON.stringify(result)).not.toContain('secret-fixture-token')
  })
  it('未知系统不尝试任何平台解密', () => {
    seal()
    const result = diagnoseCredential(home, { platform: 'linux', exec: () => { throw new Error('unexpected') } })
    expect(result.ok).toBe(false)
    expect(result.state).toBe(CredentialState.NOT_MACOS)
  })
  it('HOME 缺失时仍以系统主目录定位数据，不退化为相对路径', () => {
    const old = process.env.HOME
    const dataOverride = process.env.TELEAGENT_DATA
    try {
      delete process.env.HOME
      delete process.env.TELEAGENT_DATA
      const paths = appPaths()
      expect(path.isAbsolute(paths.home)).toBe(true)
      expect(paths.data).toBe(path.join(os.homedir(), '.local', 'share', 'TeleAgent'))
    } finally {
      if (old === undefined) delete process.env.HOME
      else process.env.HOME = old
      process.env.TELEAGENT_DATA = dataOverride
    }
  })
})
