import AppKit
import Foundation

private let proactiveDataRoot = AppPaths.dataRoot

struct ProactivePolicy: Codable, Equatable {
    let enabled: Bool
    let mode: String
    let minIntervalSeconds: Int
    let maxIntervalSeconds: Int
    let dailyAiLimit: Int
    var isValid: Bool {
        ["economy", "ai"].contains(mode) && minIntervalSeconds >= 60 && maxIntervalSeconds >= minIntervalSeconds && maxIntervalSeconds <= 86_400 && (0...10_000).contains(dailyAiLimit)
    }
    var summary: String {
        let interval = "随机 \(minIntervalSeconds / 60)–\(maxIntervalSeconds / 60) 分钟"
        let modeLabel = mode == "ai" ? "每次 AI 生成" : "本地短句＋少量 AI"
        return enabled ? interval + " · " + modeLabel : "主动聊天已暂停"
    }
}

struct ProactiveStatus: Decodable {
    let nextAt: String?
    let aiUsedToday: Int?
    let dailyAiLimit: Int?
    let reason: String?
    let usage: ProactiveUsage?
}

struct ProactiveUsage: Decodable { let totalTokens: Int? }

struct ProactiveMessage: Decodable {
    let id: String
    let at: String?
    let text: String
    let model: String?
    let source: String
}

private struct ProactiveEnvelope: Decodable {
    let policy: ProactivePolicy
    let status: ProactiveStatus?
}

private struct ProactiveInbox: Decodable {
    let messages: [ProactiveMessage]
    let cursor: String?
    let status: ProactiveStatus?
    let policy: ProactivePolicy?
}

private struct ProactivePreview: Decodable {
    let message: ProactiveMessage?
    let messages: [ProactiveMessage]?
    let cursor: String?
    let status: ProactiveStatus?
    let policy: ProactivePolicy?
}

private func proactiveRequest(path: String, body: [String: Any]? = nil) -> URLRequest? {
    guard let data = try? Data(contentsOf: proactiveDataRoot.appendingPathComponent("service.json")),
          let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let token = object["token"] as? String,
          let url = AppPaths.serviceURL(path) else { return nil }
    var request = URLRequest(url: url)
    request.timeoutInterval = path.hasSuffix("preview") ? 75 : 12
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    if let body = body {
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    return request
}

/// Polls local delivery state only. The backend owns all scheduling and model calls.
final class ProactiveInboxClient {
    var onPolicy: ((ProactivePolicy, ProactiveStatus?) -> Void)?
    var onMessage: ((ProactiveMessage) -> Bool)?
    var onCursor: ((String) -> Void)?
    var presence: (() -> (busy: Bool, typing: Bool))?
    private(set) var policy: ProactivePolicy?
    private var cursor: String?
    private var timer: Timer?
    private var request: URLSessionDataTask?
    private var stopped = false
    private var pollCount = 0
    private var generation: UInt64 = 0
    private var presencePending = false

    init(cursor: String?) { self.cursor = cursor }
    func start() {
        guard timer == nil, !stopped else { return }
        let timer = Timer(timeInterval: 20, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        refreshPolicy()
    }
    func shutdown() { stopped = true; timer?.invalidate(); timer = nil; request?.cancel(); request = nil }
    func accept(policy: ProactivePolicy, status: ProactiveStatus?) {
        guard policy.isValid else { return }
        generation &+= 1
        request?.cancel()
        request = nil
        self.policy = policy
        onPolicy?(policy, status)
    }
    @discardableResult
    func acceptPreview(_ message: ProactiveMessage, cursor nextCursor: String?) -> Bool {
        guard onMessage?(message) != false else { return false }
        // Do not advance the inbox cursor to a preview's latest ID: older
        // undelivered messages might precede it. The next inbox read dedupes
        // this preview by its persisted ChatRecord.messageId.
        return true
    }
    func refreshPolicy() { read(path: "/api/proactive-policy", inbox: false) }
    func refreshPresence() {
        guard !stopped else { return }
        presencePending = true
        flushPresence()
    }
    private func flushPresence() {
        guard presencePending, !stopped, request == nil else { return }
        guard policy?.enabled == true else { if policy != nil { presencePending = false }; return }
        presencePending = false
        readInbox()
    }
    func toggleEnabled() {
        guard let policy = policy else { refreshPolicy(); return }
        generation &+= 1
        request?.cancel()
        request = nil
        let value = ProactivePolicy(enabled: !policy.enabled, mode: policy.mode, minIntervalSeconds: policy.minIntervalSeconds, maxIntervalSeconds: policy.maxIntervalSeconds, dailyAiLimit: policy.dailyAiLimit)
        guard let encoded = try? JSONEncoder().encode(value), let body = (try? JSONSerialization.jsonObject(with: encoded)) as? [String: Any], let request = proactiveRequest(path: "/api/proactive-policy", body: body) else { return }
        send(request, inbox: false)
    }
    private func poll() {
        guard !stopped, request == nil else { return }
        pollCount += 1
        // Re-read policy while paused so changes made in settings or another
        // local surface are picked up without creating a model heartbeat.
        guard policy?.enabled == true else { refreshPolicy(); return }
        if pollCount % 3 == 0 { refreshPolicy(); return }
        readInbox()
    }
    private func readInbox() {
        var parts = URLComponents()
        let state = presence?() ?? (busy: false, typing: false)
        var query = [URLQueryItem(name: "uiBusy", value: state.busy ? "1" : "0"), URLQueryItem(name: "typing", value: state.typing ? "1" : "0")]
        if let cursor = cursor { query.append(URLQueryItem(name: "after", value: cursor)) }
        parts.queryItems = query
        read(path: "/api/proactive/inbox" + (parts.string ?? ""), inbox: true)
    }
    private func read(path: String, inbox: Bool) {
        guard !stopped, request == nil, let request = proactiveRequest(path: path) else { return }
        send(request, inbox: inbox)
    }
    private func updateCursor(_ next: String?) {
        guard let next = next, !next.isEmpty, next.count <= 200, next != cursor else { return }
        cursor = next
        onCursor?(next)
    }
    private func send(_ value: URLRequest, inbox: Bool) {
        generation &+= 1
        let generation = generation
        request = URLSession.shared.dataTask(with: value) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, !self.stopped, self.generation == generation else { return }
                self.request = nil
                defer { self.flushPresence() }
                guard error == nil, let data = data, let response = response as? HTTPURLResponse, response.statusCode == 200 else { return }
                if inbox {
                    guard let envelope = try? JSONDecoder().decode(ProactiveInbox.self, from: data) else { return }
                    if let policy = envelope.policy { self.accept(policy: policy, status: envelope.status) }
                    var delivered = true
                    for message in envelope.messages where delivered { delivered = self.onMessage?(message) != false }
                    if delivered { self.updateCursor(envelope.cursor) }
                } else {
                    guard let envelope = try? JSONDecoder().decode(ProactiveEnvelope.self, from: data), envelope.policy.isValid else { return }
                    let wasUnknown = self.policy == nil
                    self.accept(policy: envelope.policy, status: envelope.status)
                    if wasUnknown && envelope.policy.enabled { self.readInbox() }
                }
            }
        }
        request?.resume()
    }
}

final class ProactiveSettingsController: NSObject, NSWindowDelegate {
    let window = ChatPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 540), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    var onPolicyChanged: ((ProactivePolicy, ProactiveStatus?) -> Void)?
    var onPreview: ((ProactiveMessage, String?) -> Bool)?
    private let enabled = NSButton(checkboxWithTitle: "让大肥鱼主动来聊天", target: nil, action: nil)
    private let mode = NSPopUpButton()
    private let minInput = NSTextField()
    private let maxInput = NSTextField()
    private let dailyInput = NSTextField()
    private let status = NSTextField(wrappingLabelWithString: "正在读取本机主动聊天设置…")
    private let saveButton = NSButton(title: "保存设置", target: nil, action: nil)
    private let refreshButton = NSButton(title: "重新读取", target: nil, action: nil)
    private let previewButton = NSButton(title: "试着说一句", target: nil, action: nil)
    private var loaded: ProactivePolicy?
    private var request: URLSessionDataTask?
    private var stopped = false

    override init() {
        super.init()
        window.title = "大肥鱼 · 主动聊天"
        window.minSize = NSSize(width: 460, height: 550)
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.delegate = self
        let root = NSView(); window.contentView = root
        let title = NSTextField(labelWithString: "让大肥鱼偶尔来找你")
        title.font = .systemFont(ofSize: 18, weight: .semibold)
        let note = NSTextField(wrappingLabelWithString: "每次从区间内重新抽取等待时间，用角色旁的气泡说话，不抢焦点。主动消息不截图；每次 AI 生成都会使用所选 AI 服务的额度。暂停后停止后续主动消息。")
        note.font = .systemFont(ofSize: 12); note.textColor = .secondaryLabelColor
        mode.addItems(withTitles: ["每次由 AI 生成", "省额度：本地短句＋少量 AI"])
        mode.setAccessibilityLabel("主动聊天生成方式")
        minInput.setAccessibilityLabel("主动聊天最短间隔分钟")
        maxInput.setAccessibilityLabel("主动聊天最长间隔分钟")
        dailyInput.setAccessibilityLabel("主动聊天每日AI次数上限")
        let modeRow = makeRow("生成方式", field: mode)
        let minRow = makeRow("最短间隔（分钟）", field: minInput)
        let maxRow = makeRow("最长间隔（分钟）", field: maxInput)
        let dailyRow = makeRow("每日 AI 最多（次）", field: dailyInput)
        let help = NSTextField(wrappingLabelWithString: "间隔至少 1 分钟；每日 AI 次数填 0 表示不限。输入或忙碌时跳过本次互动。预算只暂停主动互动；你发起的聊天和本地提醒照常。查看设置不调用模型。")
        help.font = .systemFont(ofSize: 11); help.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: 12); status.textColor = .secondaryLabelColor
        for (button, selector) in [(saveButton, #selector(save(_:))), (refreshButton, #selector(refresh(_:))), (previewButton, #selector(preview(_:)))] { button.target = self; button.action = selector; button.bezelStyle = .rounded }
        let buttons = NSStackView(views: [saveButton, refreshButton, previewButton]); buttons.spacing = 8; buttons.distribution = .fillEqually
        let stack = NSStackView(views: [title, note, enabled, modeRow, minRow, maxRow, dailyRow, help, status, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10; stack.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18), stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 18), stack.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor, constant: -18),
        ])
        for view in [note, modeRow, minRow, maxRow, dailyRow, help, status, buttons] { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        updateControls()
    }
    private func makeRow(_ title: String, field: NSView) -> NSStackView {
        let label = NSTextField(labelWithString: title); label.font = .systemFont(ofSize: 13); label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        if let input = field as? NSTextField { input.alignment = .right; input.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular); input.widthAnchor.constraint(equalToConstant: 90).isActive = true }
        let row = NSStackView(views: [label, field]); row.spacing = 12; row.alignment = .centerY; return row
    }
    func show(near pet: NSWindow?) { if !window.isVisible { window.center() }; NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil); refresh(nil) }
    func shutdown() { stopped = true; request?.cancel(); request = nil }
    func windowShouldClose(_ sender: NSWindow) -> Bool { window.orderOut(nil); return false }
    private func updateControls() {
        let ready = !stopped && request == nil && loaded != nil
        for control in [enabled, mode, minInput, maxInput, dailyInput, saveButton, previewButton] { control.isEnabled = ready }
        refreshButton.isEnabled = !stopped && request == nil
    }
    private func accept(policy: ProactivePolicy, current: ProactiveStatus?, saved: Bool) {
        guard policy.isValid else { loaded = nil; showError("本机主动聊天设置超出可用范围。"); return }
        loaded = policy; enabled.state = policy.enabled ? .on : .off; mode.selectItem(at: policy.mode == "ai" ? 0 : 1)
        minInput.stringValue = String(policy.minIntervalSeconds / 60); maxInput.stringValue = String(policy.maxIntervalSeconds / 60); dailyInput.stringValue = String(policy.dailyAiLimit)
        let used = current?.aiUsedToday.map { " · 今日 AI 尝试 \($0) 次" } ?? ""
        let tokens = current?.usage?.totalTokens.map { " · 已报告 \($0) tokens" } ?? ""
        let next = current?.nextAt.flatMap(Self.shortTime).map { " · 下次约 " + $0 } ?? ""
        let reasons = ["token_budget": "今日 token 阈值已达，主动互动暂停", "usage_unknown": "有调用缺少完整用量，主动互动暂停", "usage_unavailable": "用量记录暂不可读取，主动互动暂停"]
        let reason = current?.reason.flatMap { reasons[$0] }.map { " · " + $0 } ?? ""
        status.stringValue = (saved ? "已保存 · " : "") + policy.summary + reason + used + tokens + next
        status.textColor = .secondaryLabelColor; updateControls(); onPolicyChanged?(policy, current)
    }
    private func showError(_ message: String) { status.stringValue = message; status.textColor = .systemRed; updateControls() }
    private static func shortTime(_ raw: String) -> String? {
        let input = ISO8601DateFormatter(); input.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = input.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) else { return nil }
        let output = DateFormatter(); output.dateFormat = "HH:mm:ss"; return output.string(from: date)
    }
    @objc private func refresh(_ sender: Any?) { guard request == nil else { return }; loaded = nil; perform(path: "/api/proactive-policy", body: nil) }
    @objc private func save(_ sender: Any?) {
        guard loaded != nil, request == nil else { return }
        guard let minimum = Int(minInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)), let maximum = Int(maxInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)), (1...1440).contains(minimum), (minimum...1440).contains(maximum), let daily = Int(dailyInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)), (0...10000).contains(daily) else { showError("请填写整数：最短1–1440分钟，最长不少于最短且不超过1440分钟，每日AI次数0–10000。"); return }
        perform(path: "/api/proactive-policy", body: ["enabled": enabled.state == .on, "mode": mode.indexOfSelectedItem == 0 ? "ai" : "economy", "minIntervalSeconds": minimum * 60, "maxIntervalSeconds": maximum * 60, "dailyAiLimit": daily])
    }
    @objc private func preview(_ sender: Any?) { guard loaded != nil, request == nil else { return }; perform(path: "/api/proactive/preview", body: [:]) }
    private func perform(path: String, body: [String: Any]?) {
        guard !stopped, request == nil, let value = proactiveRequest(path: path, body: body) else { showError("本机服务未准备好，请重新读取。"); return }
        status.stringValue = path.hasSuffix("preview") ? "正在生成一句主动消息…" : body == nil ? "正在读取本机设置…" : "正在保存…"
        request = URLSession.shared.dataTask(with: value) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, !self.stopped else { return }; self.request = nil; self.updateControls()
                guard error == nil, let data = data, let response = response as? HTTPURLResponse else { self.loaded = nil; self.showError("未确认操作结果，请重新读取后核对。"); return }
                guard (200..<300).contains(response.statusCode) else {
                    let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                    self.showError(object?["error"] as? String ?? "主动聊天服务暂不可用。"); return
                }
                if path.hasSuffix("preview") {
                    guard let envelope = try? JSONDecoder().decode(ProactivePreview.self, from: data) else { self.showError("无法读取预览结果，请稍后刷新。"); return }
                    if let policy = envelope.policy { self.accept(policy: policy, current: envelope.status, saved: false) }
                    let messages = envelope.messages ?? envelope.message.map { [$0] } ?? []
                    var delivered = true
                    for (index, message) in messages.enumerated() where delivered { delivered = self.onPreview?(message, index == messages.count - 1 ? envelope.cursor : nil) != false }
                    self.status.stringValue = messages.isEmpty ? "本次未生成消息，请查看服务状态后重试。" : delivered ? "预览消息已加入聊天记录；输入中时不弹气泡。" : "消息尚未保存到聊天记录，将在下次同步时重试。"
                } else {
                    guard let envelope = try? JSONDecoder().decode(ProactiveEnvelope.self, from: data) else { self.loaded = nil; self.showError("无法读取服务返回的设置。"); return }
                    self.accept(policy: envelope.policy, current: envelope.status, saved: body != nil)
                }
            }
        }
        updateControls(); request?.resume()
    }
}
