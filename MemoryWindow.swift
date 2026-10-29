import AppKit
import Foundation

private let memoryServiceDataRoot = AppPaths.dataRoot

private struct WhaleMemoryEntity: Decodable {
    let name: String
    let entityType: String?
    let observations: [String]
}

private struct WhaleMemoryGraph: Decodable {
    let entities: [WhaleMemoryEntity]
}

/// A local memory manager. Reading and forgetting use MCP directly, not a model.
final class MemoryWindowController: NSObject, NSWindowDelegate, NSTextFieldDelegate {
    let window: ChatPanel
    private let memoryText = NSTextView()
    private let status = NSTextField(wrappingLabelWithString: "正在连接本机记忆服务…")
    private let nameInput = NSTextField()
    private let refreshButton = NSButton(title: "刷新记忆", target: nil, action: nil)
    private let forgetButton = NSButton(title: "忘掉这个条目", target: nil, action: nil)
    private var request: URLSessionDataTask?
    private var entities: [WhaleMemoryEntity] = []
    private var stopped = false

    override init() {
        window = ChatPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 550),
                           styleMask: [.titled, .closable, .resizable, .miniaturizable],
                           backing: .buffered, defer: false)
        super.init()
        window.title = "大肥鱼 · 长期记忆"
        window.minSize = NSSize(width: 460, height: 440)
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
        let title = NSTextField(labelWithString: "🐋  大肥鱼记住的事")
        title.font = .systemFont(ofSize: 18, weight: .semibold)
        let note = NSTextField(wrappingLabelWithString: "在聊天里说“记住……”或“忘记……”。长期记忆保存在本机数据目录，新对话仍可检索。查看和删除不调用模型；历史聊天与长期记忆分别保存。")
        note.font = .systemFont(ofSize: 12)
        note.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        memoryText.isEditable = false
        memoryText.isSelectable = true
        memoryText.isRichText = false
        memoryText.font = .systemFont(ofSize: 13)
        memoryText.textColor = .labelColor
        memoryText.backgroundColor = .textBackgroundColor
        memoryText.textContainerInset = NSSize(width: 10, height: 10)
        memoryText.isVerticallyResizable = true
        memoryText.isHorizontallyResizable = false
        memoryText.autoresizingMask = [.width]
        memoryText.minSize = .zero
        memoryText.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        memoryText.textContainer?.widthTracksTextView = true
        memoryText.setAccessibilityLabel("已保存的长期记忆")
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .bezelBorder
        scroll.documentView = memoryText
        nameInput.placeholderString = "要忘掉的条目名称（从上方复制）"
        nameInput.setAccessibilityLabel("要忘掉的记忆条目名称")
        nameInput.delegate = self
        refreshButton.target = self
        refreshButton.action = #selector(refresh(_:))
        refreshButton.bezelStyle = .rounded
        forgetButton.target = self
        forgetButton.action = #selector(forget(_:))
        forgetButton.bezelStyle = .rounded
        let actions = NSStackView(views: [refreshButton, forgetButton])
        actions.spacing = 10
        actions.distribution = .fillEqually
        actions.alignment = .centerY
        let stack = NSStackView(views: [title, note, status, scroll, nameInput, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 160),
            note.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            nameInput.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actions.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    func show(near pet: NSWindow?) {
        guard !stopped else { return }
        if !window.isVisible {
            let visible = pet?.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
            let petFrame = pet?.frame ?? visible
            let x = max(visible.minX + 12, min(petFrame.minX - window.frame.width - 14, visible.maxX - window.frame.width - 12))
            let y = max(visible.minY + 12, min(petFrame.midY - window.frame.height / 2, visible.maxY - window.frame.height - 12))
            window.setFrameOrigin(NSPoint(x: x, y: y))
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        refresh(nil)
    }

    func shutdown() { stopped = true; request?.cancel(); request = nil }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func controlTextDidChange(_ obj: Notification) { updateControls() }

    private func updateControls() {
        refreshButton.isEnabled = !stopped && request == nil
        forgetButton.isEnabled = !stopped && request == nil && !nameInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        nameInput.isEnabled = !stopped && request == nil
    }

    @objc private func refresh(_ sender: Any?) {
        perform(path: "/api/memory/list") { [weak self] data in
            guard let self = self else { return }
            do {
                let graph = try JSONDecoder().decode(WhaleMemoryGraph.self, from: data)
                self.entities = graph.entities
                self.status.stringValue = "本机长期记忆 · \(graph.entities.count) 个条目 · 查看不使用所选 AI 服务的额度"
                self.status.textColor = .secondaryLabelColor
                self.memoryText.string = graph.entities.isEmpty
                    ? "尚无长期记忆。可以在聊天中说：记住，我喜欢简洁的回答。"
                    : graph.entities.map { entity in
                        let kind = entity.entityType.flatMap { $0.isEmpty ? nil : "（" + $0 + "）" } ?? ""
                        return entity.name + kind + "\n" + entity.observations.map { "• " + $0 }.joined(separator: "\n")
                    }.joined(separator: "\n\n")
                self.memoryText.scrollToBeginningOfDocument(nil)
            } catch { self.reportError("记忆服务返回了无法读取的内容，请稍后刷新。") }
        }
    }

    @objc private func forget(_ sender: Any?) {
        let name = nameInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, request == nil else { return }
        guard entities.contains(where: { $0.name == name }) else { reportError("没有找到这个条目名称，请从上方复制完整名称，或先刷新记忆。"); return }
        let alert = NSAlert()
        alert.messageText = "忘掉“\(name)”？"
        alert.informativeText = "删除这个长期记忆条目及其关系；历史聊天中的文字仍会保留。"
        alert.addButton(withTitle: "忘掉")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self = self, !self.stopped else { return }
            self.perform(path: "/api/memory/forget", body: ["names": [name]]) { [weak self] data in
                guard let self = self else { return }
                guard let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], value["success"] as? Bool == true else { self.reportError("记忆服务尚未确认删除，请刷新后检查。"); return }
                self.nameInput.stringValue = ""
                self.refresh(nil)
            }
        }
    }

    private func reportError(_ message: String) {
        status.stringValue = message
        status.textColor = .systemRed
        updateControls()
    }

    private func perform(path: String, body: [String: Any]? = nil, completion: @escaping (Data) -> Void) {
        guard !stopped, request == nil else { return }
        guard let data = try? Data(contentsOf: memoryServiceDataRoot.appendingPathComponent("service.json")),
              let state = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let token = state["token"] as? String,
              let url = AppPaths.serviceURL(path) else { reportError("本机服务未准备好，请稍后刷新。"); return }
        var urlRequest = URLRequest(url: url)
        urlRequest.timeoutInterval = 18
        urlRequest.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body = body {
            urlRequest.httpMethod = "POST"
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do { urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body) }
            catch { reportError("无法准备记忆操作。"); return }
        }
        status.stringValue = body == nil ? "正在读取本机记忆…" : "正在删除指定记忆…"
        status.textColor = .secondaryLabelColor
        request = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, !self.stopped else { return }
                self.request = nil
                self.updateControls()
                guard error == nil, let data = data, let response = response as? HTTPURLResponse else { self.reportError("无法连接本机记忆服务，请稍后刷新。"); return }
                guard (200..<300).contains(response.statusCode) else {
                    let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                    let detail = object?["error"] as? String ?? (object?["error"] as? [String: Any])?["message"] as? String ?? "记忆服务暂不可用。"
                    self.reportError(detail)
                    return
                }
                completion(data)
            }
        }
        updateControls()
        request?.resume()
    }
}
