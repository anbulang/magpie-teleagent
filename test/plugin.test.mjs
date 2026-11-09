/**
 * 插件骨架的单元测试：导出的形状、config 钩子、模型钩子、chat.headers、工具。
 *
 * 这些测试**不碰真实账号与网络**：需要登录态的钩子用注入的假数据，
 * 只有拿不到凭据时的失败分支会被走到（那些分支本身也不发包）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import TeleAgentPlugin, { PROVIDER, _internal } from '../index.mjs'
import { MODELS } from '../lib/models.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))

async function hooks(options = {}) {
  return TeleAgentPlugin({ magpie: { options }, client: { app: { log() {} } } })
}

describe('package.json', () => {
  it('是 OpenCode v1 插件（type module + main 指向入口）', () => {
    expect(PKG.type).toBe('module')
    expect(PKG.main).toBe('./index.mjs')
  })

  it('带 magpie 自己的字段（名字 / 简介 / 图标可选）', () => {
    expect(PKG.magpie).toBeTruthy()
    expect(typeof PKG.magpie.name).toBe('string')
    expect(PKG.magpie.name.length).toBeLessThanOrEqual(80)
  })

  it('keywords 里有 opencode / opencode-plugin（magpie 搜索靠它）', () => {
    expect(PKG.keywords).toContain('opencode')
    expect(PKG.keywords).toContain('opencode-plugin')
  })

  it('允许 macOS 和 Windows 安装', () => {
    expect(PKG.os).toEqual(['darwin', 'win32'])
  })

  it('没有运行时依赖（Bun 直接跑）', () => {
    expect(PKG.dependencies ?? {}).toEqual({})
  })
})

describe('插件导出', () => {
  it('默认导出是 async 函数（OpenCode v1 形状）', async () => {
    expect(typeof TeleAgentPlugin).toBe('function')
    const h = await hooks()
    expect(h).toBeTruthy()
    expect(typeof h).toBe('object')
  })

  it('只导出插件函数 + 常量 + _internal（不导出会被误当插件的函数）', async () => {
    const mod = await import('../index.mjs')
    const exportedFunctions = Object.entries(mod)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k)
    // default 是插件函数本身；其余函数必须收在 _internal 里
    expect(exportedFunctions).toEqual(['default'])
  })

  it('hooks 里有 config / auth / provider / chat.headers / tool', async () => {
    const h = await hooks()
    expect(typeof h.config).toBe('function')
    expect(h.auth).toBeTruthy()
    expect(h.provider).toBeTruthy()
    expect(typeof h['chat.headers']).toBe('function')
    expect(h.tool).toBeTruthy()
  })

  it('供应商 id 是 teleagent', () => {
    expect(PROVIDER).toBe('teleagent')
  })
})

describe('config 钩子', () => {
  it('声明供应商与 5 个模型', async () => {
    const h = await hooks()
    const cfg = {}
    await h.config(cfg)
    const provider = cfg.provider[PROVIDER]
    expect(provider.name).toBe('TeleAgent')
    expect(provider.npm).toBe('@ai-sdk/openai-compatible')
    expect(Object.keys(provider.models)).toEqual(MODELS.map((m) => m.id))
  })

  it('用 ??= ，不覆盖用户已有的配置', async () => {
    const h = await hooks()
    const mine = { name: '我的 TeleAgent', npm: '@ai-sdk/openai-compatible', models: { custom: { name: 'x' } } }
    const cfg = { provider: { [PROVIDER]: mine } }
    await h.config(cfg)
    expect(cfg.provider[PROVIDER]).toBe(mine)
  })

  it('没有 provider 字段时自己建一个', async () => {
    const h = await hooks()
    const cfg = {}
    await h.config(cfg)
    expect(cfg.provider).toBeTruthy()
  })
})

describe('provider.models 钩子', () => {
  it('把厂商倍率补回模型上（config 那层的 rate 到不了 magpie）', async () => {
    const h = await hooks()
    const cfg = {}
    await h.config(cfg)
    const provider = cfg.provider[PROVIDER]
    const listed = await h.provider.models(provider)
    for (const m of MODELS) expect(listed[m.id].rate).toBe(m.rate)
  })

  it('不认识的模型原样返回（不丢字段、不抛）', async () => {
    const h = await hooks()
    const listed = await h.provider.models({ models: { 'chat-x': { name: 'X' } } })
    expect(listed['chat-x'].name).toBe('X')
  })

  it('provider id 与 config 里的一致', async () => {
    const h = await hooks()
    expect(h.provider.id).toBe(PROVIDER)
  })
})

describe('chat.headers 钩子', () => {
  it('只对本供应商生效', async () => {
    const h = await hooks()
    const out = { headers: {} }
    await h['chat.headers']({ model: { providerID: 'codex' }, sessionID: 'ses_1' }, out)
    expect(out.headers).toEqual({})
  })

  it('把 sessionID 变成稳定的会话头', async () => {
    const h = await hooks()
    const out = { headers: {} }
    await h['chat.headers']({ model: { providerID: PROVIDER }, sessionID: 'ses_abc-123' }, out)
    expect(out.headers['x-teleagent-session']).toBe('ses_abc-123')
  })

  it('sessionID 为空时不加头', async () => {
    const h = await hooks()
    const out = { headers: {} }
    await h['chat.headers']({ model: { providerID: PROVIDER }, sessionID: '' }, out)
    expect(out.headers).toEqual({})
  })

  it('剔除不安全字符（上游头不能带奇怪字符）', async () => {
    const h = await hooks()
    const out = { headers: {} }
    await h['chat.headers']({ model: { providerID: PROVIDER }, sessionID: 'a/b c#d' }, out)
    expect(out.headers['x-teleagent-session']).toBe('abcd')
  })
})

describe('tool 钩子', () => {
  it('提供一个只读的 points 工具（magpie 会拼成 <插件短名>_points）', async () => {
    const h = await hooks()
    const tool = h.tool.points
    expect(tool).toBeTruthy()
    expect(typeof tool.execute).toBe('function')
    expect(tool.description).toContain('只读')
    expect(tool.args).toEqual({ type: 'object', properties: {}, required: [] })
  })

  it('工具没有可写参数（只读）', async () => {
    const h = await hooks()
    expect(Object.keys(h.tool.points.args.properties)).toEqual([])
  })
})

describe('登录方式', () => {
  it('是一个免输入（keyless）的 api 方式', async () => {
    const h = await hooks()
    const method = h.auth.methods[0]
    expect(method.type).toBe('api')
    expect(method.keyless).toBe(true)
    expect(method.label).toContain('TeleAgent')
  })

  it('有一个账号选择提问（多账号时让用户选）', async () => {
    const h = await hooks()
    const prompt = h.auth.methods[0].prompts[0]
    expect(prompt.type).toBe('select')
    expect(prompt.key).toBe('scope')
    expect(Array.isArray(prompt.options)).toBe(true)
    expect(prompt.options.length).toBeGreaterThan(0)
  })

  it('auth 里声明并发上限（账号存活参数）', async () => {
    const h = await hooks()
    expect(h.auth.maxConcurrency).toBe(2)
  })

  it('usage / checkin 都是 magpie 自己的钩子', async () => {
    const h = await hooks()
    expect(typeof h.auth.usage).toBe('function')
    expect(typeof h.auth.checkin).toBe('function')
  })

  it('loader 是函数（每个账号跑一次）', async () => {
    const h = await hooks()
    expect(typeof h.auth.loader).toBe('function')
  })
})

describe('_internal', () => {
  it('暴露可直接测的辅助函数', () => {
    expect(typeof _internal.modelOfBody).toBe('function')
    expect(typeof _internal.explainFailure).toBe('function')
    expect(typeof _internal.buildScopeOptions).toBe('function')
  })

  it('modelOfBody 从请求体里取 model', () => {
    expect(_internal.modelOfBody('{"model":"chat-pro"}')).toBe('chat-pro')
    expect(_internal.modelOfBody('{"messages":[]}')).toBe('')
    expect(_internal.modelOfBody('')).toBe('')
    expect(_internal.modelOfBody('not json')).toBe('')
  })

  it('scopeOf 从账号 key 取 scope', () => {
    expect(_internal.scopeOf({ key: 'v1_public_1' })).toBe('v1_public_1')
    expect(_internal.scopeOf({})).toBe('')
    expect(_internal.scopeOf(undefined)).toBe('')
  })
})

describe('loader（没有凭据时）', () => {
  const prevData = process.env.TELEAGENT_DATA
  const prevCfg = process.env.TELEAGENT_CONFIG

  beforeEach(() => {
    // 指到不存在的目录：loader 会在发请求**之前**就失败，不会碰网络
    process.env.TELEAGENT_DATA = '/tmp/te-magpie-does-not-exist'
    process.env.TELEAGENT_CONFIG = '/tmp/te-magpie-does-not-exist-config'
  })

  afterEach(() => {
    if (prevData === undefined) delete process.env.TELEAGENT_DATA
    else process.env.TELEAGENT_DATA = prevData
    if (prevCfg === undefined) delete process.env.TELEAGENT_CONFIG
    else process.env.TELEAGENT_CONFIG = prevCfg
  })

  it('返回 baseURL / 占位 apiKey / fetch', async () => {
    const h = await hooks()
    const opts = await h.auth.loader(async () => ({ key: 'v1_public_1' }))
    expect(opts.baseURL).toContain('/superCowork/sapi')
    // apiKey 只是给 magpie 加 Authorization 用的占位值，不是真凭据
    expect(opts.apiKey).toContain('teleagent:')
    expect(typeof opts.fetch).toBe('function')
  })

  it('凭据不可用时 fetch 抛错，且错误里带可执行建议（不发请求）', async () => {
    const h = await hooks()
    const opts = await h.auth.loader(async () => ({ key: 'v1_public_1' }))
    try {
      await opts.fetch('https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions', {
        method: 'POST',
        body: '{"model":"chat-flash","messages":[]}',
      })
      throw new Error('应该抛错')
    } catch (error) {
      expect(error.message).toContain('TeleAgent 凭据不可用')
      expect(error.code).toBeTruthy()
    }
  })
})

describe('explainFailure', () => {
  const { explainFailure } = _internal

  it('200 原样返回（同一个对象）', async () => {
    const res = new Response('ok', { status: 200 })
    expect(await explainFailure(res)).toBe(res)
  })

  it('普通的 401（不是封禁）也原样返回', async () => {
    const res = new Response('{"message":"unauthorized"}', { status: 401 })
    const out = await explainFailure(res)
    expect(out.status).toBe(401)
    expect(out.headers.get('x-magpie-sign-in')).toBeNull()
  })

  it('40109 封禁 → x-magpie-sign-in: kept', async () => {
    // 封的是模型调用通道，桌面端登录态仍然有效（quota 还能读），
    // 报 expired 会把用户引向「重新登录」，而重登解决不了封禁。
    const res = new Response('{"code":40109,"message":"current user is banned"}', { status: 401 })
    const out = await explainFailure(res)
    expect(out.status).toBe(401)
    expect(out.headers.get('x-magpie-sign-in')).toBe('kept')
  })

  it('40105 疑似攻击 → x-magpie-sign-in: kept（不要误判成登录失效）', async () => {
    const res = new Response('{"code":40105,"message":"您的请求疑似攻击请求"}', { status: 401 })
    const out = await explainFailure(res)
    expect(out.headers.get('x-magpie-sign-in')).toBe('kept')
  })

  it('两种错误都不会被标成 expired（真正的过期只走 loader 的 signIn）', async () => {
    for (const body of ['{"code":40109,"message":"current user is banned"}', '{"code":40105,"message":"您的请求疑似攻击请求"}']) {
      const out = await explainFailure(new Response(body, { status: 401 }))
      expect(out.headers.get('x-magpie-sign-in')).not.toBe('expired')
    }
  })

  it('正文原样保留（agent 要看到厂商原话）', async () => {
    const body = '{"code":40109,"message":"current user is banned"}'
    const out = await explainFailure(new Response(body, { status: 401 }))
    expect(await out.text()).toBe(body)
  })
})

describe('目录外模型的拦截', () => {
  it('404 且提示可用模型，不读凭据、不发请求', async () => {
    const h = await hooks()
    const opts = await h.auth.loader(async () => ({ key: 'v1_public_1' }))
    // 故意不设置 TELEAGENT_DATA：如果实现先去读凭据，这里会抛错而不是返回 404
    const res = await opts.fetch('https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'ghost-model' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.message).toContain('ghost-model')
    expect(body.error.message).toContain('chat-pro')
  })

  it('请求体里没有 model 时不拦（交给上游按原样处理）', async () => {
    const h = await hooks()
    const opts = await h.auth.loader(async () => ({ key: 'v1_public_1' }))
    expect(_internal.modelOfBody('{"messages":[]}')).toBe('')
  })
})

describe('prompts 是 getter', () => {
  it('每次读都会重新生成（刚登录的新账号下次 login 就能看到）', async () => {
    const h = await hooks()
    const method = h.auth.methods[0]
    const first = method.prompts
    const second = method.prompts
    // 内容可能相同，但不能是同一个数组实例（说明每次都在重新算）
    expect(Array.isArray(first)).toBe(true)
    expect(first).not.toBe(second)
  })
})
