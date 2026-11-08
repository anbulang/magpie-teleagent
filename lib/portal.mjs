/**
 * TeleAgent「积分福利社」portal 客户端（magpie 插件版）。
 *
 * 自包含实现（协议见 `docs/PROTOCOL.md` 第三节），三个设计要点：
 *
 *   1. 只依赖 node: 内置模块；
 *   2. 不再依赖 `./models.js` / `./bootlog.js`——路径解析（appPaths/currentScope）
 *      直接内联在本文件里，日志改为**可选注入**（默认完全不打印）；
 *   3. 网络与 sqlite 读取都可注入：`portalRequest(..., { fetchImpl })`、
 *      `readCookieValues(dbPath, { run })`。测试因此可以完全不联网、不碰真实
 *      sqlite、不触发任何真实领取接口。
 *
 * ## 与聊天网关的区别
 *
 * 聊天走 `https://agent.teleai.com.cn/superCowork/sapi`，需要两步 HMAC 签名。
 * 积分走的是**另一个服务** `https://agent.teleai.com.cn/meter/super-agent/user/portal`，
 * 由桌面端渲染层直接调用，鉴权是 **cookie + 请求头**，不签名：
 *
 *   X-Token: <operationToken>      （agent.teleai.com.cn 域下的 cookie）
 *   userId:  <userId>              （账号目录名 v1_public_<userId> 的尾段）
 *   Cookie:  operToken=…;  operationToken=…
 *
 * ## 为什么读 cookie 而不是别的
 *
 * 桌面端把每个账号的 cookie 存在独立分区：
 *   ~/.local/share/TeleAgent/Partitions/owner%3A<scope>/Cookies
 * 这是 Chromium 的 SQLite cookie 库。实测该实例把值**明文存在 `value` 列**
 * （`encrypted_value` 为空），因此不需要钥匙串解密即可读取。若将来改成加密存储，
 * 这里会读不到值并显式返回 null（余额显示不可用），而不是静默返回错误余额。
 *
 * ## 隐私
 *
 * 本模块**不打印任何 cookie / token / 账号名**。日志回调只收到阶段名和
 * 脱敏后的错误摘要；默认日志函数是空实现。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** portal 服务根地址（注意：不是聊天网关） */
export const PORTAL_BASE = 'https://agent.teleai.com.cn/meter/super-agent/user/portal'

/** 只取 portal 需要的两个 cookie（sqlite3 里 cookies 表的列：name / value） */
export const COOKIE_SQL = "select name,value from cookies where name in ('operationToken','operToken')"

/** 默认日志：不打印任何东西。可注入 `(step, detail) => void` 接管。 */
const noopLog = () => {}

// ---------------------------------------------------------------- 路径解析
// 内联自 lib/models.js。不要新建 lib/models.mjs，避免与插件其他模块冲突。

/**
 * TeleAgent 桌面端的数据/配置目录。
 * @param {string} [home]
 */
export function appPaths(home = process.env.HOME ?? '') {
  return {
    home,
    data: path.join(home, '.local', 'share', 'TeleAgent'),
    config: path.join(home, '.config', 'TeleAgent'),
  }
}

/**
 * 当前登录的账号作用域目录名。
 *
 * 优先读 `current-owner.json` 的 `ownerDir`；否则在 `users/` 下找带
 * `app-auth/token.json` 的目录，多个账号时取 token.json **最新**的那个
 * ——不能依赖目录顺序，否则换账号后可能仍读到旧账号的凭据。
 *
 * @param {string} [data] TeleAgent 数据目录
 * @returns {string} 账号目录名（形如 `v1_public_<userId>`）
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

// ---------------------------------------------------------------- 纯函数

/**
 * 从账号目录名 `v1_public_<userId>` 取 userId。
 * 非法输入返回空串（调用方据此判断"没有可用账号"）。
 * @param {string} [scope]
 * @returns {string}
 */
export function userIdFromScope(scope) {
  const m = /^v\d+_public_(\d+)$/.exec(scope ?? '')
  if (m) return m[1]
  const tail = (scope ?? '').split('_').pop() ?? ''
  return /^\d+$/.test(tail) ? tail : ''
}

/**
 * 账号 cookie 库的候选路径（按优先级）。
 *
 * 主 cookie 库 `.../TeleAgent/Cookies` **只在没有指定账号时**才兜底：
 * 指定了账号却回落到主库，会把当前账号的凭据当成别人的，余额就串了。
 *
 * @param {string} [home]
 * @param {string} [scope] 账号目录名；省略表示"当前账号"
 * @returns {string[]}
 */
export function cookieDbCandidates(home = process.env.HOME ?? '', scope) {
  const userData = path.join(home, '.local', 'share', 'TeleAgent')
  const candidates = []
  const hasScope = typeof scope === 'string' && scope !== ''
  if (hasScope) {
    candidates.push(path.join(userData, 'Partitions', `owner%3A${scope}`, 'Cookies'))
    candidates.push(path.join(userData, 'Partitions', `owner:${scope}`, 'Cookies'))
  }
  if (!hasScope) candidates.push(path.join(userData, 'Cookies'))
  return candidates
}

/**
 * 找到第一个真实存在的 cookie 库路径。
 * @param {string} [home]
 * @param {string} [scope]
 * @returns {string|null}
 */
export function findCookieDb(home = process.env.HOME ?? '', scope) {
  for (const dbPath of cookieDbCandidates(home, scope)) {
    try {
      if (fs.existsSync(dbPath)) return dbPath
    } catch { /* 继续下一个候选 */ }
  }
  return null
}

// ---------------------------------------------------------------- cookie 读取

/** 默认 sqlite 读取器：只读打开临时副本，stderr 必须 pipe（不能漏到终端）。 */
function defaultRun({ dbPath, sql }) {
  return execFileSync('sqlite3', ['-readonly', dbPath, sql], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 从 sqlite3 的 `name|value` 行输出里解析 cookie。 */
function parseCookieLines(stdout) {
  const out = {}
  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.includes('|')) continue
    const idx = line.indexOf('|')
    const name = line.slice(0, idx)
    const value = line.slice(idx + 1)
    if (name && value) out[name] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 把异常压成脱敏摘要：只留 stderr / message / code。
 *
 * `execFileSync` 的失败常把真正的 sqlite 报错放在 `stderr`（`message` 只有
 * "Command failed: sqlite3 ..."），识别 `no such table` 必须把它带上，
 * 否则真实的空库会被误判成故障并记日志。
 */
function errorSummary(error) {
  const parts = []
  const stderr = String(error?.stderr ?? '').trim()
  if (stderr) parts.push(stderr)
  const message = String(error?.message ?? error ?? '').trim()
  if (message && !parts.some((p) => p.includes(message))) parts.push(message)
  const code = error?.code ? ` [code=${error.code}]` : ''
  return parts.join(' ').trim() + code
}

/**
 * 复制 cookie 库到临时文件后读取（桌面端运行时会锁住原文件）。只取两个 cookie。
 *
 * ## 「没有 cookies 表」是空状态，不是错误
 *
 * 下列情况都会让 SQLite 报 `no such table: cookies`，但都属于**正常的空状态**：
 *   - 文件是空文件（Chromium 还没初始化过 Cookie 库，测试夹具也用它）
 *   - 桌面端正在写入，复制出来的是不完整快照
 *   - 该 Partition 从未登录过、根本没写过 cookie
 *
 * 这时调用方本来就按"没有凭据"降级，所以不该记 Error，更不该把 sqlite3 的
 * stderr 漏到控制台（execFileSync 默认继承 stderr）。真正的故障——sqlite3
 * 不存在（ENOENT）、文件不可读、库损坏（`file is not a database`）——仍然
 * 交给注入的日志函数，因为那确实需要排查。
 *
 * @param {string} dbPath
 * @param {{ run?: (arg: { dbPath: string, sql: string }) => string,
 *           log?: (step: string, detail?: unknown) => void,
 *           tmpDir?: string }} [options]
 * @returns {{ [cookieName: string]: string } | null}
 */
export function readCookieValues(dbPath, { run = defaultRun, log = noopLog, tmpDir } = {}) {
  if (typeof dbPath !== 'string' || dbPath === '') return null
  try {
    if (!fs.existsSync(dbPath)) return null
  } catch {
    return null
  }

  const dir = tmpDir ?? os.tmpdir()
  const tmp = path.join(
    dir,
    `magpie-ck-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  )

  try {
    fs.copyFileSync(dbPath, tmp)
    // 注入的读取器也可能是 async（返回 Promise），但默认实现是同步的；
    // 这里保持同步语义，Promise 会被 String() 成 "[object Promise]" 而非静默成功。
    const stdout = run({ dbPath: tmp, sql: COOKIE_SQL })
    return parseCookieLines(stdout)
  } catch (error) {
    const detail = errorSummary(error)
    // 空库 / 未初始化 / 快照不完整 → 静默当作"没有 cookie"
    if (/no such table/i.test(detail)) return null
    log('portal cookie 读取失败', { error: detail })
    return null
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败不影响结果 */ }
  }
}

/**
 * 读取某个账号的 portal 凭据。
 *
 * @param {string} [home]
 * @param {string} [explicitScope] 指定账号目录名；省略则用当前账号
 * @param {{ run?: Function, log?: Function, tmpDir?: string }} [options]
 * @returns {{userId: string, operationToken: string, operToken: string, source: string} | null}
 */
export function readPortalAuth(home = process.env.HOME ?? '', explicitScope, { run, log = noopLog, tmpDir } = {}) {
  if (typeof home !== 'string' || home === '') return null

  let scope = ''
  if (typeof explicitScope === 'string' && explicitScope !== '') {
    scope = explicitScope
  } else {
    try { scope = currentScope(appPaths(home).data) } catch { return null }
  }

  const userId = userIdFromScope(scope)
  if (!userId) return null

  for (const dbPath of cookieDbCandidates(home, explicitScope)) {
    const cookies = readCookieValues(dbPath, { run, log, tmpDir })
    if (cookies?.operationToken) {
      return {
        userId,
        operationToken: cookies.operationToken,
        operToken: cookies.operToken ?? '',
        source: dbPath,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------- HTTP

/**
 * 调 portal 接口。返回 `{ ok, status, json, error }`，**永不抛错**。
 *
 * @param {{userId: string, operationToken: string, operToken?: string}} auth
 * @param {string} apiPath 形如 `/points/detail`
 * @param {{ query?: Record<string, unknown>, timeoutMs?: number,
 *           fetchImpl?: typeof fetch, baseUrl?: string,
 *           log?: (step: string, detail?: unknown) => void }} [options]
 */
export async function portalRequest(auth, apiPath, {
  query,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
  baseUrl = PORTAL_BASE,
  log = noopLog,
} = {}) {
  try {
    const url = new URL(baseUrl + apiPath)
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))

    const headers = {
      'X-Token': auth?.operationToken ?? '',
      userId: auth?.userId ?? '',
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 TeleAgent',
      Referer: 'https://agent.teleai.com.cn/teleagent-space',
    }
    const cookieParts = []
    if (auth?.operToken) cookieParts.push(`operToken=${auth.operToken}`)
    if (auth?.operationToken) cookieParts.push(`operationToken=${auth.operationToken}`)
    if (cookieParts.length > 0) headers.Cookie = cookieParts.join('; ')

    if (typeof fetchImpl !== 'function') {
      return { ok: false, status: 0, json: null, error: '当前环境没有可用的 fetch' }
    }

    const res = await fetchImpl(url.toString(), {
      headers,
      signal: typeof globalThis.AbortSignal?.timeout === 'function'
        ? globalThis.AbortSignal.timeout(timeoutMs)
        : undefined,
    })
    const text = typeof res?.text === 'function' ? await res.text() : ''
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON（可能是登录页 HTML） */ }

    const status = Number(res?.status ?? 0)
    if (res && res.ok === false) return { ok: false, status, json, error: `HTTP ${status}` }
    if (json === null) {
      return { ok: false, status, json: null, error: '响应不是 JSON（可能需要重新登录桌面端）' }
    }
    // portal 的业务码
    if (json.code !== undefined && Number(json.code) !== 200) {
      return { ok: false, status, json, error: `${json.code} ${json.msg ?? ''}`.trim() }
    }
    return { ok: true, status, json, error: null }
  } catch (error) {
    log('portal 请求异常', { error: errorSummary(error) })
    return { ok: false, status: 0, json: null, error: errorSummary(error) }
  }
}

// ---------------------------------------------------------------- 业务接口

/**
 * 积分余额与明细。
 * @returns {Promise<{ok: boolean, balance: number|null, userRole: string|null,
 *                    groups: Array, expiresAt: string|null, error?: string}>}
 */
export async function fetchPoints(auth, options = {}) {
  const r = await portalRequest(auth, '/points/detail', options)
  if (!r.ok) return { ok: false, error: r.error }
  const data = r.json?.data ?? {}
  const balance = Number(data.pointsBalance)
  const groups = Array.isArray(data.groups) ? data.groups : []

  // 找到最早到期的活动余额，用于提示「X 积分将于 Y 过期」
  let soonestExpiry = null
  for (const g of groups) {
    for (const item of (g?.active ?? [])) {
      const end = item?.effectiveEnd
      if (typeof end === 'string' && (soonestExpiry === null || end < soonestExpiry)) soonestExpiry = end
    }
  }

  return {
    ok: true,
    balance: Number.isFinite(balance) ? balance : null,
    userRole: data.userRole ?? null,
    groups,
    expiresAt: soonestExpiry,
  }
}

/**
 * 每日领取状态（只读）。
 */
export async function fetchDailyStatus(auth, options = {}) {
  const r = await portalRequest(auth, '/companyStore/v2/checkDayTask', options)
  if (!r.ok) return { ok: false, error: r.error }
  const data = r.json?.data ?? {}
  const task = data.daily_task ?? {}
  const activity = data.activity ?? null
  return {
    ok: true,
    // 活动信息（有就带回，供展示徽标；不可见则为 null）
    activity: activity && activity.visible === true
      ? {
          title: activity.activity_title ?? null,
          endText: activity.end_date_text ?? null,
          actionText: activity.action_text ?? null,
        }
      : null,
    brandTitle: data.brand_title ?? null,
    visible: task.visible === true,
    claimable: Number(task.daily_claimable_points ?? 0),
    claimedToday: task.claimed_today === true,
    totalDays: Number(task.total_claim_days ?? 0),
    totalPoints: Number(task.total_claimed_points ?? 0),
    buttonText: task.button_text ?? null,
  }
}

/**
 * 执行每日领取（幂等）。
 *
 * 先查状态：已领就直接返回，**绝不调用领取接口**；否则调用领取接口，
 * 再查一次确认（避免"接口成功但实际没发"也报成功）。
 *
 * @returns {Promise<{ok: boolean, claimed: boolean, points: number,
 *                    alreadyClaimed: boolean, error?: string}>}
 */
export async function claimDaily(auth, options = {}) {
  const before = await fetchDailyStatus(auth, options)
  if (!before.ok) return { ok: false, claimed: false, points: 0, alreadyClaimed: false, error: before.error }
  if (before.claimedToday) {
    return { ok: true, claimed: false, alreadyClaimed: true, points: 0 }
  }

  const r = await portalRequest(auth, '/companyStore/checkTask', {
    ...options,
    query: { type: 'daily_login' },
  })
  if (!r.ok) return { ok: false, claimed: false, points: 0, alreadyClaimed: false, error: r.error }

  const after = await fetchDailyStatus(auth, options)
  const claimedNow = after.ok ? after.claimedToday && !before.claimedToday : true
  const log = options.log ?? noopLog
  log('每日领取', {
    before: before.claimedToday,
    after: after.ok ? after.claimedToday : 'unknown',
  })
  return {
    ok: true,
    claimed: claimedNow,
    points: before.claimable,
    alreadyClaimed: !claimedNow,
  }
}

/** 套餐与账号信息（计划名 / 并发上限）。 */
export async function fetchUserCenter(auth, options = {}) {
  const r = await portalRequest(auth, '/companyStore/userCenter', options)
  if (!r.ok) return { ok: false, error: r.error }
  const d = r.json?.data ?? {}
  return {
    ok: true,
    planName: d.plan_display_name ?? null,
    balance: d.current_points_balance != null ? Number(d.current_points_balance) : null,
    maxConcurrentTasks: d.max_concurrent_tasks ?? null,
    endDate: d.end_date ?? null,
  }
}
