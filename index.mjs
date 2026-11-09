/**
 * TeleAgent 的 magpie / OpenCode v1 供应商插件。
 *
 * 导出**只有**这一个插件函数（入口模块导出的每个函数都会被当成插件调用，
 * 所以辅助函数都放在 `lib/` 里）。
 *
 * ## 它做什么
 *
 *   1. 在 `config` 钩子里声明供应商 `teleagent` 与 5 个模型；
 *   2. `auth.methods` 提供「读取本机 TeleAgent 登录态」——不是填 API key，
 *      而是读出桌面端 `app-auth/token.json` 并解密（钥匙串 safeStorage）；
 *   3. `auth.loader` 为每个账号造一个 fetch：每个请求现签 ts/nonce，
 *      带上 JWT、设备指纹、网关 apiKey，发到 TeleAgent 自己的网关；
 *   4. `auth.usage` 报积分余额与套餐（`magpie quota` / `GET /v1/magpie/quotas`）；
 *   5. `auth.checkin` 按下每日签到（幂等，已领就短路）；
 *   6. `tool` 给 agent 一个只读的 `points`（对外是全名 `<插件短名>_points`）；
 *   7. `chat.headers` 补厂商的会话头。
 *
 * ## 为什么不复用 kernel
 *
 * 桌面端自带一个 Go 内核（agent runtime），经它转发会丢掉 role 结构、
 * 多轮历史和工具调用链。插件直连上游（OpenAI 兼容），三件事都由 magpie 掌控。
 *
 * ## 安全边界（重要）
 *
 * 上游对自动化流量敏感：两个账号曾因合成探测被封。插件内置并发 2 / 每分钟 20 次 /
 * 401·403 熔断 10 分钟，并且**不做**任何启动自检式的聊天请求。
 */
import { buildModels, MODELS, TELEAI_BASE_URL, TELEAI_ORIGIN } from './lib/models.mjs'
import {
  diagnoseCredential,
  listCredentialScopes,
  readAppVersion,
  readDeviceMeta,
  REMEDIES,
  CredentialState,
} from './lib/credential.mjs'
import { createSignedFetch } from './lib/sign.mjs'
import { normalizeUpstreamBody } from './lib/effort.mjs'
import { createGuard } from './lib/guard.mjs'
import { resolveApiKey } from './lib/apikey.mjs'
import {
  readPortalAuth,
  fetchPoints,
  fetchDailyStatus,
  claimDaily,
  fetchUserCenter,
} from './lib/portal.mjs'

export const PROVIDER = 'teleagent'

/**
 * 账号在 magpie 里的 key。
 *
 * 存的是**账号目录名**（`v1_public_<userId>`），不是 token：token 会过期、
 * 会被桌面端重新登录替换，复制进 `plugin-auth.json` 只会变旧，还多一处泄漏面。
 * 真正的 token 由 `auth.loader` 的 fetch 在每次请求前现读现解密。
 */
function keyForScope(scope) {
  return `${scope}`
}

/** 从保存的账号 key 里取出 scope */
function scopeOf(auth) {
  const key = typeof auth?.key === 'string' ? auth.key : ''
  if (key.length === 0) return ''
  return key
}

export default async function TeleAgentPlugin(input = {}) {
  const log = (level, message) => {
    try { input?.client?.app?.log?.({ body: { service: 'teleagent', level, message } }) } catch { /* 忽略 */ }
  }
  const verbose = () => {
    const opts = input?.magpie?.options ?? input?.magpie?.option ?? {}
    return opts.verbose === true || opts.debug === true
  }
  const say = (message) => { if (verbose()) log('info', message) }

  /** scope → { guard, apiKey, appVersion } —— guard 按账号隔离（并发/熔断互不影响） */
  const guards = new Map()

  function apiKeyOnce() {
    const opts = input?.magpie?.options ?? input?.magpie?.option ?? {}
    return resolveApiKey({ explicit: typeof opts.apiKey === 'string' ? opts.apiKey : undefined })
  }

  function guardFor(scope) {
    const existing = guards.get(scope)
    if (existing) return existing
    const created = createGuard({
      onIdle: () => {
        // 空闲只是不再持有定时器；guard 本身很小，留着无妨
        say(`空闲：${scope}`)
      },
    })
    guards.set(scope, created)
    return created
  }

  /**
   * 读当前账号的可用凭据。
   *
   * 每次请求都读一遍（只 stat + 钥匙串解密，约 10ms），这样「在桌面端重新
   * 登录后不用重启 magpie」成立。
   */
  function readAuth(scope) {
    const diagnosis = diagnoseCredential(process.env.HOME ?? '', scope ? { scope } : {})
    if (!diagnosis.ok) {
      const error = new Error(`TeleAgent 凭据不可用：${diagnosis.detail}${diagnosis.remedy ? `；${diagnosis.remedy}` : ''}`)
      error.code = diagnosis.state
      // 登录类失败告诉 magpie「这个账号需要重新登录」，它会打标并停止往这里发请求
      if ([
        CredentialState.EXPIRED,
        CredentialState.TOKEN_FILE_MISSING,
        CredentialState.NOT_SIGNED_IN,
        CredentialState.KEYCHAIN_MISSING,
        CredentialState.KEYCHAIN_DENIED,
        CredentialState.DECRYPT_FAILED,
        CredentialState.TOKEN_MALFORMED,
      ].includes(diagnosis.state)) {
        error.signIn = 'expired'
      }
      throw error
    }
    return diagnosis
  }

  return {
    // ------------------------------------------------------------ 供应商与模型
    config: async (cfg) => {
      cfg.provider ??= {}
      // 用 ??= ：不覆盖用户在 magpie 里对 teleagent 的配置
      cfg.provider[PROVIDER] ??= {
        name: 'TeleAgent',
        npm: '@ai-sdk/openai-compatible', // chat completions
        api: TELEAI_BASE_URL,
        models: buildModels(),
      }
      // 默认模型（magpie 会用它给新 agent 一个初始值）
      cfg.provider[PROVIDER].options ??= {}
    },

    // ---------------------------------------------------------------- 登录
    auth: {
      provider: PROVIDER,
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMwMDVhY2MiLz48cGF0aCBkPSJNMjAgNDJWMjJsMjQgMjBWMjIiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSI1IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGZpbGw9Im5vbmUiLz48L3N2Zz4=',
      maxConcurrency: 2,

      methods: [{
        type: 'api',
        // keyless：不需要用户输入任何东西，点一下就读本机登录态。
        // 需要 key 输入框时 magpie 会拦在 CLI 的 stdin 上，所以这里必须免输入。
        keyless: true,
        label: '读取本机 TeleAgent 登录态',
        placeholder: '本机已登录的账号',
        // prompts 用 getter：magpie 每次问这一步时都会重新读一遍，
        // 于是你刚在桌面端登录的新账号，下一次 login 就能出现在下拉框里
        // （不需要重启 magpie 宿主）。
        get prompts() {
          const options = buildScopeOptions()
          return [{
            type: 'select',
            key: 'scope',
            message: '选择要接入的 TeleAgent 账号（本机所有已登录账号）',
            options,
          }]
        },
        /**
         * 登记一个账号。这里只保存 scope，不保存 token：
         * token 会过期、会被重新登录替换，复制进 plugin-auth.json 只会变旧。
         */
        async authorize(inputs) {
          const wanted = typeof inputs?.scope === 'string' ? inputs.scope : ''
          const diagnosis = diagnoseCredential(process.env.HOME ?? '', wanted ? { scope: wanted } : {})
          if (!diagnosis.ok) {
            return {
              type: 'failed',
              error: `${diagnosis.detail}${diagnosis.remedy ? `（${diagnosis.remedy}）` : ''}`.slice(0, 500),
            }
          }
          return {
            type: 'success',
            key: keyForScope(diagnosis.scope),
            // accountName 用于 magpie 的账号显示（它依次看 accountId / metadata.email / email）；
            // expiresAt / scope 是我们自己的字段，随账号一起保存
            accountId: String(diagnosis.accountId ?? diagnosis.scope),
            metadata: {
              // magpie 依次用 accountId / metadata.email / email 给账号命名；
              // 但 api 方式的保存只留下 key + metadata（accountId 不落盘），
              // 所以把账号名放进 metadata.email，界面上才显示成名字而不是 `API key …2064`。
              email: typeof diagnosis.accountName === 'string' && diagnosis.accountName ? diagnosis.accountName : undefined,
              accountName: diagnosis.accountName ?? null,
              scope: diagnosis.scope,
              expiresAt: diagnosis.expiresAt ?? null,
              daysLeft: diagnosis.daysLeft ?? null,
            },
          }
        },
      }],

      /** 每个账号的请求：现签 + 现读 token */
      async loader(getAuth) {
        const auth = await getAuth()
        const scope = scopeOf(auth)
        const resolved = apiKeyOnce()
        say(`loader：scope=${scope || '<default>'} apiKey=${resolved.source}`)
        return {
          baseURL: TELEAI_BASE_URL,
          // magpie 会按 @ai-sdk/openai-compatible 的规则发
          // `Authorization: Bearer <apiKey>`；我们把它删掉换成网关 apiKey，
          // 所以这里给一个明确但不是上游凭据的占位值。
          apiKey: `teleagent:${scope || 'default'}`,
          async fetch(fetchInput, init) {
            // 目录外的模型 id 直接 404，**在读凭据之前**就拦下：
            // magpie 允许 agent 传任意 model 字符串，上游对未知 id 会静默回落到
            // 默认模型（实测：请求 chat-flash，回的却是另一个厂商的模型）。
            const asked = modelOfBody(init?.body)
            if (asked && !MODELS.some((m) => m.id === asked)) {
              return new Response(JSON.stringify({
                error: { message: `TeleAgent 没有模型 ${asked}（可用：${MODELS.map((m) => m.id).join(' / ')}）`, type: 'invalid_request_error' },
              }), { status: 404, headers: { 'Content-Type': 'application/json' } })
            }

            // 思考档位：上游只认 low / high / max，且不接受"关闭思考"。
            // 宿主会按它自己的通用理解写 reasoning_effort（实测 Claude Code 经
            // magpie 网关会写 medium），medium 不在上游的三档里 → 整轮 400：
            //   「该模型始终思考，不支持关闭思考；请使用 low、high 或 max。」
            // 这里是所有请求的必经之路，也是插件能动的最后一处，所以在发出去
            // 之前把档位削成上游认的（规则见 lib/effort.mjs）。
            const effort = normalizeUpstreamBody(init?.body)
            if (effort.changed) {
              say(`思考档位：${effort.from || '<无>'} → ${effort.to ?? '<删除>（上游不接受关闭思考）'}`)
              init = { ...init, body: effort.body }
            }

            // 凭据每次现读：在桌面端重新登录后不用重启 magpie
            const diagnosis = readAuth(scope)
            const device = readDeviceMeta(process.env.HOME ?? '')
            const appVersion = readAppVersion()
            const signed = createSignedFetch({
              auth: {
                token: diagnosis.token,
                installId: device.installId ?? '',
                deviceId: device.deviceId ?? '',
                appVersion,
              },
              apiKey: () => resolved.key,
              // 熔断/并发按**账号**隔离：一个账号被封不该拖住另一个
              guard: guardFor(diagnosis.scope),
              log: verbose() ? say : undefined,
            })
            let response
            try {
              response = await signed(fetchInput, init)
            } catch (error) {
              // 熔断/网络问题：交给 magpie 的故障切换（换账号或换模型）
              if (error?.circuitOpen === true) {
                const secs = Math.max(1, Math.ceil((error.retryAfterMs ?? 60_000) / 1000))
                return new Response(JSON.stringify({
                  error: { message: `${error.message}（约 ${Math.ceil(secs / 60)} 分钟后自动恢复）`, type: 'upstream_unavailable' },
                }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': String(secs) } })
              }
              throw error
            }
            return explainFailure(response)
          },
        }
      },

      /** 用量：只读 portal（不花积分、不发模型请求） */
      async usage(getAuth) {
        const auth = await getAuth()
        const scope = scopeOf(auth)
        const portal = safePortalAuth(scope)
        if (!portal) {
          return {
            plan: undefined,
            error: '读不到积分凭据（cookie）：在 TeleAgent 桌面端登录一次即可',
            windows: [],
          }
        }
        const [points, center] = await Promise.all([
          fetchPoints(portal).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
          fetchUserCenter(portal).catch(() => ({ ok: false })),
        ])
        if (!points.ok) {
          return { error: points.error ?? '读取积分失败', windows: [] }
        }
        const windows = [{
          // balance：预付钱包式余额，没有 used/limit，不参与「用尽」判断
          name: '积分余额',
          balance: Number(points.balance ?? 0),
          unit: '积分',
          ...(points.expiresAt ? { runsOutAt: points.expiresAt } : {}),
        }]
        return {
          plan: center.ok ? (center.planName ?? undefined) : undefined,
          // 顶层 balance 不再给：它和窗口里的 balance 是同一个数，
          // magpie 会把两者都画出来（实测重复显示两遍）
          windows,
        }
      },

      /** 每日签到（幂等；已领返回 done，不重复领取） */
      async checkin(getAuth) {
        const auth = await getAuth()
        const scope = scopeOf(auth)
        const portal = safePortalAuth(scope)
        if (!portal) return { outcome: 'failed', message: '读不到积分凭据（cookie）：在 TeleAgent 桌面端登录一次' }
        try {
          // 先读状态：今天已经签过就报 done（不是 failed），**不碰领取接口**
          const before = await fetchDailyStatus(portal)
          if (!before.ok) return { outcome: 'failed', message: before.error ?? '读取签到状态失败' }
          if (before.claimedToday) return { outcome: 'done', message: '今天已经签过了' }
          if (before.visible === false) return { outcome: 'inactive', message: '当前没有签到活动' }

          const r = await claimDaily(portal)
          if (!r.ok) return { outcome: 'failed', message: r.error ?? '签到失败' }
          // 领取接口 2xx 但复查仍是未签：如实报 failed，让 magpie 当天稍后再试
          if (!r.claimed) return { outcome: 'failed', message: '领取接口返回成功，但复查仍显示未签到' }
          return { outcome: 'claimed', credit: Number(r.points ?? 0), message: '签到成功' }
        } catch (error) {
          return { outcome: 'failed', message: String(error?.message ?? error) }
        }
      },
    },

    // ---------------------------------------------------- 每个账号的模型清单
    //
    // 本机每个账号的模型都一样（同一个上游目录），所以从 `MODELS` 里按 id 补回
    // 厂商自己的字段。**`rate` 必须在 models 钩子里重新给一遍**：`config` 钩子里的
    // `rate` 只会用来构建 OpenCode 的 Model（那一层没有 rate 字段），magpie 是
    // 从 models 钩子的返回值上读 `rate` / `free` / `rateWas` 的。
    provider: {
      id: PROVIDER,
      async models(provider) {
        const out = {}
        for (const [id, model] of Object.entries(provider.models)) {
          const known = MODELS.find((m) => m.id === id)
          out[id] = known ? { ...model, rate: known.rate } : model
        }
        return out
      },
    },

    // -------------------------------------------------------------- 请求头
    'chat.headers': async (chatInput, output) => {
      if (chatInput?.model?.providerID !== PROVIDER) return
      const sessionId = typeof chatInput?.sessionID === 'string' ? chatInput.sessionID : ''
      if (!sessionId) return
      // 让上游看到「同一段对话」的会话头稳定（magpie 的 sessionID 在同一段对话里不变）
      const stable = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
      if (!stable) return
      output.headers['x-teleagent-session'] = stable
    },

    // ---------------------------------------------------------------- 工具
    tool: {
      // 工具名不要带 teleagent 前缀：magpie 会拼成 `<插件短名>_<工具名>` 并且用全名去重复
      points: {
        description: '查询本机登录的 TeleAgent 账号积分余额与每日签到状态。只读：不消耗积分、不触发领取、不发任何模型请求。',
        args: {
          type: 'object',
          properties: {},
          required: [],
        },
        async execute() {
          const scope = currentAccountScope()
          const portal = safePortalAuth(scope)
          if (!portal) return { ok: false, error: '读不到积分凭据（cookie）：在 TeleAgent 桌面端登录一次' }
          const [points, daily, center] = await Promise.all([
            fetchPoints(portal).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
            fetchDailyStatus(portal).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
            fetchUserCenter(portal).catch(() => ({ ok: false })),
          ])
          if (!points.ok) return { ok: false, error: points.error ?? '读取积分失败' }
          return {
            ok: true,
            balance: points.balance ?? null,
            expiresAt: points.expiresAt ?? null,
            planName: center.ok ? (center.planName ?? null) : null,
            claimedToday: daily.ok ? daily.claimedToday : null,
            claimable: daily.ok ? daily.claimable : null,
            totalClaimDays: daily.ok ? daily.totalDays : null,
            totalClaimedPoints: daily.ok ? daily.totalPoints : null,
          }
        },
      },
    },
  }
}

// ------------------------------------------------------------------ 辅助

/**
 * 登录时的账号选项。
 *
 * 本机可能有多个账号目录（切换过账号），但只有**当前**账号是桌面端真正在用的；
 * 其余可能没有 cookie（积分读不到）。这里把它们都列出来，并标注剩余天数。
 */
function buildScopeOptions() {
  const scopes = listCredentialScopes()
  if (scopes.length === 0) {
    return [{ label: '（未找到已登录的 TeleAgent 账号）', value: '__none__' }]
  }
  return scopes.map((scope) => {
    const d = diagnoseCredential(process.env.HOME ?? '', { scope })
    if (!d.ok) {
      return { label: `${scope}（不可用：${REMEDIES[d.state] ? shortRemedy(d.state) : d.detail}）`, value: scope }
    }
    const who = d.accountName ?? d.accountId ?? scope
    const days = typeof d.daysLeft === 'number' ? `，剩余 ${d.daysLeft} 天` : ''
    return { label: `${who}${days}`, value: scope }
  })
}

function shortRemedy(state) {
  const text = REMEDIES[state] ?? ''
  return text.split('：')[0].split('，')[0].slice(0, 24)
}

/** 当前账号的 scope（工具调用没有账号上下文时用） */
function currentAccountScope() {
  const d = diagnoseCredential(process.env.HOME ?? '')
  return d.ok ? d.scope : ''
}

/** 读 portal 凭据（永不抛） */
function safePortalAuth(scope) {
  try {
    return readPortalAuth(process.env.HOME ?? '', scope || undefined)
  } catch {
    return null
  }
}

/** 从请求体里取 model（拿不到就返回空串；不解析失败就抛） */
function modelOfBody(body) {
  if (typeof body !== 'string' || body.length === 0) return ''
  try {
    const parsed = JSON.parse(body)
    return typeof parsed?.model === 'string' ? parsed.model : ''
  } catch {
    return ''
  }
}

/**
 * 把上游的「看起来成功但其实说不清」的响应翻译成 magpie 能处理的形状。
 *
 * 目前只处理两类：
 *   - `40105 您的请求疑似攻击请求`：网关 apiKey 没带上（本机桌面端版本不受支持）
 *   - `40109 current user is banned`：账号被封，用 `X-Magpie-Sign-In: kept`
 *     明确告诉 magpie「不要把这个当登录失效去刷别的账号」，同时把原话透传。
 *
 * 两个错误**都不是**登录失效，所以都报 `kept`：
 *   - `40105` 是本机桌面端版本不受支持，凭据是好的；
 *   - `40109` 封的是**模型调用通道**，桌面端登录态仍然有效（`magpie quota`
 *     照样能读到积分），报 `expired` 会让 magpie 提示「重新登录」，
 *     而重登解决不了封禁，只是把人往错误的方向带。
 *
 * 真正的凭据过期走 `auth.loader` 抛的 `error.signIn = 'expired'`，不在这条路径上。
 */
async function explainFailure(response) {
  const status = Number(response?.status ?? 0)
  if (status !== 401 && status !== 403) return response

  let text = ''
  try {
    text = await response.clone().text()
  } catch {
    return response
  }
  const banned = /40109|is banned|封禁|被封/i.test(text)
  const suspicious = /40105|疑似攻击/i.test(text)
  if (!banned && !suspicious) return response

  // Response 的 headers 是不可变的（fetch 回来的），要加 magpie 自己的头
  // 必须重建一个 Response。正文仍然原样（这里是错误体，很小）。
  const headers = new Headers(response.headers)
  // 两个都不是登录失效：保留登录态，让 magpie 不要把账号标成「需要重新登录」。
  headers.set('x-magpie-sign-in', 'kept')
  const body = status === 204 || status === 205 ? null : text
  return new Response(body, { status, statusText: response.statusText, headers })
}

export const _internal = {
  buildModels,
  MODELS,
  TELEAI_BASE_URL,
  TELEAI_ORIGIN,
  explainFailure,
  buildScopeOptions,
  modelOfBody,
  keyForScope,
  scopeOf,
}
