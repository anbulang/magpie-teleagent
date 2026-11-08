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
import path from 'node:path'

import { APP_BUNDLE, appPaths, currentScope } from './credential.mjs'

/** 桌面端「预置模型」供应商的 id */
const NEW_API_PROVIDER = 'NewApi'

/**
 * 从 `app.asar` 里读网关 apiKey。
 *
 * asar 是「4 字节 pickle 头 + JSON 头 + 顺序排列的文件体」，这里只用它读
 * 一个已安装文件的字节，不做解包、不写盘。main runtime 的 markdown 里
 * 有 `apiKey: "sk-…"` 字面量；不同版本文件名会变，所以按 `main-runtime-…js`
 * 前缀匹配。
 *
 * @returns {string} 读不到时返回空串
 */
export function readApiKeyFromAsar(bundle = APP_BUNDLE) {
  const asar = path.join(bundle, 'Contents', 'Resources', 'app.asar')
  let fd
  try {
    fd = fs.openSync(asar, 'r')
    const head = Buffer.alloc(16)
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) return ''
    // pickle: [payload size(=4)][header size][header string size][json length]
    const jsonLength = head.readUInt32LE(12)
    if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) return ''
    const headerRaw = Buffer.alloc(jsonLength)
    fs.readSync(fd, headerRaw, 0, jsonLength, 16)
    const header = JSON.parse(headerRaw.toString('utf8'))

    const findRuntime = (node, prefix) => {
      for (const [name, meta] of Object.entries(node?.files ?? {})) {
        const full = prefix === '' ? name : `${prefix}/${name}`
        if (meta?.files) {
          const found = findRuntime(meta, full)
          if (found) return found
        } else if (/^dist-electron\/main-runtime-.+\.js$/.test(full)) {
          return { full, meta }
        }
      }
      return null
    }
    const runtime = findRuntime(header, '')
    if (!runtime) return ''

    const base = 16 + jsonLength
    const size = Number(runtime.meta.size)
    if (!Number.isFinite(size) || size <= 0 || size > 64 * 1024 * 1024) return ''
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, base + Number(runtime.meta.offset))
    const text = buf.toString('utf8')

    // 只认「预置模型」供应商那一段里的 key（从 `id: "new-api"` 往后找），
    // 别处还有别的 apiKey 常量（例如内网代理用的），不能抓错
    const anchor = text.indexOf(`id: "new-api"`)
    if (anchor < 0) return ''
    const scope = text.slice(anchor, anchor + 1200)
    const m = /\bapiKey:\s*"([A-Za-z0-9_-]{8,128})"/.exec(scope)
    return m ? m[1] : ''
  } catch {
    return ''
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

/** 从账号自己的 `TeleAgent.jsonc` 读（用户改过配置时会写在里面） */
export function readApiKeyFromConfig(home = process.env.HOME ?? '') {
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
 * @param {{explicit?: string, home?: string}} [options]
 * @returns {{key: string, source: string}} source 用于诊断输出（不含 key 本身）
 */
export function resolveApiKey({ explicit, home = process.env.HOME ?? '' } = {}) {
  if (typeof explicit === 'string' && explicit.trim()) return { key: explicit.trim(), source: '配置' }

  const fromEnv = process.env.TELEAGENT_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim()) return { key: fromEnv.trim(), source: '环境变量' }

  const fromConfig = readApiKeyFromConfig(home)
  if (fromConfig) return { key: fromConfig, source: '桌面端配置' }

  const fromAsar = readApiKeyFromAsar()
  if (fromAsar) return { key: fromAsar, source: '桌面端安装包' }

  return { key: '', source: '未找到' }
}
