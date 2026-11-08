/**
 * portal（积分 / 每日签到）测试。
 *
 * 三条硬约束，全部在这里守住：
 *  1. **不联网** —— 每个 fetch 都是本文件的打桩实现，绝不发真实请求；
 *  2. **不碰真实 sqlite** —— 读取器 `run` 与临时目录都可注入；
 *  3. **不重复领取** —— 已领状态必须短路，断言领取接口调用次数为 0。
 *
 * 跑法（magpie 宿主是 Bun，测试用 bun:test）：
 *
 *   magpie-bun test magpie/test/portal.test.mjs
 *
 * 其中 magpie-bun 是 magpie 自带的 bun，例如
 *   ~/.cache/magpie/bun/1.4.2/magpie-bun
 *
 * 注意：`portal.mjs` 本身只用 node: 内置模块，`node -e "import('./magpie/lib/portal.mjs')"`
 * 可以正常加载；但**本测试文件**依赖 bun:test，node 下不可运行，这是刻意的。
 */

import { describe, it, expect } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  PORTAL_BASE,
  appPaths,
  currentScope,
  userIdFromScope,
  cookieDbCandidates,
  findCookieDb,
  readCookieValues,
  readPortalAuth,
  portalRequest,
  fetchPoints,
  fetchDailyStatus,
  claimDaily,
  fetchUserCenter,
} from '../lib/portal.mjs'

// ---------------------------------------------------------------- 夹具

/** 造一个临时 home，含 TeleAgent 数据目录骨架。返回 {home, userData, cleanup} */
function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-portal-test-'))
  const home = path.join(root, 'home')
  const userData = path.join(home, '.local', 'share', 'TeleAgent')
  fs.mkdirSync(userData, { recursive: true })
  return {
    root,
    home,
    userData,
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } },
  }
}

/** 写一个空的 Cookies 文件（模拟已存在但未初始化的 Chromium 库） */
function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  return file
}

/**
 * 假 fetch：按路径路由。记录每次调用的路径，供"领取接口是否被调用"断言。
 *
 * @param {(arg: {apiPath: string, url: string, init: any, callIndex: number}) => any} handler
 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    const parsed = new URL(String(url))
    const apiPath = parsed.pathname.replace('/meter/super-agent/user/portal', '')
    const callIndex = calls.length
    calls.push({ url: String(url), apiPath })
    const reply = await handler({ apiPath, url: parsed, init, callIndex })
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => reply.text,
    }
  }
  impl.calls = calls
  return impl
}

/** 生成一个 portal 成功响应（业务码 200） */
function okJson(data) {
  return { status: 200, text: JSON.stringify({ code: 200, msg: 'ok', data }) }
}

const AUTH = { userId: '2092131099330392064', operationToken: 'stub-op-token', operToken: 'stub-oper-token' }

/** 每日任务响应的最小可用形状 */
function dailyTask(overrides = {}) {
  return {
    daily_task: {
      visible: true,
      daily_claimable_points: 100,
      claimed_today: false,
      total_claim_days: 7,
      total_claimed_points: 700,
      button_text: '领取',
      ...overrides,
    },
    activity: null,
  }
}

// ---------------------------------------------------------------- userIdFromScope

describe('userIdFromScope', () => {
  it('从账号目录名取出 userId', () => {
    expect(userIdFromScope('v1_public_2092131099330392064')).toBe('2092131099330392064')
    expect(userIdFromScope('v2_public_1900000000000000000')).toBe('1900000000000000000')
  })

  it('非法输入返回空串', () => {
    expect(userIdFromScope('')).toBe('')
    expect(userIdFromScope(undefined)).toBe('')
    expect(userIdFromScope(null)).toBe('')
    expect(userIdFromScope('garbage')).toBe('')
    expect(userIdFromScope('v1_public_abc')).toBe('')
  })

  it('宽松兜底：任意形如 xxx_<数字> 也取尾段', () => {
    expect(userIdFromScope('owner_123456')).toBe('123456')
  })
})

// ---------------------------------------------------------------- 路径 helper

describe('appPaths / cookieDbCandidates / findCookieDb', () => {
  it('appPaths 指向 XDG 位置', () => {
    const p = appPaths('/tmp/fake-home')
    expect(p.data).toBe('/tmp/fake-home/.local/share/TeleAgent')
    expect(p.config).toBe('/tmp/fake-home/.config/TeleAgent')
  })

  it('指定 scope 时：Partitions 优先，且**不包含**主 Cookie 库', () => {
    const list = cookieDbCandidates('/h', 'v1_public_2092131099330392064')
    expect(list.length).toBe(2)
    expect(list[0]).toBe('/h/.local/share/TeleAgent/Partitions/owner%3Av1_public_2092131099330392064/Cookies')
    expect(list[1]).toBe('/h/.local/share/TeleAgent/Partitions/owner:v1_public_2092131099330392064/Cookies')
    expect(list).not.toContain('/h/.local/share/TeleAgent/Cookies')
  })

  it('未指定 scope 时才回落到主 Cookie 库', () => {
    const list = cookieDbCandidates('/h')
    expect(list).toEqual(['/h/.local/share/TeleAgent/Cookies'])
  })

  it('findCookieDb 返回第一个存在的路径，都不存在返回 null', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      expect(findCookieDb(home, 'scope_a')).toBeNull()
      touch(path.join(userData, 'Cookies'))
      expect(findCookieDb(home)).toBe(path.join(userData, 'Cookies'))
      const partition = touch(path.join(userData, 'Partitions', 'owner%3Ascope_a', 'Cookies'))
      expect(findCookieDb(home, 'scope_a')).toBe(partition)
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------- readCookieValues

describe('readCookieValues', () => {
  it('解析注入 run 返回的 name|value 行', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      const db = touch(path.join(userData, 'Cookies'))
      const seen = []
      const cookies = readCookieValues(db, {
        run: ({ dbPath, sql }) => {
          seen.push({ dbPath, sql })
          return 'operationToken|abc\noperToken|def\n'
        },
      })
      expect(cookies).toEqual({ operationToken: 'abc', operToken: 'def' })
      // 读到的是临时副本，不是原库（桌面端会锁原库）
      expect(seen.length).toBe(1)
      expect(seen[0].dbPath).not.toBe(db)
      expect(seen[0].sql).toContain('operationToken')
    } finally {
      cleanup()
    }
  })

  it('run 抛 no such table: cookies → 返回 null 且不抛错、不记日志', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      const db = touch(path.join(userData, 'Cookies'))
      const logs = []
      const cookies = readCookieValues(db, {
        run: () => { throw new Error('Error: in prepare, no such table: cookies') },
        log: (step, detail) => logs.push({ step, detail }),
      })
      expect(cookies).toBeNull()
      // 空状态不该记 Error
      expect(logs.length).toBe(0)
    } finally {
      cleanup()
    }
  })

  it('文件不存在 → null，且完全不调用 run', () => {
    let runCalled = false
    const cookies = readCookieValues('/definitely/not/here/Cookies', {
      run: () => { runCalled = true; return 'operationToken|abc\n' },
    })
    expect(cookies).toBeNull()
    expect(runCalled).toBe(false)
  })

  it('真正的故障（如库损坏 / sqlite3 缺失）返回 null 但不抛，且走日志', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      const db = touch(path.join(userData, 'Cookies'))
      const logs = []
      const cookies = readCookieValues(db, {
        run: () => { const e = new Error('file is not a database'); e.code = 'ENOENT'; throw e },
        log: (step, detail) => logs.push({ step, detail }),
      })
      expect(cookies).toBeNull()
      expect(logs.length).toBe(1)
      expect(logs[0].step).toContain('cookie')
      // 日志里不能出现 cookie 值
      expect(JSON.stringify(logs)).not.toContain('stub-op-token')
    } finally {
      cleanup()
    }
  })

  it('run 输出为空 / 只有无关 cookie → null', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      const db = touch(path.join(userData, 'Cookies'))
      expect(readCookieValues(db, { run: () => '' })).toBeNull()
      expect(readCookieValues(db, { run: () => 'otherCookie|zzz\n' })).toEqual({ otherCookie: 'zzz' })
    } finally {
      cleanup()
    }
  })

  it('sqlite3 把 "no such table" 放在 stderr 里也能识别为空状态（真实 execFileSync 形状）', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      const db = touch(path.join(userData, 'Cookies'))
      const logs = []
      const err = new Error('Command failed: sqlite3 -readonly /tmp/x.db select ...')
      err.stderr = 'Error: in prepare, no such table: cookies (1)'
      const cookies = readCookieValues(db, { run: () => { throw err }, log: (s, d) => logs.push({ s, d }) })
      expect(cookies).toBeNull()
      expect(logs.length).toBe(0)
    } finally {
      cleanup()
    }
  })

  it('临时副本会被清理', () => {
    const { home, userData, root, cleanup } = makeHome()
    try {
      const db = touch(path.join(userData, 'Cookies'))
      const tmpDir = path.join(root, 'tmp')
      fs.mkdirSync(tmpDir, { recursive: true })
      readCookieValues(db, { run: () => 'operationToken|abc\n', tmpDir })
      expect(fs.readdirSync(tmpDir)).toEqual([])
      // run 抛错时同样要清理
      readCookieValues(db, { run: () => { throw new Error('no such table: cookies') }, tmpDir })
      expect(fs.readdirSync(tmpDir)).toEqual([])
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------- readPortalAuth

describe('readPortalAuth', () => {
  it('指定 scope：读 Partitions 下的库，返回 userId + token', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      const scope = 'v1_public_2092131099330392064'
      const db = touch(path.join(userData, 'Partitions', `owner%3A${scope}`, 'Cookies'))
      const auth = readPortalAuth(home, scope, {
        run: () => 'operationToken|abc\noperToken|def\n',
      })
      expect(auth).not.toBeNull()
      expect(auth.userId).toBe('2092131099330392064')
      expect(auth.operationToken).toBe('abc')
      expect(auth.operToken).toBe('def')
      expect(auth.source).toBe(db)
    } finally {
      cleanup()
    }
  })

  it('原实现修过的 bug：指定 scope 时**绝不**回落到主 Cookie 库', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      // 主库有"别人的"凭据，但指定的账号分区不存在
      touch(path.join(userData, 'Cookies'))
      const auth = readPortalAuth(home, 'v1_public_2092131099330392064', {
        run: () => 'operationToken|someone-else\noperToken|x\n',
      })
      expect(auth).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('未指定 scope 时走当前账号；当前账号分区缺失才用主库兜底', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      fs.writeFileSync(
        path.join(userData, 'current-owner.json'),
        JSON.stringify({ ownerDir: 'v1_public_2092131099330392064' }),
      )
      const main = touch(path.join(userData, 'Cookies'))
      const auth = readPortalAuth(home, undefined, { run: () => 'operationToken|main-token\n' })
      expect(auth).not.toBeNull()
      expect(auth.userId).toBe('2092131099330392064')
      expect(auth.operationToken).toBe('main-token')
      expect(auth.source).toBe(main)
    } finally {
      cleanup()
    }
  })

  it('缺少 operationToken → null（有 operToken 也不算已登录）', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      const scope = 'v1_public_2092131099330392064'
      touch(path.join(userData, 'Partitions', `owner%3A${scope}`, 'Cookies'))
      const auth = readPortalAuth(home, scope, { run: () => 'operToken|def\n' })
      expect(auth).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('没有已登录账号（currentScope 抛错）→ null，不抛错', () => {
    const { home, cleanup } = makeHome()
    try {
      expect(readPortalAuth(home)).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('currentScope 多个账号时选 token.json 最新的那个', () => {
    const { home, userData, cleanup } = makeHome()
    try {
      const usersDir = path.join(userData, 'users')
      const older = path.join(usersDir, 'v1_public_111')
      const newer = path.join(usersDir, 'v1_public_222')
      touch(path.join(older, 'app-auth', 'token.json'))
      touch(path.join(newer, 'app-auth', 'token.json'))
      const past = new Date(Date.now() - 60_000)
      fs.utimesSync(path.join(older, 'app-auth', 'token.json'), past, past)
      expect(currentScope(userData)).toBe('v1_public_222')
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------- portalRequest

describe('portalRequest', () => {
  it('200 且业务码 200 → ok', async () => {
    const impl = fakeFetch(() => okJson({ hello: 1 }))
    const r = await portalRequest(AUTH, '/points/detail', { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.json.data.hello).toBe(1)
    expect(r.error).toBeNull()
    expect(impl.calls[0].url.startsWith(PORTAL_BASE)).toBe(true)
  })

  it('带上 X-Token / userId / Cookie 头，且 query 被拼进 URL', async () => {
    let captured = null
    const impl = async (url, init) => {
      captured = { url: String(url), headers: init.headers }
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200 }) }
    }
    await portalRequest(AUTH, '/companyStore/checkTask', {
      fetchImpl: impl,
      query: { type: 'daily_login' },
    })
    expect(captured.url).toContain('type=daily_login')
    expect(captured.headers['X-Token']).toBe(AUTH.operationToken)
    expect(captured.headers.userId).toBe(AUTH.userId)
    expect(captured.headers.Cookie).toContain(`operationToken=${AUTH.operationToken}`)
    expect(captured.headers.Cookie).toContain(`operToken=${AUTH.operToken}`)
  })

  it('HTTP 404 → ok:false', async () => {
    const impl = fakeFetch(() => ({ status: 404, text: 'not found' }))
    const r = await portalRequest(AUTH, '/points/detail', { fetchImpl: impl })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
    expect(r.error).toContain('404')
  })

  it('非 JSON 响应 → ok:false，并且 error 提到"可能需要重新登录"', async () => {
    const impl = fakeFetch(() => ({ status: 200, text: '<html>login</html>' }))
    const r = await portalRequest(AUTH, '/points/detail', { fetchImpl: impl })
    expect(r.ok).toBe(false)
    expect(r.json).toBeNull()
    expect(r.error).toContain('不是 JSON')
    expect(r.error).toContain('重新登录')
  })

  it('业务码非 200 → ok:false 并带上 code/msg', async () => {
    const impl = fakeFetch(() => ({ status: 200, text: JSON.stringify({ code: 401, msg: '未登录' }) }))
    const r = await portalRequest(AUTH, '/points/detail', { fetchImpl: impl })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('401')
    expect(r.error).toContain('未登录')
  })

  it('fetch 抛异常 → ok:false、status 0，永不抛错', async () => {
    const impl = async () => { throw new Error('getaddrinfo ENOTFOUND') }
    const r = await portalRequest(AUTH, '/points/detail', { fetchImpl: impl })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
    expect(r.error).toContain('ENOTFOUND')
  })

  it('没有可用 fetch → ok:false 而不是抛错', async () => {
    const r = await portalRequest(AUTH, '/points/detail', { fetchImpl: null })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
  })
})

// ---------------------------------------------------------------- fetchPoints

describe('fetchPoints', () => {
  it('读取余额、角色，并取最早到期的活动余额', async () => {
    const impl = fakeFetch(() => okJson({
      pointsBalance: 5967.79,
      userRole: 'free',
      groups: [
        { active: [{ effectiveEnd: '2026-12-31' }, { effectiveEnd: '2026-11-15' }] },
        { active: [{ effectiveEnd: '2027-01-01' }] },
      ],
    }))
    const r = await fetchPoints(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.balance).toBeCloseTo(5967.79, 5)
    expect(r.userRole).toBe('free')
    expect(r.groups.length).toBe(2)
    expect(r.expiresAt).toBe('2026-11-15')
  })

  it('balance 不是数字 → null', async () => {
    const impl = fakeFetch(() => okJson({ pointsBalance: 'N/A', groups: [] }))
    const r = await fetchPoints(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.balance).toBeNull()
    expect(r.expiresAt).toBeNull()
    expect(r.groups).toEqual([])
  })

  it('没有 groups → expiresAt null，不崩', async () => {
    const impl = fakeFetch(() => okJson({ pointsBalance: 0 }))
    const r = await fetchPoints(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.balance).toBe(0)
    expect(r.groups).toEqual([])
    expect(r.expiresAt).toBeNull()
  })

  it('portal 失败 → ok:false 并透传 error', async () => {
    const impl = fakeFetch(() => ({ status: 500, text: 'boom' }))
    const r = await fetchPoints(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('500')
  })
})

// ---------------------------------------------------------------- fetchDailyStatus

describe('fetchDailyStatus', () => {
  it('活动 visible=false → activity 为 null', async () => {
    const impl = fakeFetch(() => okJson({
      ...dailyTask(),
      activity: { visible: false, activity_title: '签到活动' },
    }))
    const r = await fetchDailyStatus(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.activity).toBeNull()
  })

  it('活动 visible=true → 带回标题/结束文案', async () => {
    const impl = fakeFetch(() => okJson({
      ...dailyTask(),
      activity: { visible: true, activity_title: '签到活动', end_date_text: '还剩 3 天', action_text: '去看看' },
    }))
    const r = await fetchDailyStatus(AUTH, { fetchImpl: impl })
    expect(r.activity).toEqual({ title: '签到活动', endText: '还剩 3 天', actionText: '去看看' })
  })

  it('解析任务字段：可见性 / 可领积分 / 今日是否已领 / 累计', async () => {
    const impl = fakeFetch(() => okJson(dailyTask({ claimed_today: true })))
    const r = await fetchDailyStatus(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.visible).toBe(true)
    expect(r.claimable).toBe(100)
    expect(r.claimedToday).toBe(true)
    expect(r.totalDays).toBe(7)
    expect(r.totalPoints).toBe(700)
    expect(r.buttonText).toBe('领取')
  })

  it('字段缺失时给安全默认值（不崩、不 undefined）', async () => {
    const impl = fakeFetch(() => okJson({}))
    const r = await fetchDailyStatus(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.visible).toBe(false)
    expect(r.claimable).toBe(0)
    expect(r.claimedToday).toBe(false)
    expect(r.totalDays).toBe(0)
    expect(r.totalPoints).toBe(0)
    expect(r.buttonText).toBeNull()
    expect(r.activity).toBeNull()
  })

  it('portal 失败 → ok:false', async () => {
    const impl = fakeFetch(() => ({ status: 404, text: 'no' }))
    const r = await fetchDailyStatus(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('404')
  })
})

// ---------------------------------------------------------------- claimDaily

describe('claimDaily', () => {
  it('已领 → 短路返回，且**不调用领取接口**', async () => {
    const impl = fakeFetch(() => okJson(dailyTask({ claimed_today: true })))
    const r = await claimDaily(AUTH, { fetchImpl: impl })
    expect(r).toEqual({ ok: true, claimed: false, alreadyClaimed: true, points: 0 })
    // 只查了一次状态，没有调 /companyStore/checkTask
    expect(impl.calls.length).toBe(1)
    expect(impl.calls.map((c) => c.apiPath)).toEqual(['/companyStore/v2/checkDayTask'])
    expect(impl.calls.some((c) => c.apiPath.includes('/companyStore/checkTask'))).toBe(false)
  })

  it('未领 → 调领取接口 → 复查已领 → claimed true，points 取可领值', async () => {
    let statusCalls = 0
    const impl = fakeFetch(({ apiPath }) => {
      if (apiPath === '/companyStore/v2/checkDayTask') {
        statusCalls += 1
        // 第一次未领，复查时已领
        return okJson(dailyTask({ claimed_today: statusCalls > 1 }))
      }
      if (apiPath === '/companyStore/checkTask') return okJson({})
      return { status: 404, text: 'unexpected' }
    })
    const r = await claimDaily(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.claimed).toBe(true)
    expect(r.alreadyClaimed).toBe(false)
    expect(r.points).toBe(100)
    expect(impl.calls.map((c) => c.apiPath)).toEqual([
      '/companyStore/v2/checkDayTask',
      '/companyStore/checkTask',
      '/companyStore/v2/checkDayTask',
    ])
    // 领取请求带 type=daily_login
    expect(impl.calls[1].url).toContain('type=daily_login')
  })

  it('领取接口成功但复查仍是未领 → claimed false（不谎报成功）', async () => {
    const impl = fakeFetch(({ apiPath }) => {
      if (apiPath === '/companyStore/v2/checkDayTask') return okJson(dailyTask({ claimed_today: false }))
      return okJson({})
    })
    const r = await claimDaily(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.claimed).toBe(false)
    expect(r.alreadyClaimed).toBe(true)
  })

  it('状态查询失败 → ok:false，且绝不调用领取接口', async () => {
    const impl = fakeFetch(({ apiPath }) => {
      if (apiPath === '/companyStore/v2/checkDayTask') return { status: 500, text: 'boom' }
      return okJson({})
    })
    const r = await claimDaily(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(false)
    expect(r.claimed).toBe(false)
    expect(r.error).toContain('500')
    expect(impl.calls.some((c) => c.apiPath === '/companyStore/checkTask')).toBe(false)
  })

  it('领取接口失败 → ok:false，且不会去复查（只查 1 次状态）', async () => {
    const impl = fakeFetch(({ apiPath }) => {
      if (apiPath === '/companyStore/v2/checkDayTask') return okJson(dailyTask({ claimed_today: false }))
      return { status: 500, text: 'claim failed' }
    })
    const r = await claimDaily(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(false)
    expect(r.claimed).toBe(false)
    expect(r.error).toContain('500')
    expect(impl.calls.filter((c) => c.apiPath === '/companyStore/v2/checkDayTask').length).toBe(1)
  })

  it('幂等：连续两次调用，第二次不再调领取接口', async () => {
    let claimed = false
    const impl = fakeFetch(({ apiPath }) => {
      if (apiPath === '/companyStore/v2/checkDayTask') return okJson(dailyTask({ claimed_today: claimed }))
      claimed = true // 领取成功
      return okJson({})
    })
    const first = await claimDaily(AUTH, { fetchImpl: impl })
    expect(first.claimed).toBe(true)
    const claimCallsAfterFirst = impl.calls.filter((c) => c.apiPath === '/companyStore/checkTask').length
    expect(claimCallsAfterFirst).toBe(1)

    const second = await claimDaily(AUTH, { fetchImpl: impl })
    expect(second).toEqual({ ok: true, claimed: false, alreadyClaimed: true, points: 0 })
    const claimCallsAfterSecond = impl.calls.filter((c) => c.apiPath === '/companyStore/checkTask').length
    expect(claimCallsAfterSecond).toBe(1) // 没有新增领取调用
  })
})

// ---------------------------------------------------------------- fetchUserCenter

describe('fetchUserCenter', () => {
  it('读取计划名 / 余额 / 并发上限', async () => {
    const impl = fakeFetch(() => okJson({
      plan_display_name: '免费版',
      current_points_balance: '5967.79',
      max_concurrent_tasks: 2,
      end_date: '2027-01-01',
    }))
    const r = await fetchUserCenter(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.planName).toBe('免费版')
    expect(r.balance).toBeCloseTo(5967.79, 5)
    expect(r.maxConcurrentTasks).toBe(2)
    expect(r.endDate).toBe('2027-01-01')
  })

  it('字段缺失 → null，不崩', async () => {
    const impl = fakeFetch(() => okJson({}))
    const r = await fetchUserCenter(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(true)
    expect(r.planName).toBeNull()
    expect(r.balance).toBeNull()
    expect(r.maxConcurrentTasks).toBeNull()
    expect(r.endDate).toBeNull()
  })

  it('portal 失败 → ok:false', async () => {
    const impl = fakeFetch(() => ({ status: 401, text: 'unauthorized' }))
    const r = await fetchUserCenter(AUTH, { fetchImpl: impl })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('401')
  })
})

// ---------------------------------------------------------------- 隐私

describe('隐私', () => {
  it('默认日志不打印任何东西（注入 log 才记录）', async () => {
    const logs = []
    const impl = fakeFetch(() => okJson(dailyTask({ claimed_today: false })))
    await claimDaily(AUTH, { fetchImpl: impl, log: (step, detail) => logs.push({ step, detail }) })
    // 注入的日志只收到阶段名与布尔值，绝不含 token
    expect(JSON.stringify(logs)).not.toContain(AUTH.operationToken)
    expect(JSON.stringify(logs)).not.toContain(AUTH.operToken)
    expect(JSON.stringify(logs)).not.toContain(AUTH.userId)
  })
})
