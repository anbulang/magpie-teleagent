import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

import { decryptWindowsBuffer, decryptWindowsString } from '../lib/windows-crypto.mjs'

const key = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex')
const wrappedKey = Buffer.from('synthetic-dpapi-wrapped-key')
let dataRoot

beforeEach(() => { dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-win-crypto-')) })
afterEach(() => { fs.rmSync(dataRoot, { recursive: true, force: true }) })

function localState(wrapped = wrappedKey) {
  fs.writeFileSync(path.join(dataRoot, 'Local State'), JSON.stringify({
    os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), wrapped]).toString('base64') },
  }))
}

function seal(plain, encryptionKey = key) {
  const nonce = Buffer.from('000102030405060708090a0b', 'hex')
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from('v10'), nonce, ciphertext, cipher.getAuthTag()])
}

const fakeUnprotect = () => key.toString('base64')

function captureError(fn) {
  try { fn() } catch (error) { return error }
  throw new Error('Expected decryption to fail')
}

describe('Windows safeStorage', () => {
  it('decrypts the v10 AES-256-GCM layout and preserves binary cookie bytes', () => {
    localState()
    const plain = Buffer.from([0, 255, 10, 128, 65])
    expect(decryptWindowsBuffer(seal(plain), { dataRoot, exec: fakeUnprotect })).toEqual(plain)
    const token = 'tenant:synthetic.JWT.示例'
    expect(decryptWindowsString(seal(Buffer.from(token)).toString('base64'), { dataRoot, exec: fakeUnprotect })).toBe(token)
  })

  it('passes only the wrapped key through stdin and bounds a hidden PowerShell process', () => {
    localState()
    let invocation
    const plain = 'test-token-never-in-argv'
    const exec = (...args) => { invocation = args; return fakeUnprotect() }
    expect(decryptWindowsString(seal(Buffer.from(plain)).toString('base64'), { dataRoot, exec })).toBe(plain)
    const [command, args, options] = invocation
    expect(command.toLowerCase()).toEndWith('powershell.exe')
    expect(args).toContain('-NoProfile')
    expect(args).toContain('-NonInteractive')
    expect(args.join(' ')).toContain('CurrentUser')
    expect(args.join(' ')).toContain('[Console]::In.ReadToEnd()')
    expect(args.join(' ')).not.toContain(wrappedKey.toString('base64'))
    expect(args.join(' ')).not.toContain(plain)
    expect(options.input).toBe(wrappedKey.toString('base64'))
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(options.windowsHide).toBe(true)
    expect(options.timeout).toBeGreaterThan(0)
    expect(options.timeout).toBeLessThanOrEqual(10000)
    expect(options.maxBuffer).toBeLessThanOrEqual(2 * 1024 * 1024)
  })

  it('does not cache the Local State key across relogin', () => {
    localState()
    expect(decryptWindowsBuffer(seal(Buffer.from('first')), { dataRoot, exec: fakeUnprotect }).toString()).toBe('first')
    const newKey = Buffer.alloc(32, 23)
    const nextWrapped = Buffer.from('next-wrapped-key')
    localState(nextWrapped)
    const exec = (_command, _args, options) => {
      expect(options.input).toBe(nextWrapped.toString('base64'))
      return newKey.toString('base64')
    }
    expect(decryptWindowsBuffer(seal(Buffer.from('second'), newKey), { dataRoot, exec }).toString()).toBe('second')
  })

  it('rejects unsupported versions and truncated ciphertext before invoking DPAPI', () => {
    const exec = () => { throw new Error('must not invoke') }
    for (const raw of [Buffer.from('v11' + 'x'.repeat(40)), Buffer.from('v20' + 'x'.repeat(40)), Buffer.from('v10short'), Buffer.alloc(0), Buffer.from('unencrypted')]) {
      const error = captureError(() => decryptWindowsBuffer(raw, { dataRoot, exec }))
      expect(error.code).toBe('decrypt_failed')
      expect(error.message).not.toContain('must not invoke')
    }
    expect(() => decryptWindowsString('not-valid-!base64', { dataRoot, exec })).toThrow()
  })

  it('fails closed for a missing, malformed, or non-DPAPI Local State key', () => {
    const raw = seal(Buffer.from('synthetic'))
    const exec = () => { throw new Error('must not invoke') }
    expect(() => decryptWindowsBuffer(raw, { dataRoot, exec })).toThrow()
    for (const content of ['{bad-json', JSON.stringify({}), JSON.stringify({ os_crypt: { encrypted_key: 'not-base64!' } }), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('APPBbad-key').toString('base64') } })]) {
      fs.writeFileSync(path.join(dataRoot, 'Local State'), content)
      const error = captureError(() => decryptWindowsBuffer(raw, { dataRoot, exec }))
      expect(error.code).toBe('decrypt_failed')
      expect(error.message).not.toContain('must not invoke')
    }
  })

  it('rejects wrong key lengths, invalid DPAPI output, and modified GCM tags', () => {
    localState()
    const raw = seal(Buffer.from('synthetic'))
    for (const output of ['not-base64!', Buffer.alloc(16).toString('base64')]) {
      expect(() => decryptWindowsBuffer(raw, { dataRoot, exec: () => output })).toThrow()
    }
    raw[raw.length - 1] ^= 1
    expect(() => decryptWindowsBuffer(raw, { dataRoot, exec: fakeUnprotect })).toThrow()
  })

  it('sanitizes child-process failures without retaining stdout, stderr, or cause', () => {
    localState()
    const secret = 'sensitive-child-output'
    const exec = () => { throw Object.assign(new Error(secret), { stdout: secret, stderr: secret, output: [null, secret, secret] }) }
    const error = captureError(() => decryptWindowsBuffer(seal(Buffer.from('synthetic')), { dataRoot, exec }))
    expect(error.code).toBe('decrypt_failed')
    expect(error.stack).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(error.cause).toBeUndefined()
    expect(error.stdout).toBeUndefined()
    expect(error.stderr).toBeUndefined()
  })

  it('supports legacy raw DPAPI buffers without opening Local State', () => {
    const raw = Buffer.concat([Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb', 'hex'), Buffer.from('synthetic')])
    const exec = (_command, _args, options) => {
      expect(options.input).toBe(raw.toString('base64'))
      return Buffer.from('legacy-plaintext').toString('base64')
    }
    expect(decryptWindowsBuffer(raw, { dataRoot, exec }).toString()).toBe('legacy-plaintext')
  })
})

// These use only generated data under the CI Windows user, never TeleAgent credentials.
describe.skipIf(process.platform !== 'win32')('Windows native DPAPI integration', () => {
  function protect(bytes) {
    const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $wrapped=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($wrapped))"
    return Buffer.from(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      input: bytes.toString('base64'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000, windowsHide: true,
    }).trim(), 'base64')
  }

  it('unwraps a native DPAPI profile key and decrypts an authenticated v10 token', () => {
    localState(protect(key))
    const plain = 'tenant:windows-native-fixture.示例'
    expect(decryptWindowsString(seal(Buffer.from(plain)).toString('base64'), { dataRoot })).toBe(plain)
  }, 15000)

  it('decrypts a native legacy DPAPI buffer', () => {
    const plain = Buffer.from('legacy-windows-fixture')
    expect(decryptWindowsBuffer(protect(plain), { dataRoot })).toEqual(plain)
  }, 15000)
})
