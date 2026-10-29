import AppKit
import Foundation

struct LocalDeliveryEvent: Decodable {
    let id: String
    let text: String
    let at: String?
    let kind: String
    let reminderId: String?
}

/// The event poller and these panels use only authenticated loopback requests.
/// They never invoke a model or capture the screen.
final class LocalToolsController: NSObject, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
    let window = ChatPanel(contentRect: NSRect(x: 0, y: 0, width: 760, height: 760), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    var onLocalEvent: ((LocalDeliveryEvent) -> Bool)?
    var onSettingsChanged: (() -> Void)?
    private let tabs = NSSegmentedControl(labels: ["提醒与待办", "用量与预算"], trackingMode: .selectOne, target: nil, action: nil)
    private let tasksPane = NSStackView()
    private let usagePane = NSStackView()
    private let status = NSTextField(wrappingLabelWithString: "正在连接本机桌宠服务…")
    private let reminderText = NSTextField()
    private let reminderDate = NSDatePicker()
    private let todoText = NSTextField()
    private let morningTime = NSTextField()
    private let budgetInput = NSTextField()
    private let usageText = NSTextView()
    private let reminderTable = NSTableView()
    private let todoTable = NSTableView()
    private var reminders: [[String: Any]] = []
    private var todos: [[String: Any]] = []
    private var timer: Timer?
    private var requests: [UUID: URLSessionDataTask] = [:]
    private var eventBusy = false
    private var refreshing = false
    private var refreshPending = false
    private var mutating = false
    private var mutationControls: [NSControl] = []
    private var stopped = false
    private var pollCount = 0
    private var generation = 0
    private var selectedTab = "tasks"
    private let dataRoot = AppPaths.dataRoot
    private let shanghai = TimeZone(identifier: "Asia/Shanghai")!

    override init() {
        super.init()
        window.title = "大肥鱼 · 本地小工具"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 650, height: 690)
        let root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 10
        root.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView(); window.contentView = content; content.addSubview(root)
        NSLayoutConstraint.activate([root.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18), root.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18), root.topAnchor.constraint(equalTo: content.topAnchor, constant: 16), root.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -14)])
        let title = NSTextField(labelWithString: "大肥鱼的本地小工具"); title.font = .boldSystemFont(ofSize: 19)
        root.addArrangedSubview(title)
        tabs.target = self; tabs.action = #selector(changeTab(_:)); tabs.selectedSegment = 0
        tabs.setAccessibilityLabel("本地小工具分类"); root.addArrangedSubview(tabs)
        let body = NSView(); body.translatesAutoresizingMaskIntoConstraints = false; root.addArrangedSubview(body)
        for pane in [tasksPane, usagePane] {
            pane.orientation = .vertical; pane.alignment = .leading; pane.spacing = 9; pane.translatesAutoresizingMaskIntoConstraints = false
            body.addSubview(pane)
            NSLayoutConstraint.activate([pane.leadingAnchor.constraint(equalTo: body.leadingAnchor), pane.trailingAnchor.constraint(equalTo: body.trailingAnchor), pane.topAnchor.constraint(equalTo: body.topAnchor), pane.bottomAnchor.constraint(equalTo: body.bottomAnchor)])
        }
        body.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        buildTasks(); buildUsage(); usagePane.isHidden = true
        mutationControls += [reminderText, reminderDate, todoText, morningTime, budgetInput]
        status.font = .systemFont(ofSize: 12); status.textColor = .secondaryLabelColor; status.maximumNumberOfLines = 3
        root.addArrangedSubview(status); status.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
    }

    private func button(_ title: String, _ selector: Selector) -> NSButton {
        let value = NSButton(title: title, target: self, action: selector); value.bezelStyle = .rounded
        mutationControls.append(value)
        return value
    }
    private func row(_ views: [NSView]) -> NSStackView {
        let spacer = NSView(); spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        spacer.widthAnchor.constraint(greaterThanOrEqualToConstant: 0).isActive = true
        spacer.heightAnchor.constraint(equalToConstant: 1).isActive = true
        let value = NSStackView(views: views + [spacer]); value.orientation = .horizontal; value.distribution = .fill; value.spacing = 8; value.alignment = .centerY
        value.setContentHuggingPriority(.required, for: .vertical)
        for view in views { view.setContentHuggingPriority(.defaultHigh, for: .horizontal) }
        return value
    }
    private func label(_ text: String) -> NSTextField { let value = NSTextField(wrappingLabelWithString: text); value.font = .systemFont(ofSize: 12); value.textColor = .secondaryLabelColor; return value }
    private func fill(_ view: NSView, in pane: NSStackView) { pane.addArrangedSubview(view); view.widthAnchor.constraint(equalTo: pane.widthAnchor).isActive = true }

    private func buildTasks() {
        fill(label("提醒在本机定时，不消耗模型。桌宠运行时用气泡提示；休眠或退出时错过的提醒，重新打开后提示一次。已设提醒照常送达，自动聊天的勿扰不会取消它。"), in: tasksPane)
        reminderText.placeholderString = "提醒内容"; reminderText.setAccessibilityLabel("本地提醒内容")
        reminderDate.datePickerStyle = .textFieldAndStepper; reminderDate.datePickerElements = [.yearMonthDay, .hourMinute]
        reminderDate.locale = Locale(identifier: "zh_CN"); reminderDate.timeZone = shanghai; reminderDate.dateValue = Date().addingTimeInterval(1800)
        reminderDate.setAccessibilityLabel("提醒时间（北京时间）")
        fill(row([reminderText, reminderDate, button("添加提醒", #selector(addReminder(_:)))]), in: tasksPane)
        reminderText.widthAnchor.constraint(equalToConstant: 160).isActive = true
        reminderDate.widthAnchor.constraint(equalToConstant: 200).isActive = true
        tasksPane.addArrangedSubview(NSTextField(labelWithString: "提醒列表（时间为北京时间）"))
        let reminderScroll = tableScroll(reminderTable, identifier: "reminders", minimumHeight: 145)
        fill(reminderScroll, in: tasksPane)
        fill(row([button("完成选中提醒", #selector(completeSelectedReminder(_:))), button("10分钟后提醒", #selector(snoozeSelectedReminder(_:))), button("取消选中提醒", #selector(cancelSelectedReminder(_:)))]), in: tasksPane)
        todoText.placeholderString = "小待办"; todoText.setAccessibilityLabel("本地待办内容")
        todoText.widthAnchor.constraint(equalToConstant: 300).isActive = true
        fill(row([todoText, button("添加待办", #selector(addTodo(_:)))]), in: tasksPane)
        let todoScroll = tableScroll(todoTable, identifier: "todos", minimumHeight: 110)
        fill(todoScroll, in: tasksPane)
        reminderScroll.heightAnchor.constraint(equalTo: todoScroll.heightAnchor, multiplier: 1.25).isActive = true
        fill(row([button("完成选中待办", #selector(completeSelectedTodo(_:))), button("恢复选中待办", #selector(reopenSelectedTodo(_:))), button("取消选中待办", #selector(cancelSelectedTodo(_:)))]), in: tasksPane)
        morningTime.stringValue = "09:00"; morningTime.setAccessibilityLabel("明早提醒的默认时间")
        morningTime.widthAnchor.constraint(equalToConstant: 70).isActive = true
        fill(row([NSTextField(labelWithString: "“明早”默认时间"), morningTime, button("保存时间", #selector(saveMorning(_:))), button("重新读取", #selector(refreshTapped(_:)))]), in: tasksPane)
        fill(label("也可以直接聊天：半小时后提醒我出门／明早提醒我带充电器／添加待办整理桌面。"), in: tasksPane)
    }
    private func buildUsage() {
        fill(label("这里显示本桌宠已经报告的用量。它不是账号剩余额度；启用前的普通聊天和任务可能未计入，今天已有的主动消息累计会导入一次。"), in: usagePane)
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        usageText.isEditable = false; usageText.isSelectable = true; usageText.drawsBackground = false
        usageText.font = .monospacedSystemFont(ofSize: 13, weight: .regular); usageText.textContainerInset = NSSize(width: 12, height: 10)
        usageText.isVerticallyResizable = true; usageText.isHorizontallyResizable = false
        usageText.autoresizingMask = [.width]; usageText.textContainer?.widthTracksTextView = true
        usageText.setAccessibilityLabel("桌宠用量统计"); scroll.documentView = usageText
        fill(scroll, in: usagePane); scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 360).isActive = true
        budgetInput.stringValue = "0"; budgetInput.setAccessibilityLabel("每日已报告token停止阈值")
        budgetInput.widthAnchor.constraint(equalToConstant: 120).isActive = true
        fill(row([NSTextField(labelWithString: "每日 token 停止阈值"), budgetInput, button("保存预算", #selector(saveBudget(_:))), button("重新读取", #selector(refreshTapped(_:)))]), in: usagePane)
        fill(label("0 表示不限。达到阈值后暂停后续主动消息，明确发送的聊天和任务仍可继续。阈值按响应后实际报告值判断，单次响应可能超过它；本地提醒不调用模型。"), in: usagePane)
    }
    private func tableScroll(_ table: NSTableView, identifier: String, minimumHeight: CGFloat) -> NSScrollView {
        table.identifier = NSUserInterfaceItemIdentifier(identifier); table.dataSource = self; table.delegate = self
        table.rowHeight = 38; table.usesAlternatingRowBackgroundColors = true; table.allowsEmptySelection = true
        let text = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("text")); text.title = "事项"; text.width = 420; text.minWidth = 200
        let details = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("details")); details.title = "时间／状态"; details.width = 240; details.minWidth = 150
        table.addTableColumn(text); table.addTableColumn(details); table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.setAccessibilityLabel(identifier == "reminders" ? "本地提醒列表" : "本地待办列表")
        let scroll = NSScrollView(); scroll.documentView = table; scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: minimumHeight).isActive = true
        return scroll
    }

    func start() {
        guard timer == nil, !stopped else { return }
        let timer = Timer(timeInterval: 10, repeats: true) { [weak self] _ in
            guard let self = self else { return }; self.pollEvents(); self.pollCount += 1
            if self.window.isVisible && self.pollCount % 3 == 0 { self.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common); self.timer = timer; pollEvents()
    }
    func shutdown() { stopped = true; timer?.invalidate(); timer = nil; requests.values.forEach { $0.cancel() }; requests.removeAll(); window.orderOut(nil) }
    func show(tab: String, near pet: NSWindow?) {
        selectedTab = tab == "usage" ? "usage" : "tasks"; tabs.selectedSegment = selectedTab == "usage" ? 1 : 0
        tasksPane.isHidden = selectedTab != "tasks"; usagePane.isHidden = selectedTab != "usage"
        if !window.isVisible {
            let visible = (pet?.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 900)
            let frame = pet?.frame ?? visible
            let origin = NSPoint(x: max(visible.minX + 12, min(frame.minX - window.frame.width - 12, visible.maxX - window.frame.width - 12)), y: max(visible.minY + 12, min(frame.midY - window.frame.height / 2, visible.maxY - window.frame.height - 12)))
            window.setFrameOrigin(origin)
        }
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil); refresh()
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    @objc private func changeTab(_ sender: Any?) { selectedTab = tabs.selectedSegment == 1 ? "usage" : "tasks"; tasksPane.isHidden = selectedTab != "tasks"; usagePane.isHidden = selectedTab != "usage"; refresh() }
    @objc private func refreshTapped(_ sender: Any?) { refresh() }

    private func perform(_ route: String, body: [String: Any]? = nil, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard !stopped else { return }
        guard let data = try? Data(contentsOf: dataRoot.appendingPathComponent("service.json")), let service = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let token = service["token"] as? String, let url = AppPaths.serviceURL(route) else {
            completion(.failure(NSError(domain: "LocalTools", code: 1, userInfo: [NSLocalizedDescriptionKey: "本机桌宠服务尚未连接，请稍后重试。"])))
            return
        }
        var request = URLRequest(url: url); request.timeoutInterval = 15; request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body = body { request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        let id = UUID()
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }; self.requests[id] = nil; guard !self.stopped else { return }
                if let error = error { completion(.failure(error)); return }
                guard let data = data, let response = response as? HTTPURLResponse, let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { completion(.failure(NSError(domain: "LocalTools", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法读取本机服务返回的内容。"]))); return }
                guard (200..<300).contains(response.statusCode) else { completion(.failure(NSError(domain: "LocalTools", code: response.statusCode, userInfo: [NSLocalizedDescriptionKey: value["error"] as? String ?? "本机操作未完成，请稍后重试。"]))); return }
                completion(.success(value))
            }
        }
        requests[id] = task; task.resume()
    }
    private func pollEvents() {
        guard !eventBusy, !stopped else { return }; eventBusy = true
        perform("/api/local-events/inbox") { [weak self] result in
            guard let self = self else { return }
            guard case .success(let value) = result, let raw = value["events"], let data = try? JSONSerialization.data(withJSONObject: raw), let events = try? JSONDecoder().decode([LocalDeliveryEvent].self, from: data) else { self.eventBusy = false; return }
            var ids: [String] = []
            for event in events.prefix(10) {
                guard self.onLocalEvent?(event) == true else { break }
                ids.append(event.id)
            }
            guard !ids.isEmpty else { self.eventBusy = false; return }
            self.perform("/api/local-events/ack", body: ["ids": ids]) { [weak self] _ in self?.eventBusy = false }
        }
    }
    private func refresh() {
        guard !stopped else { return }
        guard !refreshing, !mutating else { refreshPending = true; return }
        refreshPending = false; refreshing = true; generation += 1; let current = generation; let tab = selectedTab
        status.stringValue = "正在读取本机数据…"
        perform(tab == "usage" ? "/api/usage" : "/api/reminders") { [weak self] result in
            guard let self = self else { return }; self.refreshing = false
            guard !self.mutating, self.generation == current, self.selectedTab == tab else {
                self.refreshPending = true
                if !self.mutating { self.refresh() }
                return
            }
            switch result {
            case .success(let value):
                if tab == "usage" { self.renderUsage(value) } else { self.renderTasks(value) }
                self.status.stringValue = "本机数据已更新；查看与设置不调用模型。"
            case .failure(let error): self.status.stringValue = String(error.localizedDescription.prefix(240))
            }
            if self.refreshPending { self.refresh() }
        }
    }
    private func mutate(_ route: String, body: [String: Any], success: String, clear: NSTextField? = nil) {
        guard !stopped else { return }
        guard !mutating else { status.stringValue = "正在保存上一项，请稍候…"; return }
        mutating = true
        // A read started before this action must not repaint stale settings or
        // clear the action's pending state. Its task remains independent.
        generation += 1
        mutationControls.forEach { $0.isEnabled = false }
        let submittedValue = clear?.stringValue
        status.stringValue = "正在保存…"
        perform(route, body: body) { [weak self] result in
            guard let self = self else { return }
            self.mutating = false
            self.mutationControls.forEach { $0.isEnabled = true }
            switch result {
            case .success:
                if clear?.stringValue == submittedValue { clear?.stringValue = "" }
                self.onSettingsChanged?(); self.refresh(); self.status.stringValue = success
            case .failure(let error):
                if self.refreshPending { self.refresh() }
                self.status.stringValue = String(error.localizedDescription.prefix(240))
            }
        }
    }
    func focus(minutes: Int, completion: @escaping (Bool) -> Void) {
        perform("/api/companion/focus", body: ["minutes": minutes]) { [weak self] result in
            if case .success = result { self?.onSettingsChanged?(); completion(true) } else { completion(false) }
        }
    }
    func performReminderAction(id: String, action: String, minutes: Int = 10, completion: @escaping (Bool) -> Void) {
        perform("/api/reminders/action", body: ["id": id, "action": action, "minutes": minutes]) { [weak self] result in
            if case .success = result { self?.refresh(); completion(true) } else { completion(false) }
        }
    }
    @objc private func addReminder(_ sender: Any?) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        mutate("/api/reminders/create", body: ["text": reminderText.stringValue, "dueAt": formatter.string(from: reminderDate.dateValue)], success: "提醒已保存。", clear: reminderText)
    }
    @objc private func addTodo(_ sender: Any?) { mutate("/api/todos/create", body: ["text": todoText.stringValue], success: "待办已保存。", clear: todoText) }
    @objc private func saveMorning(_ sender: Any?) { mutate("/api/reminders/configure", body: ["defaultMorningTime": morningTime.stringValue], success: "默认早晨时间已保存。") }
    @objc private func saveBudget(_ sender: Any?) {
        guard let value = Int(budgetInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)), value >= 0 else { status.stringValue = "请输入非负整数，0 表示不限。"; return }
        mutate("/api/usage-policy", body: ["dailyTokenLimit": value], success: "每日主动消息停止阈值已保存。")
    }
    private func reminderAction(_ action: String) {
        let index = reminderTable.selectedRow
        guard reminders.indices.contains(index), let id = reminders[index]["id"] as? String else { status.stringValue = "请先选中一条提醒。"; return }
        mutate("/api/reminders/action", body: ["id": id, "action": action, "minutes": 10], success: "提醒已更新。")
    }
    private func todoAction(_ action: String) {
        let index = todoTable.selectedRow
        guard todos.indices.contains(index), let id = todos[index]["id"] as? String else { status.stringValue = "请先选中一条待办。"; return }
        mutate("/api/todos/action", body: ["id": id, "action": action], success: "待办已更新。")
    }
    @objc private func completeSelectedReminder(_ sender: Any?) { reminderAction("complete") }
    @objc private func snoozeSelectedReminder(_ sender: Any?) { reminderAction("snooze") }
    @objc private func cancelSelectedReminder(_ sender: Any?) { reminderAction("cancel") }
    @objc private func completeSelectedTodo(_ sender: Any?) { todoAction("complete") }
    @objc private func reopenSelectedTodo(_ sender: Any?) { todoAction("reopen") }
    @objc private func cancelSelectedTodo(_ sender: Any?) { todoAction("cancel") }

    private func renderTasks(_ value: [String: Any]) {
        reminders = value["reminders"] as? [[String: Any]] ?? []; todos = value["todos"] as? [[String: Any]] ?? []
        let settings = value["settings"] as? [String: Any]
        if window.firstResponder !== morningTime.currentEditor() { morningTime.stringValue = settings?["defaultMorningTime"] as? String ?? "09:00" }
        reminderTable.reloadData(); todoTable.reloadData()
    }
    private func number(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? 0 }
    private func renderUsage(_ value: [String: Any]) {
        let today = value["today"] as? [String: Any] ?? [:], usage = today["usage"] as? [String: Any] ?? [:]
        let kinds = today["byKind"] as? [String: Any] ?? [:], screenshot = value["screenshot"] as? [String: Any] ?? [:]
        let policy = value["policy"] as? [String: Any] ?? [:], proactive = value["proactive"] as? [String: Any] ?? [:], state = proactive["status"] as? [String: Any] ?? [:]
        if window.firstResponder !== budgetInput.currentEditor() { budgetInput.stringValue = String(number(policy["dailyTokenLimit"])) }
        var lines = ["日期：\(value["day"] as? String ?? "—")（北京时间）", "", "今日已报告 token：\(number(usage["totalTokens"]))", "输入 \(number(usage["input"]))  输出 \(number(usage["output"]))  缓存读 \(number(usage["cacheRead"]))  缓存写 \(number(usage["cacheWrite"]))", "已记录模型调用：\(number(today["modelCalls"]))", "缺少完整用量报告的请求：\(number(today["unknownUsageAttempts"]))", ""]
        for (key, title) in [("chat", "聊天（含视觉）"), ("proactive", "主动消息"), ("task", "后台任务")] {
            let item = kinds[key] as? [String: Any] ?? [:], count = item["usage"] as? [String: Any] ?? [:]
            lines.append("\(title)：\(number(count["totalTokens"])) tokens / \(number(item["requests"])) 次请求")
        }
        lines += ["", "今日截图：\(number(screenshot["used"])) / \((screenshot["dailyUnlimited"] as? Bool) == true ? "不限" : String(number(screenshot["limit"])))", "截图最小间隔：\(number(screenshot["minIntervalSeconds"]) / 60) 分钟", "主动消息今日尝试：\(number(state["aiUsedToday"]))", "主动状态：\(statusName(state["reason"] as? String ?? "ready"))", "", "最近日期（仅已记录用量）："]
        for item in (value["history"] as? [[String: Any]] ?? []).prefix(7) {
            let usage = item["usage"] as? [String: Any] ?? (item["today"] as? [String: Any])?["usage"] as? [String: Any] ?? [:]
            lines.append("\(item["day"] as? String ?? "—")  \(number(usage["totalTokens"])) tokens")
        }
        usageText.string = lines.joined(separator: "\n")
    }
    private func statusName(_ value: String) -> String {
        ["ready":"已安排", "disabled":"已暂停", "ui_offline":"等待桌宠连接", "quiet_hours":"夜间勿扰", "focus":"临时专注", "token_budget":"达到 token 阈值", "usage_unknown":"有请求缺少完整用量报告", "usage_unavailable":"用量记录暂不可读取", "daily_limit":"达到每日次数上限", "user_busy":"正在输入或聊天", "work_busy":"正在处理任务", "generating":"正在生成"][value] ?? value
    }
    func numberOfRows(in tableView: NSTableView) -> Int { tableView === reminderTable ? reminders.count : todos.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let values = tableView === reminderTable ? reminders : todos; guard values.indices.contains(row) else { return nil }
        let item = values[row]; let text: String
        if tableColumn?.identifier.rawValue == "text" { text = item["text"] as? String ?? "" }
        else {
            let state = item["status"] as? String ?? "pending"
            let translated = ["pending":"待处理", "due":"已到时", "completed":"已完成", "cancelled":"已取消"][state] ?? state
            text = tableView === reminderTable ? "\(displayDate(item["dueAt"] as? String)) · \(translated)" : translated
        }
        let cell = NSTextField(labelWithString: text); cell.font = .systemFont(ofSize: 12); cell.lineBreakMode = .byTruncatingTail; cell.toolTip = text
        return cell
    }
    private func displayDate(_ value: String?) -> String {
        guard let value = value else { return "—" }
        let a = ISO8601DateFormatter(); a.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = a.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return "—" }
        let format = DateFormatter(); format.locale = Locale(identifier: "zh_CN"); format.timeZone = shanghai; format.dateFormat = "MM-dd HH:mm"; return format.string(from: date)
    }
}
