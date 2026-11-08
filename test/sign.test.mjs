/**
 * 签名、模型目录、guard 的单元测试。
 *
 * 这些测试**不发任何网络请求**：签名是纯函数，模型目录是静态表，
 * guard 用注入的时钟和假的 fn。
 *
 * 运行：
 *   bun test test/            （magpie 自带 bun：~/.cache/magpie/bun/<ver>/magpie-bun）
 */
import { describe, it, expect } from 'bun:test'
import crypto from 'node:crypto'

import {
  computeSignature,
  buildAuthHeaders,
  signedPathFrom,
  createSignedFetch,
} from '../lib/sign.mjs'
import { MODELS, buildModels, VISION_MODEL_IDS, TELEAI_BASE_URL, TELEAI_SIGNED_PATH } from '../lib/models.mjs'
import { createGuard, GuardBlockedError, DEFAULT_GUARD } from '../lib/guard.mjs'

// ---------------------------------------------------------------- 签名

/** 独立重算一遍签名（不复用实现里的内部函数），用来锁住算法 */
function referenceSignature({ token, installId, appVersion, method, pathname, ts, nonce, body }) {
  const h = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex')
  const jwtThird = token.split('.')[2] ?? ''
  const k1 = h(jwtThird, `superagent-auth-v1/${token}/${installId}/${ts}/${nonce}`)
  const sha = crypto.createHash('sha256').update(body).digest('hex')
  return h(k1, ['superagent-auth-v1', method, pathname, ts, nonce, appVersion, sha].join('\n'))
}

const FIXTURE = {
  token: 'tenant.eyJhIjoxfQ.c2lnbmF0dXJl',
  installId: 'install-1',
  appVersion: '2.7.1',
  method: 'POST',
  pathname: '/superCowork/sapi/api/v1/chat/completions',
  ts: '1700000000',
  nonce: 'nonce-1',
  body: '{"model":"chat-flash"}',
}

describe('computeSignature', () => {
  it('与独立实现一致（两步 HMAC，换行分隔）', () => {
    const { signature } = computeSignature(FIXTURE)
    expect(signature).toBe(referenceSignature(FIXTURE))
  })

  it('k1 是第一次 HMAC 的十六进制结果，并被当作第二次的 key', () => {
    const { k1, signature } = computeSignature(FIXTURE)
    expect(k1).toMatch(/^[0-9a-f]{64}$/)
    const sha = crypto.createHash('sha256').update(FIXTURE.body).digest('hex')
    const expected = crypto.createHmac('sha256', k1)
      .update(['superagent-auth-v1', FIXTURE.method, FIXTURE.pathname, FIXTURE.ts, FIXTURE.nonce, FIXTURE.appVersion, sha].join('\n'))
      .digest('hex')
    expect(signature).toBe(expected)
  })

  it('body 变化会改变签名（说明 body 参与摘要）', () => {
    const a = computeSignature(FIXTURE).signature
    const b = computeSignature({ ...FIXTURE, body: '{"model":"chat-pro"}' }).signature
    expect(a).not.toBe(b)
  })

  it('ts / nonce 变化会改变签名', () => {
    const base = computeSignature(FIXTURE).signature
    expect(computeSignature({ ...FIXTURE, ts: '1700000001' }).signature).not.toBe(base)
    expect(computeSignature({ ...FIXTURE, nonce: 'nonce-2' }).signature).not.toBe(base)
  })

  it('pathname 必须带 /superCowork/sapi 前缀（不带就是另一个签名）', () => {
    const withPrefix = computeSignature(FIXTURE).signature
    const without = computeSignature({ ...FIXTURE, pathname: '/api/v1/chat/completions' }).signature
    expect(withPrefix).not.toBe(without)
  })

  it('token 没有第三段时不抛错（退化成空 key）', () => {
    const out = computeSignature({ ...FIXTURE, token: 'only-two.parts' })
    expect(out.signature).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('buildAuthHeaders', () => {
  const auth = { token: FIXTURE.token, installId: 'install-1', deviceId: 'device-1', appVersion: '2.7.1' }

  it('带上全部上游要求的头', () => {
    const headers = buildAuthHeaders(auth, { body: '{}', ts: '1700000000', nonce: 'n' })
    for (const key of [
      'X-Token', 'X-Superagent-Device-Id', 'X-Superagent-Install-Id',
      'X-Superagent-Timestamp', 'X-Superagent-Nonce', 'X-Superagent-Sign-Version',
      'X-Superagent-Signature', 'X-Route-Target', 'X-Teleai-Run-Unit-Type',
      'X-Session-Id', 'X-Message-Id', 'X-Teleai-Root-Session-Id',
    ]) {
      expect(headers[key]).toBeTruthy()
    }
    expect(headers['X-Superagent-Sign-Version']).toBe('v1')
    expect(headers['X-Route-Target']).toBe('ops-gateway')
  })

  it('session 与 root-session 指向同一个 id', () => {
    const headers = buildAuthHeaders(auth, { body: '{}' })
    expect(headers['X-Teleai-Root-Session-Id']).toBe(headers['X-Session-Id'])
  })

  it('有网关 apiKey 时加 Bearer，没有就不加', () => {
    expect(buildAuthHeaders(auth, { body: '{}', apiKey: 'sk-test' }).Authorization).toBe('Bearer sk-test')
    expect(buildAuthHeaders(auth, { body: '{}' }).Authorization).toBeUndefined()
  })

  it('默认不把 token 放进 Authorization', () => {
    const headers = buildAuthHeaders(auth, { body: '{}' })
    expect(String(headers.Authorization ?? '')).not.toContain(FIXTURE.token)
    // token 只通过 X-Token 传
    expect(headers['X-Token']).toBe(FIXTURE.token)
  })
})

describe('signedPathFrom', () => {
  it('从完整 URL 取 pathname（含 /superCowork/sapi 前缀）', () => {
    expect(signedPathFrom(`${TELEAI_BASE_URL}/chat/completions`)).toBe(TELEAI_SIGNED_PATH)
  })

  it('保留 query', () => {
    expect(signedPathFrom(`${TELEAI_BASE_URL}/chat/completions?a=1`)).toBe(`${TELEAI_SIGNED_PATH}?a=1`)
  })

  it('非法 URL 回退到默认对话路径（不抛）', () => {
    expect(signedPathFrom('not a url')).toBe(TELEAI_SIGNED_PATH)
  })
})

describe('createSignedFetch', () => {
  const auth = { token: FIXTURE.token, installId: 'i', deviceId: 'd', appVersion: '2.7.1' }

  it('用新的 ts/nonce 签名，并把请求交给注入的 fetch', async () => {
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push({ url, init })
      return new Response('ok', { status: 200 })
    }
    const signed = createSignedFetch({ auth, apiKey: 'sk-gw', baseFetch: fetchImpl })
    const res = await signed(`${TELEAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer teleagent:scope' },
      body: '{"model":"chat-flash"}',
    })
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    const headers = seen[0].init.headers
    expect(headers.get('authorization')).toBe('Bearer sk-gw')
    expect(headers.get('x-superagent-signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(headers.get('x-token')).toBe(FIXTURE.token)
  })

  it('没有网关 key 时删掉 magpie 加的 Authorization', async () => {
    let captured
    const signed = createSignedFetch({
      auth,
      apiKey: '',
      baseFetch: async (url, init) => { captured = init; return new Response('ok') },
    })
    await signed(`${TELEAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer teleagent:scope' },
      body: '{}',
    })
    expect(captured.headers.get('authorization')).toBeNull()
  })

  it('两次请求的 nonce 不同（签名不可重放）', async () => {
    const nonces = []
    const signed = createSignedFetch({
      auth,
      apiKey: 'k',
      baseFetch: async (url, init) => {
        nonces.push(init.headers.get('x-superagent-nonce'))
        return new Response('ok')
      },
    })
    await signed(`${TELEAI_BASE_URL}/chat/completions`, { method: 'POST', body: '{}' })
    await signed(`${TELEAI_BASE_URL}/chat/completions`, { method: 'POST', body: '{}' })
    expect(nonces[0]).not.toBe(nonces[1])
  })

  it('经过 guard：记录状态码', async () => {
    const statuses = []
    const guard = createGuard({})
    const signed = createSignedFetch({
      auth,
      apiKey: 'k',
      guard,
      baseFetch: async () => new Response('ok', { status: 200 }),
      onStatus: (s) => statuses.push(s),
    })
    await signed(`${TELEAI_BASE_URL}/chat/completions`, { method: 'POST', body: '{}' })
    expect(statuses).toEqual([200])
  })
})

// ---------------------------------------------------------------- 模型目录

describe('MODELS / buildModels', () => {
  it('5 个模型，id 与上游一致', () => {
    expect(MODELS.map((m) => m.id)).toEqual(['chat-pro', 'chat-flagship', 'chat-flash', 'chat-lite', 'chat-nano'])
  })

  it('上下文与输出上限来自实测目录', () => {
    const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]))
    expect(byId['chat-pro'].contextWindow).toBe(400_000)
    expect(byId['chat-pro'].maxTokens).toBe(65_536)
    expect(byId['chat-lite'].contextWindow).toBe(100_000)
    // 轻量/轻速的输出上限是 16384（桌面端账号配置里的真实值）
    expect(byId['chat-lite'].maxTokens).toBe(16_384)
    expect(byId['chat-nano'].maxTokens).toBe(16_384)
  })

  it('倍率用厂商写法，且不等于 0（0 会被 magpie 当作「没有倍率」）', () => {
    for (const m of MODELS) {
      expect(m.rate).toMatch(/^x\d/)
      expect(Number(m.rate.slice(1))).toBeGreaterThan(0)
    }
  })

  it('只有实测支持视觉的模型声明图片', () => {
    expect(VISION_MODEL_IDS).toEqual(['chat-pro', 'chat-flash'])
    const models = buildModels()
    expect(models['chat-pro'].modalities.input).toContain('image')
    expect(models['chat-flash'].modalities.input).toContain('image')
    for (const id of ['chat-flagship', 'chat-lite', 'chat-nano']) {
      expect(models[id].modalities.input).not.toContain('image')
      expect(models[id].attachment).toBe(false)
    }
  })

  it('每个模型都带 rate / reasoning / tool_call / interleaved', () => {
    const models = buildModels()
    for (const m of Object.values(models)) {
      expect(m.rate).toBeTruthy()
      expect(m.reasoning).toBe(true)
      expect(m.tool_call).toBe(true)
      expect(m.interleaved.field).toBe('reasoning_content')
    }
  })

  it('基地址以 /v1 结尾（magpie 会拼 /chat/completions）', () => {
    expect(TELEAI_BASE_URL.endsWith('/v1')).toBe(true)
  })
})

// ---------------------------------------------------------------- guard

describe('createGuard', () => {
  it('默认数字就是账号存活参数（并发 2 / 每分钟 20 / 熔断 10 分钟）', () => {
    const guard = createGuard({})
    expect(guard.config.maxConcurrent).toBe(2)
    expect(guard.config.maxPerMinute).toBe(20)
    expect(guard.config.cooldownMs).toBe(10 * 60 * 1000)
    expect(DEFAULT_GUARD.failureThreshold).toBe(3)
  })

  it('并发上限：第 3 个请求要排队', async () => {
    let running = 0
    let peak = 0
    const guard = createGuard({ maxPerMinute: 0 })
    const task = async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 10))
      running--
    }
    await Promise.all([guard.withSlot(task), guard.withSlot(task), guard.withSlot(task)])
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('连续 3 次 401 → 熔断；冷却期间 check() 抛 GuardBlockedError', () => {
    let clock = 0
    const guard = createGuard({ maxPerMinute: 0 }, () => clock)
    guard.observe(401)
    guard.observe(401)
    expect(guard.isOpen()).toBe(false)
    guard.observe(401)
    expect(guard.isOpen()).toBe(true)
    expect(() => guard.check()).toThrow(GuardBlockedError)
    // 冷却结束
    clock += 10 * 60 * 1000 + 1
    expect(guard.isOpen()).toBe(false)
    expect(() => guard.check()).not.toThrow()
  })

  it('非认证失败会闭合熔断（403 之后的 200 清计数）', () => {
    let clock = 0
    const guard = createGuard({ maxPerMinute: 0 }, () => clock)
    guard.observe(403)
    guard.observe(403)
    guard.observe(200)
    guard.observe(401)
    expect(guard.isOpen()).toBe(false)
  })

  it('reset() 清掉旧账号的熔断状态', () => {
    const guard = createGuard({ maxPerMinute: 0 })
    guard.observe(401); guard.observe(401); guard.observe(401)
    expect(guard.isOpen()).toBe(true)
    guard.reset()
    expect(guard.isOpen()).toBe(false)
    expect(guard.snapshot().consecutiveFailures).toBe(0)
  })

  it('snapshot 给出可读状态', () => {
    const guard = createGuard({})
    const snap = guard.snapshot()
    expect(snap.maxConcurrent).toBe(2)
    expect(snap.maxPerMinute).toBe(20)
    expect(snap.open).toBe(false)
  })
})
