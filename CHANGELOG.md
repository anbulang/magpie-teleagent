# Changelog

本目录是独立的 npm 包 `opencode-teleagent-auth`（magpie 的 TeleAgent 供应商插件），
本仓库独立成库：不依赖、也不包含 DeepSeek Harness 的插件。

## 0.1.0 — 2026-11-08

首个版本。把 TeleAgent 桌面端的接入能力做成 magpie / OpenCode v1 供应商插件。
协议推导、签名算法、凭据链路、portal 接口与封号复盘笔记都在 `docs/PROTOCOL.md`。

### 新增

- **供应商 `teleagent`**：`config` 钩子里用 `??=` 声明，5 个模型
  （`chat-pro` / `chat-flagship` / `chat-flash` / `chat-lite` / `chat-nano`），
  带上下文、输出上限、`reasoning`、`tool_call`、`modalities`、积分倍率 `rate`。
- **登录**：`auth.methods` 一个 `keyless` 的 api 方式 + 账号选择 `prompts`
  （getter，每次 login 重新枚举本机账号），`authorize` 只存 scope 不存 token。
- **请求**：`auth.loader` 返回按账号签名的 `fetch`，每个请求现读凭据、
  现签 `ts` / `nonce`，两步 HMAC（与 kernel 的 Go 实现一致）。
- **用量**：`auth.usage` 只读 portal，报积分余额（窗口式 `balance` + `runsOutAt`）与套餐名。
- **签到**：`auth.checkin` 先读状态再领，已领返回 `done`，不重复领取。
- **工具**：只读 `teleagent_points`（不花积分、不触发领取、不发模型请求）。
- **会话头**：`chat.headers` 补 `x-teleagent-session`。
- **防护**：并发 2 / 每分钟 20 次 / 连续 3 次 401·403 熔断 10 分钟，按账号隔离。
- **网关 apiKey 运行时解析**：配置 → `TELEAGENT_API_KEY` → `TeleAgent.jsonc` →
  `app.asar`（只读本地字节，不联网、不打包常量）。
- **本地模型白名单**：目录外的 model id 在插件内直接 404，不打到上游
  （实测上游对未知 id 会静默回落到别的模型）。

### 分发

- npm：`magpie plugin add opencode-teleagent-auth`（2026-11-08 发布 0.1.0）
- git：`magpie plugin add github:anbulang/magpie-teleagent`
- 仓库：https://github.com/anbulang/magpie-teleagent

### 测试

146 项，5 个文件，全部离线：

| 文件 | 覆盖 |
|---|---|
| `test/sign.test.mjs` | 签名（独立实现对照、ts/nonce/body/pathname 敏感性）、头组装、模型目录、guard |
| `test/plugin.test.mjs` | hooks 形状、`config` 不覆盖用户配置、`rate` 补回、`chat.headers`、工具、登录方式、目录外模型拦截、loader 失败分支、401 翻译 |
| `test/credential.test.mjs` | safeStorage v10 加解密对称、JWT 解析、诊断全分支、账号枚举、钥匙串错误分类 |
| `test/apikey.test.mjs` | asar 解析（自造 asar）、只认 `new-api` 段、坏文件不抛、四级优先级 |
| `test/portal.test.mjs` | cookie 库读取、`no such table` 是空状态、指定 scope 不回落主库、积分/签到幂等、隐私（日志不含 token） |

```bash
bun test test/          # magpie 自带 bun
bash scripts/sandbox.sh # 隔离 HOME 手测（--real-home 才发真实请求）
```

### 与 DeepSeek Harness 版的关系

同样是接入 TeleAgent，但宿主、接口、安装方式完全不同，是两个独立仓库：

| 项 | DSH 版（另一仓库） | 本仓库 |
|---|---|---|
| 宿主 | DeepSeek Harness | magpie / OpenCode |
| 接入方式 | pi-ai provider + 本地 shim | OpenCode v1 插件 hooks |
| 登录交互 | 设置卡片 | `auth.methods` 按钮 + 下拉框 |
| 积分 | 卡片 + 胶囊 | `auth.usage` / `magpie quota` |
| 工具 | DSH 工具桥 | magpie 的 MCP 工具服务器 |
| 协议笔记 | 在它自己的 docs 里 | `docs/PROTOCOL.md` |

装一个即可，两者不需要同时存在。
