import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** Synthetic Electron credentials; Windows uses native DPAPI so CI exercises the OS boundary. */
export function sealFixture(plain, password, dataRoot) {
  if (process.platform === 'win32') {
    const key = Buffer.alloc(32, 0x42)
    const script = "Add-Type -AssemblyName System.Security; $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)))"
    const protectedKey = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: key.toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    fs.mkdirSync(dataRoot, { recursive: true })
    fs.writeFileSync(path.join(dataRoot, 'Local State'), JSON.stringify({
      os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from(protectedKey, 'base64')]).toString('base64') },
    }))
    const nonce = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
    return Buffer.concat([Buffer.from('v10'), nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString('base64')
  }
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]).toString('base64')
}
