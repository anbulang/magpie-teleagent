/**
 * 思考档位（reasoning effort）的上游适配。
 *
 * ## 为什么需要这一层
 *
 * TeleAgent 上游只认 **low / high / max** 三档，并且**拒绝任何"关闭思考"的写法**。
 * 这不是我们的猜测，是上游自己的 400 原话：
 *
 *   TeleAgent: 该模型始终思考，不支持关闭思考；请使用 low、high 或 max。
 *   （magpie 日志里 `err_type: "1210"`）
 *
 * 而宿主（magpie）会按它自己对档位的通用理解往请求体里写 `reasoning_effort`：
 * Claude Code 通过 magpie 网关发一轮对话时，magpie 把 anthropic 请求翻成
 * chat/completions，并写入 `reasoning_effort: "medium"`（实测，2026-11-09）。
 * medium 不在上游的三档里，于是整轮请求 400，用户看到的就是这句话。
 *
 * ## 为什么在插件的 fetch 里削，而不是别处
 *
 * 宿主往请求体里写什么是宿主的事，插件改不了（插件只拿到 `chat.headers` 与
 * loader 的 `fetch`，没有改写 body 的钩子）。而 loader 的 `fetch` 是**所有**
 * 请求的必经之路，也是插件能看到的最后一道关口。放在这里削有三个好处：
 *
 *   1. 与 agent 无关：Claude Code / OpenCode / curl 走同一套；
 *   2. 与宿主版本无关：magpie 以后换档位映射也不用改插件；
 *   3. 单一职责：削档位的规则只在这一个文件里，别的模块不碰思考字段。
 *
 * ## 削法
 *
 *   - `low` / `high` / `max`：原样保留；
 *   - `minimal` / `medium` / `xhigh`：落到**最近**的合法档位（medium→high，
 *     minimal→low，xhigh→high）——不擅自把用户要的强度降到底；
 *   - 关闭类写法（`off` / `none` / `disabled` / 空值）：**删掉整个字段**。
 *     上游没有"关闭"这个概念，删掉即表示"按模型默认思考"，这是唯一合法的表达；
 *   - 其它不成形的写法（`enable_thinking`、`thinking: {type:'disabled'}` 等）：
 *     同样删掉——上游不接受它们，带上只会 400。
 *
 * 只碰思考相关的键，其余字段（messages / tools / temperature / max_tokens…）
 * 一个字节都不动；正文里没有思考字段时**原样返回同一个字符串**，不做
 * parse→stringify 的往返（那会改动数字精度、转义和键顺序，白白破坏缓存）。
 */

/** 上游接受的档位，顺序即由弱到强 */
export const ACCEPTED_EFFORTS = ['low', 'high', 'max']

/** 上游没有"关闭思考"这个概念，默认给最强的合法档位（与桌面端一致） */
export const DEFAULT_EFFORT = 'high'

/** 请求体里与思考相关的键：出现就要处理，因为上游不认识它们 */
const EFFORT_KEYS = ['reasoning_effort', 'reasoningEffort']
const THINKING_KEYS = ['enable_thinking', 'thinking']

/** 关闭思考的各种写法（上游一律拒绝） */
const OFF_VALUES = new Set(['off', 'none', 'disabled', 'false', 'no', '0'])

/**
 * 把任意档位取值映射成上游认的档位。
 *
 * @param {unknown} level 宿主写进来的档位
 * @returns {string|null} 合法档位；`null` 表示"应删掉这个字段"
 */
export function normalizeEffort(level) {
  if (typeof level !== 'string') return null
  const value = level.trim().toLowerCase()
  if (value === '') return null
  if (OFF_VALUES.has(value)) return null
  if (ACCEPTED_EFFORTS.includes(value)) return value
  // 就近落档：宁可多思考，也不要因为一个不认识的档位整轮失败
  if (value === 'minimal') return 'low'
  if (value === 'medium') return 'high'
  if (value === 'xhigh') return 'high'
  return DEFAULT_EFFORT
}

/**
 * 削一个请求体。
 *
 * @param {string} raw 原始请求体（JSON 文本）
 * @returns {{body:string, changed:boolean, from:string, to:string|null}}
 *   `body` 是**要发出去的**正文；`changed` 为 false 时它与输入是同一个字符串。
 */
export function normalizeUpstreamBody(raw) {
  const text = typeof raw === 'string' ? raw : ''
  const unchanged = { body: text, changed: false, from: '', to: null }
  if (text.length === 0) return unchanged

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 不是 JSON 就别猜：原样放行，让上游自己说
    return unchanged
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return unchanged

  const touched = [...EFFORT_KEYS, ...THINKING_KEYS].some((key) => key in parsed)
  if (!touched) return unchanged

  const rawEffort = EFFORT_KEYS.find((key) => key in parsed)
    ? parsed[EFFORT_KEYS.find((key) => key in parsed)]
    : undefined
  const from = typeof rawEffort === 'string' ? rawEffort : ''
  const to = normalizeEffort(from)

  // 已经是上游认的写法、也没有多余的思考键：原样返回，不做 parse→stringify
  // 的往返（那会改动数字精度、转义和键顺序，白白让上游的缓存失效）
  const extraKeys = THINKING_KEYS.some((key) => key in parsed)
  const effortAlreadyFine = EFFORT_KEYS.some((key) => key in parsed)
    && typeof rawEffort === 'string'
    && rawEffort === to
    && !EFFORT_KEYS.some((key) => key in parsed && key !== EFFORT_KEYS[0])
  if (effortAlreadyFine && !extraKeys) return unchanged

  // 所有思考相关的键先全部摘掉，再把归一化后的档位按上游的键名放回去
  for (const key of [...EFFORT_KEYS, ...THINKING_KEYS]) delete parsed[key]

  if (to !== null) parsed.reasoning_effort = to

  return { body: JSON.stringify(parsed), changed: true, from, to }
}

/**
 * 读出请求体里声明的档位（用于日志；拿不到返回空串）。
 *
 * @param {string} raw
 * @returns {string}
 */
export function reasoningOfBody(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return ''
    for (const key of EFFORT_KEYS) {
      if (typeof parsed[key] === 'string') return parsed[key]
    }
  } catch { /* 不是 JSON */ }
  return ''
}
