/**
 * TeleAgent 本地凭据：读取 / 解密 / 校验。
 *
 * 自包含实现（解密参数见 `docs/PROTOCOL.md` 第一节）：
 *   - 只依赖 node: 内置模块；
 *   - 不再依赖 `./models.js`（路径解析内联）；
 *   - **不缓存**任何东西：`diagnoseCredential` 每次调用都重新 stat / 解密，
 *     这样「在 TeleAgent 里重新登录后，不用重启 magpie」这件事才成立。
 *
 * ## 凭据链路（全部实测）
 *
 *   1. `$APP_DATA/users/<scope>/app-auth/token.json`
 *      → `{ version, encryptedToken, scheme: "safe_storage" }`
 *   2. macOS 钥匙串条目 `TeleAgent Safe Storage`（`security find-generic-password -w`）
 *   3. PBKDF2-SHA1(password, "saltysalt", 1003, 16) → AES-128-CBC(key, IV = 16×0x20)
 *      解密 `base64(encryptedToken)[3:]`（跳过 "v10"）
 *   4. 明文 = `<tenant>:<JWT>`，JWT 里有 accountId / accountName / exp
 *
 * ## 为什么没有 refresh
 *
 * `token.json` 里**没有 refresh token**，也没有续期接口。token 有效期约 30 天，
 * 过期后只能引导用户回 TeleAgent 桌面端重新登录。插件不做假的自愈。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { decryptWindowsString } from './windows-crypto.mjs'

export const KEYCHAIN_SERVICE = 'TeleAgent Safe Storage'
export const APP_BUNDLE = '/Applications/TeleAgent.app'

/** 凭据状态枚举（值即 code，便于 UI/日志稳定匹配） */
export const CredentialState = {
  OK: 'ok',
  APP_MISSING: 'app_missing',
  DATA_MISSING: 'data_missing',
  NOT_SIGNED_IN: 'not_signed_in',
  TOKEN_FILE_MISSING: 'token_file_missing',
  KEYCHAIN_MISSING: 'keychain_missing',
  KEYCHAIN_DENIED: 'keychain_denied',
  DECRYPT_FAILED: 'decrypt_failed',
  TOKEN_MALFORMED: 'token_malformed',
  EXPIRED: 'expired',
  NOT_MACOS: 'not_macos',
}

/** 每种状态对应的用户动作 */
export const REMEDIES = {
  [CredentialState.APP_MISSING]: '安装 TeleAgent 桌面版（https://www.teleai.com.cn），并至少启动登录一次',
  [CredentialState.DATA_MISSING]: '启动一次 TeleAgent 桌面端，让它初始化数据目录',
  [CredentialState.NOT_SIGNED_IN]: '在 TeleAgent 桌面端登录',
  [CredentialState.TOKEN_FILE_MISSING]: '在 TeleAgent 桌面端登录一次；若已登录，重启桌面端让它写出凭据',
  [CredentialState.KEYCHAIN_MISSING]: '在 TeleAgent 桌面端重新登录，重建钥匙串条目',
  [CredentialState.KEYCHAIN_DENIED]: '钥匙串授权被拒绝：打开「钥匙串访问」删除 TeleAgent Safe Storage 后重新登录桌面端',
  [CredentialState.DECRYPT_FAILED]: '凭据格式与当前 TeleAgent 版本不匹配：更新桌面端后重新登录',
  [CredentialState.TOKEN_MALFORMED]: '在 TeleAgent 桌面端重新登录',
  [CredentialState.EXPIRED]: '登录已过期，在 TeleAgent 桌面端重新登录（凭据里没有 refresh token，插件无法自动续期）',
  [CredentialState.NOT_MACOS]: '本插件支持 macOS 和 Windows，尚不支持此系统的凭据解密',
}

/**
 * TeleAgent 桌面端的数据/配置目录（XDG 默认位置）。
 * Windows 桌面端同样使用用户目录下的 .local/share，而非 AppData。
 * 允许用 `TELEAGENT_DATA` / `TELEAGENT_CONFIG` 覆盖。
 */
export function appPaths(home = os.homedir()) {
  const dataRoot = process.env.TELEAGENT_DATA
    || path.join(home, '.local', 'share', 'TeleAgent')
  const configRoot = process.env.TELEAGENT_CONFIG
    || process.env.TELEAGENT_CONFIG_DIR
    || path.join(home, '.config', 'TeleAgent')
  return { home, data: dataRoot, config: configRoot }
}

/**
 * 当前登录的账号作用域目录名（`users/v1_public_<userId>`）。
 *
 * 优先读 `current-owner.json` 的 `ownerDir`；否则在 `users/` 下找
 * `token.json` **最新**的那个（换过账号时目录顺序不可靠）。
 */
export function currentScope(data = appPaths().data) {
  const ownerFile = path.join(data, 'current-owner.json')
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
    if (typeof owner?.ownerDir === 'string' && owner.ownerDir.length > 0) return owner.ownerDir
  } catch { /* 回退到目录扫描 */ }

  const usersDir = path.join(data, 'users')
  let entries = []
  try { entries = fs.readdirSync(usersDir, { withFileTypes: true }) } catch { /* 无 users 目录 */ }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const tokenFile = path.join(usersDir, entry.name, 'app-auth', 'token.json')
    try {
      const st = fs.statSync(tokenFile)
      candidates.push({ name: entry.name, mtime: st.mtimeMs })
    } catch { /* 该账号无凭据 */ }
  }
  if (candidates.length === 0) throw new Error('未找到已登录账号（缺少 app-auth/token.json）')
  if (candidates.length === 1) return candidates[0].name
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].name
}

/** 读取钥匙串密码，区分「不存在」与「被拒绝」 */
export function readKeychainPassword({ exec = execFileSync, platform = process.platform } = {}) {
  if (platform !== 'darwin') {
    return { ok: false, state: CredentialState.NOT_MACOS }
  }
  try {
    const out = exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim()
    if (out.length === 0) return { ok: false, state: CredentialState.KEYCHAIN_MISSING }
    return { ok: true, password: out }
  } catch (error) {
    const text = String(error?.stderr ?? error?.message ?? '')
    // security 找不到条目时返回 44；用户拒绝访问时通常提到 denied/canceled
    if (/could not be found|SecKeychainSearchCopyNext|44$/.test(text)) {
      return { ok: false, state: CredentialState.KEYCHAIN_MISSING }
    }
    return { ok: false, state: CredentialState.KEYCHAIN_DENIED }
  }
}

/** 解 Electron safeStorage(v10) */
export function decryptSafeStorage(encryptedToken, password) {
  const raw = Buffer.from(encryptedToken, 'base64')
  if (raw.subarray(0, 3).toString() !== 'v10') {
    const error = new Error('凭据不是 safeStorage v10 格式')
    error.code = CredentialState.DECRYPT_FAILED
    throw error
  }
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), 'saltysalt', 1003, 16, 'sha1')
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  try {
    return Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()]).toString('utf8')
  } catch {
    const error = new Error('凭据解密失败（钥匙串密码与凭据不匹配）')
    error.code = CredentialState.DECRYPT_FAILED
    throw error
  }
}

/** 解析 JWT（不校验签名，只取声明） */
export function parseClaims(token) {
  const jwt = token.includes(':') ? token.slice(token.indexOf(':') + 1) : token
  const payload = jwt.split('.')[1]
  if (!payload) {
    const error = new Error('凭据不是合法的 JWT')
    error.code = CredentialState.TOKEN_MALFORMED
    throw error
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    const error = new Error('凭据里的声明不是合法 JSON')
    error.code = CredentialState.TOKEN_MALFORMED
    throw error
  }
}

/** 读取设备指纹（签名要用；在 `$APP_DATA/app-auth/device-meta.json`） */
export function readDeviceMeta(home = os.homedir()) {
  const file = path.join(appPaths(home).data, 'app-auth', 'device-meta.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

function fail(state, detail, extra = {}) {
  return { ok: false, state, detail, remedy: REMEDIES[state], ...extra }
}

/**
 * 完整诊断。永不抛错，总是返回结构化结果。
 *
 * @returns {{
 *   state: string, ok: boolean, remedy?: string,
 *   token?: string, scope?: string, claims?: object,
 *   accountName?: string, accountId?: string, tenant?: string,
 *   expiresAt?: number, daysLeft?: number, detail: string,
 * }}
 */
export function diagnoseCredential(home = os.homedir(), { scope, keychain, exec, platform = process.platform } = {}) {
  if (platform !== 'darwin' && platform !== 'win32') {
    return fail(CredentialState.NOT_MACOS, `当前平台是 ${platform}，本插件尚未适配此平台的凭据解密`)
  }

  const paths = appPaths(home)
  if (!fs.existsSync(paths.data)) {
    return fail(CredentialState.DATA_MISSING, `数据目录不存在：${paths.data}`)
  }

  let sc = scope
  if (sc === undefined) {
    try {
      sc = currentScope(paths.data)
    } catch (error) {
      return fail(CredentialState.NOT_SIGNED_IN, String(error?.message ?? error))
    }
  }

  const tokenFile = path.join(paths.data, 'users', sc, 'app-auth', 'token.json')
  if (!fs.existsSync(tokenFile)) {
    return fail(CredentialState.TOKEN_FILE_MISSING, `凭据文件不存在：${tokenFile}`, { scope: sc })
  }

  let envelope
  try {
    envelope = JSON.parse(fs.readFileSync(tokenFile, 'utf8'))
  } catch (error) {
    return fail(CredentialState.DECRYPT_FAILED, `凭据文件无法解析：${String(error?.message ?? error)}`, { scope: sc })
  }
  if (typeof envelope?.encryptedToken !== 'string' || envelope.encryptedToken.length === 0) {
    return fail(CredentialState.TOKEN_FILE_MISSING, '凭据文件里没有 encryptedToken', { scope: sc })
  }

  let token
  try {
    if (platform === 'win32') {
      token = decryptWindowsString(envelope.encryptedToken, { dataRoot: paths.data, exec })
    } else {
      const kc = keychain ?? readKeychainPassword({ exec, platform })
      if (!kc.ok) {
        return fail(kc.state, kc.state === CredentialState.KEYCHAIN_MISSING
          ? `钥匙串里没有 ${KEYCHAIN_SERVICE} 条目`
          : `无法读取钥匙串条目 ${KEYCHAIN_SERVICE}`, { scope: sc })
      }
      token = decryptSafeStorage(envelope.encryptedToken, kc.password)
    }
  } catch (error) {
    return fail(error?.code ?? CredentialState.DECRYPT_FAILED, String(error?.message ?? error), { scope: sc })
  }

  let claims
  try {
    claims = parseClaims(token)
  } catch (error) {
    return fail(error?.code ?? CredentialState.TOKEN_MALFORMED, String(error?.message ?? error), { scope: sc })
  }

  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  const daysLeft = expiresAt === undefined ? undefined : Math.floor((expiresAt - Date.now()) / 86_400_000)
  const base = {
    ok: true,
    token,
    scope: sc,
    claims,
    accountName: claims.accountName,
    accountId: claims.accountId,
    tenant: claims.tenant,
    expiresAt,
    daysLeft,
  }

  if (expiresAt !== undefined && expiresAt < Date.now()) {
    return {
      ...base,
      ok: false,
      state: CredentialState.EXPIRED,
      remedy: REMEDIES[CredentialState.EXPIRED],
      detail: `登录已于 ${new Date(expiresAt).toISOString().slice(0, 10)} 过期`,
    }
  }

  const who = claims.accountName ?? claims.accountId ?? '未知账号'
  return {
    ...base,
    state: CredentialState.OK,
    detail: daysLeft === undefined ? `已登录：${who}` : `已登录：${who}，剩余 ${daysLeft} 天`,
  }
}

/** 列出本机所有**有凭据**的账号（用于登录时让用户选一个） */
export function listCredentialScopes(home = os.homedir()) {
  const usersDir = path.join(appPaths(home).data, 'users')
  let entries = []
  try { entries = fs.readdirSync(usersDir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const tokenFile = path.join(usersDir, entry.name, 'app-auth', 'token.json')
    try {
      const st = fs.statSync(tokenFile)
      out.push({ scope: entry.name, mtime: st.mtimeMs })
    } catch { /* 无凭据 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((x) => x.scope)
}
