/**
 * Windows Electron safeStorage, verified against TeleAgent's Electron 43.1.0.
 *
 * v10 = prefix (3) + nonce (12) + AES-256-GCM ciphertext + authentication tag (16).
 * Local State stores base64("DPAPI" + DPAPI(profile key)); only that wrapped key
 * enters PowerShell, through stdin. Plaintext and keys never enter command argv.
 *
 * Pinned upstream implementation (os_crypt_win.cc restored by Electron):
 * https://github.com/electron/electron/blob/v43.1.0/patches/chromium/revert_oscrypt_remove_sync_backend.patch
 * Electron's Local State location:
 * https://github.com/electron/electron/blob/v43.1.0/shell/browser/browser_process_impl.cc
 *
 * No global key cache: reopening Local State on each call honors a new login or
 * replaced desktop profile. No app execution, file mutation, or network access.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const MAX_BYTES = 1024 * 1024
// Chromium's OSCryptTestWin.DPAPIHeader pins this four-byte version marker.
const DPAPI_HEADER = Buffer.from('01000000', 'hex')

// This script is constant. Its error handler deliberately discards exceptions:
// PowerShell/.NET errors can otherwise include sensitive input or output.
const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Security',
  '  $wrapped = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '  $clear = [System.Security.Cryptography.ProtectedData]::Unprotect($wrapped, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '  [Console]::Out.Write([Convert]::ToBase64String($clear))',
  '} catch {',
  "  [Console]::Error.Write('DPAPI decryption failed')",
  '  exit 1',
  '}',
].join('\n')

function failure(reason, message) {
  return Object.assign(new Error(message), { code: 'decrypt_failed', reason })
}

function decodeBase64(value, reason) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BYTES * 2) {
    throw failure(reason, 'Windows 凭据或密钥的 Base64 格式无效')
  }
  const result = Buffer.from(value, 'base64')
  if (result.length === 0 || result.length > MAX_BYTES || result.toString('base64') !== value) {
    throw failure(reason, 'Windows 凭据或密钥的 Base64 格式无效')
  }
  return result
}

function unprotect(wrapped, exec) {
  // Prefer the Windows system installation over a potentially unrelated PATH entry.
  const command = path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  let output
  try {
    output = exec(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', UNPROTECT_SCRIPT], {
      input: wrapped.toString('base64'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 10000,
      maxBuffer: MAX_BYTES * 2,
    })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw failure('windows_dpapi_unavailable', '找不到 Windows PowerShell，无法读取本机登录凭据')
    }
    // Never retain a child-process error as cause: it may hold stdout/stderr.
    throw failure('windows_dpapi_failed', 'Windows DPAPI 无法解密凭据；请使用登录 TeleAgent 的同一 Windows 用户')
  }
  return decodeBase64(String(output ?? '').trim(), 'windows_dpapi_invalid_output')
}

function readProfileKey(dataRoot, exec) {
  let envelope
  try {
    const file = path.join(dataRoot, 'Local State')
    if (fs.statSync(file).size > 8 * MAX_BYTES) throw new Error('oversized')
    envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw failure('windows_local_state_unavailable', '无法读取 TeleAgent 的 Local State；请先启动桌面端并登录')
  }
  const wrapped = decodeBase64(envelope?.os_crypt?.encrypted_key, 'windows_key_invalid')
  if (wrapped.length <= 5 || wrapped.subarray(0, 5).toString('ascii') !== 'DPAPI') {
    throw failure('windows_key_unsupported', 'TeleAgent 的 Windows 密钥格式不受支持，请更新插件')
  }
  const key = unprotect(wrapped.subarray(5), exec)
  if (key.length !== 32) {
    key.fill(0)
    throw failure('windows_key_invalid', 'TeleAgent 的 Windows 加密密钥长度无效')
  }
  return key
}

/** Decrypt a Chromium Windows buffer, preserving binary cookie prefixes. */
export function decryptWindowsBuffer(encryptedBuffer, { dataRoot, exec = execFileSync } = {}) {
  if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0 || encryptedBuffer.length > MAX_BYTES) {
    throw failure('windows_ciphertext_invalid', 'Windows 加密凭据为空或格式无效')
  }
  const prefix = encryptedBuffer.subarray(0, 3).toString('ascii')
  if (prefix !== 'v10') {
    // Chromium still reads legacy raw DPAPI. Recognize its fixed version header
    // explicitly so unsupported versions (v11/v20) never enter a fallback path.
    if (encryptedBuffer.length > DPAPI_HEADER.length && encryptedBuffer.subarray(0, DPAPI_HEADER.length).equals(DPAPI_HEADER)) {
      return unprotect(encryptedBuffer, exec)
    }
    throw failure('windows_ciphertext_unsupported', 'TeleAgent 的 Windows 凭据加密版本不受支持，请更新插件')
  }
  if (encryptedBuffer.length < 3 + 12 + 16) {
    throw failure('windows_ciphertext_invalid', 'Windows 加密凭据不完整')
  }
  const root = dataRoot ?? process.env.TELEAGENT_DATA ?? path.join(os.homedir(), '.local', 'share', 'TeleAgent')
  const key = readProfileKey(root, exec)
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, encryptedBuffer.subarray(3, 15))
    decipher.setAuthTag(encryptedBuffer.subarray(-16))
    return Buffer.concat([decipher.update(encryptedBuffer.subarray(15, -16)), decipher.final()])
  } catch {
    throw failure('windows_ciphertext_invalid', 'Windows 凭据解密失败，文件可能损坏或与本机密钥不匹配')
  } finally {
    key.fill(0)
  }
}

/** Decrypt token.json's base64 encryptedToken into its UTF-8 token string. */
export function decryptWindowsString(encryptedToken, options = {}) {
  return decryptWindowsBuffer(decodeBase64(encryptedToken, 'windows_ciphertext_invalid'), options).toString('utf8')
}
