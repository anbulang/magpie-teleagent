# opencode-teleagent-auth

magpie（usemagpie.ai）的 TeleAgent 供应商插件，包名 `opencode-teleagent-auth`。

把本机已登录的 **TeleAgent**（天翼 AI 星辰超级智能体桌面版）接进 magpie，
在 magpie 里多出一个 `teleagent` 供应商和 5 个模型。

- 供应商 id：`teleagent`
- 模型：`chat-pro` / `chat-flagship` / `chat-flash` / `chat-lite` / `chat-nano`
- 登录方式：一键读取本机 TeleAgent 登录态，**不需要 API key**
- 平台：仅 macOS

装好之后，在 magpie 的 agent 里写 `teleagent/chat-pro` 就能用。

---

章节：定位 · 前置条件 · 安装 · 登录与多账号 · 模型 · 用量与签到 · 请求形态 ·
封号风险与硬约束 · 故障排查 · 隐私 · 开发 · 已知限制 · 免责声明。

先读第八节（封号风险）再动手。那一节不是免责声明，是操作说明。

---

## 一、定位

### 一句话

magpie 的 TeleAgent 供应商插件：复用 TeleAgent 桌面端已有的登录态，把桌面端的 5 个模型
以 OpenAI 兼容协议暴露给 magpie，不需要单独注册账号、不需要申请 API key。

### 这个插件做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 注册供应商 `teleagent` 与 5 个模型 | 不创建新账号：用的是本机已登录的账号 |
| 从本机桌面端读登录态（`token.json` + 钥匙串） | 不伪造官方客户端：不改提示词、不伪造人格串 |
| 每个请求用 token + 设备指纹做两步 HMAC 签名 | 不上报、不记录：不写请求日志、不上报账号信息 |
| `magpie quota` 显示余额与套餐；每日签到（幂等） | 不绕过风控：限速是为了**减少**被标记的概率 |
| 给 agent 一个只读工具 `points`（全名 `<插件短名>_points`） | 不做多平台：桌面端只有 macOS 版 |
| 内置并发 / 每分钟 / 熔断三层防突发 | 不伪造签名变体去试上游 |

### 这个仓库是什么

一个**只服务 magpie / OpenCode** 的供应商插件。它不依赖任何其他仓库：
签名、凭据、portal 的实现与推导都在这份代码和 `docs/PROTOCOL.md` 里。

同样的 TeleAgent 接入思路还有一个 DeepSeek Harness 的插件
（`dsh-connect-teleagent`），那个是**另一个独立仓库**——宿主不同、接口不同、
安装方式不同。两者只共享"逆向结论"这类知识，不共享代码，也不需要一起装。

| | DSH 插件（另一个仓库） | 本仓库 |
|---|---|---|
| 宿主 | DeepSeek Harness | magpie / OpenCode |
| 接口 | pi-ai provider + 设置卡片 | OpenCode v1 插件 hooks |
| 登录交互 | 设置卡片按钮 | `auth.methods` 无输入登录 |
| 积分 | 卡片 + 输入框胶囊 | `auth.usage` + `magpie quota` |
| 协议笔记 | 在它自己的 docs 里 | `docs/PROTOCOL.md`（本仓库） |

装了这个就不用装那个；反过来也一样。

---

## 二、前置条件

| 条件 | 检查方式 | 不满足会怎样 |
|---|---|---|
| macOS | `uname -s` 返回 `Darwin` | 报 `not_macos`：「当前平台是 linux，TeleAgent 桌面端只有 macOS 版」 |
| TeleAgent 桌面端已安装 | `ls /Applications/TeleAgent.app` | 报 `app_missing` |
| 已在桌面端登录 | 桌面端里能看到账号 | 报 `not_signed_in` |
| magpie 0.1.6xx 以上 | `magpie --version` | 更早的版本只跑 `config` / `auth` / `provider`：模型能用，`auth.usage`（积分）与 `auth.checkin`（签到）不跑 |
| 钥匙串可读 | 首次会弹授权框 | 报 `keychain_denied` |

**不需要**：

- 不需要注册 magpie 账号之外的任何东西
- 不需要 API key
- 不需要手动复制 token
- 不需要 root

一个提醒：TeleAgent 桌面端不需要一直开着，但**登录态要存在**。
插件读的是磁盘上的凭据文件，不是运行中的桌面端进程。

`package.json` 里的关键字段：

| 字段 | 值 | 作用 |
|---|---|---|
| `name` | `opencode-teleagent-auth` | 安装时用的包名 |
| `type` / `main` | `module` / `./index.mjs` | ESM 入口 |
| `os` | `["darwin"]` | 非 macOS 直接拒装 |
| `engines.node` | `>=20` | 需要内置 fetch 与 `AbortSignal.timeout` |
| `magpie.summary` | `{en, zh}` | 「发现」卡片上的简介（按窗口语言选） |
| `magpie.name` | `TeleAgent 模型` | 插件列表里的显示名 |

---

## 三、安装

插件本身是一个 npm 包 / git 仓库 / 本地目录，三种装法都行。

### 三种装法

| 方式 | 命令 |
|---|---|
| git 仓库（现在就能用） | `magpie plugin add github:anbulang/magpie-teleagent` |
| 本地目录（开发用） | `magpie plugin add /path/to/magpie-teleagent` |
| npm 包（发布后可用） | `magpie plugin add opencode-teleagent-auth` |

克隆下来直接指向仓库根就是本地目录方式；开发也用这个，改完把插件关掉再打开即可。

magpie 界面里也能装：**插件** → **发现** 或 **添加插件** → 粘贴包名 / git 地址 / 本地路径。

### 装好了怎么确认

```bash
magpie plugin            # 列表里应该出现插件名
magpie plugin --json     # 机器可读，适合脚本判断
```

`magpie plugin --json` 只读插件清单，不联网、不发模型请求，最安全。
`magpie provider test teleagent` 会发**真实**请求并消耗积分，装完不必立刻跑（见第八节）。

### 沙箱安装测试（推荐先跑这个）

不想污染自己的 magpie 配置，就开一个隔离 HOME 试：

```bash
sb=$(mktemp -d)
m() { env HOME=$sb \
          XDG_CONFIG_HOME=$sb/.config \
          XDG_CACHE_HOME=$sb/.cache \
          MAGPIE_ADDR=127.0.0.1:3499 \
          magpie "$@"; }

m plugin add /path/to/magpie-teleagent
m plugin --json
```

注意：这里 `HOME` 被换成了临时目录，所以插件**读不到**你真实的 TeleAgent 登录态。
这是故意的——用来验证「未登录」这条分支是不是干净地报错，而不是崩掉或者瞎猜。
要测真实登录态，去掉 `HOME=` 覆盖那一行。

装完没生效就三件事：完全退出 magpie 再启动（别等热更新）、`magpie plugin --json`
看清单、确认没装到另一个 profile（`--profile` 参数）。

---

## 四、登录与多账号

### 为什么没有 API key

TeleAgent 没有给第三方发 API key。桌面端自己拿的是**用户登录凭据 + 设备指纹**，
每个请求现场签名。所以插件能提供的登录方式只有一种：**读取本机已有的登录态**。

| 常规插件 | 本插件 |
|---|---|
| 用户去后台申请 API key | 用户在本机登录 TeleAgent 桌面端 |
| 把 key 粘进 magpie | 点一下「读取本机登录态」 |
| key 长期有效 | 凭据约 30 天到期，只能重登桌面端 |

### 凭据链路

```text
~/.local/share/TeleAgent/
├── current-owner.json                          当前账号指针
├── users/<scope>/app-auth/token.json           加密凭据（safeStorage v10）
└── app-auth/device-meta.json                   deviceId / installId

        │  用钥匙串条目 "TeleAgent Safe Storage" 解密
        ▼
   <tenant>:<JWT>     JWT 里带 accountName / accountId / exp
```

解密细节（给好奇的人）：

| 项 | 值 |
|---|---|
| 加密格式 | Electron `safeStorage`，前缀 `v10` |
| 钥匙串条目 | `TeleAgent Safe Storage`（generic password） |
| KDF | PBKDF2-SHA1，salt `saltysalt`，1003 轮，16 字节 |
| 加密算法 | AES-128-CBC，IV 为 16 个 `0x20` |
| 明文 | `<tenant>:<JWT>` |

插件只用这些信息**加签自己的请求**，不解密别的东西，不读你的聊天记录。

### 插件选项（可选）

`magpie plugin options teleagent '<json>'`（或界面里那一行的选项按钮）：

| 键 | 默认 | 作用 |
|---|---|---|
| `verbose` | `false` | 往 magpie 日志写 loader/fetch 阶段信息（不含 token、不含正文） |
| `apiKey` | 自动解析 | 显式指定网关 apiKey；一般不用设，见第七节 |
| `debug` | `false` | `verbose` 的别名 |

选项在下次请求前生效；`off` 清除并回到默认。

### 登录步骤

1. 确认桌面端已登录：`ls ~/.local/share/TeleAgent/users/`
   应看到 `v1_public_<数字>` 这样的目录。
2. 读一次凭据（会弹一次钥匙串授权）：`magpie plugin login teleagent`。
   下拉框里选账号，弹框里点 **允许** 或 **始终允许**；点「拒绝」会得到
   `keychain_denied`，见故障排查表。
3. 验证：`magpie quota` 能看到积分余额，就说明凭据链路通了。

界面里同一步骤是供应商设置页上的 **「读取本机 TeleAgent 登录态」**。

### 多账号

桌面端的数据目录按账号隔离（`users/<scope>/`），所以本机可以同时存在多个账号的凭据，
插件把它们映射成 magpie 的多个账号：

| 概念 | 对应 |
|---|---|
| 本机账号 | `users/<scope>/` 下一个带 `token.json` 的目录 |
| magpie 里的账号 | 一个条目，key 是 `scope`，显示名来自 JWT 的 `accountName` |
| 当前账号 | `current-owner.json` 指向的，或 `token.json` 最新的那个 |

登录时 `auth.methods` 的 `prompts` 会列出一个下拉框：

```text
选择要接入的 TeleAgent 账号（本机所有已登录账号）
  · 示例账号，剩余 27 天
  · yxBOJa（示例），剩余 12 天
  · v1_public_…（不可用：钥匙串授权被拒绝）
```

每个账号各自登记一次，key 只存 `scope`，**不存 token**。

下拉框的选项在**登录那一刻**生成（magpie 的 prompts 只在登录流程里问一次）。
所以你刚在桌面端登录了新账号时，重新跑一遍 `magpie plugin login teleagent`
就能看到它——不需要重启 magpie 宿主。

| 行为 | 说明 |
|---|---|
| 列账号 | 遍历 `users/`，只列有 `token.json` 的目录 |
| 标注 | 每个账号现读一次凭据，标出显示名与剩余天数 |
| 不可用 | 直接在下拉项里写原因（钥匙串拒绝、过期等） |
| token | 每次请求前现读现解密，不缓存、不写进 `plugin-auth.json` |
| guard | 按 scope 隔离：一个账号熔断，不影响另一个账号 |
| 故障切换 | 交给 magpie：一个账号被标记失效后，它会换另一个账号或模型 |

为什么 token 不落盘：token 会过期，也会被桌面端重新登录替换。复制进
`plugin-auth.json` 只会变成旧凭据，还多一处泄漏面。

限制：

- 多账号的前提是本机真的存了多份凭据。桌面端同一时刻只允许一个「当前登录」，
  切号要你在桌面端操作，插件不替你换号，也不动 `current-owner.json`
- 非当前账号可能没有 portal cookie，表现为「模型能用、积分读不到」
- 账号名只用于显示，插件不核对它和凭据是否一致

### 凭据过期（重要）

| 项 | 事实 |
|---|---|
| 有效期 | 约 30 天（JWT 的 `exp`） |
| refresh token | **没有**。凭据文件里只有加密的 token |
| 能否自动续期 | **不能**。插件没有任何合法手段拿新 token |
| 到期后现象 | 401 / `40108 token invalid` |
| 到期怎么办 | 桌面端重新登录，再 `magpie plugin login teleagent` |

插件会在下拉项和 `magpie quota` 里写剩余天数，但**不会**偷偷续期、
也**不会**伪造凭据。到期前重登一次最省事——过期和封禁的报错很像，
别等它过期再排查。

---

## 五、模型

### 模型表

| modelID | 名称 | 上下文 | 输出 | 图片 | 积分倍率 | magpie 里的写法 |
|---|---|---|---|---|---|---|
| `chat-pro` | 智能 | 400K | 65536 | 支持 | x0.6 | `teleagent/chat-pro` |
| `chat-flagship` | 旗舰 | 400K | 65536 | 不支持 | x1.0 | `teleagent/chat-flagship` |
| `chat-flash` | 极速 | 400K | 65536 | 支持 | x0.2 | `teleagent/chat-flash` |
| `chat-lite` | 轻量 | 100K | 16384 | 不支持 | x0.5 | `teleagent/chat-lite` |
| `chat-nano` | 轻速 | 100K | 16384 | 不支持 | x0.1 | `teleagent/chat-nano` |

倍率来自 TeleAgent 自己的模型目录，不是插件编的。
它表示「这个模型消耗积分是基准的几倍」，不是折扣。

输出上限：三档模型（pro / flagship / flash）是 65536，`chat-lite` / `chat-nano` 是 **16384**；
上下文只有 `chat-lite` / `chat-nano` 收到 100K。

这些数字取自桌面端自己的账号配置（`~/.config/TeleAgent/users/<scope>/TeleAgent.jsonc`
里的 `provider.NewApi.models`），也就是客户端真正在用的目录。

### 声明成什么样

`lib/models.mjs` 的 `buildModels()` 把模型目录转成 magpie 要的形状：

```js
{
  name: '智能 · x0.6',
  id: 'chat-pro',
  limit: { context: 400000, input: 400000, output: 65536 },   // chat-lite/nano 的 output 是 16384
  reasoning: true,
  tool_call: true,
  attachment: true,
  modalities: { input: ['text', 'image'], output: ['text'] },
  interleaved: { field: 'reasoning_content' },
  rate: 'x0.6',
}
```

字段含义：

| 字段 | 作用 | 说明 |
|---|---|---|
| `name` | 选择器里的名字 | 带上倍率，例如 `智能 · x0.6` |
| `limit.context` / `limit.input` | 上下文窗口 | 单位 token，两者取同一个值 |
| `limit.output` | 单次最大输出 | 单位 token |
| `reasoning` | 是否暴露思维链 | 上游返回 `reasoning_content`，可折叠显示 |
| `interleaved.field` | 思维链字段名 | `reasoning_content` |
| `tool_call` | 是否支持工具调用 | 5 个模型上游都支持 |
| `attachment` | 能否带附件 | 与 `vision` 一致 |
| `modalities.input` | 能收什么输入 | 只写 `['text','image']` 或 `['text']` |
| `rate` | 显示用倍率 | 写成 `x0.6` 这样 |

三个刻意的选择：

- **不写 `capabilities`**。magpie 只认 `modalities`，写了 `capabilities` 不生效，
  只会让人误以为生效了。
- **不写 `free: true`**。所有模型都花积分，标成免费就是在骗用户。
- **`vision` 按实测填**，不按上游目录填（下一小节）。

### 为什么有的模型不声明图片

`modalities.input` 一旦声明 `image`，magpie 就会真的把图片塞进请求。
所以这个字段只能按**实测**结果写，不能按上游目录写。

实测方法：同一张「蓝色三角形 + 文字 42」的图片，逐个模型发，看能不能正确读出来。

| 模型 | 实测结果 | 结论 |
|---|---|---|
| `chat-pro` | 正确识别 | 声明图片 |
| `chat-flash` | 正确识别 | 声明图片 |
| `chat-lite` | HTTP 200，但内容与图片无关（在编） | 不声明 |
| `chat-nano` | HTTP 400 `telechat-29b is not a multimodal model` | 不声明 |
| `chat-flagship` | HTTP 400，业务码 `1210`（内容块类型不支持） | 不声明 |

有两个反直觉的点，都写在这里免得以后又被改回去：

1. **桌面端自己的能力目录把 `chat-pro` / `chat-flash` 标成 `Input.Image: false`**，
   和实测不符。以实测为准。
2. **`chat-lite` 返回 200 不算支持**。它不报错，但答非所问。对外声明「支持图片」
   等于让用户拿到幻觉，比直接拒绝更糟。

给 `chat-lite` / `chat-nano` / `chat-flagship` 发图片，会在上游拿到 `1210` 或 400，
插件把这类错误原样报给 magpie，不重试。

### 怎么选

| 场景 | 建议 |
|---|---|
| 日常写代码、长上下文 | `chat-pro`（x0.6） |
| 大批量、便宜的活 | `chat-flash`（x0.2） |
| 需要看图 | `chat-pro` 或 `chat-flash` |
| 短问答、要质量 | `chat-flagship`（x1.0），但它不看图 |
| 极短、极便宜 | `chat-nano`（x0.1） |
| 不太建议 | `chat-lite`（x0.5，比 flash 贵却更弱） |

贵不等于强。长任务默认 `chat-flash` 或 `chat-pro`，`chat-flagship` 留给短问答。
省积分的办法：勤开新会话、及时压缩上下文、关掉不用的工具——输入 tokens
**包含完整历史**，长会话单步很容易到 10 万以上，工具定义也算输入。

---

## 六、用量与签到

积分和聊天**不是同一个服务**，这点很容易踩坑。

| | 聊天 | 积分 |
|---|---|---|
| 地址 | `https://agent.teleai.com.cn/superCowork/sapi` | `https://agent.teleai.com.cn/meter/super-agent/user/portal` |
| 鉴权 | 两步 HMAC 签名 + Bearer | cookie + 请求头，**不签名** |
| 是否花积分 | 是 | 否 |
| 谁调的 | 插件自己 | 插件自己（只读为主） |

### `auth.usage`：余额与套餐

magpie 会定期调 `auth.usage`，插件转成 `GET /v1/magpie/quotas` 展示。
它**只读 portal**，不花积分、不发模型请求。

| 显示项 | 来源接口 | 说明 |
|---|---|---|
| 积分余额 | `/points/detail` → `pointsBalance` | 放在窗口里：`windows: [{name:'积分余额', balance, unit:'积分'}]`，显示成 `6,293.85 积分 left` |
| 即将过期 | `/points/detail` → `groups[].active[].effectiveEnd` | 最早到期的那一笔，填进 `runsOutAt` |
| 套餐名 | `/companyStore/userCenter` → `plan_display_name` | 例如「免费版」，填进 `plan` |

对应命令：`magpie quota`。

三个说明：

- 这是**预付钱包式余额**，没有 `used` / `limit`，所以不参与「额度用尽」判断
- 顶层 `balance` 不重复给：它和窗口里的 `balance` 是同一个数，同时给会显示两遍
- 返回值里 `user` 留空；`magpie quota` 里那个账号名来自登录时写入的
  `metadata.email`（magpie 用它给账号命名），不是插件在用量里报的

读不到 portal cookie 时，`usage` 返回 `error` 而不是崩掉：

```text
读不到积分凭据（cookie）：在 TeleAgent 桌面端登录一次即可
```

此时模型照常可用。

### `auth.checkin`：每日签到

| 项 | 说明 |
|---|---|
| 频率 | 每天一次 |
| 幂等 | 是。先查 `claimed_today`，已领就短路返回 `done` |
| 复查 | 领完再查一次，接口说成功但实际没发也算失败 |
| 花积分 | 否 |
| 返回 | `claimed`（附获得积分）/ `done` / `failed`（附原因） |
| 失败影响 | 只影响签到结果，不影响模型可用 |

接口序列：

```text
GET  /companyStore/v2/checkDayTask              → 今天是领没领、能领多少
POST /companyStore/checkTask?type=daily_login   → 领取
GET  /companyStore/v2/checkDayTask              → 再确认一次
```

签到是**唯一**一个会改服务器状态的积分操作，所以插件对它特别小心：
先查后领、领完复查、失败不重试。

### 只读工具 `points`（全名含插件短名）

插件给 agent 挂了一个只读工具，让它能自己回答「我还有多少积分、今天领了没」：
无参数、无副作用、不消耗积分、不触发领取、**不发任何模型请求**。
返回 `balance` / `expiresAt` / `planName` / `claimedToday` / `claimable` /
`totalClaimDays` / `totalClaimedPoints`。

### cookie 从哪来

桌面端给每个账号开了独立的 Chromium 分区
`~/.local/share/TeleAgent/Partitions/owner%3A<scope>/Cookies`。
这是标准的 Chromium SQLite cookie 库，插件只取 `operationToken`（也用作请求头
`X-Token`）和 `operToken`。实测这个实例把值**明文**存在 `value` 列，所以不需要解密；
若将来改成加密存储，插件会读不到值并显式返回「积分不可用」，而不是显示错误的余额。

两个实现细节：

1. 读之前先把 cookie 库**复制到临时文件**——桌面端运行时会锁原库，直接读会失败。
2. `sqlite3` 报 `no such table: cookies` 属于**正常空状态**（库没初始化、快照不完整、
   这个分区从没登录过）。这时返回「没有 cookie」，不报错、不打印 sqlite3 的 stderr。

### 积分不可用时

积分读不到不影响模型，两个子系统独立降级：

| 情况 | 模型 | 积分显示 |
|---|---|---|
| 凭据正常、cookie 缺失 | 能用 | 「不可用」 |
| 凭据过期 | 不能用 | 可能仍能读（cookie 与 token 生命周期不同步） |
| 账号被封（40109） | 不能用 | **仍然正常**，这是被封的典型特征 |

最后一行很重要：**能读积分 ≠ 账号没被封**。封的是模型调用通道，不是账号本身。

---

## 七、请求形态

### 一句话

走 OpenAI 兼容的 chat completions，本地复刻上游的两步 HMAC 签名，流式原样透传。

```text
magpie agent
   │  OpenAI 兼容 chat completions
   ▼
magpie 内置 openai-compatible provider
   │  auth.loader 返回的 fetch（每次请求现场加签）
   ▼
https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions
```

### 签名算法

逆向自桌面端内核的 `GatewaySigner.Sign`（lldb 断在 `hmacHex` 入口实测得到两次调用）。
完整推导与踩坑记录见 `docs/PROTOCOL.md` 第二节。

第一步，绑定安装标识：

```text
key = JWT 第三段（token.split(".")[2]）
msg = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
k1  = hex(HMAC-SHA256(key, msg))
```

第二步，签请求指纹：

```text
key = k1（当作 64 字符十六进制文本使用）
msg = "superagent-auth-v1\n{METHOD}\n{pathname}\n{ts}\n{nonce}\n{appVersion}\n{sha256hex(body)}"
sig = hex(HMAC-SHA256(key, msg))
```

两个容易写错的点：

| 点 | 说明 |
|---|---|
| `pathname` | 必须**包含** `/superCowork/sapi` 前缀，签的是完整路径 |
| 顺序 | 两步顺序反了会得到 `40104 invalid signature`（说明 token 是对的，只有签名不对） |

`40104` 是个好信号：它证明凭据没问题，问题在签名实现。

### 请求头

| 头 | 值 / 来源 |
|---|---|
| `Authorization` | `Bearer <网关 apiKey>`，缺失会 `40105` |
| `X-Token` | 本机解密出的 JWT |
| `X-Superagent-Device-Id` / `-Install-Id` | `device-meta.json` 的 `deviceId` / `installId` |
| `X-Superagent-Timestamp` / `-Nonce` | 每次请求新生成的秒级时间戳与 UUID |
| `X-Superagent-Signature` / `-Sign-Version` | 第二步算出的 sig，版本 `v1` |
| `X-App-Version` | 桌面端 `CFBundleShortVersionString` |
| `X-Route-Target` | `ops-gateway` |
| `X-Session-Id` / `X-Message-Id` / `X-Teleai-Root-Session-Id` | 本地生成的会话标识 |
| `x-teleagent-session` | 由 magpie 的 `sessionID` 脱敏后生成，给 `chat.headers` 用 |

关于 `Authorization` 里那个 apiKey：它是**桌面端内置的常量**，作用不是鉴权
（真正的鉴权是 JWT + 签名），而是「请求来自官方客户端」的特征之一。
实测去掉它，上游直接回 `40105 您的请求疑似攻击请求`。

插件不在仓库里硬编码这个值，而是运行时按顺序找：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | 插件配置 | 用户显式填的 |
| 2 | 环境变量 `TELEAGENT_API_KEY` | 想覆盖时用这个 |
| 3 | 桌面端 `TeleAgent.jsonc` | 用户改过供应商配置时会写进去 |
| 4 | 桌面端安装包的 `app.asar` | 纯本地读取字节，不联网、不解包、不写盘 |

四步都失败就返回空串，请求照发，上游用 `40105` 报错，插件翻译成
「本机 TeleAgent 版本不受支持，请更新插件」。这个 key 和你的账号能不能用、
积分多少都无关。

### 消息与工具

- `messages` 原样送上游，插件不改 role、不折叠多轮、不替换 system 提示词
- `tools` 原样送上游，tool_calls 原样回给 magpie，工具由 magpie 执行
- 插件**不**注入任何人格串，**不**伪造官方客户端会话

会话 id（`X-Session-Id` / `X-Message-Id`）是本地生成的。这不是伪造：
opencode 系协议里这些 id 本来就由客户端生成，服务端不下发。

### 流式

| 情况 | 做法 |
|---|---|
| magpie 要流式 | 上游 SSE 字节流原样转发，不重新编码 |
| magpie 要非流式 | 插件向上游**仍然发流式**，在本地聚合成一条响应 |

为什么非流式也发流式：实测桌面端所有请求都是 `stream: true`，
从不用 `stream: false`。为了不在请求形态上露出差异，插件保持这个习惯。

### 错误透传

上游的业务错误码会翻译成人话再报给 magpie，不重试、不吞掉：

| 上游码 | 含义 / 插件行为 |
|---|---|
| `40104` | 签名无效 → 提示上游可能改了协议 |
| `40105` | 请求疑似攻击 → 网关 apiKey 没取到 |
| `40108` | token 无效 → 提示重登 |
| `40109` | 账号封禁 → 报「账号被封」，**停止重试** |
| `40110` | 账号停用 |
| `402` / `4029` | 积分不足，不重试 |
| `429` / `4290` | 请求过于频繁 |
| `1210` | 该模型不支持这种内容（如图片） |

积分不足、封禁、限流这三类**不会被自动重试**。
自动重试只会把一次小错误放大成一串请求，这正是要避免的。

---

## 八、封号风险与硬约束

这一节请认真读。它的每一条都是从两次真实的封号里换来的。

### 事实

| 时间 | 事件 |
|---|---|
| 2026-10-27 前 | 第一个账号因合成探测被风控 |
| 2026-10-27 | 第二个账号在**约 1 小时 45 分**后被封，现象与第一次一致 |
| 现象 | 聊天网关返回 `40109 current user is banned` |
| 关键细节 | **积分接口仍然正常**：余额能读、签到能领 |

最后一行说明：封的是**模型调用通道**，不是账号注销。
所以「我积分还能查，应该没事」是错判。

### 触发封禁的行为（复盘结论）

第二轮的问题出在插件自己的探测上：

| 行为 | 规模 |
|---|---|
| 5 个模型 × 图片 data URL 逐个试 | 约 13 次请求 |
| 50 / 150 / 300 / 600 KB 填充体各试一次 | 4 次超大 body |
| 10 / 100 / 265 个合成工具（`tool_0` … `tool_264`）各试一次 | 3 次 |
| 每次启动都发一次真实聊天请求做自检 | 每次重启 +1 |

在风控眼里这是教科书式的自动化探测：

- 超大 body、没有实际语义
- 工具名规律得像机器生成的
- 短时间内在多个模型之间跳
- 没有人类对话的节奏

配套还有两个放大因素：启动自检每次都发真实请求；只有并发上限、**没有速率上限**，
短时间可以打出一串请求。

### 插件内置的硬约束

| 机制 | 默认值 | 作用 |
|---|---|---|
| 并发上限 | 2 | 同时最多 2 个上游请求，其余排队 |
| 每分钟上限 | 20 | 超过就等到下一个窗口，不硬闯 |
| 熔断阈值 | 连续 3 次 401/403 | 达到即暂停 |
| 熔断冷却 | 10 分钟 | 期间快速失败，不发请求 |
| 半开探测 | 1 个 | 冷却结束后只放一个请求试探，成功才恢复 |
| 空闲回调 | 10 分钟 | 最后一次活动后回调一次 `onIdle`（当前只记 `verbose` 日志，不影响后续请求） |

这些数字不是随便定的：官方客户端是人工交互，天然低并发，而 magpie 可能并行调多个
模型；每分钟 20 次正常对话到不了，能到的只有脚本和压测。`lib/guard.mjs` 的注释里
写得很直白：这些不是性能参数，是**账号存活参数**，不要为了「跑得快」调大。
guard 按账号隔离，一个账号熔断不影响另一个。

### 明确劝阻的行为

| 不要做 | 为什么 |
|---|---|
| 批量跑 `magpie provider test teleagent` | 每个模型一次真实请求，5 个模型就是 5 次；循环跑更快进风控 |
| 循环压测（for 循环发请求） | 最典型的自动化流量形态 |
| 用脚本遍历模型 / 遍历参数 | 上面的封号就是这么来的 |
| 发超大填充体测上限 | 超大 body + 无语义 = 高危 |
| 批量注册合成工具名 | 工具名规律 = 高危 |
| 拿真实账号试签名变体 | `40104` 刷屏本身就是异常流量 |

### `magpie provider test` 的正确用法

`magpie provider test teleagent` 测的是**单个**供应商的一个模型，发**一次**
真实请求、消耗积分。测一次确认链路通是合理的；每改一次配置就测一遍、
放进 CI 循环、或者写脚本轮着跑，都不合适。

想确认「插件装好了没」用 `magpie plugin --json`，那个不联网。

### 该怎么做

| 目的 | 做法 |
|---|---|
| 确认插件装好 | `magpie plugin --json`（零请求） |
| 确认凭据能读 | `magpie quota`（只读 portal，不花积分） |
| 确认链路能通 | 一个模型测一次，然后正常用 |
| 排签名问题 | 看是 `40104` 还是 `40108`，别反复重试换参数 |
| 看能不能读图 | 用 `chat-pro` 发一张，**不要遍历 5 个模型** |

### 如果已经被封

1. 停止所有自动化请求，别再试
2. 确认是不是 `40109`（积分能读、模型全拒，基本就是）
3. 换一个账号登录（本机多账号会走故障切换）
4. 需要申诉就联系天翼 AI 客服
5. 不要试图改请求头或改签名绕过——那是另一个问题

内置限速只是**降低**被标记的概率，不能保证账号安全。上游风控策略不公开、会变，
你能控制的只有自己的请求形态。

---

## 九、故障排查

### 排查顺序

```text
1. magpie plugin --json            插件在不在
2. magpie quota                    凭据能不能读（只读、免费）
3. magpie provider test teleagent  链路通不通（一次真实请求）
```

从只读往花钱的方向走，别一上来就压测。

### 表

| 现象 | 原因 | 动作 |
|---|---|---|
| 插件列表里没有 | 没装成功 / 装到了别的 profile | `magpie plugin add <路径>`；确认 `--profile` |
| 「未检测到 TeleAgent.app」 | 桌面端没装，或不在 `/Applications` | 安装 TeleAgent 桌面端 |
| 「数据目录不存在」 | 桌面端从没启动过 | 启动一次桌面端，让它初始化 `~/.local/share/TeleAgent` |
| 「未登录」 | 没有 `app-auth/token.json` | 在桌面端登录，然后 `magpie plugin login teleagent` |
| 钥匙串弹框被拒绝（`errSecAuthFailed`） | 拒绝了 `TeleAgent Safe Storage` 授权 | 打开「钥匙串访问」删掉 `TeleAgent Safe Storage`，重登桌面端，再试一次 |
| 「钥匙串里没有条目」 | 凭据在但钥匙串条目丢了（换机/迁移） | 在桌面端重新登录，重建条目 |
| 「凭据解密失败」 | 桌面端版本变了，加密格式不匹配 | 更新桌面端后重登；仍失败就是插件要适配 |
| 401 / `40108`，提示登录过期 | 约 30 天到期，**没有 refresh token，无法自动续期** | 桌面端重新登录 → `magpie plugin login teleagent` |
| `40104` 签名无效 | 上游改了签名协议，或 `pathname` 没带 `/superCowork/sapi` | 更新插件；别反复重试 |
| `40105` 请求疑似攻击 | 网关 apiKey 没取到（桌面端版本不受支持） | 更新插件；或 `export TELEAGENT_API_KEY=<本机桌面端的值>` |
| `40109` 账号封禁 | 模型通道被封（积分仍可读） | 停手，换账号，看第八节 |
| `40110` 账号停用 | 账号状态异常 | 联系客服或换账号 |
| `402` / `4029` 积分不足 | 余额不够 | `magpie quota` 看余额，签到领积分，或换低倍率模型 |
| `429` / `4290` 限流 | 请求太密 | 等一会儿；插件已有并发和分钟限速，持续出现就别再循环发 |
| `1210` 内容类型不支持 | 给不支持的模型发了图片 | 换 `chat-pro` / `chat-flash` |
| `413` 请求体过大 | 工具 schema 或附件太大 | 减工具、减附件。**这不是账号问题** |
| `404` | 接口变更 | 上游路径改了，插件需要更新 |
| `5xx` | 上游故障 | 稍后重试，不是你的问题 |
| 积分显示「不可用」，模型正常 | cookie 库没初始化 / 分区不对 | 启动桌面端，进一次积分页让它写 cookie |
| `sqlite3: command not found` | 系统没有 sqlite3 | macOS 自带；用 brew 装过的环境检查 PATH |
| 非 macOS | 插件只支持 macOS | 没有别的办法，桌面端只有 macOS |
| 模型列表为空 | `config` 没生效或被别的插件覆盖 | `magpie plugin --json` 看 hooks；确认 `cfg.provider.teleagent ??=` 没被改写 |
| 偶发「熔断中」 | 连续 3 次 401/403 触发了冷却 | 等 10 分钟，或修好凭据后重新登录（loader 会按账号隔离熔断，换账号即可继续） |
| `404` 且提示「TeleAgent 没有模型 X」 | agent 传了目录外的模型 id | 用第五节表里的 5 个 id；插件在本地就拦下，不会打到上游 |

### 两个容易混淆的错误

| | `40104` | `40108` |
|---|---|---|
| 含义 | 签名不对 | 身份不对 |
| 说明什么 | token 是好的 | token 坏了 / 过期 / 账号异常 |
| 怎么办 | 更新插件 | 重新登录 |
| 别做 | 反复重试换参数 | 反复重试 |

「积分能读但模型全拒」几乎一定是 `40109`：`magpie quota` 能出余额说明凭据和
cookie 都没问题，而任意模型请求都 401 说明模型通道被限制。别继续试，看第八节。

---

## 十、隐私

### 插件能看到什么

| 数据 | 位置 | 是否离开本机 |
|---|---|---|
| TeleAgent 登录凭据（JWT） | `users/<scope>/app-auth/token.json` | 否，只用于本机加签 |
| 设备指纹（deviceId / installId） | `app-auth/device-meta.json` | 否，只放在请求头里 |
| 桌面端版本号 | `Info.plist` | 否，只放在请求头里 |
| 积分 cookie | `Partitions/owner%3A<scope>/Cookies` | 否，只发给 portal |
| 你的对话内容 | magpie 传给插件 | 是，只发给 TeleAgent 上游 |
| 你的聊天记录 / 技能 / 记忆 | 桌面端数据目录 | **不读** |

### 请求发到哪里

只有一个域名：

```text
https://agent.teleai.com.cn
├── /superCowork/sapi/api/v1/chat/completions     聊天
└── /meter/super-agent/user/portal/...            积分与签到
```

没有别的出站目标。没有第三方统计、没有回传、没有「匿名使用数据」。

### 日志

| 项 | 行为 |
|---|---|
| 请求日志 | 不写 |
| 请求体 / 响应体 | 不落盘 |
| token / cookie | 不打印，不进错误信息 |
| 账号信息 | 不上报 |
| 错误信息 | 只报错误码和人话，不含凭据 |

`magpie plugin --json` 和 `magpie quota` 的输出里只有状态和数字，可以直接贴出来求助，
但还是建议看一眼再贴，别把完整路径贴到公开地方。你可以自己核对：

```bash
grep -rn "https://" magpie/lib/ magpie/index.mjs   # 出站目标只有 agent.teleai.com.cn
grep -rn "token.json" magpie/lib/                  # 只读，不写
```

---

## 十一、开发

### 目录结构

```text
magpie-teleagent/
├── package.json          插件元数据（type: module、os: darwin、magpie.name/summary）
├── index.mjs             插件入口：export default async (input) => hooks
├── lib/
│   ├── credential.mjs    读 token.json、钥匙串解密、凭据诊断、列本机账号
│   ├── apikey.mjs        网关 apiKey 运行时解析（配置 / 环境变量 / 配置库 / app.asar）
│   ├── sign.mjs          两步 HMAC、请求头组装、按账号签名的 fetch
│   ├── guard.mjs         并发 / 每分钟 / 熔断 / 空闲回调
│   ├── models.mjs        5 个模型元数据与 buildModels()
│   └── portal.mjs        积分与签到（只读为主，网络与 sqlite 可注入）
├── scripts/
│   └── sandbox.sh        隔离 HOME 的手测脚本（--real-home 才发真实请求）
├── test/
│   ├── sign.test.mjs     签名 / 模型目录 / guard（29 项）
│   ├── plugin.test.mjs   hooks 形状 / 目录外模型拦截 / 401 翻译（39 项）
│   ├── credential.test.mjs 凭据解密与诊断（21 项）
│   ├── apikey.test.mjs   网关 apiKey 解析（11 项）
│   └── portal.test.mjs   积分与签到（46 项）
│                         合计 146 项，全部离线
├── docs/
│   └── PROTOCOL.md       协议笔记：签名 / 凭据 / portal / 封号复盘（本仓库唯一知识来源）
├── README.md             本文件
├── CHANGELOG.md          版本变更
└── LICENSE               MIT
```

入口模块**只导出一个函数**。magpie 会把入口的每个导出函数都当成插件调用，
所以辅助函数必须放 `lib/`。

### 插件入口

```js
export default async function TeleAgentPlugin(input = {}) {
  return {
    config: async (cfg) => { /* cfg.provider.teleagent ??= {...} */ },
    auth: {
      provider: 'teleagent',
      icon: '…',
      maxConcurrency: 2,
      methods: [{ type: 'api', keyless: true, /* 选账号的 select */ }],
      loader: async (getAuth) => ({ baseURL, apiKey: '占位', async fetch(fi, init) { … } }),
      usage: async (getAuth) => ({ plan, windows }),
      checkin: async (getAuth) => ({ outcome: 'claimed' | 'done' | 'failed' }),
    },
    provider: { id: 'teleagent', async models(provider) { return provider.models } },
    'chat.headers': async (chatInput, output) => { /* 补会话头 */ },
    tool: { points: { /* 只读工具 */ } },
  }
}
```

hooks 一览：

| hook | 本插件的用途 |
|---|---|
| `config` | 用 `??=` 声明 `teleagent` 与 5 个模型，不覆盖用户配置 |
| `auth.methods` | 一个 `keyless` 的登录方式：选账号 + 读本机登录态 |
| `auth.loader` | 返回 `{baseURL, apiKey, fetch}`，`fetch` 里现读 token、现签、过 guard |
| `auth.usage` | 只读 portal：余额、`runsOutAt`、套餐名 |
| `auth.checkin` | 每日签到，幂等 |
| `provider.models` | 复用 `config` 的模型列表，并补上厂商倍率 `rate` |
| `chat.headers` | 补 `x-teleagent-session`（用 magpie 的 sessionID 脱敏后生成） |
| `tool` | 只读工具 `points`（magpie 拼成 `<插件短名>_points`） |

`auth.loader` 里的 `apiKey` 是一个明确的**占位值**（`teleagent:<scope>`）：
magpie 会给 openai-compatible 请求自动加 `Authorization: Bearer <apiKey>`，
插件在自己的 `fetch` 里换成真正的网关 apiKey。真正的 token 从不经过这个字段。

`auth.refresh` **没有实现，是故意的**：凭据里没有 refresh token，写一个假的
「刷新成功」只会让过期问题更难排查。凭据失效时 `loader` 抛的错带
`error.signIn = 'expired'`，magpie 据此把账号标记成「需要重新登录」。

### 测试

```bash
cd magpie && bun test test/         # magpie 自带 bun：~/.cache/magpie/bun/<ver>/magpie-bun
# 没有全局 bun 时用 magpie 下载的那个：
#   <magpie bun 路径>/magpie-bun test test/
```

测试的红线：

| 红线 | 原因 |
|---|---|
| 测试不发真实网络请求 | 一次 CI 就是一次风控样本 |
| 测试不调真实签到接口 | 会改服务器状态 |
| 测试不读真实凭据 | 别把别人的 token 带进测试环境 |
| 测试不打印 cookie / token | 日志会进 CI 记录 |
| 网络与 sqlite 都要可注入 | 打桩才能离线跑 |

全部依赖用 `node:` 内置模块，没有第三方依赖。纯函数要能在 node 下直接 import。

### 沙箱手测

隔离 HOME 的模板见第三节「沙箱安装测试」。开发时常用两条路径：

仓库自带脚本把这两条路径都封好了：

```bash
# 隔离 HOME：只验证「未登录」分支，不发真实请求
bash magpie/scripts/sandbox.sh

# 真实 HOME：登录 + quota + 一次 provider test（会消耗积分，只跑一次）
bash magpie/scripts/sandbox.sh --real-home
```

### 改代码时的自检

| 改了什么 | 至少跑什么 |
|---|---|
| 签名实现 | 单测（确定性 ts/nonce）+ 一次真实请求看是不是 `40104` |
| 模型元数据 | 单测对齐 `limit` / `modalities` / `rate` |
| portal | 单测（注入 `run` 和 `fetchImpl`） |
| guard | 单测（注入时钟与 `onIdle`） |
| 入口 hooks | `magpie plugin --json` |

**别用真实账号跑重复验证。** 一次失败就够定位了，第二次只是多一次异常流量。

---

## 十二、已知限制

| 限制 | 说明 |
|---|---|
| 仅 macOS | TeleAgent 桌面端只有 macOS 版 |
| 依赖逆向 | 上游协议可能变，变了就 `40104` |
| 凭据约 30 天 | 没有 refresh token，到期必须重登 |
| 图片只有 2 个模型 | `chat-pro` / `chat-flash`；其余三个实测不支持 |
| 与官方客户端可区分 | 系统提示词、工具集合、TLS 指纹、请求节奏都不同，插件不伪装 |
| 积分 cookie 靠明文存储 | 上游哪天加密存了，积分就不可用（模型不受影响） |
| 多账号需要本机真有凭据 | 插件不会替你换号 |
| 封号无法预测 | 内置限速只降低概率，不保证安全 |

关于「与官方客户端可区分」，是刻意的取舍：

| 维度 | 官方客户端 | 本插件 |
|---|---|---|
| `messages[0]` | 固定人格串 | magpie agent 自己的提示词 |
| 工具集合 | 客户端内置 | magpie 的工具 |
| TLS 指纹 | Electron / Chromium | Node undici |
| 请求节奏 | 人工交互 | 可能突发，已加并发与限速 |

不建议伪造官方人格或客户端身份：既污染模型行为，也无助于账号申诉。

## 十三、免责声明

本项目是对本机已安装客户端行为的互操作研究，用于把自己已有的账号接进自己的工具链。
仓库不包含任何真实账号凭据、cookie 或上游密钥。

- 请遵守 TeleAgent 与 magpie 的使用条款，以及当地法律
- 账号风险由使用者承担：插件已按已知教训内置限速与熔断，但不能保证账号安全
- 上游协议随时可能变化，插件不承诺长期可用

## License

[MIT](../LICENSE)
