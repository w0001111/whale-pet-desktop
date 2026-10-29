import AppKit
import Foundation

/// Connection setup is explicit. Saving settings and polling login never invoke a model.
final class SetupWindowController: NSObject, NSWindowDelegate {
    let window = ChatPanel(contentRect: NSRect(x: 0, y: 0, width: 590, height: 630),
                           styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    private let titleLabel = NSTextField(labelWithString: "连接你自己的 AI")
    private let mode = NSSegmentedControl(labels: ["离线桌宠", "Codex 账号", "API 兼容服务"], trackingMode: .selectOne, target: nil, action: nil)
    private let offlinePane = NSStackView()
    private let codexPane = NSStackView()
    private let apiPane = NSStackView()
    private let model = NSTextField()
    private let apiFormat = NSPopUpButton()
    private let baseURL = NSTextField()
    private let apiKey = NSSecureTextField()
    private let cliPath = NSTextField()
    private let codexStatus = NSTextField(wrappingLabelWithString: "尚未读取 Codex 状态")
    private let status = NSTextField(wrappingLabelWithString: "桌宠动作、拖动和本地提醒可以离线使用。")
    private let save = NSButton(title: "保存连接设置", target: nil, action: nil)
    private let test = NSButton(title: "测试连接", target: nil, action: nil)
    private let login = NSButton(title: "在官方页面登录 Codex", target: nil, action: nil)
    private let cancelLogin = NSButton(title: "取消登录", target: nil, action: nil)
    private let logout = NSButton(title: "退出本应用的 Codex 账号", target: nil, action: nil)
    private let clearKey = NSButton(title: "删除已保存的 API Key", target: nil, action: nil)
    private let refreshButton = NSButton(title: "刷新状态", target: nil, action: nil)
    private var controls: [NSControl] = []
    private var request: URLSessionDataTask?
    private var timer: Timer?
    private var busy = false
    private var stopped = false
    private var loginPending = false
    private var loginID: String?
    private var openedAuthURL: String?
    private var mayOpenLoginPage = false
    private var hasKey = false
    private var configured = false
    private var didLoadConfig = false
    private var generation = 0

    override init() {
        super.init()
        window.title = "Whale Pet · AI 连接设置"
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.delegate = self
        buildUI()
    }

    private func label(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 12)
        label.textColor = .secondaryLabelColor
        return label
    }

    private func fieldRow(_ text: String, _ control: NSView) -> NSStackView {
        let caption = NSTextField(labelWithString: text)
        caption.font = .systemFont(ofSize: 12)
        caption.widthAnchor.constraint(equalToConstant: 83).isActive = true
        control.setContentHuggingPriority(.defaultLow, for: .horizontal)
        control.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = NSStackView(views: [caption, control])
        row.orientation = .horizontal; row.alignment = .centerY; row.spacing = 8
        return row
    }

    private func buildUI() {
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        let intro = label("先把大肥鱼放到桌面上。聊天、网页任务和 AI 陪伴可稍后连接；默认不主动调用 AI，截图默认关闭。")
        mode.selectedSegment = 0
        mode.target = self; mode.action = #selector(changeMode(_:))
        for pane in [offlinePane, codexPane, apiPane] { pane.orientation = .vertical; pane.alignment = .leading; pane.spacing = 10 }
        offlinePane.addArrangedSubview(label("离线也能拖动、漫游、挥手、播放动作，使用本地提醒与待办。离线模式不发送聊天到 AI。以后可随时从菜单栏的“AI 连接设置”启用。"))
        cliPath.placeholderString = "留空使用应用附带的官方 Codex CLI"
        cliPath.setAccessibilityLabel("可选 Codex CLI 路径")
        let cliRow = fieldRow("CLI 路径", cliPath)
        codexPane.addArrangedSubview(label("官方 Codex 登录：隔离只读受限模式（实验），仅支持文字。工具尝试会中断，首版不上传截图；账号授权保存在本应用的独立配置中。"))
        codexPane.addArrangedSubview(cliRow)
        codexStatus.font = .systemFont(ofSize: 12)
        codexStatus.maximumNumberOfLines = 3
        codexPane.addArrangedSubview(codexStatus)
        login.target = self; login.action = #selector(beginLogin(_:))
        cancelLogin.target = self; cancelLogin.action = #selector(cancelAuthorization(_:))
        logout.target = self; logout.action = #selector(logoutCodex(_:))
        let loginRow = NSStackView(views: [login, cancelLogin]); loginRow.spacing = 8
        codexPane.addArrangedSubview(loginRow); codexPane.addArrangedSubview(logout)
        apiFormat.addItems(withTitles: ["Responses", "Chat Completions"])
        apiFormat.setAccessibilityLabel("API 协议")
        baseURL.placeholderString = "例如 https://api.openai.com/v1"
        baseURL.setAccessibilityLabel("API Base URL")
        apiKey.placeholderString = "输入 API Key；保存后不会回显"
        apiKey.setAccessibilityLabel("API Key")
        apiKey.isAutomaticTextCompletionEnabled = false
        let formatRow = fieldRow("API 协议", apiFormat)
        let urlRow = fieldRow("Base URL", baseURL)
        let keyRow = fieldRow("API Key", apiKey)
        apiPane.addArrangedSubview(label("填写兼容服务的地址、模型和你自己的 Key。API 视觉模型可识别聊天时显式附带的截图；保存不调用模型，只有“测试连接”发送一次小请求。Key 保存后不会回显。"))
        for row in [formatRow, urlRow, keyRow] { apiPane.addArrangedSubview(row) }
        clearKey.target = self; clearKey.action = #selector(deleteKey(_:))
        apiPane.addArrangedSubview(clearKey)
        model.placeholderString = "API 模式必填；Codex 模式留空使用默认模型"
        model.setAccessibilityLabel("AI 模型")
        let modelRow = fieldRow("模型", model)
        save.target = self; save.action = #selector(saveConfiguration(_:))
        test.target = self; test.action = #selector(testConnection(_:))
        refreshButton.target = self; refreshButton.action = #selector(refresh(_:))
        let buttons = NSStackView(views: [save, test, refreshButton]); buttons.spacing = 9
        let later = NSButton(title: "先离线使用", target: self, action: #selector(useOffline(_:)))
        later.bezelStyle = .inline
        status.font = .systemFont(ofSize: 12); status.maximumNumberOfLines = 4
        let storage = label("本机数据目录：" + AppPaths.dataRoot.path)
        storage.maximumNumberOfLines = 2; storage.toolTip = AppPaths.dataRoot.path
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .vertical)
        let root = NSStackView(views: [titleLabel, intro, mode, offlinePane, codexPane, apiPane,
                                       modelRow, buttons, status, spacer, storage, later])
        root.orientation = .vertical; root.alignment = .leading; root.spacing = 13
        root.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView(); window.contentView = content; content.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
            root.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -22),
            root.topAnchor.constraint(equalTo: content.topAnchor, constant: 22),
            root.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18),
            spacer.heightAnchor.constraint(greaterThanOrEqualToConstant: 0)
        ])
        let full: [NSView] = [intro, offlinePane, codexPane, apiPane, modelRow, status, storage]
        for view in full { view.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true }
        for pane in [offlinePane, codexPane, apiPane] {
            for child in pane.arrangedSubviews where child is NSTextField || child is NSStackView {
                child.widthAnchor.constraint(equalTo: pane.widthAnchor).isActive = true
            }
        }
        controls = [mode, model, apiFormat, baseURL, apiKey, cliPath, save, test, login, cancelLogin, logout, clearKey, refreshButton, later]
        for control in controls.compactMap({ $0 as? NSButton }) { if control !== later { control.bezelStyle = .rounded } }
        updateMode()
    }

    func show(firstLaunch: Bool) {
        titleLabel.stringValue = firstLaunch ? "欢迎，先让大肥鱼住到桌面上" : "连接你自己的 AI"
        if !window.isVisible { window.center() }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        refresh(nil)
    }

    func shutdown() { stopped = true; generation += 1; timer?.invalidate(); request?.cancel(); apiKey.stringValue = "" }
    func windowShouldClose(_ sender: NSWindow) -> Bool { markOnboardingSeen(); sender.orderOut(nil); schedulePoll(); return false }

    private func markOnboardingSeen() {
        do {
            try AppPaths.prepareDataDirectory()
            let data = try JSONSerialization.data(withJSONObject: ["seen": true, "version": 1])
            try data.write(to: AppPaths.setupFile, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: AppPaths.setupFile.path)
        } catch { status.stringValue = "设置引导状态未能保存；桌宠仍可使用。" }
    }

    @objc private func changeMode(_ sender: Any?) { model.stringValue = ""; updateMode() }
    private func updateMode() {
        offlinePane.isHidden = mode.selectedSegment != 0
        codexPane.isHidden = mode.selectedSegment != 1
        apiPane.isHidden = mode.selectedSegment != 2
        updateControls()
    }
    private func updateControls() {
        for control in controls { control.isEnabled = !busy && !stopped }
        test.isEnabled = !busy && configured
        cancelLogin.isEnabled = !busy && loginPending
        logout.isEnabled = !busy && didLoadConfig
        clearKey.isEnabled = !busy && hasKey
    }

    private func schedulePoll() {
        timer?.invalidate(); timer = nil
        guard !stopped, loginPending || (window.isVisible && !didLoadConfig) else { return }
        timer = Timer.scheduledTimer(withTimeInterval: loginPending ? 2 : 3, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            if self.loginPending { self.pollLogin() } else { self.refresh(nil) }
        }
    }

    @objc private func refresh(_ sender: Any?) {
        perform("/api/config") { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let object): self.applyConfig(object)
            case .failure(let error): self.showError(error)
            }
            self.schedulePoll()
        }
    }

    private func applyConfig(_ object: [String: Any]) {
        let config = object["config"] as? [String: Any] ?? object
        let currentMode = config["mode"] as? String ?? "none"
        mode.selectedSegment = currentMode == "codex" ? 1 : currentMode == "api" ? 2 : 0
        model.stringValue = config["model"] as? String ?? ""
        let api = config["api"] as? [String: Any] ?? [:]
        baseURL.stringValue = api["baseURL"] as? String ?? ""
        apiFormat.selectItem(at: api["format"] as? String == "chat-completions" ? 1 : 0)
        hasKey = api["hasKey"] as? Bool == true
        apiKey.stringValue = ""
        apiKey.placeholderString = hasKey ? "同一服务留空保留；换服务须重填 Key" : "输入 API Key；保存后不会回显"
        let codex = config["codex"] as? [String: Any] ?? [:]
        cliPath.stringValue = codex["cliPath"] as? String ?? ""
        loginPending = codex["loginPending"] as? Bool == true
        let available = codex["available"] as? Bool == true
        let authenticated = codex["authenticated"] as? Bool == true
        if authenticated {
            codexStatus.stringValue = codex["restrictedModeVerified"] as? Bool == true
                ? "已授权 · 隔离只读受限模式（实验）· 仅文字，首版不支持截图。"
                : "本应用账号已授权，但当前 CLI 尚未通过受限模式兼容检查，AI 尚未启用。"
        } else {
            codexStatus.stringValue = codex["message"] as? String ?? (loginPending ? "正在等待官方页面授权…" : available ? "官方 Codex CLI 已准备好，可点击登录。" : "未找到可用的官方 Codex CLI；可填写 CLI 路径或改用 API。")
        }
        configured = config["configured"] as? Bool == true
        didLoadConfig = true
        status.stringValue = configured ? "连接配置已保存。发消息和执行任务时才会使用 AI；测试连接需你主动点击。" : "当前可离线玩桌宠。聊天前请先完成连接并保存。"
        updateMode()
    }

    private func configuration() -> [String: Any]? {
        let modes = ["none", "codex", "api"]
        var body: [String: Any] = ["mode": modes[max(0, mode.selectedSegment)]]
        let modelName = model.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !modelName.isEmpty { body["model"] = modelName }
        if mode.selectedSegment == 1 {
            body["codex"] = ["cliPath": cliPath.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)]
        }
        if mode.selectedSegment == 2 {
            let raw = baseURL.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = URLComponents(string: raw), ["http", "https"].contains(url.scheme ?? ""), url.host != nil, url.user == nil, url.password == nil else {
                status.stringValue = "请填写完整的 http:// 或 https:// Base URL，且地址中不要包含账号或 Key。"; return nil
            }
            guard !modelName.isEmpty else { status.stringValue = "API 模式需要填写模型名称。"; return nil }
            guard hasKey || !apiKey.stringValue.isEmpty else { status.stringValue = "请填写你自己的 API Key。"; return nil }
            var api: [String: Any] = ["format": apiFormat.indexOfSelectedItem == 1 ? "chat-completions" : "responses", "baseURL": raw]
            if !apiKey.stringValue.isEmpty { api["apiKey"] = apiKey.stringValue }
            body["api"] = api
        }
        return body
    }

    @objc private func saveConfiguration(_ sender: Any?) {
        guard let body = configuration() else { return }
        perform("/api/config", body: body) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let object): self.apiKey.stringValue = ""; self.markOnboardingSeen(); self.applyConfig(object)
            case .failure(let error): self.showError(error)
            }
        }
    }

    @objc private func useOffline(_ sender: Any?) {
        mode.selectedSegment = 0; updateMode()
        perform("/api/config", body: ["mode": "none"]) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let object): self.applyConfig(object); self.markOnboardingSeen(); self.window.orderOut(nil)
            case .failure(let error):
                self.status.stringValue = "桌宠仍可离线玩，但离线设置尚未保存：" + error.localizedDescription
            }
        }
    }

    @objc private func testConnection(_ sender: Any?) {
        status.stringValue = "正在发送一条小请求测试已保存的连接…"
        perform("/api/config/test", body: [:], timeout: 60) { [weak self] result in
            switch result {
            case .success(let object): self?.status.stringValue = (object["ok"] as? Bool == true ? "测试成功：" : "测试未通过：") + (object["message"] as? String ?? "连接测试已返回。")
            case .failure(let error): self?.showError(error)
            }
        }
    }

    @objc private func deleteKey(_ sender: Any?) {
        perform("/api/config", body: ["api": ["clearKey": true]]) { [weak self] result in
            switch result {
            case .success(let object): self?.applyConfig(object)
            case .failure(let error): self?.showError(error)
            }
        }
    }

    @objc private func beginLogin(_ sender: Any?) {
        mayOpenLoginPage = true
        if loginPending { pollLogin(); return }
        let path = cliPath.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        perform("/api/config", body: ["mode": "codex", "codex": ["cliPath": path]]) { [weak self] result in
            guard let self = self else { return }
            if case .failure(let error) = result { self.showError(error); return }
            self.perform("/api/codex/login", body: [:], timeout: 20) { [weak self] result in
                guard let self = self else { return }
                switch result {
                case .success(let object):
                    self.loginID = object["loginId"] as? String
                    self.loginPending = true
                    self.presentAuthorizationPage(object)
                    self.status.stringValue = "请在官方页面完成你自己的账号授权；本窗口只检查登录状态。" + ((object["userCode"] as? String).map { " 授权码：" + $0 } ?? "")
                    self.updateControls(); self.schedulePoll()
                case .failure(let error): self.showError(error)
                }
            }
        }
    }

    private func pollLogin() {
        perform("/api/codex/status") { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let object):
                let codex = object["codex"] as? [String: Any] ?? object
                self.presentAuthorizationPage(codex)
                let authenticated = codex["authenticated"] as? Bool == true
                self.loginPending = codex["loginPending"] as? Bool == true || codex["status"] as? String == "pending"
                if authenticated { self.loginPending = false; self.mayOpenLoginPage = false; self.markOnboardingSeen(); self.refresh(nil) }
                else if !self.loginPending { self.codexStatus.stringValue = codex["message"] as? String ?? "登录尚未完成。可重新点击登录。" }
                self.updateControls()
            case .failure(let error): self.showError(error)
            }
            self.schedulePoll()
        }
    }

    @objc private func cancelAuthorization(_ sender: Any?) {
        mayOpenLoginPage = false
        var body: [String: Any] = [:]; if let id = loginID { body["loginId"] = id }
        perform("/api/codex/login/cancel", body: body) { [weak self] result in
            if case .failure(let error) = result { self?.showError(error); return }
            self?.loginPending = false; self?.refresh(nil)
        }
    }

    @objc private func logoutCodex(_ sender: Any?) {
        mayOpenLoginPage = false
        perform("/api/codex/logout", body: [:]) { [weak self] result in
            if case .failure(let error) = result { self?.showError(error); return }
            self?.loginPending = false; self?.refresh(nil)
        }
    }

    private func showError(_ error: Error) {
        status.stringValue = "连接设置未完成：" + error.localizedDescription
        status.toolTip = status.stringValue
        schedulePoll()
    }

    private func presentAuthorizationPage(_ object: [String: Any]) {
        guard mayOpenLoginPage, let raw = object["authUrl"] as? String, raw != openedAuthURL,
              let url = URL(string: raw), url.scheme == "https" else { return }
        openedAuthURL = raw
        NSWorkspace.shared.open(url)
    }

#if WHALE_SETUP_TEST
    func applyProbeConfiguration(_ object: [String: Any]) { applyConfig(object) }
#endif

    private func perform(_ route: String, body: [String: Any]? = nil, timeout: TimeInterval = 12,
                         completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard !busy, !stopped else { return }
        guard let url = AppPaths.serviceURL(route), let token = AppPaths.serviceToken() else {
            completion(.failure(NSError(domain: "WhaleSetup", code: 1, userInfo: [NSLocalizedDescriptionKey: "本机服务尚未准备好。桌宠可离线使用，稍后可点刷新。"])))
            return
        }
        var outgoing = URLRequest(url: url); outgoing.timeoutInterval = timeout; outgoing.cachePolicy = .reloadIgnoringLocalCacheData
        outgoing.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body = body {
            outgoing.httpMethod = "POST"; outgoing.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do { outgoing.httpBody = try JSONSerialization.data(withJSONObject: body) } catch { completion(.failure(error)); return }
        }
        busy = true; updateControls(); let currentGeneration = generation
        request = URLSession.shared.dataTask(with: outgoing) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, !self.stopped, self.generation == currentGeneration else { return }
                self.busy = false; self.request = nil; self.updateControls()
                if let error = error { completion(.failure(error)); return }
                let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                    let message = object["error"] as? String ?? (object["error"] as? [String: Any])?["message"] as? String ?? "本机服务没有返回有效配置。"
                    completion(.failure(NSError(domain: "WhaleSetup", code: (response as? HTTPURLResponse)?.statusCode ?? 0, userInfo: [NSLocalizedDescriptionKey: message])))
                    return
                }
                completion(.success(object))
            }
        }
        request?.resume()
    }
}
