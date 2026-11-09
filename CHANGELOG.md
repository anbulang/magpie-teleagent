# Changelog

本仓库与 npm 包同名，都是 `opencode-teleagent-auth`（magpie / OpenCode 的 TeleAgent 供应商插件）；
不依赖、也不包含 DeepSeek Harness 的插件。

## 0.2.0 — 2026-11-09

- 新增 Windows 支持：用同一系统用户的 DPAPI 解锁 `Local State` 密钥，再解密 Electron
  v10 AES-256-GCM token；保留旧 DPAPI 格式读取，明确拒绝未知加密版本。敏感值不进入命令行或日志。
- 新增跨平台安装资源发现，支持 `TELEAGENT_APP_PATH`，从 ASAR 读取版本与网关配置；
  修正 ASAR pickle 对齐偏移。数据路径改用系统主目录，不再依赖 `HOME` 环境变量。
- 积分读取优先使用 Bun / Node 内置 SQLite，不要求 Windows 预装 sqlite3；读取数据库及 WAL 副本，
  支持 Windows 加密 cookie 和 v24+ 域名哈希校验，并只读取 TeleAgent 域名的 cookie。

- 修复首次安装时未登录桌面端，之后登录并刷新仍读取 `users/__none__/app-auth/token.json`：
  提交时重新解析自动检测选项，并兼容旧版缓存的 `__none__`。明确选定的账号缺少凭据时仍报错，
  不自动借用其他账号。
- 修复 magpie 刷新积分时可能把模型账号标为「需要登录」：积分 cookie 与模型 JWT 是独立凭据，
  `auth.usage` 无论成功或失败都返回 `signIn: kept`，不再改变模型登录状态。
  已被旧版误标的账号，更新后需执行一次插件登录清除旧状态。
- 统一积分与聊天的数据目录解析；积分查询也遵守 `TELEAGENT_DATA`，保留账号分区隔离。
- 增加 macOS / Windows CI，Windows 上运行原生 DPAPI 解密、登录和加密 cookie 测试。
  Linux 支持尚未实现。
- 增加离线回归：缓存空选项后登录、旧占位符兼容、未登录提示、指定账号隔离、
  登录后积分刷新及签名请求、积分错误/成功不改变模型登录状态、自定义目录 cookie 读取。

## 0.1.2 — 2026-11-09

修一个**必然失败**的线上问题：经 magpie 网关（Claude Code / Codex 等 agent）调用时，
每一轮都被上游以 400 挡回：

```
API Error: 400 TeleAgent: 该模型始终思考，不支持关闭思考；请使用 low、high 或 max。
```

### 根因

上游只认 `low` / `high` / `max` 三档，且**拒绝任何"关闭思考"的写法**。而宿主
会按它自己对档位的通用理解往请求体里写 `reasoning_effort`：Claude Code 经 magpie
网关发一轮对话时，magpie 把 anthropic 请求翻成 chat/completions 并写入
`reasoning_effort: "medium"`（实测，magpie 的 `usage.jsonl` 里留有
`"effort":"medium","status":400,"err_type":"1210"`）。`medium` 不在上游的三档里，
于是整轮请求还没开始就被拒。

插件的 loader `fetch` 当时是**纯透传**，把宿主的档位原样发给了上游。

### 修复

- 新增 `lib/effort.mjs`：在请求真正发出**之前**把档位削成上游认的
  - `low` / `high` / `max`：原样保留（不改一个字节，避免破坏上游的提示词缓存）；
  - `minimal` / `medium` / `xhigh`：落到**最近**的合法档位（`medium`→`high`、
    `minimal`→`low`、`xhigh`→`high`），不擅自把用户要的强度降到底；
  - 关闭类写法（`off` / `none` / `disabled` / 空值）：**删掉整个字段**——
    上游没有"关闭"这个概念，删掉即"按模型默认思考"，是唯一合法的表达；
  - 其它形状的开关（`enable_thinking`、`thinking`）：同样删掉，带上只会 400；
  - 只碰思考相关的键，`messages` / `tools` / `temperature` 等一律不动；
  - 正文没有思考字段时**原样返回同一个字符串**，不做 parse→stringify 往返。
- `index.mjs` 的 loader `fetch` 接入这一层；`verbose` 打开时会打一行
  `思考档位：medium → high`，便于日后核对。
- `lib/models.mjs` 补一段说明：**插件没有声明档位的字段可用**——查 magpie 二进制
  确认 `provider.info()` 合并模型时 `capabilities` 只读 `reasoning`（布尔），
  档位来自 magpie 自己的 provider 配置（`Provider.ModelEfforts`），所以
  "声明能力让宿主别发错档位"这条路走不通，只能在发请求前削。

### 测试

`test/effort.test.mjs`（17 项）。其中 3 项是**真实链路**回归：临时 HOME + 伪造的
`security` 口令，走真实的 loader / 凭据 / 签名代码，只在最外层 fetch 打桩，
断言"发出去的 `medium` 已经是 `high`"、"`off` 已被删掉"。这三项在移除修复后
**确实会红**（已验证），不是永远绿的假测试。

### 代码审查跟进

magpie-community/plugins 的维护者在合并 registry 条目时提了三条，都已修：

- **域名白名单**（安全）：`createSignedFetch` 现在拒绝把签名发给
  `agent.teleai.com.cn` 以外的 origin。之前 `api` 配置被指向别处时，JWT 签名与
  设备指纹会一起送过去。比较 origin（协议 + 域名 + 端口），所以
  `agent.teleai.com.cn.evil.test` 与 `http://` 降级都被挡掉；错误信息只带域名，
  不带 path / query。
- **`x-magpie-sign-in` 语义**（真 bug）：`explainFailure` 的注释说 40109 用 `kept`，
  代码却发 `expired`。核对 magpie 源码后确认 `expired` 会把账号标成「登录失效、
  请重新登录」，而 40109 封的是模型调用通道（`magpie quota` 仍能读积分），
  重登解决不了封禁。现在 40105 与 40109 **都发 `kept`**；真正的凭据过期仍走
  `auth.loader` 抛的 `error.signIn = 'expired'`，不在这条路径上。
- **registry summary**：`package.json` 的 `magpie.summary` 补上 "Unofficial" 与
  "macOS only"，与 orcaterm / deepaicode 等条目的写法一致。

## 0.1.1 — 2026-11-09

只改文档与元数据，插件行为与 0.1.0 **完全一致**（代码零改动）。

### 变更

- **仓库改名为 `opencode-teleagent-auth`**，与 npm 包名统一（旧地址
  `anbulang/magpie-teleagent` 由 GitHub 自动跳转）。`package.json` 的
  `repository` / `homepage` / `bugs` 指向新地址。
  插件短名推导仍是 `teleagent`（`opencode-` 前缀 + `-auth` 后缀被剥掉），
  工具全名仍是 `teleagent_points`、MCP 短名仍是 `teleagent`，**升级不影响任何已有配置**。
- README 重写：参考 `dsh-connect-teleagent` 的排版（徽章 / 特性 / 模型 / 安装 / 使用 /
  原理 / 费用与风险 / 故障排查 / 隐私 / 开发 / 限制），从 950 行压到 460 行；
  顺手修掉拆分仓库时残留的错误路径（`magpie/lib/`、`cd magpie`、`magpie/scripts/`）。
- 新增 `assets/icon.svg`（registry 卡片图标，随包发布）。
- npm 关键词调整：去掉半改的旧名 `opencode-teleagent`。

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
- git：`magpie plugin add github:anbulang/opencode-teleagent-auth`
  （当时仓库名为 `magpie-teleagent`，旧地址仍可装，GitHub 会自动跳转）
- 仓库：https://github.com/anbulang/opencode-teleagent-auth

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
