/**
 * TeleAgent 上游签名与请求发送。
 *
 * 核心只有一件事：**把请求签成上游认的样子**。
 * 签名算法是对 kernel 的 Go 实现（`einoprovider.(*GatewaySigner).Sign`）
 * 断点实测出来的，完整推导见 `docs/PROTOCOL.md` 第二节。
 *
 * ## 两步 HMAC
 *
 * 第 1 步（绑定 installId）：
 *   key = JWT 第三段（token.split(".")[2]）
 *   msg = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
 *   k1  = hex(HMAC-SHA256(key, msg))
 *
 * 第 2 步（请求签名）：
 *   key = k1（作为 64 字符十六进制文本）
 *   msg = "superagent-auth-v1\n{METHOD}\n{pathname}\n{ts}\n{nonce}\n{appVersion}\n{sha256hex(body)}"
 *   sig = hex(HMAC-SHA256(key, msg))
 *
 * `pathname` 必须带 `/superCowork/sapi` 前缀（签名用完整路径）。
 *
 * ## 为什么用 `Authorization: Bearer`
 *
 * 桌面端自带网关 apiKey（`预置模型` 供应商的 `options.apiKey`），实测**必需**：
 * 去掉它上游直接返回 `40105 您的请求疑似攻击请求`。magpie 插件不再硬编码它，
 * 改为运行时从 `app.asar` 里读常量（见 `apikey.mjs`），也可以显式配置。
 *
 * ## 为什么自己发 fetch
 *
 * magpie 的 `auth.loader` 可以返回一个 `fetch`，让每个请求经过它。我们在里面
 * 重新签一次（ts/nonce 每次都要新），然后交给标准 fetch；响应的状态码、头、
 * 正文原样返回，流式字节不落地、不改写。
 */
import crypto from 'node:crypto'

import {
  TELEAI_ORIGIN,
  TELEAI_SIGNED_PATH,
  TELEAI_ROUTE_TARGET,
  TELEAI_BASE_URL,
} from './models.mjs'

const hex = (buf) => buf.toString('hex')
const sha256hex = (s) => hex(crypto.createHash('sha256').update(s).digest())
const hmacHex = (key, msg) => hex(crypto.createHmac('sha256', key).update(msg).digest())

/**
 * 纯签名函数（无时间依赖，便于单测）。
 *
 * @param {{token:string, installId:string, appVersion:string, method:string,
 *          pathname:string, ts:string, nonce:string, body:string}} input
 * @returns {{k1:string, signature:string}}
 */
export function computeSignature({ token, installId, appVersion, method, pathname, ts, nonce, body }) {
  const jwtThird = String(token).split('.')[2] ?? ''
  const k1 = hmacHex(jwtThird, `superagent-auth-v1/${token}/${installId}/${ts}/${nonce}`)
  const signature = hmacHex(k1, [
    'superagent-auth-v1', method, pathname, ts, nonce, appVersion, sha256hex(body),
  ].join('\n'))
  return { k1, signature }
}

/** 单次请求的签名头（每次请求都要新的 ts + nonce） */
export function buildAuthHeaders(auth, {
  body,
  method = 'POST',
  pathname = TELEAI_SIGNED_PATH,
  ts: tsIn,
  nonce: nonceIn,
  sessionId,
  messageId,
  requestId,
  apiKey = '',
  appVersion,
  installId,
  deviceId,
} = {}) {
  const ts = tsIn ?? String(Math.floor(Date.now() / 1000))
  const nonce = nonceIn ?? crypto.randomUUID()
  const { signature } = computeSignature({
    token: auth.token,
    installId: installId ?? auth.installId ?? '',
    appVersion: appVersion ?? auth.appVersion ?? '2.7.1',
    method: method.toUpperCase(),
    pathname,
    ts,
    nonce,
    body: body ?? '',
  })

  // 同一次请求里会话 id 必须一致（root 与 session 指向同一个会话）
  const sid = sessionId ?? newSessionId()
  const mid = messageId ?? newMessageId()

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Token': auth.token,
    'User-Agent': 'super-agent/1.0',
    'X-App-Version': appVersion ?? auth.appVersion ?? '2.7.1',
    'X-Route-Target': TELEAI_ROUTE_TARGET,
    'X-Superagent-Device-Id': deviceId ?? auth.deviceId ?? '',
    'X-Superagent-Install-Id': installId ?? auth.installId ?? '',
    'X-Superagent-Timestamp': ts,
    'X-Superagent-Nonce': nonce,
    'X-Superagent-Sign-Version': 'v1',
    'X-Superagent-Signature': signature,
    'X-Teleai-Run-Unit-Type': 'agent_loop',
    'X-Teleai-Upstream-Request-Id': crypto.randomUUID(),
    'X-Request-Id': requestId ?? crypto.randomUUID(),
    // 桌面端总会带上会话上下文；缺失这些头的请求在服务端看来是异常信号
    'X-Session-Id': sid,
    'X-Message-Id': mid,
    'X-Teleai-Root-Session-Id': sid,
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  }
  if (typeof apiKey === 'string' && apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`
  return headers
}

/** 与桌面端同形的会话/消息标识（协议里由客户端生成，不是服务端下发） */
function newSessionId() {
  return 'ses_' + crypto.randomBytes(10).toString('hex')
}
function newMessageId() {
  return 'msg_' + crypto.randomBytes(10).toString('hex')
}

/**
 * 从完整 URL 反推签名用的 pathname。
 *
 * magpie 传进来的 `input` 是「基地址 + 该 API 的路径」，基地址是
 * `https://agent.teleai.com.cn/superCowork/sapi/api/v1`，路径是 `/chat/completions`。
 * 签名要的是 `/superCowork/sapi/api/v1/chat/completions`，也就是 URL 的 pathname。
 */
export function signedPathFrom(url) {
  try {
    const u = new URL(String(url))
    return u.pathname + (u.search || '')
  } catch {
    return TELEAI_SIGNED_PATH
  }
}

/**
 * 请求的地址是不是上游自己。
 *
 * 签名头只能发给 `https://agent.teleai.com.cn`：magpie 的 `api` 是用户可改的
 * 配置，万一被改成别的域名（打错、从别处抄来、或恶意模板），插件不该把 JWT
 * 签名与设备指纹一起送过去。
 *
 * 比的是 **origin（协议 + 域名 + 端口）**，不是字符串前缀，也不是单纯的 host：
 *   - `agent.teleai.com.cn.evil.test` —— host 不同，挡掉；
 *   - `http://agent.teleai.com.cn` —— 协议降级，签名会明文上网，挡掉。
 */
export function isUpstreamHost(url) {
  try {
    const u = new URL(String(url))
    const upstream = new URL(TELEAI_ORIGIN)
    return u.protocol === upstream.protocol && u.host === upstream.host
  } catch {
    return false
  }
}

/**
 * 只在错误信息里用的 host，解析不了就退回一个不泄露内容的说法。
 * 不带 path / query / userinfo：错误信息会进日志，不该夹带这些东西。
 */
function safeHostOf(url) {
  try {
    return new URL(String(url)).host || '（空域名）'
  } catch {
    return '（无法解析的地址）'
  }
}

/**
 * 造一个「按账号签名」的 fetch，交给 magpie 的 `auth.loader`。
 *
 * @param {object} options
 * @param {{token:string, installId?:string, deviceId?:string, appVersion?:string}} options.auth
 * @param {() => string} [options.apiKey] 网关 apiKey（可能异步取得）
 * @param {object} [options.guard] 并发/限速/熔断（见 guard.mjs）
 * @param {(event:object)=>void} [options.log]
 * @param {typeof fetch} [options.baseFetch] 测试注入
 * @returns {(input:any, init?:any) => Promise<Response>}
 */
export function createSignedFetch({ auth, apiKey, guard, log, baseFetch, onStatus } = {}) {
  const fetchImpl = baseFetch ?? globalThis.fetch
  return async function signedFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    const method = (init.method ?? 'POST').toUpperCase()
    const body = typeof init.body === 'string' ? init.body : ''
    const pathname = signedPathFrom(url)

    // 签名头只发给上游自己。magpie 的 `api` 是用户可改的配置，指向别处时
    // 不能把 JWT 签名与设备指纹一起送出去：直接拒绝，不发这个请求。
    if (!isUpstreamHost(url)) {
      throw new Error(
        `拒绝向非上游域名发送签名请求：${safeHostOf(url)}`
        + `（只允许 ${new URL(TELEAI_ORIGIN).host}；检查 magpie 里 teleagent 的 api 配置）`,
      )
    }

    let key = ''
    try { key = typeof apiKey === 'function' ? (await apiKey()) ?? '' : (apiKey ?? '') } catch { key = '' }

    const headers = buildAuthHeaders(auth, { body, method, pathname, apiKey: key })

    // loader 返回的 headers 与网关请求头合并（后者优先），magpie 已经把
    // sdkHeaders / loader headers / chat.headers 合进 init.headers 了，
    // 这里只需要「我们自己的签名头覆盖」+ 保留其它。
    const incoming = new Headers(init.headers ?? {})
    for (const [k, v] of Object.entries(headers)) {
      if (v === '' || v === undefined) continue
      incoming.set(k, v)
    }
    // 没拿到网关 apiKey 时必须**删掉** magpie 加上的
    // `Authorization: Bearer <账号 key>`（那个 key 是本插件的标记，不是上游凭据），
    // 否则上游会把一个明显错误的 Authorization 当成攻击特征（40105）。
    if (!key) incoming.delete('authorization')

    const run = async () => fetchImpl(url, {
      ...init,
      method,
      headers: incoming,
      body: init.body,
    })

    const res = guard ? await guard.withSlot(run) : await run()
    guard?.observe?.(res.status)
    onStatus?.(res.status)
    log?.({ stage: 'fetch', status: res.status, path: pathname })
    return res
  }
}

/** 上游错误形状：尽量保留厂商原话，便于 agent 直接显示 */
export function errorBodyOf(json, text) {
  const message = json?.error?.message ?? json?.message ?? json?.msg
    ?? (typeof text === 'string' && text.trim() ? text.trim().slice(0, 500) : '')
  return {
    error: {
      message: message || 'TeleAgent 上游返回了错误',
      type: 'upstream_error',
      code: String(json?.code ?? json?.error?.code ?? ''),
    },
  }
}

export { TELEAI_ORIGIN, TELEAI_BASE_URL }
