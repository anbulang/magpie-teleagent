/**
 * 上游调用防护：并发节流 + 每分钟限速 + 认证失败熔断。
 *
 * 每个 guard 实例只服务**一个账号**（并发与熔断按账号隔离）。
 * 插件在 magpie 里是**常驻**的（一个 Bun 宿主进程），所以多一个 `onIdle`：
 * 长时间没有请求时可以借它收尾（当前只记一条 `verbose` 日志，不影响后续请求）。
 *
 * ## 为什么这些数字是硬约束
 *
 * 2026-10-27 两个账号先后因**合成探测**被上游风控封禁（5 个模型 × 图片、
 * 50–600KB 填充体、10/100/265 个合成工具、每次启动发一次真实请求）。
 * 复盘结论：并发 2、每分钟 20 次、连续 3 次 401/403 熔断 10 分钟。
 * 这些数字不是性能参数，是账号存活参数，不要为了「跑得快」调大。
 */

export const DEFAULT_GUARD = {
  maxConcurrent: 2,
  maxPerMinute: 20,
  failureThreshold: 3,
  cooldownMs: 10 * 60 * 1000,
  /** 连续失败计数只由这些状态码触发（认证/权限类） */
  authFailureStatuses: [401, 403],
  /** 最后一次活动后多久算空闲（毫秒）；0 = 不回调 */
  idleMs: 10 * 60 * 1000,
}

/** 熔断打开时抛出，调用方据此快速失败 */
export class GuardBlockedError extends Error {
  constructor(retryAfterMs, reason) {
    super(`上游调用已暂停：${reason}`)
    this.name = 'GuardBlockedError'
    this.code = 'circuit_open'
    this.circuitOpen = true
    this.retryAfterMs = retryAfterMs
    this.reason = reason
  }
}

/**
 * @param {Partial<typeof DEFAULT_GUARD>} [options]
 * @param {() => number} [options.now] 可注入时钟（测试用）
 * @param {() => void} [options.onIdle] 空闲回调（最后一次活动 idleMs 后调用一次）
 */
export function createGuard(options = {}, now = options.now ?? (() => Date.now())) {
  const cfg = { ...DEFAULT_GUARD, ...options }
  const maxConcurrent = Math.max(1, Number(cfg.maxConcurrent) || 1)
  const failureThreshold = Math.max(1, Number(cfg.failureThreshold) || 1)
  const cooldownMs = Math.max(0, Number(cfg.cooldownMs) || 0)
  const idleMs = Math.max(0, Number(cfg.idleMs) || 0)

  let active = 0
  const waiters = []

  let consecutiveFailures = 0
  let openUntil = 0
  let halfOpenProbeInFlight = false
  let lastReason = null
  let lastFailureAt = null
  let totalRejected = 0

  let windowStart = 0
  let windowCount = 0
  let totalThrottled = 0

  let lastActivityAt = now()
  let idleTimer = null
  let idleFired = false

  function touch() {
    lastActivityAt = now()
    if (idleMs <= 0 || idleFired) return
    if (idleTimer !== null) return
    const schedule = () => {
      idleTimer = setTimeout(() => {
        idleTimer = null
        if (active > 0) { schedule(); return }
        if (now() - lastActivityAt < idleMs) { schedule(); return }
        idleFired = true
        try { cfg.onIdle?.() } catch { /* 空闲回调失败不影响请求 */ }
      }, Math.min(idleMs, 60_000))
      idleTimer.unref?.()
    }
    schedule()
  }

  function acquire() {
    if (active < maxConcurrent) {
      active++
      return Promise.resolve()
    }
    return new Promise((resolve) => waiters.push(resolve))
  }

  function release() {
    active--
    const next = waiters.shift()
    if (next) {
      active++
      next()
    }
  }

  return {
    config: cfg,

    /** 请求前检查。熔断打开时抛 GuardBlockedError；半开时只放一个探测 */
    check() {
      if (openUntil === 0) return
      const remaining = openUntil - now()
      if (remaining > 0) {
        totalRejected++
        throw new GuardBlockedError(remaining, lastReason ?? '连续认证失败')
      }
      if (halfOpenProbeInFlight) {
        totalRejected++
        throw new GuardBlockedError(cooldownMs, '半开状态已有探测请求在途')
      }
      halfOpenProbeInFlight = true
    },

    /** 分钟级限速：超过 maxPerMinute 就等到下一个窗口（不硬闯） */
    async throttle() {
      const limit = Number(cfg.maxPerMinute) || 0
      if (limit <= 0) return
      const t = now()
      if (t - windowStart >= 60_000) {
        windowStart = t
        windowCount = 0
      }
      if (windowCount < limit) { windowCount++; return }
      const waitMs = Math.max(1, Math.min(60_000 - (t - windowStart), 60_000))
      totalThrottled++
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, waitMs)
        timer.unref?.()
      })
      windowStart = now()
      windowCount = 1
    },

    /** 在并发槽内执行 fn（含限速与熔断检查） */
    async withSlot(fn) {
      this.check()
      await this.throttle()
      await acquire()
      touch()
      try {
        return await fn()
      } finally {
        release()
        touch()
      }
    },

    /** 记录一次上游响应状态 */
    observe(status) {
      const numeric = Number(status)
      if (cfg.authFailureStatuses.includes(numeric)) {
        consecutiveFailures++
        lastReason = `连续 ${consecutiveFailures} 次认证失败（HTTP ${numeric}）`
        lastFailureAt = now()
        halfOpenProbeInFlight = false
        if (openUntil !== 0) {
          openUntil = now() + cooldownMs
        } else if (consecutiveFailures >= failureThreshold) {
          openUntil = now() + cooldownMs
        }
        return
      }
      consecutiveFailures = 0
      openUntil = 0
      halfOpenProbeInFlight = false
      lastReason = null
    },

    /** 现在是否处于熔断 */
    isOpen() {
      return openUntil !== 0 && now() < openUntil
    },

    /** 重置（重新登录后调用，避免旧账号状态影响新账号） */
    reset() {
      consecutiveFailures = 0
      openUntil = 0
      halfOpenProbeInFlight = false
      lastReason = null
      lastFailureAt = null
    },

    /** 供状态/日志读取 */
    snapshot() {
      return {
        open: this.isOpen(),
        cooldownRemainingMs: openUntil === 0 ? 0 : Math.max(0, openUntil - now()),
        consecutiveFailures,
        failureThreshold,
        maxConcurrent,
        active,
        queued: waiters.length,
        totalRejected,
        totalThrottled,
        maxPerMinute: cfg.maxPerMinute,
        lastReason,
        lastFailureAt,
      }
    },

    /** 停掉空闲定时器（宿主卸载时用） */
    dispose() {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = null
    },
  }
}
