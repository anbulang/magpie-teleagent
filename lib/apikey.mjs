/**
 * 上游网关 apiKey：运行时从 TeleAgent 桌面端读，而不是硬编码。
 *
 * ## 为什么需要它
 *
 * TeleAgent 桌面端请求自己的网关时会带 `Authorization: Bearer <apiKey>`，
 * 这个 key 是**桌面端内置常量**（`预置模型` 供应商的 `options.apiKey`）。
 * 实测去掉它，上游直接回 `40105 您的请求疑似攻击请求` —— 也就是说它不是
 * 真正的鉴权（真正的鉴权是 JWT + 签名），而是「请求来自官方客户端」的特征之一。
 *
 * ## 为什么不在仓库里写死
 *
 * 它是**桌面端内置常量**，不能写进仓库（开源仓库不提交真实值），
 * 又不能要求用户自己去申请一个。所以运行时四级解析——
 * 用户机器上一定能从已安装的桌面端里读出它：
 *
 *   1. 先看用户配置 / 环境变量（`TELEAGENT_API_KEY`）；
 *   2. 再看本机 TeleAgent 的 `TeleAgent.jsonc`（用户自己改过供应商配置时会写进去）；
 *   3. 最后从 `app.asar` 的 main runtime 里读常量（纯本地读取，不联网）。
 *
 * 三步都失败就返回空串：请求照样发，上游会用 `40105` 说明问题，
 * 我们把它翻译成「本机 TeleAgent 版本不受支持，请更新插件」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appPaths, currentScope } from './credential.mjs'
import { findAppResources, readAsarFile } from './installation.mjs'

/** 桌面端「预置模型」供应商的 id */
const NEW_API_PROVIDER = 'NewApi'

/**
 * 从 `app.asar` 里读网关 apiKey。
 *
 * 这里只读取一个已安装文件的字节，不做解包、不写盘。main runtime 的代码里
 * 有 `apiKey: "sk-…"` 字面量；不同版本文件名会变，所以按 `main-runtime-…js`
 * 前缀匹配。
 *
 * 参数可以是安装发现选项；保留原来的 macOS bundle 路径字符串参数。
 * @returns {string} 读不到时返回空串
 */
export function readApiKeyFromAsar(bundleOrOptions = {}) {
  const resources = typeof bundleOrOptions === 'string'
    ? path.join(bundleOrOptions, 'Contents', 'Resources')
    : bundleOrOptions.resources ?? findAppResources(bundleOrOptions)
  if (!resources) return ''
  const buf = readAsarFile(path.join(resources, 'app.asar'), (name) => /^dist-electron\/main-runtime-.+\.js$/.test(name))
  if (!buf) return ''
  const text = buf.toString('utf8')

  // 只认「预置模型」供应商那一段里的 key（从 `id: "new-api"` 往后找），
  // 别处还有别的 apiKey 常量（例如内网代理用的），不能抓错
  const anchor = text.indexOf(`id: "new-api"`)
  if (anchor < 0) return ''
  const scope = text.slice(anchor, anchor + 1200)
  const m = /\bapiKey:\s*"([A-Za-z0-9_-]{8,128})"/.exec(scope)
  return m ? m[1] : ''
}

/** 从账号自己的 `TeleAgent.jsonc` 读（用户改过配置时会写在里面） */
export function readApiKeyFromConfig(home = os.homedir()) {
  let scope = ''
  try { scope = currentScope(appPaths(home).data) } catch { return '' }
  const file = path.join(appPaths(home).config, 'users', scope, 'TeleAgent.jsonc')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const key = parsed?.provider?.[NEW_API_PROVIDER]?.options?.apiKey
    return typeof key === 'string' ? key : ''
  } catch {
    return ''
  }
}

/**
 * 依次尝试：显式配置 → 环境变量 → 账号配置 → asar 常量。
 *
 * @param {{explicit?: string, home?: string, env?: object, platform?: string, appPath?: string, resources?: string, exists?: Function}} [options]
 * @returns {{key: string, source: string}} source 用于诊断输出（不含 key 本身）
 */
export function resolveApiKey({ explicit, home = os.homedir(), env = process.env, ...installation } = {}) {
  if (typeof explicit === 'string' && explicit.trim()) return { key: explicit.trim(), source: '配置' }

  const fromEnv = env.TELEAGENT_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim()) return { key: fromEnv.trim(), source: '环境变量' }

  const fromConfig = readApiKeyFromConfig(home)
  if (fromConfig) return { key: fromConfig, source: '桌面端配置' }

  const fromAsar = readApiKeyFromAsar({ ...installation, home, env })
  if (fromAsar) return { key: fromAsar, source: '桌面端安装包' }

  return { key: '', source: '未找到' }
}
