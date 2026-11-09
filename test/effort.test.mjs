/**
 * 思考档位（reasoning effort）：上游只认 low / high / max，**不接受**关闭，
 * 也不接受 medium / minimal / xhigh 等其它档位。
 *
 * 真实故障（2026-11-09，magpie 日志 usage.jsonl 第 110/111 行）：
 *
 *   {"agent":"claude-desktop","model":"chat-pro","effort":"medium","status":400,
 *    "err":"TeleAgent: 该模型始终思考，不支持关闭思考；请使用 low、high 或 max。",
 *    "err_type":"1210"}
 *
 * 触发链路：Claude Code 通过 magpie 网关调用 → magpie 把 anthropic 请求翻成
 * chat/completions → 它按自己对档位的理解写了 `reasoning_effort` →
 * 插件的 loader fetch 原样透传 → 上游 400。
 *
 * 所以插件必须在**自己的 fetch 里**把上游不接受的东西削掉：这是唯一一处
 * 既能保证「不管哪个 agent、哪个版本的 magpie 都生效」、又不需要改宿主的位置。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MODELS, TELEAI_ACCEPTED_EFFORTS, TELEAI_DEFAULT_EFFORT, buildModels } from '../lib/models.mjs'
import { normalizeUpstreamBody, reasoningOfBody } from '../lib/effort.mjs'
import TeleAgentPlugin from '../index.mjs'
import { sealFixture } from './helpers/credential-fixture.mjs'

describe('上游接受的思考档位', () => {
  it('就是 low / high / max（来自上游 400 的原话）', () => {
    expect(TELEAI_ACCEPTED_EFFORTS).toEqual(['low', 'high', 'max'])
  })

  it('默认档位在可接受集合里（不能是关闭）', () => {
    expect(TELEAI_ACCEPTED_EFFORTS).toContain(TELEAI_DEFAULT_EFFORT)
    expect(TELEAI_DEFAULT_EFFORT).not.toBe('off')
    expect(TELEAI_DEFAULT_EFFORT).not.toBe('none')
  })
})

describe('normalizeUpstreamBody：把档位削成上游认的', () => {
  const base = { model: 'chat-pro', messages: [{ role: 'user', content: 'hi' }] }

  it('medium（真实故障里的值）→ 落到最近的合法档位', () => {
    const out = normalizeUpstreamBody(JSON.stringify({ ...base, reasoning_effort: 'medium' }))
    expect(JSON.parse(out.body).reasoning_effort).toBe('high')
    expect(out.changed).toBe(true)
    expect(out.from).toBe('medium')
    expect(out.to).toBe('high')
  })

  it('low / high / max 原样保留（三个合法档位一个都不动）', () => {
    for (const level of ['low', 'high', 'max']) {
      const out = normalizeUpstreamBody(JSON.stringify({ ...base, reasoning_effort: level }))
      expect(JSON.parse(out.body).reasoning_effort).toBe(level)
      expect(out.changed).toBe(false)
    }
  })

  it('关闭思考的写法一律删掉（上游明确不接受）', () => {
    for (const level of ['off', 'none', 'disabled', '', null]) {
      const out = normalizeUpstreamBody(JSON.stringify({ ...base, reasoning_effort: level }))
      const parsed = JSON.parse(out.body)
      expect('reasoning_effort' in parsed).toBe(false)
      expect(out.changed).toBe(true)
      expect(out.to).toBe(null)
    }
  })

  it('minimal / xhigh 落到最近的合法档位', () => {
    expect(JSON.parse(normalizeUpstreamBody(JSON.stringify({ ...base, reasoning_effort: 'minimal' })).body).reasoning_effort).toBe('low')
    expect(JSON.parse(normalizeUpstreamBody(JSON.stringify({ ...base, reasoning_effort: 'xhigh' })).body).reasoning_effort).toBe('high')
  })

  it('其它形状的思考开关也删掉（enable_thinking / thinking）', () => {
    const out = normalizeUpstreamBody(JSON.stringify({ ...base, enable_thinking: false, thinking: { type: 'disabled' } }))
    const parsed = JSON.parse(out.body)
    expect('enable_thinking' in parsed).toBe(false)
    expect('thinking' in parsed).toBe(false)
    expect(out.changed).toBe(true)
  })

  it('正文没有思考字段时原样返回同一个字符串（不改字节）', () => {
    const raw = JSON.stringify(base)
    const out = normalizeUpstreamBody(raw)
    expect(out.body).toBe(raw)
    expect(out.changed).toBe(false)
  })

  it('非 JSON / 空正文原样放行（不吞掉上游能处理的请求）', () => {
    for (const raw of ['', 'not json', undefined, null]) {
      const out = normalizeUpstreamBody(raw)
      expect(out.body).toBe(typeof raw === 'string' ? raw : '')
      expect(out.changed).toBe(false)
    }
  })

  it('保留其余字段不动（只碰思考相关的键）', () => {
    const body = { ...base, temperature: 0.3, tools: [{ type: 'function' }], reasoning_effort: 'medium' }
    const parsed = JSON.parse(normalizeUpstreamBody(JSON.stringify(body)).body)
    expect(parsed.temperature).toBe(0.3)
    expect(parsed.tools).toEqual([{ type: 'function' }])
    expect(parsed.messages).toEqual(base.messages)
  })
})

describe('reasoningOfBody', () => {
  it('读出请求体里的档位（没有就是空串）', () => {
    expect(reasoningOfBody('{"reasoning_effort":"medium"}')).toBe('medium')
    expect(reasoningOfBody('{"messages":[]}')).toBe('')
    expect(reasoningOfBody('not json')).toBe('')
  })
})

describe('模型清单不越权声明档位', () => {
  it('插件不声明 reasoningEfforts（magpie 的模型 schema 不读它，声明了是假的）', () => {
    // 结论来自 magpie 二进制：provider.info() 合并 config/plugin 模型时只读
    // capabilities.reasoning（布尔），档位来自它自己的 provider 配置
    // （Provider.ModelEfforts / SetModelEfforts）；`reasoningEfforts` 只出现在
    // magpie 自己的 agent 设置结构里（yaml 标签），不是插件模型字段。
    for (const m of Object.values(buildModels())) {
      expect(m.reasoningEfforts).toBeUndefined()
    }
  })

  it('目录里的 5 个模型仍然都有 rate', () => {
    const models = buildModels()
    expect(Object.keys(models)).toHaveLength(5)
    for (const id of MODELS.map((m) => m.id)) expect(models[id].rate).toBeTruthy()
  })
})

/**
 * 真实链路的回归：Claude Code 经 magpie 网关发来的正是这一段——
 * anthropic 请求被翻成 chat/completions，body 里带 `reasoning_effort: "medium"`，
 * 上游回 400 / 1210。这里断言插件在**真正发出去之前**就把它削成 high。
 *
 * 为了让这条测试**一定会走到发请求那一步**（否则它只会在凭据失败处返回，
 * 变成永远绿的假测试），这里把环境完全隔离出来：
 *   - 临时 HOME 里造一份 v10 加密的假凭据；
 *   - PATH 前面放一个假的 `security`，给出解密口令；
 *   - 只有最外层 fetch 是替身，签名 / 凭据 / 拼头都走真实代码。
 * 任何一个前提不成立时**直接失败**，不再静默跳过。
 */
describe('loader fetch 的接线（真实故障复现）', () => {
  let home = ''
  let stubbed = ''
  const prev = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    TELEAGENT_DATA: process.env.TELEAGENT_DATA,
    TELEAGENT_CONFIG: process.env.TELEAGENT_CONFIG,
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'te-magpie-effort-'))
    const dataDir = path.join(home, '.local', 'share', 'TeleAgent')
    const scope = 'v1_public_1'
    const dir = path.join(dataDir, 'users', scope, 'app-auth')
    fs.mkdirSync(dir, { recursive: true })

    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const token = `${enc({ alg: 'HS256' })}.${enc({
      accountName: '示例账号',
      accountId: '1',
      exp: Math.floor(Date.now() / 1000) + 86400,
    })}.sig`
    fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({
      version: 1,
      encryptedToken: sealFixture(`tenant:${token}`, 'pw-1', dataDir),
      encrypted: true,
      scheme: 'safe_storage',
    }))
    const appAuth = path.join(dataDir, 'app-auth')
    fs.mkdirSync(appAuth, { recursive: true })
    fs.writeFileSync(path.join(appAuth, 'device-meta.json'), JSON.stringify({ deviceId: 'd-1', installId: 'i-1' }))

    // 假的 security：直接吐解密口令
    stubbed = fs.mkdtempSync(path.join(os.tmpdir(), 'te-fakebin-'))
    const fake = path.join(stubbed, 'security')
    fs.writeFileSync(fake, '#!/bin/sh\necho "pw-1"\n')
    fs.chmodSync(fake, 0o755)

    process.env.HOME = home
    process.env.TELEAGENT_DATA = dataDir
    process.env.TELEAGENT_CONFIG = path.join(home, '.config', 'TeleAgent')
    process.env.PATH = `${stubbed}${path.delimiter}${prev.PATH ?? ''}`
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(stubbed, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  async function attemptFetch(bodyText) {
    const h = await TeleAgentPlugin({ magpie: { options: {} }, client: { app: { log() {} } } })
    const opts = await h.auth.loader(async () => ({ key: 'v1_public_1' }))
    const sent = []
    const real = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), body: init?.body })
      return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    try {
      const res = await opts.fetch('https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions', {
        method: 'POST',
        body: bodyText,
      })
      return { sent, res, error: null }
    } catch (error) {
      return { sent, res: null, error }
    } finally {
      globalThis.fetch = real
    }
  }

  it('medium 经 loader 之后以 high 发出', async () => {
    const { sent, error, res } = await attemptFetch(JSON.stringify({
      model: 'chat-pro',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'medium',
    }))
    if (error) throw new Error(`请求没能发出去，测试前提被破坏：${error.message}`)
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    const out = JSON.parse(sent[0].body)
    expect(out.reasoning_effort).toBe('high')
    expect(out.model).toBe('chat-pro')
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('关闭思考的请求不带该字段（上游不认"关闭"）', async () => {
    const { sent, error } = await attemptFetch(JSON.stringify({
      model: 'chat-pro',
      messages: [],
      reasoning_effort: 'off',
    }))
    if (error) throw new Error(`请求没能发出去，测试前提被破坏：${error.message}`)
    expect(sent).toHaveLength(1)
    expect('reasoning_effort' in JSON.parse(sent[0].body)).toBe(false)
  })

  it('签名用的是改写后的 body（否则上游会因签名不符回 40104）', async () => {
    // 真实链路里 sign.mjs 会对**发出去的** body 做 sha256 再签。
    // 如果先签后改，header 里的签名就和 body 对不上。
    // 这里断言：抓到的 body 是改写后的，且它参与签名的值（sha256）与之一致。
    const { sent, error } = await attemptFetch(JSON.stringify({
      model: 'chat-pro',
      messages: [],
      reasoning_effort: 'medium',
    }))
    if (error) throw new Error(`请求没能发出去，测试前提被破坏：${error.message}`)
    expect(sent).toHaveLength(1)
    const body = sent[0].body
    expect(JSON.parse(body).reasoning_effort).toBe('high')
    const { computeSignature } = await import('../lib/sign.mjs')
    const pathname = new URL(sent[0].url).pathname
    const ts = '1700000000'
    const nonce = 'n-1'
    // 用**改写后**的 body 签名，与用原始 body 签名的结果必须不同：
    // 这正是"签名覆盖的是发出去的那份字节"的证明
    const sign = (b) => computeSignature({
      token: 'a.b.c', installId: 'i-1', appVersion: '1', method: 'POST', pathname, ts, nonce, body: b,
    }).signature
    const original = JSON.stringify({ model: 'chat-pro', messages: [], reasoning_effort: 'medium' })
    expect(sign(body)).not.toBe(sign(original))
    // 而插件实际发出去的就是 body 这一份
    expect(sent[0].body).toBe(body)
  })

  it('合法的 high 原样发出（不改字节）', async () => {
    const body = JSON.stringify({ model: 'chat-pro', messages: [], reasoning_effort: 'high' })
    const { sent, error } = await attemptFetch(body)
    if (error) throw new Error(`请求没能发出去，测试前提被破坏：${error.message}`)
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toBe(body)
  })
})
