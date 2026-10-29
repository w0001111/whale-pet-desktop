# Windows 发行包审计

Windows CI 在打包和隔离验证后运行 `python scripts/audit-windows.py`。完整报告位于 `build/windows-validation/audit-windows.json`；只有报告的 `pass` 为 `true` 才表示该次审计通过。

脚本逐文件核对实际发行目录、manifest、portable ZIP 表及解压字节；重新校验锁定的 Node/Codex 官方归档并提取原件，核对包内字节。微软自包含运行库须匹配指定版本 NuGet 原包中的文件；脚本校验 `.nupkg.sha512`，并在 `dotnet` 可用时执行真实的 `dotnet nuget verify --all` 签名验证。

CI 在打包前先运行 `--nuget-preflight`，使用在线证书撤销检查和仓库指定的 NuGet 配置。隔离证书环境验证失败时，仅在 GitHub 托管的 Windows 构建机上允许对比该次构建的证书缓存与网络环境；必须取得真实验签成功，且包的哈希一致。报告保留每次验证的环境类别、退出码和 NuGet 错误码；不会使用离线模式、忽略签名错误或公开原始环境变量。后续审计会对相同包重新验签，应用安装与诊断仍使用独立临时用户目录。

隐私扫描覆盖实际 payload、应用自身的 EXE/DLL、服务、素材、metadata 和安装器原始字节。上游原件中的原始匹配仍记在 `upstreamRawFindings`；只有字节完全匹配已核对原件的发行文件才能记为 `classifiedUpstream`。应用自身 EXE/DLL 不接受上游豁免。任何未分类匹配都会失败，报告不会把原始匹配描述为零，也不会输出匹配文本、个人目录、SID 或密钥。

安装器还必须在新的临时目录实际静默安装，安装后的 payload 逐文件匹配发行目录，然后用隔离的数据目录运行 `--diagnostics`，最后实际卸载并检查合成用户数据标记仍保留。安装器生成的 `unins000` 文件单独列出，不能替代发行 payload 检查。

这些检查不登录账号、不调用模型、不启动正常 GUI、不截取真实桌面，也不代表用户电脑上的鼠标、多屏、真实额度或截图识别已经验收。`--self-test` 只运行合成完整性与分类测试，不能代替 Windows CI 的安装和运行证据。
