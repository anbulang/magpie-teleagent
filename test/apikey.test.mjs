/**
 * 网关 apiKey 读取的单元测试。
 *
 * **不读真实 app.asar、不用真实 key**：用临时目录造一个「像 asar 的文件」
 * （4 字节 pickle 头 + JSON 头及对齐填充 + 文件体），验证解析逻辑。
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readApiKeyFromAsar, readApiKeyFromConfig, resolveApiKey } from '../lib/apikey.mjs'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'te-magpie-asar-'))
})

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

/**
 * 造一个最小可用的 asar：pickle 头（16 字节）+ JSON header + 顺序文件体。
 *
 * @param {Record<string,string>} files 路径 → 内容
 */
function makeAsar(filePath, files) {
  const entries = {}
  const bodies = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.from(content, 'utf8')
    // 顶层目录结构：dist-electron/xxx.js
    const parts = name.split('/')
    let node = entries
    for (const part of parts.slice(0, -1)) {
      node[part] ??= { files: {} }
      node = node[part].files
    }
    node[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) }
    bodies.push(buf)
    offset += buf.length
  }
  const header = JSON.stringify({ files: entries })
  const headerBuf = Buffer.from(header, 'utf8')
  const padding = Buffer.alloc((4 - headerBuf.length % 4) % 4)
  // pickle: uint32(4) + uint32(headerSize) + uint32(pickledJsonSize) + uint32(jsonLen)
  const pickle = Buffer.alloc(16)
  pickle.writeUInt32LE(4, 0)
  pickle.writeUInt32LE(headerBuf.length + padding.length + 8, 4)
  pickle.writeUInt32LE(headerBuf.length + padding.length + 4, 8)
  pickle.writeUInt32LE(headerBuf.length, 12)
  fs.writeFileSync(filePath, Buffer.concat([pickle, headerBuf, padding, ...bodies]))
  return filePath
}

/** 造一个假的 app bundle：<bundle>/Contents/Resources/app.asar */
function makeBundle(files) {
  const bundle = path.join(dir, 'Fake.app')
  const resources = path.join(bundle, 'Contents', 'Resources')
  fs.mkdirSync(resources, { recursive: true })
  makeAsar(path.join(resources, 'app.asar'), files)
  return bundle
}

describe('readApiKeyFromAsar', () => {
  it('从 main-runtime 的「预置模型」供应商里读出 apiKey', () => {
    const bundle = makeBundle({
      'dist-electron/main-runtime-abc123.js': `
        const n$t = { NewApi: { id: "new-api", name: "预置模型", options: {
          baseURL: aNe, apiKey: "sk-testkey1234", headers: lNe, useSuperAgentAuth: !0 } } }
      `,
    })
    expect(readApiKeyFromAsar(bundle)).toBe('sk-testkey1234')
  })

  it('文件不叫 main-runtime-*.js 时读不到（结构变了就明确失败，不乱猜）', () => {
    const bundle = makeBundle({ 'dist-electron/main.jsc': 'id: "new-api", apiKey: "sk-shouldnot" ' })
    expect(readApiKeyFromAsar(bundle)).toBe('')
  })

  it('只认 new-api 那一段，别处的 apiKey 不抓', () => {
    const bundle = makeBundle({
      'dist-electron/main-runtime-x.js': `
        const other = { apiKey: "sk-elsewhere-9999" }
        const n$t = { NewApi: { id: "new-api", options: { apiKey: "sk-the-new-api" } } }
      `,
    })
    expect(readApiKeyFromAsar(bundle)).toBe('sk-the-new-api')
  })

  it('asar 不存在时返回空串（不抛）', () => {
    expect(readApiKeyFromAsar(path.join(dir, 'nope.app'))).toBe('')
  })

  it('asar 被截断/头部坏掉时返回空串（不抛）', () => {
    const bundle = path.join(dir, 'Bad.app')
    fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'), { recursive: true })
    fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'app.asar'), 'garbage')
    expect(readApiKeyFromAsar(bundle)).toBe('')
  })

  it('从显式安装目录的 resources/app.asar 读取，适用于 Windows 布局', () => {
    const install = path.join(dir, 'TeleAgent')
    const resources = path.join(install, 'resources')
    fs.mkdirSync(resources, { recursive: true })
    makeAsar(path.join(resources, 'app.asar'), {
      'dist-electron/main-runtime-win.js': 'id: "new-api", options: { apiKey: "sk-test-windows" }',
    })
    expect(readApiKeyFromAsar({ env: { TELEAGENT_APP_PATH: install } })).toBe('sk-test-windows')
  })

  it('已知 resources 目录时直接读取，不依赖默认安装位置', () => {
    const bundle = makeBundle({
      'dist-electron/main-runtime-x.js': 'id: "new-api", options: { apiKey: "sk-test-resources" }',
    })
    expect(readApiKeyFromAsar({ resources: path.join(bundle, 'Contents', 'Resources') }))
      .toBe('sk-test-resources')
  })
})

describe('readApiKeyFromConfig', () => {
  it('读账号配置里用户自己填的 apiKey', () => {
    const home = path.join(dir, 'home')
    const scope = 'v1_public_1'
    const cfgDir = path.join(home, '.config', 'TeleAgent', 'users', scope)
    fs.mkdirSync(cfgDir, { recursive: true })
    fs.writeFileSync(path.join(cfgDir, 'TeleAgent.jsonc'), JSON.stringify({
      provider: { NewApi: { options: { apiKey: 'sk-from-config' } } },
    }))
    const dataDir = path.join(home, '.local', 'share', 'TeleAgent')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'current-owner.json'), JSON.stringify({ ownerDir: scope }))
    const prev = process.env.TELEAGENT_DATA
    process.env.TELEAGENT_DATA = dataDir
    try {
      expect(readApiKeyFromConfig(home)).toBe('sk-from-config')
    } finally {
      if (prev === undefined) delete process.env.TELEAGENT_DATA
      else process.env.TELEAGENT_DATA = prev
    }
  })

  it('没有配置文件时返回空串（不抛）', () => {
    expect(readApiKeyFromConfig(path.join(dir, 'empty-home'))).toBe('')
  })
})

describe('resolveApiKey 的优先级', () => {
  const prevEnv = process.env.TELEAGENT_API_KEY

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.TELEAGENT_API_KEY
    else process.env.TELEAGENT_API_KEY = prevEnv
  })

  it('显式配置最高', () => {
    process.env.TELEAGENT_API_KEY = 'sk-env'
    expect(resolveApiKey({ explicit: 'sk-explicit', home: path.join(dir, 'none') }))
      .toEqual({ key: 'sk-explicit', source: '配置' })
  })

  it('其次是环境变量', () => {
    process.env.TELEAGENT_API_KEY = 'sk-env'
    expect(resolveApiKey({ home: path.join(dir, 'none') }))
      .toEqual({ key: 'sk-env', source: '环境变量' })
  })

  it('都没有时给 source「未找到」，不抛（请求仍会发，由上游 40105 说明）', () => {
    delete process.env.TELEAGENT_API_KEY
    const r = resolveApiKey({ home: path.join(dir, 'none'), exists: () => false, env: {} })
    // 只输出真假，不会在旧实现失败时把本机安装包中的 key 打印到测试日志。
    expect(r.key === '').toBe(true)
    expect(r.source).toBe('未找到')
  })

  it('配置和环境变量都缺失时读取指定安装包', () => {
    const bundle = makeBundle({
      'dist-electron/main-runtime-x.js': 'id: "new-api", options: { apiKey: "sk-test-resolver" }',
    })
    const result = resolveApiKey({ home: path.join(dir, 'none'), env: {}, resources: path.join(bundle, 'Contents', 'Resources') })
    expect(result.key === 'sk-test-resolver').toBe(true)
    expect(result.source).toBe('桌面端安装包')
  })

  it('永远不稳定返回太长/带空白的值', () => {
    process.env.TELEAGENT_API_KEY = '  sk-trim-me  '
    expect(resolveApiKey({ home: path.join(dir, 'none') }).key).toBe('sk-trim-me')
  })
})
