# 维护者构建与发布

本项目将可公开资源与本机用户数据分开。每次发布须检查**实际产生的安装包**，不能只依赖 `.gitignore` 或源码搜索。

## 环境与构建

使用 macOS 15+、Xcode Command Line Tools、Python 3 与 Node 24+。构建过程不要求登录 Codex，不需要 API Key，也不会使用维护者现有的模型账号。

```sh
npm test
npm run test:native
npm run audit:self-test
npm run audit:source
python3 scripts/package-macos.py --arch arm64
python3 scripts/package-macos.py --arch x86_64
```

`runtime-lock.json` 固定官方 Node、Codex 平台包版本、下载地址和校验值。每次打包都会运行 `scripts/fetch-runtime.py`，重新核验缓存归档字节，再仅提取运行时与许可证；已通过校验的下载不会重复联网获取。不要改成仅信任一份缓存 manifest，或复制本机已安装的可执行文件、登录目录或 npm 缓存。网络中断可重新运行，下载暂存位于 `.cache/runtime/`。

产物保存在 `dist/`，不要提交到源码 Git 历史。`.app` 中仅包含原生程序、生产脚本、角色资源、运行时与许可证，不应包含用户数据、测试报告、构建缓存或 Git 元数据。

## 签名与测试边界

默认构建使用 ad hoc 签名来校验包内容，没有 Developer ID 身份和 Apple 公证。它不能代替系统信任，也不能宣称首次下载完全没有 Gatekeeper 提示。若后续正式签名或公证，应在最终签名完成后重新生成安装包、校验值和审计报告；不要发布已修改而未重新验证的旧产物。

用主机架构匹配的实际包执行离线检查：

```sh
node scripts/smoke-release.mjs --app "dist/arm64/Whale Pet.app" --report "dist/smoke-arm64.json"
node scripts/smoke-release.mjs --app "dist/x86_64/Whale Pet.app" --report "dist/smoke-x86_64.json"
```

脚本不打开 GUI、不登录账号、不发送模型请求、不截图；它使用临时 HOME 和数据目录。主机架构不同的包只做静态检查，报告明确标记 `static-only`，不能当作该架构已经运行验收。实际功能与权限还需在目标 Mac 上测试。不要为了打包测试读取日常实例的聊天、记忆、截图或凭据。

检查各架构的真实 `.app`、ZIP 与 DMG，例如：

```sh
python3 scripts/audit-release.py \
  "dist/arm64/Whale Pet.app" \
  "dist/Whale-Pet-0.1.0-macos-arm64.zip" \
  "dist/Whale-Pet-0.1.0-macos-arm64.dmg"
```

DMG 审计会只读挂载并在结束后卸载。审计器只报告路径、行号和类别，不输出命中的秘密。任何未检查内容、挂载失败或超限也会导致失败。检查运行时的完整 Node LICENSE、锁定 Codex LICENSE / NOTICE 是否在最终包中。

官方运行时可能包含公开的上游编译路径、测试字符串或与密钥形态相似的普通文本，默认扫描器仍会报告它们。这些命中必须单独分类：重新按 lock 校验官方归档、提取原始二进制，并证明每一候选字符串同样存在于该原件；还要核对签名后的实际应用、ZIP 和 DMG 内容一致。保留原始命中数与对照结果，不要把文件名叫作 `node` / `codex` 当成豁免理由，也不要修改官方二进制擦除字串。无法在锁定原件中解释的命中、项目自身内容里的个人信息以及任何未检查内容，仍须阻止发布。报告应分别说明本项目内容与上游原件的结论，不能把分类后的结果写成原始全包扫描零命中。

## 干净源码与发布

发布仓库必须使用干净历史。不要把私人仓库、旧提交、工作目录、`.git` 或应用数据直接复制上网。提交前逐项核对 `git diff --cached --stat` 与文件列表；确保没有聊天、记忆、截图、日志、授权文件、个人路径或私人服务器配置。GitHub 仓库所有者和提交署名本来就是公开信息，使用维护者明确选择的公开身份。

在所有改动已提交、工作区已核对后生成源码包：

```sh
git archive --format=zip --prefix=whale-pet-desktop-0.1.0/ \
  --output=dist/Whale-Pet-0.1.0-source.zip HEAD
python3 scripts/audit-release.py dist/Whale-Pet-0.1.0-source.zip
```

源代码包也要实际扫描。不要对开发根目录无差别扫描并发布：该目录可合法存在不分发的下载缓存与构建缓存。最终以 Git 的明确提交文件列表、源码归档和二进制安装包三者核对。

版本标题、README、包名和 `CFBundleShortVersionString` 应一致。把两种架构的 DMG / ZIP、源码包、SHA-256 清单和不含本机路径的测试说明附在同一个 GitHub Release；Release 描述明确列出未公证、Codex 实验性文字模式、模型服务自备以及跨架构验证边界。发布后重新检查下载链接和文件大小；只有上传成功后才能称为已发布。
