import AppKit
import Foundation

private let screenshotServiceDataRoot = AppPaths.dataRoot

struct ScreenshotPolicy: Decodable, Equatable {
    let minIntervalSeconds: Int
    let dailyLimit: Int

    var isValid: Bool { (0...86_400).contains(minIntervalSeconds) && (0...10_000).contains(dailyLimit) }
    var intervalLabel: String {
        if minIntervalSeconds == 0 { return "每条聊天可附截图" }
        if minIntervalSeconds % 60 == 0 { return "至少间隔 \(minIntervalSeconds / 60) 分钟" }
        return "至少间隔 \(minIntervalSeconds) 秒"
    }
    var dailyLabel: String { dailyLimit == 0 ? "每日不限张数" : "每天最多 \(dailyLimit) 张" }
    var summary: String { intervalLabel + "／" + dailyLabel }
}

private struct ScreenshotPolicyEnvelope: Decodable {
    let policy: ScreenshotPolicy
    let budget: ScreenshotBudgetSummary?
}

private struct ScreenshotBudgetSummary: Decodable {
    let used: Int?
}

/// Only edits the local upload policy. It never captures images or asks for OS permissions.
final class ScreenshotSettingsController: NSObject, NSWindowDelegate, NSTextFieldDelegate {
    let window: ChatPanel
    var onPolicyChanged: ((ScreenshotPolicy) -> Void)?
    private let intervalInput = NSTextField()
    private let dailyInput = NSTextField()
    private let intervalStepper = NSStepper()
    private let dailyStepper = NSStepper()
    private let saveButton = NSButton(title: "保存设置", target: nil, action: nil)
    private let refreshButton = NSButton(title: "重新读取", target: nil, action: nil)
    private let status = NSTextField(wrappingLabelWithString: "正在读取本机截图设置…")
    private var loadedPolicy: ScreenshotPolicy?
    private var loadedMinuteText = ""
    private var intervalEdited = false
    private var request: URLSessionDataTask?
    private var stopped = false

    override init() {
        window = ChatPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 330),
                           styleMask: [.titled, .closable, .resizable, .miniaturizable],
                           backing: .buffered, defer: false)
        super.init()
        window.title = "大肥鱼 · 截图设置"
        window.minSize = NSSize(width: 420, height: 350)
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.delegate = self
        buildUI()
        updateControls()
    }

    private func buildUI() {
        let root = NSView()
        window.contentView = root
        let title = NSTextField(labelWithString: "截图频率由你决定")
        title.font = .systemFont(ofSize: 18, weight: .semibold)
        let note = NSTextField(wrappingLabelWithString: "仍然只在发送聊天时按需附图，不会定时截屏。截图需 API 视觉模型；Codex 首版仅支持文字、不上传截图。更多截图会使用更多额度。保存后立即生效，并在重启后保留。")
        note.font = .systemFont(ofSize: 12)
        note.textColor = .secondaryLabelColor
        let intervalRow = makeRow(title: "最小间隔（分钟）", input: intervalInput, stepper: intervalStepper, maximum: 1_440)
        let dailyRow = makeRow(title: "每日最多（张）", input: dailyInput, stepper: dailyStepper, maximum: 10_000)
        intervalInput.setAccessibilityLabel("截图最小间隔分钟")
        dailyInput.setAccessibilityLabel("截图每日张数上限")
        intervalStepper.setAccessibilityLabel("调整截图间隔")
        dailyStepper.setAccessibilityLabel("调整截图每日上限")
        let help = NSTextField(wrappingLabelWithString: "间隔填 0：每条聊天都可附图。每日张数填 0：不设每日上限。关闭聊天中的截图开关仍可停止附图。")
        help.font = .systemFont(ofSize: 11)
        help.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        saveButton.target = self
        saveButton.action = #selector(save(_:))
        saveButton.bezelStyle = .rounded
        refreshButton.target = self
        refreshButton.action = #selector(refresh(_:))
        refreshButton.bezelStyle = .rounded
        let buttons = NSStackView(views: [saveButton, refreshButton])
        buttons.spacing = 10
        buttons.distribution = .fillEqually
        let stack = NSStackView(views: [title, note, intervalRow, dailyRow, help, status, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: root.bottomAnchor, constant: -18),
            note.widthAnchor.constraint(equalTo: stack.widthAnchor),
            intervalRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            dailyRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            help.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    private func makeRow(title: String, input: NSTextField, stepper: NSStepper, maximum: Double) -> NSStackView {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13)
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        input.delegate = self
        input.alignment = .right
        input.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
        input.widthAnchor.constraint(equalToConstant: 84).isActive = true
        stepper.minValue = 0
        stepper.maxValue = maximum
        stepper.increment = 1
        stepper.valueWraps = false
        stepper.target = self
        stepper.action = #selector(step(_:))
        let row = NSStackView(views: [label, input, stepper])
        row.alignment = .centerY
        row.spacing = 10
        return row
    }

    func show(near pet: NSWindow?) {
        guard !stopped else { return }
        if !window.isVisible { window.center() }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        refresh(nil)
    }
    func shutdown() { stopped = true; request?.cancel(); request = nil }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func controlTextDidChange(_ obj: Notification) {
        if let field = obj.object as? NSTextField, field === intervalInput { intervalEdited = true }
        synchronizeSteppers()
        updateControls()
    }

    private func synchronizeSteppers() {
        if let value = Int(intervalInput.stringValue) { intervalStepper.integerValue = min(1_440, max(0, value)) }
        if let value = Int(dailyInput.stringValue) { dailyStepper.integerValue = min(10_000, max(0, value)) }
    }
    @objc private func step(_ sender: NSStepper) {
        if sender === intervalStepper { intervalInput.stringValue = String(sender.integerValue); intervalEdited = true }
        else { dailyInput.stringValue = String(sender.integerValue) }
        updateControls()
    }
    private func updateControls() {
        let ready = !stopped && request == nil && loadedPolicy != nil
        intervalInput.isEnabled = ready
        dailyInput.isEnabled = ready
        intervalStepper.isEnabled = ready
        dailyStepper.isEnabled = ready
        saveButton.isEnabled = ready
        refreshButton.isEnabled = !stopped && request == nil
    }
    private func showError(_ message: String) {
        status.stringValue = message
        status.textColor = .systemRed
        updateControls()
    }
    private func accept(_ envelope: ScreenshotPolicyEnvelope, saved: Bool) {
        guard envelope.policy.isValid else { loadedPolicy = nil; showError("本机设置超出可用范围，请重新读取。"); return }
        loadedPolicy = envelope.policy
        loadedMinuteText = String(envelope.policy.minIntervalSeconds / 60)
        intervalEdited = false
        intervalInput.stringValue = loadedMinuteText
        dailyInput.stringValue = String(envelope.policy.dailyLimit)
        synchronizeSteppers()
        let prior = saved ? "已保存，立即生效" : "当前设置已读取"
        let used = envelope.budget?.used.map { " · 今日已发送 \($0) 张" } ?? ""
        let precise = envelope.policy.minIntervalSeconds % 60 == 0 ? "" : "；当前精确间隔为 \(envelope.policy.minIntervalSeconds) 秒，修改分钟数后按整分钟保存"
        status.stringValue = prior + " · " + envelope.policy.summary + used + precise
        status.textColor = .secondaryLabelColor
        updateControls()
        onPolicyChanged?(envelope.policy)
    }

    @objc private func refresh(_ sender: Any?) {
        guard request == nil else { return }
        loadedPolicy = nil
        perform(body: nil)
    }
    @objc private func save(_ sender: Any?) {
        guard let loaded = loadedPolicy, request == nil else { return }
        let minuteText = intervalInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let dailyText = dailyInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let minutes = Int(minuteText), (0...1_440).contains(minutes), let daily = Int(dailyText), (0...10_000).contains(daily) else { showError("请填写整数：间隔 0–1440 分钟，每日 0–10000 张；0 表示不设该项限制。"); return }
        // An API-configured sub-minute interval stays exact if the user only
        // changes the daily limit. Explicit minute editing uses minute units.
        let seconds = !intervalEdited && minuteText == loadedMinuteText ? loaded.minIntervalSeconds : minutes * 60
        perform(body: ["minIntervalSeconds": seconds, "dailyLimit": daily])
    }
    private func perform(body: [String: Int]?) {
        guard !stopped, request == nil else { return }
        guard let data = try? Data(contentsOf: screenshotServiceDataRoot.appendingPathComponent("service.json")),
              let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let token = state["token"] as? String,
              let url = AppPaths.serviceURL("/api/screen-policy") else { showError("本机服务未准备好，请稍后重新读取。"); return }
        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = 12
        urlRequest.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body = body {
            urlRequest.httpMethod = "POST"
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        status.stringValue = body == nil ? "正在读取本机截图设置…" : "正在保存截图设置…"
        status.textColor = .secondaryLabelColor
        saveButton.title = body == nil ? "保存设置" : "保存中…"
        request = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, !self.stopped else { return }
                self.request = nil
                self.saveButton.title = "保存设置"
                self.updateControls()
                guard error == nil, let data = data, let response = response as? HTTPURLResponse else {
                    self.loadedPolicy = nil
                    self.showError(body == nil ? "无法读取本机设置，请稍后重新读取。" : "保存结果未确认，请重新读取后核对。")
                    return
                }
                guard (200..<300).contains(response.statusCode) else {
                    let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                    let detail = object?["error"] as? String ?? (object?["error"] as? [String: Any])?["message"] as? String ?? "截图设置暂不可用。"
                    self.showError(detail)
                    return
                }
                do { self.accept(try JSONDecoder().decode(ScreenshotPolicyEnvelope.self, from: data), saved: body != nil) }
                catch { self.loadedPolicy = nil; self.showError("本机返回的设置无法读取，请刷新核对。") }
            }
        }
        updateControls()
        request?.resume()
    }
}
