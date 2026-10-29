Windows 首个公开测试版，目标为 **Windows 11 x64**。

提供原生 WPF 桌面界面、可安装 EXE 与便携 ZIP，内置所需 .NET、Node24.22.2 和官方 Codex CLI0.164.0。无需另外安装 Harness 或开发环境。

支持透明桌宠、拖动、二维自动散步、8个动作片段、气泡直接回复、聊天历史与最新定位、本地记忆、提醒与待办、用量面板、陪伴偏好/勿扰/退让、可选主动消息和手动只读网页任务。提供离线、Codex 账号和兼容 Responses / Chat Completions API 三种连接方式。

**首版不提供 Windows 前台应用信息或屏幕截图**，不会读取窗口标题或屏幕内容。主动 AI 默认关闭。Codex 为实验性受限文字模式，真实账号权限和额度由官方账号决定；API 使用自己的地址、模型和Key，按对应服务计费。

使用安装版时运行 `*-setup.exe`；便携版须完整解压后打开 `WhalePet.exe`。默认数据保存在 `%LOCALAPPDATA%\WhalePet`，与程序分离，更新/卸载保留用户数据。完整说明见仓库 `docs/INSTALL.windows.zh-CN.md`。

本版未使用 Windows Authenticode 证书签名，可能出现未知发布者或 SmartScreen 提示。请核对来源与 SHA-256；不需要关闭系统防护。

构建、离线服务、空 HOME Codex 协议、原生合成渲染、安装 payload 和隐私来源核对结果见附带报告。CI 上的 Windows Server 运行与合成 UI 检查不能代替普通 Windows 11 用户环境中对鼠标、多屏缩放、真实模型和系统策略的验收。未执行真实账号登录、模型生成或屏幕采集。

Mac 稳定版继续使用 `v0.1.0` 的安装包；本测试版只新增 Windows 发行资产。项目为独立开源桌宠，与 OpenAI、DeepSeek 没有官方隶属关系。
