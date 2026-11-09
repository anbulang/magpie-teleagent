import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { writeAsar } from './helpers/asar-fixture.mjs'
import { sealFixture } from './helpers/credential-fixture.mjs'
import TeleAgentPlugin from '../index.mjs'

// Exercise authorize with a serialized prompt, just as the host/UI does.
// Credentials and the keychain command are local fixtures; no real account is read.
describe('登录与刷新账号状态', () => {
  let home, data, previous, originalFetch

  beforeEach(() => {
    previous = Object.fromEntries(['HOME', 'PATH', 'TELEAGENT_DATA', 'TELEAGENT_CONFIG', 'TELEAGENT_APP_PATH', 'TELEAGENT_API_KEY']
      .map((key) => [key, process.env[key]]))
    originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('Unexpected network request in login test') }
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teleagent-login-'))
    data = path.join(home, '.local', 'share', 'TeleAgent')
    const bin = path.join(home, 'bin')
    fs.mkdirSync(data, { recursive: true })
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\nprintf fixture-password\n', { mode: 0o755 })
    process.env.HOME = home
    process.env.TELEAGENT_DATA = data
    process.env.TELEAGENT_CONFIG = path.join(home, '.config', 'TeleAgent')
    process.env.PATH = `${bin}${path.delimiter}${previous.PATH ?? ''}`
    process.env.TELEAGENT_APP_PATH = home
    delete process.env.TELEAGENT_API_KEY
    installVersion('2.7.1')
  })

  function installVersion(version, apiKey = 'fixture-gateway-key') {
    writeAsar(path.join(home, 'app.asar'), {
      'package.json': JSON.stringify({ version }),
      'dist-electron/main-runtime-fixture.js': `{ id: "new-api", apiKey: "${apiKey}" }`,
    })
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(home, { recursive: true, force: true })
  })

  function signIn(scope = 'v1_public_42') {
    const claims = Buffer.from(JSON.stringify({ accountId: '42', accountName: 'Fixture', exp: 4102444800 })).toString('base64url')
    const token = `tenant:eyJhbGciOiJIUzI1NiJ9.${claims}.fixture-signature`
    const encryptedToken = sealFixture(token, 'fixture-password', data)
    const dir = path.join(data, 'users', scope, 'app-auth')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'token.json'), JSON.stringify({ version: 1, encryptedToken, scheme: 'safe_storage' }))
    fs.writeFileSync(path.join(data, 'current-owner.json'), JSON.stringify({ ownerDir: scope }))
  }

  it('提交安装时缓存的空账号选项，会重新发现后来登录的账号', async () => {
    const hooks = await TeleAgentPlugin()
    const method = hooks.auth.methods[0]
    const cached = JSON.parse(JSON.stringify(method.prompts))
    signIn()
    const result = await method.authorize({ scope: cached[0].options[0].value })
    expect(result.type).toBe('success')
    expect(result.key).toBe('v1_public_42')
    expect(result.metadata.scope).toBe('v1_public_42')
  })

  it('兼容旧宿主缓存的 __none__，不会把占位符当账号路径', async () => {
    const hooks = await TeleAgentPlugin()
    signIn()
    const result = await hooks.auth.methods[0].authorize({ scope: '__none__' })
    expect(result.type).toBe('success')
    expect(result.key).toBe('v1_public_42')
  })

  it('还未登录时提示登录，不暴露占位符 token.json 错误', async () => {
    const hooks = await TeleAgentPlugin()
    const result = await hooks.auth.methods[0].authorize({ scope: '__none__' })
    expect(result.type).toBe('failed')
    expect(result.error).not.toContain('__none__')
    expect(result.error).toContain('登录')
  })

  it('明确选定的账号凭据消失时失败，不悄悄切到其他账号', async () => {
    const hooks = await TeleAgentPlugin()
    signIn('v1_public_42')
    const result = await hooks.auth.methods[0].authorize({ scope: 'v1_public_99' })
    expect(result.type).toBe('failed')
    expect(result.error).toContain('v1_public_99')
  })

  it.each(['2.7.0', '2.6.99', '2.7.1-rc.1'])('登录拒绝低于最低要求的版本 %s', async (version) => {
    signIn()
    installVersion(version)
    const method = (await TeleAgentPlugin()).auth.methods[0]
    expect(method.prompts[0].options[0].label).toContain('2.7.1')
    const result = await method.authorize({ scope: 'v1_public_42' })
    expect(result.type).toBe('failed')
    expect(result.error).toContain(version)
    expect(result.error).toContain('升级到 2.7.1')
  })

  it.each(['2.7.1+build.42', '2.7.10', '2.10.0', '3.0.0'])('登录接受符合最低要求的版本 %s', async (version) => {
    signIn()
    installVersion(version)
    const method = (await TeleAgentPlugin()).auth.methods[0]
    expect((await method.authorize({ scope: 'v1_public_42' })).type).toBe('success')
  })

  it('读不到安装版本时拒绝登录并提示安装路径', async () => {
    signIn()
    process.env.TELEAGENT_APP_PATH = path.join(home, 'missing')
    const method = (await TeleAgentPlugin()).auth.methods[0]
    const result = await method.authorize({ scope: 'v1_public_42' })
    expect(result.type).toBe('failed')
    expect(result.error).toContain('TELEAGENT_APP_PATH')
  })

  it('已保存账号的模型请求重新检查版本，并使用升级后的版本与网关 key', async () => {
    signIn()
    const hooks = await TeleAgentPlugin()
    const opts = await hooks.auth.loader(async () => ({ key: 'v1_public_42' }))
    const send = () => opts.fetch('https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions', {
      method: 'POST', body: '{"model":"chat-flash","messages":[]}',
    })
    installVersion('2.7.0')
    await expect(send()).rejects.toMatchObject({ code: 'app_version_unsupported' })
    installVersion(undefined)
    await expect(send()).rejects.toMatchObject({ code: 'app_version_unknown' })

    let sentHeaders
    globalThis.fetch = async (_url, init) => {
      sentHeaders = new Headers(init.headers)
      return new Response('{"ok":true}')
    }
    installVersion('2.7.1')
    expect((await send()).status).toBe(200)
    expect(sentHeaders.get('Authorization')).toBe('Bearer fixture-gateway-key')

    installVersion('2.7.10', 'fixture-updated-key')
    expect((await send()).status).toBe(200)
    expect(sentHeaders.get('X-App-Version')).toBe('2.7.10')
    expect(sentHeaders.get('Authorization')).toBe('Bearer fixture-updated-key')
  })

  it('登录后刷新积分：缺少 cookie 不要求重新登录，模型请求仍可签名发出', async () => {
    signIn()
    const hooks = await TeleAgentPlugin({ magpie: { options: { apiKey: 'fixture-gateway-key' } } })
    const result = await hooks.auth.methods[0].authorize({ scope: 'v1_public_42' })
    expect(result.type).toBe('success')
    // Magpie 的 api 登录保存 key + metadata，随后 tab 刷新通过 usage 查询积分。
    const getAuth = async () => ({ type: 'api', key: result.key, metadata: result.metadata })
    const usage = await hooks.auth.usage(getAuth)
    expect(usage.windows).toEqual([])
    expect(usage.error).toContain('积分')
    expect(usage.signIn).toBe('kept')
    const opts = await hooks.auth.loader(getAuth)
    let requests = 0
    globalThis.fetch = async () => {
      requests++
      return new Response('{"ok":true}')
    }
    const response = await opts.fetch('https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions', {
      method: 'POST', body: JSON.stringify({ model: 'chat-flash', messages: [] }),
    })
    expect(response.status).toBe(200)
    expect(requests).toBe(1)
  })

  function portalCookie() {
    const dir = path.join(data, 'Partitions', 'owner%3Av1_public_42')
    fs.mkdirSync(dir, { recursive: true })
    const db = new Database(path.join(dir, 'Cookies'))
    try {
      db.run('CREATE TABLE meta (key TEXT, value TEXT)')
      db.run("INSERT INTO meta VALUES ('version', '24')")
      db.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)')
      db.run("INSERT INTO cookies VALUES ('agent.teleai.com.cn', 'operationToken', 'fixture-cookie', X'')")
    } finally { db.close() }
  }

  it('旧版桌面端的积分查询和签到在发请求前提示升级', async () => {
    installVersion('2.7.0')
    portalCookie()
    const hooks = await TeleAgentPlugin()
    const getAuth = async () => ({ key: 'v1_public_42' })
    expect(await hooks.auth.usage(getAuth)).toMatchObject({ signIn: 'kept', error: expect.stringContaining('2.7.1') })
    expect(await hooks.auth.checkin(getAuth)).toMatchObject({ outcome: 'failed', message: expect.stringContaining('2.7.1') })
    expect(await hooks.tool.points.execute()).toMatchObject({ ok: false, error: expect.stringContaining('2.7.1') })
  })

  it('积分接口要求登录时，不把模型账号标为过期', async () => {
    portalCookie()
    globalThis.fetch = async () => new Response('{"code":401,"msg":"please sign in again"}', { status: 401 })
    const hooks = await TeleAgentPlugin()
    const usage = await hooks.auth.usage(async () => ({ type: 'api', key: 'v1_public_42' }))
    expect(usage.error).toBeTruthy()
    expect(usage.windows).toEqual([])
    expect(usage.signIn).toBe('kept')
  })

  it('积分仍可查询时，也不把已失效的模型登录状态改回有效', async () => {
    portalCookie()
    globalThis.fetch = async () => new Response('{"code":200,"data":{"pointsBalance":42}}')
    const hooks = await TeleAgentPlugin()
    const usage = await hooks.auth.usage(async () => ({ type: 'api', key: 'v1_public_42' }))
    expect(usage.windows[0].balance).toBe(42)
    expect(usage.signIn).toBe('kept')
  })
})
