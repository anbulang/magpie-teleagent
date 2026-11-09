/**
 * magpie 插件的模型清单。
 *
 * TeleAgent 内置的 5 个 NewApi 模型（来源与实测见 `docs/PROTOCOL.md` 第二节），
 * 按 OpenCode `Model` 的形状给出 magpie 需要的字段。
 *
 * `vision` 是实测结论，不是上游目录的声明：用同一张「蓝色三角形 + 文字 42」
 * 的图片逐个测，能正确读出的才算支持。
 *
 *   chat-pro       ✅ 正确识别
 *   chat-flash     ✅ 正确识别
 *   chat-lite      ❌ 返回 200 但内容与图片无关（胡编），不算支持
 *   chat-nano      ❌ HTTP 400 "telechat-29b is not a multimodal model"
 *   chat-flagship  ❌ HTTP 400 code 1210（参数不支持 image 内容块）
 */
import { ACCEPTED_EFFORTS, DEFAULT_EFFORT } from './effort.mjs'

/**
 * 五个内置模型（顺序即选择器顺序）。
 *
 * `contextWindow` / `maxTokens` 取自桌面端自己的账号配置
 * （`~/.config/TeleAgent/users/<scope>/TeleAgent.jsonc` 的 `provider.NewApi.models`），
 * 也就是客户端真正在用的目录。注意 `chat-lite` / `chat-nano` 的输出上限是 **16384**，
 * 不是 65536——这五个数不要统一成同一个值。
 */
export const MODELS = [
  { id: 'chat-pro', name: '智能', contextWindow: 400_000, maxTokens: 65_536, rate: 'x0.6', vision: true },
  { id: 'chat-flagship', name: '旗舰', contextWindow: 400_000, maxTokens: 65_536, rate: 'x1.0', vision: false },
  { id: 'chat-flash', name: '极速', contextWindow: 400_000, maxTokens: 65_536, rate: 'x0.2', vision: true },
  { id: 'chat-lite', name: '轻量', contextWindow: 100_000, maxTokens: 16_384, rate: 'x0.5', vision: false },
  { id: 'chat-nano', name: '轻速', contextWindow: 100_000, maxTokens: 16_384, rate: 'x0.1', vision: false },
]

/** 上游接受的思考档位（唯一事实来源在 `lib/effort.mjs`，这里转出方便同文件使用） */
export const TELEAI_ACCEPTED_EFFORTS = ACCEPTED_EFFORTS
export const TELEAI_DEFAULT_EFFORT = DEFAULT_EFFORT

/** 支持图片输入的模型 id 集合 */
export const VISION_MODEL_IDS = MODELS.filter((m) => m.vision === true).map((m) => m.id)

/** 上游聊天网关（OpenAI 兼容；签名用的 pathname 含 `/superCowork/sapi` 前缀） */
export const TELEAI_ORIGIN = 'https://agent.teleai.com.cn'
export const TELEAI_API_PREFIX = '/superCowork/sapi'
export const TELEAI_CHAT_PATH = '/api/v1/chat/completions'
/** 模型 API 基地址（magpie 拼 `/chat/completions`，所以这里到 `/v1` 为止） */
export const TELEAI_BASE_URL = TELEAI_ORIGIN + TELEAI_API_PREFIX + '/api/v1'
/** 签名时使用的完整 pathname */
export const TELEAI_SIGNED_PATH = TELEAI_API_PREFIX + TELEAI_CHAT_PATH
export const TELEAI_ROUTE_TARGET = 'ops-gateway'

/**
 * 把模型清单转成 OpenCode `Model`（magpie 的 `config` 钩子里的 `models`）。
 *
 * - `rate` 用厂商自己的写法（`x0.6`），magpie 会解析成倍率显示在选择器里；
 * - 只有实测支持视觉的模型才声明 `modalities.input.image`，否则 agent 会发图片
 *   而模型不接受（`1210` / `is not a multimodal model`）；
 * - `reasoning: true`：上游会返回 `reasoning_content`（实测有）；
 * - 思考档位：上游**只认 low / high / max**，且**不接受关闭思考**
 *   （「该模型始终思考，不支持关闭思考；请使用 low、high 或 max。」）。
 *   插件这一层**没有**声明档位的字段可用（magpie 的 `capabilities` 只认
 *   `reasoning` 这个布尔值，档位来自它自己的 provider 配置），所以档位是在
 *   发请求前削的，见 `lib/effort.mjs`；
 * - `tool_call: true`：上游支持 tools，且 magpie 会把工具的调用统一交给 agent 执行。
 */
export function buildModels() {
  return Object.fromEntries(MODELS.map((m) => [m.id, {
    name: `${m.name} · ${m.rate}`,
    id: m.id,
    limit: { context: m.contextWindow, input: m.contextWindow, output: m.maxTokens },
    reasoning: true,
    tool_call: true,
    attachment: m.vision,
    modalities: { input: m.vision ? ['text', 'image'] : ['text'], output: ['text'] },
    interleaved: { field: 'reasoning_content' },
    rate: m.rate,
  }]))
}
