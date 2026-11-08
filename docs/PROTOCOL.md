# TeleAgent 协议笔记（插件自包含版）

这份文档是**这个仓库唯一的逆向知识来源**。插件不依赖任何其他仓库的文档；
上游协议变了，只改这里和对应的 `lib/` 模块。

内容是实际断点/抓包/试错得到的结论，不是从官方文档抄的。
没有官方文档——TeleAgent 桌面端不对外提供 API。

---

## 一、凭据：Electron safeStorage

`$APP_DATA/users/<scope>/app-auth/token.json`：

```json
{ "version": 1, "encryptedToken": "djEw...", "encrypted": true, "scheme": "safe_storage" }
```

解密链路：

```text
password = security find-generic-password -s "TeleAgent Safe Storage" -w
key      = PBKDF2-SHA1(password, "saltysalt", 1003 iters, 16 bytes)
plain    = AES-128-CBC(key, IV = 16 × 0x20).decrypt(base64(encryptedToken)[3:])
```

- 跳过前 3 个字节（`v10` 前缀，Electron safeStorage 的版本标记）
- IV 是 16 个 `0x20`（空格），不是随机 IV
- 明文 = `<tenant>:<JWT>`

JWT 声明里对插件有用的字段：

| 字段 | 用途 |
|---|---|
| `accountId` / `userId` | 账号 id |
| `accountName` | 显示名 |
| `tenant` | 租户 |
| `exp` | 过期时间（约 30 天） |

**没有 refresh token**，也没有续期接口。过期只能回桌面端重新登录。

实现：`lib/credential.mjs`。

### 设备指纹

`$APP_DATA/app-auth/device-meta.json` → `{ deviceId, installId }`。
两个值都参与签名，缺任何一个上游都会拒。

---

## 二、上游聊天网关：两步 HMAC

- 地址：`https://agent.teleai.com.cn/superCowork/sapi/api/v1/chat/completions`
- 协议：OpenAI 兼容 chat completions（流式 SSE）

### 签名算法

逆向自 kernel 的 `einoprovider.(*GatewaySigner).Sign`（lldb 断在 `hmacHex` 入口，
抓到两次调用的真实参数）。

**第 1 步（绑定 installId）**

```text
key = JWT 第三段（token.split(".")[2]）
msg = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
k1  = hex(HMAC-SHA256(key, msg))
```

**第 2 步（请求签名）**

```text
key = k1（作为 64 字符十六进制文本，不是字节）
msg = "superagent-auth-v1\n{METHOD}\n{pathname}\n{ts}\n{nonce}\n{appVersion}\n{sha256hex(body)}"
sig = hex(HMAC-SHA256(key, msg))
```

三条容易踩的坑：

| 坑 | 现象 | 正确做法 |
|---|---|---|
| `pathname` 少前缀 | `40104 invalid signature` | 必须带 `/superCowork/sapi`（签名用完整路径） |
| 用空格分隔而非换行 | `40104` | 两处 `join` 都用 `\n`（实测空格 401、换行 200） |
| 复用 ts/nonce | 偶发 `40104` | 每个请求现生成；`ts` 是**秒**级 |

实现：`lib/sign.mjs` 的 `computeSignature()` / `buildAuthHeaders()`。

### 请求头

| Header | 值 |
|---|---|
| `Authorization` | `Bearer <网关 apiKey>` |
| `X-Token` | 解密出来的 JWT（含 `<tenant>:` 前缀） |
| `X-App-Version` | 桌面端版本，如 `2.7.1` |
| `X-Route-Target` | `ops-gateway` |
| `X-Superagent-Device-Id` | `deviceId` |
| `X-Superagent-Install-Id` | `installId` |
| `X-Superagent-Timestamp` | 秒级时间戳 |
| `X-Superagent-Nonce` | 每次随机 |
| `X-Superagent-Sign-Version` | `v1` |
| `X-Superagent-Signature` | 上面的 `sig` |
| `X-Teleai-Run-Unit-Type` | `agent_loop` |
| `X-Session-Id` / `X-Teleai-Root-Session-Id` | 同一个本地生成的 `ses_*` |
| `X-Message-Id` | 本地生成的 `msg_*` |

会话/消息 id 由**客户端生成**（协议里不是服务端下发），所以本地生成是协议正确的行为。

### 网关 apiKey 是必需的

实测：去掉 `Authorization`，上游直接回 `40105 您的请求疑似攻击请求`。
所以它不是可选的装饰——上游把它当成「请求来自官方客户端」的特征之一。

这个 key 是桌面端内置常量（`预置模型` 供应商的 `options.apiKey`）。
本插件**不硬编码**它，运行时四级解析（`lib/apikey.mjs`）：

1. 插件选项 `apiKey`（`magpie plugin options teleagent '{"apiKey":"…"}'`）
2. 环境变量 `TELEAGENT_API_KEY`
3. 账号配置 `~/.config/TeleAgent/users/<scope>/TeleAgent.jsonc` 的
   `provider.NewApi.options.apiKey`
4. 桌面端安装包 `app.asar` 里的 `dist-electron/main-runtime-*.js` 常量

第 4 步只读本地文件的字节（asar = 16 字节 pickle 头 + JSON 头 + 顺序文件体），
不解包、不写盘、不联网。

### 模型目录

来自账号配置 `~/.config/TeleAgent/users/<scope>/TeleAgent.jsonc` 的
`provider.NewApi.models`（客户端真正在用的那份）：

| modelID | 名称 | context | output | 图片 |
|---|---|---|---|---|
| `chat-pro` | 智能 | 400000 | 65536 | ✅ 实测 |
| `chat-flagship` | 旗舰 | 400000 | 65536 | ❌ 400/1210 |
| `chat-flash` | 极速 | 400000 | 65536 | ✅ 实测 |
| `chat-lite` | 轻量 | 100000 | **16384** | ❌ 200 但内容无关 |
| `chat-nano` | 轻速 | 100000 | **16384** | ❌ 400 "not a multimodal model" |

图片能力是实测结论（同一张「蓝色三角形 + 文字 42」逐个试），
不是上游目录的声明——客户端自己的目录把 `chat-pro`/`chat-flash` 标成
`Input.Image:false`，与实测不符，以实测为准。

积分倍率（`x0.6` 这类）来自厂商选择器自己的写法。

实现：`lib/models.mjs`。

### 未知 model id 会静默回落

实测：请求 `model: "chat-flash"` 之外的任意字符串，上游**不报错**，
而是返回另一个厂商模型的回答。所以插件在本地对目录外的 id 直接 404，
不把这种请求放到上游。

---

## 三、门户服务（积分 / 签到）

**完全独立的另一个服务**，不是聊天网关：

- 基地址：`https://agent.teleai.com.cn/meter/super-agent/user/portal`
- 鉴权：cookie + 请求头，**不用签名**

| Header | 值 |
|---|---|
| `X-Token` | `operationToken`（`agent.teleai.com.cn` 域下的 cookie） |
| `userId` | 账号目录名 `v1_public_<userId>` 的尾段 |
| `Cookie` | `operToken=…; operationToken=…` |

### cookie 从哪来

桌面端按账号分区存 Chromium 的 cookie 库：

```text
$APP_DATA/Partitions/owner%3A<scope>/Cookies
```

这是 SQLite。实测该实例把值**明文存在 `value` 列**（`encrypted_value` 为空），
所以不需要钥匙串解密。若将来改成加密存储，`readCookieValues` 会读不到值并
返回 `null`（积分不可用），而不是给出错误余额。

**必须先复制再读**：桌面端运行时会锁库。

### 用到的接口

| 路径 | 用途 |
|---|---|
| `GET /points/detail` | `data.pointsBalance`、`data.groups[].active[].effectiveEnd` |
| `GET /companyStore/v2/checkDayTask` | 当日签到状态、可领积分、连续天数、活动信息 |
| `GET /companyStore/checkTask?type=daily_login` | 执行签到 |
| `GET /companyStore/userCenter` | 套餐名、余额、并发上限 |

### 两条实测结论

1. **`no such table: cookies` 是正常空状态**，不是故障：库未初始化 / 快照不完整 /
   该分区从未登录都会这样。要静默返回 `null`，不能记成错误。
2. **封禁后 portal 仍然可用**：聊天网关 `40109` 时，余额能读、签到能领。
   所以「积分还能查」不能证明账号没问题。

实现：`lib/portal.mjs`。

---

## 四、账号与多账号

```text
$APP_DATA/
├── current-owner.json                     当前账号指针 {ownerDir, userId, generation}
├── app-auth/device-meta.json              deviceId / installId
├── users/<scope>/app-auth/token.json      加密凭据
└── Partitions/owner%3A<scope>/Cookies     该账号的 cookie
```

- `<scope>` 形如 `v1_public_<userId>`
- 桌面端同一时刻只有一个「当前账号」，但数据目录按账号隔离
- 切换账号要改 `current-owner.json`（这是桌面端自己的文件，插件**不动**它）
- 当前账号的判定：优先 `current-owner.json`，否则 `token.json` 最新的那个

---

## 五、账号安全：两次封号复盘

这一节不是免责声明，是设计约束的来源。

### 事实

2026-10-27，两个账号先后被封：

| 事件 | 现象 |
|---|---|
| 第一个账号 | 合成探测后被风控 |
| 第二个账号 | 与第一个相隔约 1 小时 45 分，同样被封 |
| 报错 | 聊天网关 `40109 current user is banned` |
| 关键 | **积分接口仍正常**（余额可读、签到可领） |

封的是模型调用通道，不是账号注销。

### 触发封禁的行为（自查结论）

| 行为 | 规模 |
|---|---|
| 5 个模型 × 图片 data URL 逐个试 | 约 13 次请求 |
| 50 / 150 / 300 / 600 KB 填充体各一次 | 4 次超大 body |
| 10 / 100 / 265 个合成工具（`tool_0`…`tool_264`）各一次 | 3 次 |
| 每次启动发一次真实聊天请求做自检 | 每次重启 +1 |

在风控眼里这是教科书式自动化探测：超大 body、无语义、工具名规律、
短时间在多个模型间跳、没有人类对话节奏。

### 因此这些是硬约束，不要为了性能调大

| 机制 | 值 | 位置 |
|---|---|---|
| 并发上限 | 2 | `lib/guard.mjs` `maxConcurrent` |
| 每分钟上限 | 20 | `maxPerMinute` |
| 连续认证失败熔断 | 3 次 401/403 → 停 10 分钟 | `failureThreshold` / `cooldownMs` |
| 启动自检聊天请求 | **不发** | 全项目无此代码路径 |

以及这些明确不要做：

- 批量跑 `magpie provider test teleagent`（每个模型一次真实请求）
- 循环压测、脚本遍历模型或参数
- 发超大填充体测上限
- 批量注册合成工具名
- 用真实账号反复试签名变体（`40104` 刷屏本身就是异常流量）

内置限速只**降低**被标记的概率，不能保证账号安全。上游风控策略不公开、会变。

---

## 六、上游错误码

| 码 | 含义 | 处置 |
|---|---|---|
| `40104` | 签名无效 | 协议变了（或 pathname/分隔符错）→ 更新插件 |
| `40105` | 请求疑似攻击 | 网关 apiKey 没带上 |
| `40108` | token 无效 | 重新登录 |
| `40109` | 账号封禁 | 停手，换账号 |
| `40110` | 账号停用 | 联系客服或换账号 |
| `402` / `4029` | 积分不足 | 签到领积分 / 换低倍率模型 |
| `429` / `4290` | 频率过高 | 等一会儿 |
| `413` | 请求体过大 | 减工具/附件（**不是账号问题**） |
| `1210` | 内容类型不支持（如图片） | 换 `chat-pro` / `chat-flash` |

`40104` 与 `40108` 的区别很重要：前者说明 token 是好的、签名不对；
后者说明身份本身坏了。两者的处置完全不同，别混着重试。
