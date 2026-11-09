# Windows 兼容实现与验证

目标：Windows 用户继续通过已登录的 TeleAgent 桌面端接入 magpie，无需复制 token，
并修复 0.1.2 的空账号占位符和积分刷新误判登录问题。

实现选择：复用系统自带 PowerShell/.NET 的 CurrentUser DPAPI 解锁桌面端密钥，
在 Node/Bun 内完成 AES-256-GCM 解密。相比打包 Electron 或新增本地二进制依赖，
此方案保留插件轻量分发；敏感数据只通过子进程 stdin/stdout 传递，不放进命令行或日志。

## 实现

- 统一使用系统用户主目录；保留 TeleAgent 自己的 `.local/share/TeleAgent` 布局及目录覆盖。
- 识别 Windows/macOS 安装资源，支持 `TELEAGENT_APP_PATH`，从 ASAR 读取版本和网关配置。
- Windows token：从 `Local State` 读取 DPAPI 包装的密钥，验证 v10 AES-GCM 布局并解密。
- 积分：使用运行时内置 SQLite，处理 WAL 快照、账号分区、Network/Cookies 及 Windows 加密 cookie。
- GitHub Actions 在 Windows/macOS 上运行离线测试；Windows 上额外运行真实的 DPAPI 系统调用测试。

## 验证边界

凭据必须属于运行插件的同一个 Windows 系统用户；DPAPI 失败时不尝试其他账号或明文降级。
未知加密版本明确失败。模型 JWT 与积分 cookie 的状态相互独立。
CI 使用合成凭据，不访问真实 TeleAgent 账号，也不发送真实模型请求。
CI 可以验证 Windows 系统解密和文件链路，不能代替安装了 TeleAgent 的机器上的完整用户验收。

格式依据：TeleAgent 2.7.1 安装包及其 Electron 43.1.0；
[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)、
[Electron 43.1.0 的 Chromium OSCrypt 同步后端](https://github.com/electron/electron/blob/v43.1.0/patches/chromium/revert_oscrypt_remove_sync_backend.patch)。
