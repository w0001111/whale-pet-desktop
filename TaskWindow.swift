import AppKit
import Foundation

private struct WhaleTaskEvent: Decodable {
    let at: String?
    let type: String?
    let message: String?
    let url: String?
    let name: String?
    let number: Int?
    let arguments: WhaleTaskArguments?
    let result: WhaleTaskToolResult?
    let isError: Bool?

    var displayMessage: String {
        let tool = name == "search_web" ? "搜索网页" : name == "read_web" ? "读取网页" : (name ?? "网页工具")
        if type == "tool_start" {
            return "开始" + tool + (arguments?.query.map { " · " + $0 } ?? "")
        }
        if type == "tool_end" {
            if isError == true { return tool + "失败：" + (result?.error?.message ?? "工具未完成") }
            return tool + "已返回" + (result?.note.map { " · " + $0 } ?? "")
        }
        if let number = number { return (message ?? type ?? "事件") + "（第 \(number) 次）" }
        return message ?? type ?? "事件"
    }
}

private struct WhaleTaskArguments: Decodable {
    let query: String?
    let url: String?
}

private struct WhaleTaskToolResult: Decodable {
    let error: WhaleTaskError?
    let sourceUrl: String?
    let note: String?
}

private struct WhaleTaskError: Decodable {
    let message: String
    private enum CodingKeys: String, CodingKey { case message }
    init(from decoder: Decoder) throws {
        if let text = try? decoder.singleValueContainer().decode(String.self) { message = text }
        else {
            let object = try decoder.container(keyedBy: CodingKeys.self)
            message = try object.decodeIfPresent(String.self, forKey: .message) ?? "任务返回了未说明原因的错误。"
        }
    }
}

private struct WhaleTaskSource: Decodable {
    let url: String
    let title: String?
    let kind: String?
}

private struct WhaleTaskUsage: Decodable { let totalTokens: Int? }
private struct WhaleTaskLimits: Decodable {
    let durationMs: Int?
    let modelCalls: Int?
    let toolCalls: Int?
    let totalTokens: Int?
}

private struct WhaleTask: Decodable {
    let id: String
    let goal: String
    let status: String
    let createdAt: String?
    let updatedAt: String?
    let modelCalls: Int?
    let toolCalls: Int?
    let events: [WhaleTaskEvent]?
    let result: String?
    let error: WhaleTaskError?
    let sources: [WhaleTaskSource]?
    let usage: WhaleTaskUsage?
    let limits: WhaleTaskLimits?

    var isRunning: Bool { ["queued", "running", "stopping"].contains(status) }
    var statusLabel: String {
        switch status {
        case "queued": return "排队中"
        case "running": return "执行中"
        case "stopping": return "正在停止"
        case "completed": return "已完成"
        case "failed": return "执行失败"
        case "stopped": return "已停止"
        case "interrupted": return "服务重启，任务已中断"
        case "budget_exhausted", "limited": return "已达单次上限"
        default: return status
        }
    }
}

private struct WhaleTaskEnvelope: Decodable { let task: WhaleTask }
private struct WhaleTaskListEnvelope: Decodable { let tasks: [WhaleTask] }

/// A separate, explicitly started, read-only agent task surface. Polling only reads local state.
final class TaskWindowController: NSObject, NSWindowDelegate, NSTextViewDelegate {
    let window: ChatPanel
    private let goalInput = NSTextView()
    private let urlInput = NSTextField()
    private let history = NSPopUpButton()
    private let refreshButton = NSButton(title: "刷新", target: nil, action: nil)
    private let startButton = NSButton(title: "启动任务", target: nil, action: nil)
    private let stopButton = NSButton(title: "停止任务", target: nil, action: nil)
    private let taskStatus = NSTextField(labelWithString: "尚无任务")
    private let counters = NSTextField(labelWithString: "模型 0 / 8 · 工具 0 / 12 · tokens —")
    private let connectionStatus = NSTextField(wrappingLabelWithString: "点击启动后才会使用 所选 AI 服务的额度。")
    private let eventText = NSTextView()
    private let resultText = NSTextView()
    private var tasks: [WhaleTask] = []
    private var selectedTask: WhaleTask?
    private var selectedID: String?
    private var request: URLSessionDataTask?
    private var requestInFlight = false
    private var needsStartReconciliation = false
    private var pollTimer: Timer?
    private var stopped = false
    private var generation = 0

    override init() {
        window = ChatPanel(contentRect: NSRect(x: 0, y: 0, width: 660, height: 790),
                           styleMask: [.titled, .closable, .resizable, .miniaturizable],
                           backing: .buffered, defer: false)
        super.init()
        window.title = "大肥鱼 · 后台任务"
        window.minSize = NSSize(width: 550, height: 760)
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.delegate = self
        buildUI()
        updateControls()
    }

    private var hasRunningTask: Bool { tasks.contains(where: \.isRunning) || selectedTask?.isRunning == true }
    private var isWindowVisible: Bool { window.isVisible && !window.isMiniaturized }

    private func makeScroll(for textView: NSTextView, editable: Bool) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .bezelBorder
        textView.isEditable = editable
        textView.isSelectable = true
        textView.isRichText = false
        textView.font = .systemFont(ofSize: 13)
        textView.textColor = .labelColor
        textView.backgroundColor = .textBackgroundColor
        textView.textContainerInset = NSSize(width: 9, height: 8)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        scroll.documentView = textView
        return scroll
    }

    private func buildUI() {
        let root = NSView()
        window.contentView = root
        let title = NSTextField(labelWithString: "🐋  让大肥鱼查一件事")
        title.font = .systemFont(ofSize: 18, weight: .semibold)
        let note = NSTextField(wrappingLabelWithString: "只读浏览，不发帖或改文件；单次最多 3 分钟 / 8 次模型调用 / 12 次工具。任务在本机服务执行，关掉此窗口可继续；退出大肥鱼会停止服务。")
        note.font = .systemFont(ofSize: 12)
        note.textColor = .secondaryLabelColor
        let goalLabel = NSTextField(labelWithString: "任务目标")
        goalLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        goalInput.delegate = self
        goalInput.setAccessibilityLabel("后台任务目标")
        let goalScroll = makeScroll(for: goalInput, editable: true)
        urlInput.placeholderString = "目标网址（可选，多个网址用空格分隔）"
        urlInput.font = .systemFont(ofSize: 12)
        urlInput.setAccessibilityLabel("可选目标网址")
        startButton.target = self
        startButton.action = #selector(startTask(_:))
        startButton.bezelStyle = .rounded
        stopButton.target = self
        stopButton.action = #selector(stopTask(_:))
        stopButton.bezelStyle = .rounded
        let actionRow = NSStackView(views: [startButton, stopButton])
        actionRow.spacing = 8
        actionRow.alignment = .centerY
        actionRow.distribution = .fillEqually
        history.target = self
        history.action = #selector(selectHistory(_:))
        history.setAccessibilityLabel("任务记录")
        history.setContentHuggingPriority(.defaultLow, for: .horizontal)
        history.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        refreshButton.target = self
        refreshButton.action = #selector(refresh(_:))
        refreshButton.bezelStyle = .rounded
        let historyRow = NSStackView(views: [history, refreshButton])
        historyRow.spacing = 8
        taskStatus.font = .systemFont(ofSize: 13, weight: .semibold)
        taskStatus.lineBreakMode = .byTruncatingTail
        counters.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        counters.textColor = .secondaryLabelColor
        counters.setContentHuggingPriority(.required, for: .horizontal)
        taskStatus.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let statusRow = NSStackView(views: [taskStatus, counters])
        statusRow.spacing = 10
        connectionStatus.font = .systemFont(ofSize: 11)
        connectionStatus.textColor = .secondaryLabelColor
        connectionStatus.maximumNumberOfLines = 2
        let eventLabel = NSTextField(labelWithString: "来源与执行记录")
        eventLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        let eventScroll = makeScroll(for: eventText, editable: false)
        eventText.setAccessibilityLabel("任务来源与工具执行记录")
        let resultLabel = NSTextField(labelWithString: "任务结果")
        resultLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        let resultScroll = makeScroll(for: resultText, editable: false)
        resultText.setAccessibilityLabel("任务最终结果")
        let content = NSStackView(views: [title, note, goalLabel, goalScroll, urlInput, actionRow,
                                           historyRow, statusRow, connectionStatus, eventLabel,
                                           eventScroll, resultLabel, resultScroll])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 8
        content.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(content)
        let fullWidth: [NSView] = [note, goalScroll, urlInput, historyRow, statusRow,
                                   connectionStatus, eventScroll, resultScroll]
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            content.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            content.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            content.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
            goalScroll.heightAnchor.constraint(equalToConstant: 72),
            actionRow.widthAnchor.constraint(equalToConstant: 188),
            urlInput.heightAnchor.constraint(equalToConstant: 25),
            eventScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 70),
            eventScroll.heightAnchor.constraint(equalTo: resultScroll.heightAnchor, multiplier: 0.65),
            resultScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 110)
        ] + fullWidth.map { $0.widthAnchor.constraint(equalTo: content.widthAnchor) })
        rebuildHistory()
        showSelectedTask()
    }

    func show(near pet: NSWindow?) {
        if !window.isVisible {
            let visible = (pet?.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 900)
            let frame = pet?.frame ?? visible
            window.setFrameOrigin(NSPoint(x: max(visible.minX + 12, min(frame.minX - window.frame.width - 14, visible.maxX - window.frame.width - 12)),
                                          y: max(visible.minY + 12, min(frame.midY - window.frame.height / 2, visible.maxY - window.frame.height - 12))))
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(goalInput)
        refreshTasks()
    }

    func shutdown() {
        stopped = true
        generation += 1
        pollTimer?.invalidate()
        request?.cancel()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        schedulePoll()
        return false
    }
    func windowDidMiniaturize(_ notification: Notification) { schedulePoll() }
    func windowDidDeminiaturize(_ notification: Notification) { refreshTasks() }
    func textDidChange(_ notification: Notification) { updateControls() }

    private func updateControls() {
        startButton.isEnabled = !stopped && !requestInFlight && !needsStartReconciliation && !hasRunningTask && !goalInput.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        stopButton.isEnabled = !stopped && !requestInFlight && selectedTask?.isRunning == true
        history.isEnabled = !requestInFlight && !tasks.isEmpty
        refreshButton.isEnabled = !requestInFlight
    }

    private func schedulePoll() {
        pollTimer?.invalidate()
        pollTimer = nil
        guard !stopped, hasRunningTask || needsStartReconciliation || isWindowVisible else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: hasRunningTask || needsStartReconciliation ? 2 : 5, repeats: false) { [weak self] _ in self?.refreshTasks() }
        if let pollTimer = pollTimer { RunLoop.main.add(pollTimer, forMode: .common) }
    }

    @objc private func refresh(_ sender: Any?) { refreshTasks() }

    private func refreshTasks() {
        guard !stopped, !requestInFlight else { return }
        perform(path: "/api/tasks/list") { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let data):
                do {
                    self.tasks = try JSONDecoder().decode(WhaleTaskListEnvelope.self, from: data).tasks
                    if self.needsStartReconciliation || self.selectedID == nil || !self.tasks.contains(where: { $0.id == self.selectedID }) {
                        self.selectedID = self.tasks.first(where: \.isRunning)?.id ?? self.tasks.first?.id
                    }
                    self.needsStartReconciliation = false
                    self.rebuildHistory()
                    if let id = self.selectedID { self.fetchTask(id: id) }
                    else {
                        self.selectedTask = nil
                        self.connectionStatus.stringValue = "本地任务服务已连接 · 点击启动后才使用 所选 AI 服务的额度。"
                        self.showSelectedTask()
                        self.schedulePoll()
                    }
                } catch { self.reportConnectionError("无法读取任务列表：" + error.localizedDescription) }
            case .failure(let error): self.reportConnectionError(error.localizedDescription)
            }
        }
    }

    private func fetchTask(id: String) {
        var parts = URLComponents()
        parts.queryItems = [URLQueryItem(name: "id", value: id)]
        perform(path: "/api/tasks/status" + (parts.string ?? "")) { [weak self] result in
            guard let self = self else { return }
            self.handleTaskResponse(result)
        }
    }

    private func rebuildHistory() {
        history.removeAllItems()
        if tasks.isEmpty { history.addItem(withTitle: "暂无任务记录") }
        for task in tasks {
            let oneLine = task.goal.replacingOccurrences(of: "\n", with: " ")
            history.addItem(withTitle: "[" + task.statusLabel + "] " + String(oneLine.prefix(58)))
            history.lastItem?.representedObject = task.id
        }
        if let selectedID = selectedID, let index = tasks.firstIndex(where: { $0.id == selectedID }) { history.selectItem(at: index) }
        updateControls()
    }

    @objc private func selectHistory(_ sender: Any?) {
        guard !requestInFlight, let id = history.selectedItem?.representedObject as? String else { return }
        selectedID = id
        selectedTask = nil
        showSelectedTask()
        fetchTask(id: id)
    }

    @objc private func startTask(_ sender: Any?) {
        guard !requestInFlight, !needsStartReconciliation, !hasRunningTask else { return }
        let goal = goalInput.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !goal.isEmpty else { return }
        let urls = urlInput.stringValue.components(separatedBy: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ",，"))).filter { !$0.isEmpty }
        for raw in urls {
            guard let url = URLComponents(string: raw), let scheme = url.scheme?.lowercased(), ["https", "http"].contains(scheme),
                  let host = url.host, !host.isEmpty, url.user == nil, url.password == nil else {
                connectionStatus.stringValue = "网址格式有误：请填写完整的 http:// 或 https:// 网址。"
                return
            }
        }
        pollTimer?.invalidate()
        needsStartReconciliation = true
        selectedID = nil
        selectedTask = nil
        showSelectedTask()
        connectionStatus.stringValue = "正在提交任务…"
        perform(path: "/api/tasks/start", method: "POST", body: ["goal": goal, "urls": urls]) { [weak self] result in
            self?.handleTaskResponse(result)
        }
    }

    @objc private func stopTask(_ sender: Any?) {
        guard !requestInFlight, let task = selectedTask, task.isRunning else { return }
        pollTimer?.invalidate()
        connectionStatus.stringValue = "正在请求停止…"
        perform(path: "/api/tasks/stop", method: "POST", body: ["id": task.id]) { [weak self] result in
            self?.handleTaskResponse(result)
        }
    }

    private func handleTaskResponse(_ result: Result<Data, Error>) {
        switch result {
        case .success(let data):
            do {
                let task = try JSONDecoder().decode(WhaleTaskEnvelope.self, from: data).task
                needsStartReconciliation = false
                selectedID = task.id
                selectedTask = task
                if let index = tasks.firstIndex(where: { $0.id == task.id }) { tasks[index] = task }
                else { tasks.insert(task, at: 0) }
                connectionStatus.stringValue = task.isRunning ? "本机后台执行中 · 关闭窗口可继续 · 每 2 秒读取本地进度" : "状态来自本机任务服务 · 查看记录和刷新不调用模型"
                rebuildHistory()
                showSelectedTask()
                schedulePoll()
            } catch { reportConnectionError("无法读取任务状态：" + error.localizedDescription) }
        case .failure(let error): reportConnectionError(error.localizedDescription)
        }
    }

    private func showSelectedTask() {
        guard let task = selectedTask else {
            taskStatus.stringValue = needsStartReconciliation ? "启动结果待确认" : selectedID == nil ? "尚无任务" : "正在读取任务…"
            taskStatus.textColor = .labelColor
            counters.stringValue = "模型 0 / 8 · 工具 0 / 12 · tokens —"
            eventText.string = "执行过程和来源会显示在这里。"
            resultText.string = needsStartReconciliation
                ? "正在等待本机服务确认任务。尚未收到任务结果，请勿重复启动。"
                : "输入目标并点击“启动任务”。完成、停止或达到上限后，可在这里查看服务返回的结果。"
            updateControls()
            return
        }
        let durationMs = task.limits?.durationMs ?? 180_000
        let duration = durationMs % 60_000 == 0 ? "\(durationMs / 60_000)分钟" : "\(durationMs / 1_000)秒"
        taskStatus.stringValue = task.statusLabel + " · 最多" + duration
        taskStatus.toolTip = taskStatus.stringValue
        taskStatus.textColor = task.status == "failed" ? .systemRed : .labelColor
        let tokens = task.usage?.totalTokens.map(Self.shortCount) ?? "—"
        counters.stringValue = "模型 \(task.modelCalls ?? 0) / \(task.limits?.modelCalls ?? 8) · 工具 \(task.toolCalls ?? 0) / \(task.limits?.toolCalls ?? 12) · tokens " + tokens
        counters.toolTip = "本次模型累计 tokens：" + (task.usage?.totalTokens.map(String.init) ?? "服务未返回") + "；达到 \(task.limits?.totalTokens ?? 24_000) tokens 后停止后续模型调用；单次响应可能超过阈值。只显示服务返回的实际计数。"
        let logs = NSMutableAttributedString()
        let font = NSFont.systemFont(ofSize: 12)
        for event in task.events ?? [] {
            let at = event.at.map { Self.shortTime($0) + " " } ?? ""
            let type = event.type.map { "[" + $0 + "] " } ?? ""
            logs.append(NSAttributedString(string: at + type + event.displayMessage + "\n", attributes: [.font: font, .foregroundColor: NSColor.labelColor]))
            if let raw = event.url ?? event.arguments?.url ?? event.result?.sourceUrl,
               let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                logs.append(NSAttributedString(string: raw + "\n", attributes: [.font: font, .link: url]))
            }
            logs.append(NSAttributedString(string: "\n", attributes: [.font: font]))
        }
        for source in task.sources ?? [] {
            guard let url = URL(string: source.url), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { continue }
            let label = source.kind == "search" ? "已读取搜索结果，目标正文未读" : "已读取来源"
            logs.append(NSAttributedString(string: "[" + label + "] " + (source.title ?? source.url) + "\n", attributes: [.font: font, .foregroundColor: NSColor.labelColor]))
            logs.append(NSAttributedString(string: source.url + "\n\n", attributes: [.font: font, .link: url]))
        }
        let wasAtBottom = eventText.visibleRect.maxY >= eventText.bounds.maxY - 30
        if logs.length == 0 { eventText.string = "任务尚未返回执行记录。" }
        else { eventText.textStorage?.setAttributedString(logs) }
        if wasAtBottom { eventText.scrollToEndOfDocument(nil) }
        var result = task.result?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let error = task.error?.message, !error.isEmpty { result = "任务错误：" + error + (result.isEmpty ? "" : "\n\n" + result) }
        if result.isEmpty {
            result = task.isRunning ? "任务正在执行，最终结果尚未生成。" : "任务未返回结果。请查看状态与执行记录。"
        }
        if resultText.string != result { resultText.string = result }
        updateControls()
    }

    private static func shortTime(_ raw: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
        guard let date = date else { return raw }
        let display = DateFormatter()
        display.dateFormat = "HH:mm:ss"
        return display.string(from: date)
    }

    private static func shortCount(_ value: Int) -> String {
        value < 1_000 ? String(value) : String(format: "%.1fk", Double(value) / 1_000)
    }

    private func reportConnectionError(_ message: String) {
        connectionStatus.stringValue = needsStartReconciliation
            ? "启动结果尚未确认：" + message + "；正在同步本机记录，请勿重复启动。"
            : "连接或读取失败：" + message + "；已有状态未更新，可点刷新重试。"
        connectionStatus.toolTip = connectionStatus.stringValue
        updateControls()
        schedulePoll()
    }

    private func perform(path: String, method: String = "GET", body: [String: Any]? = nil,
                         completion: @escaping (Result<Data, Error>) -> Void) {
        guard !stopped, !requestInFlight, let url = AppPaths.serviceURL(path) else { return }
        let serviceFile = AppPaths.serviceFile
        guard let credentials = try? Data(contentsOf: serviceFile),
              let object = (try? JSONSerialization.jsonObject(with: credentials)) as? [String: Any],
              let token = object["token"] as? String ?? object["accessToken"] as? String, !token.isEmpty else {
            completion(.failure(NSError(domain: "WhaleTask", code: 401, userInfo: [NSLocalizedDescriptionKey: "本地服务凭据尚未就绪，请稍后刷新。"])))
            return
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        urlRequest.httpMethod = method
        urlRequest.timeoutInterval = 10
        urlRequest.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body = body {
            do { urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body) }
            catch { completion(.failure(error)); return }
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        requestInFlight = true
        updateControls()
        let requestGeneration = generation
        request = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, !self.stopped, self.generation == requestGeneration else { return }
                self.requestInFlight = false
                self.request = nil
                self.updateControls()
                if let error = error { completion(.failure(error)); return }
                guard let http = response as? HTTPURLResponse else {
                    completion(.failure(NSError(domain: "WhaleTask", code: 0, userInfo: [NSLocalizedDescriptionKey: "本地服务没有返回有效响应。"])))
                    return
                }
                guard (200...299).contains(http.statusCode), let data = data else {
                    let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                    let detail = object?["error"] as? String ?? (object?["error"] as? [String: Any])?["message"] as? String ?? "HTTP \(http.statusCode)"
                    completion(.failure(NSError(domain: "WhaleTask", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: detail])))
                    return
                }
                completion(.success(data))
            }
        }
        request?.resume()
    }
}
