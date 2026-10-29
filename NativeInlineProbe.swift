#if WHALE_NATIVE_TEST
import AppKit
import Foundation

private final class ChatFixtureProtocol: URLProtocol {
    static let lock = NSLock()
    static var chatRequests: [[String: Any]] = []
    static var failure = false
    static var delay: Double = 0
    private var work: DispatchWorkItem?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "127.0.0.1" && request.url?.port == AppPaths.serviceURL("/")?.port }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let route = request.url!.path
        var body: [String: Any] = [:]
        var code = 200
        var delay: Double = 0
        if route == "/api/chat" {
            let raw: Data
            if let data = request.httpBody { raw = data }
            else if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                raw = data
            } else { raw = Data() }
            let payload = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] ?? [:]
            Self.lock.lock(); Self.chatRequests.append(payload); let failure = Self.failure; delay = Self.delay; Self.lock.unlock()
            if failure { code = 502; body = ["error": "合成失败，不是实际模型调用"] }
            else { body = ["text": "合成回复-" + (payload["message"] as? String ?? "missing"), "source": "local", "model": "fixture", "modelCalls": 0, "usage": ["totalTokens": 0]] }
        } else if route == "/health" { body = ["configured": true] }
        else if route == "/api/screen-policy" { body = ["policy": ["minIntervalSeconds": 300, "dailyLimit": 36]] }
        else { body = [:] }
        let data = try! JSONSerialization.data(withJSONObject: body)
        let task = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.client?.urlProtocol(self, didReceive: HTTPURLResponse(url: self.request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: data)
            self.client?.urlProtocolDidFinishLoading(self)
        }
        work = task
        DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: task)
    }
    override func stopLoading() { work?.cancel(); work = nil }
    static var count: Int { lock.lock(); defer { lock.unlock() }; return chatRequests.count }
    static func plan(fail: Bool = false, delay: Double = 0) { lock.lock(); Self.failure = fail; Self.delay = delay; lock.unlock() }
}

@main enum NativeInlineProbe {
    private static var checks = 0
    static func check(_ value: Bool, _ message: String) {
        precondition(value, message); checks += 1
    }
    static func child<T>(_ object: Any, _ name: String, _: T.Type) -> T {
        Mirror(reflecting: object).children.first(where: { $0.label == name })!.value as! T
    }
    static func spin(_ seconds: Double = 0.08) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end { RunLoop.main.run(until: min(end, Date().addingTimeInterval(0.01))) }
    }
    static func wait(_ description: String, _ predicate: () -> Bool) {
        let end = Date().addingTimeInterval(5)
        while !predicate() && Date() < end { spin(0.01) }
        check(predicate(), description)
    }
    static func latestVisible(_ chat: ChatController, marker: String) {
        spin()
        let transcript = child(chat, "transcript", NSTextView.self)
        let scroll = child(chat, "transcriptScroll", NSScrollView.self)
        let range = (transcript.string as NSString).range(of: marker, options: .backwards)
        check(range.location != NSNotFound, "latest message is in transcript")
        let manager = transcript.layoutManager!, container = transcript.textContainer!
        manager.ensureLayout(for: container)
        var rect = manager.boundingRect(forGlyphRange: manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil), in: container)
        rect.origin.x += transcript.textContainerInset.width; rect.origin.y += transcript.textContainerInset.height
        check(scroll.documentVisibleRect.intersects(rect), "latest message must be visible after settled layout")
    }
    static func main() throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        URLCache.shared = URLCache(memoryCapacity: 0, diskCapacity: 0, diskPath: nil)
        URLProtocol.registerClass(ChatFixtureProtocol.self)
        let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["WHALE_NATIVE_TEST_ROOT"]!, isDirectory: true)
        let data = root.appendingPathComponent("data", isDirectory: true)
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        let settingsFile = data.appendingPathComponent("settings.json")
        let defaults = try loadPetSettings(from: settingsFile)
        check(defaults.screenshotEnabled == nil && !FileManager.default.fileExists(atPath: settingsFile.path), "a genuine missing file returns defaults without writing")
        let valid = Data("{\"height\":180,\"wandering\":false,\"screenshotEnabled\":true}".utf8)
        try valid.write(to: settingsFile)
        check(try loadPetSettings(from: settingsFile).screenshotEnabled == true, "existing preference must load")
        try FileManager.default.setAttributes([.posixPermissions: 0o100], ofItemAtPath: data.path)
        do {
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: data.path) }
            check(try loadPetSettings(from: settingsFile).screenshotEnabled == true, "known settings load without unnecessary parent directory enumeration")
        }
        let corrupt = Data("not-json".utf8); try corrupt.write(to: settingsFile)
        do { _ = try loadPetSettings(from: settingsFile); preconditionFailure("corrupt settings accepted") } catch { checks += 1 }
        check(try Data(contentsOf: settingsFile) == corrupt, "failed settings decode never writes defaults")
        do { _ = try loadPetSettings(from: root.appendingPathComponent("absent-parent/settings.json")); preconditionFailure("missing parent accepted") } catch { checks += 1 }
        try valid.write(to: settingsFile)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: settingsFile.path)
        do { _ = try loadPetSettings(from: settingsFile); preconditionFailure("unreadable settings accepted") } catch { checks += 1 }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: settingsFile.path)
        check(try Data(contentsOf: settingsFile) == valid, "permission failure leaves existing settings intact")
        try FileManager.default.removeItem(at: settingsFile)
        try FileManager.default.createSymbolicLink(atPath: settingsFile.path, withDestinationPath: data.appendingPathComponent("missing-target.json").path)
        do { _ = try loadPetSettings(from: settingsFile); preconditionFailure("dangling settings symlink accepted as first launch") } catch { checks += 1 }
        try FileManager.default.removeItem(at: settingsFile); try valid.write(to: settingsFile)
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        var seed = (0..<180).map { ChatRecord(role: $0 % 2 == 0 ? "user" : "assistant", content: "合成长历史 \($0) 🐋 \n多行内容 " + String(repeating: "用于真实排版的长段落。", count: 4), source: $0 % 2 == 0 ? nil : "codex") }
        seed.append(ChatRecord(role: "assistant", content: "启动末条标记-🦋", source: "codex"))
        let chatFile = data.appendingPathComponent("chat.json")
        try encoder.encode(seed).write(to: chatFile)
        try Data("{\"token\":\"synthetic-fixture-only\"}".utf8).write(to: data.appendingPathComponent("service.json"))
        let chat = ChatController()
        let input = child(chat, "input", NSTextField.self)
        let transcript = child(chat, "transcript", NSTextView.self)
        let scroll = child(chat, "transcriptScroll", NSScrollView.self)
        defer { chat.shutdown(); chat.window.orderOut(nil) }
        for width in [450.0, 380.0] {
            chat.window.setContentSize(NSSize(width: width, height: 650))
            chat.show(near: nil); latestVisible(chat, marker: "启动末条标记-🦋")
            scroll.contentView.scroll(to: .zero); scroll.reflectScrolledClipView(scroll.contentView)
            check(scroll.documentVisibleRect.minY < 1, "fixture can scroll to old messages")
            chat.window.orderOut(nil); chat.show(near: nil)
            latestVisible(chat, marker: "启动末条标记-🦋")
            input.stringValue = "主窗口草稿保持 🐋"; chat.window.makeFirstResponder(input)
            check(chat.receiveLocalEvent(LocalDeliveryEvent(id: "fixture-event-\(width)", text: "提醒最新-\(width)-🧭", at: nil, kind: "reminder", reminderId: "fixture-reminder")), "local event saved")
            latestVisible(chat, marker: "提醒最新-\(width)-🧭")
            check(input.stringValue == "主窗口草稿保持 🐋", "new message cannot erase draft")
            check(chat.window.firstResponder === input || chat.window.firstResponder === input.currentEditor(), "scroll cannot move keyboard focus into transcript")
            let proactive = ProactiveMessage(id: "fixture-proactive-\(width)", at: nil, text: "主动最新-\(width)-🐳", model: nil, source: "local")
            check(chat.receiveProactive(proactive), "proactive message saved")
            latestVisible(chat, marker: "主动最新-\(width)-🐳")
        }
        for index in 0..<8 { _ = chat.receiveLocalEvent(LocalDeliveryEvent(id: "rapid-\(index)", text: "连续新消息-\(index)-🪼", at: nil, kind: "reminder", reminderId: nil)) }
        latestVisible(chat, marker: "连续新消息-7-🪼")
        input.stringValue = "不可覆盖的完整聊天草稿"
        ChatFixtureProtocol.plan(delay: 0.12)
        var completed = 0, rejected = 0
        chat.sendInlineReply("  气泡合成成功  ") { result in if case .success = result { completed += 1 } }
        chat.sendInlineReply("重复点击不能派发") { result in if case .failure = result { rejected += 1 } }
        check(rejected == 1, "shared slot rejects duplicate entry")
        wait("inline success callback", { completed == 1 && !chat.isBusy })
        check(ChatFixtureProtocol.count == 1, "one accepted send dispatches once")
        check(input.stringValue == "不可覆盖的完整聊天草稿", "inline send preserves main composer")
        check(chat.window.isVisible, "reply keeps already opened chat window visible")
        latestVisible(chat, marker: "合成回复-气泡合成成功")
        ChatFixtureProtocol.plan(fail: true)
        var failed = 0
        chat.sendInlineReply("合成失败保留回调") { result in if case .failure = result { failed += 1 } }
        wait("inline failure releases shared slot", { failed == 1 && !chat.isBusy })
        check(input.stringValue == "不可覆盖的完整聊天草稿", "failure preserves other surface draft")
        ChatFixtureProtocol.plan()
        input.stringValue = "完整窗口合成回复"
        _ = chat.perform(NSSelectorFromString("sendMessage:"), with: nil)
        wait("ordinary send completes", { !chat.isBusy && ChatFixtureProtocol.count == 3 })
        check(chat.window.isVisible, "ordinary send no longer hides the chat")
        latestVisible(chat, marker: "合成回复-完整窗口合成回复")
        let count = ChatFixtureProtocol.count
        let old = try Data(contentsOf: chatFile)
        try FileManager.default.removeItem(at: chatFile); try FileManager.default.createDirectory(at: chatFile, withIntermediateDirectories: false)
        var storageRejected = 0
        chat.sendInlineReply("持久化失败不得派发") { result in if case .failure = result { storageRejected += 1 } }
        spin()
        check(storageRejected == 1 && !chat.isBusy && ChatFixtureProtocol.count == count, "storage failure blocks dispatch and restores slot")
        try FileManager.default.removeItem(at: chatFile); try old.write(to: chatFile)
        ChatFixtureProtocol.plan(delay: 0.4)
        var cancelled = 0
        chat.sendInlineReply("关闭期间的合成请求") { result in if case .failure = result { cancelled += 1 } }
        wait("fixture request starts", { ChatFixtureProtocol.count == count + 1 })
        chat.shutdown(); spin(0.55)
        check(cancelled == 1 && !chat.isBusy, "shutdown completes inline callback exactly once and ignores late response")
        check(!transcript.string.contains("合成回复-关闭期间的合成请求"), "late cancelled reply cannot overwrite latest")
        print("NATIVE_INLINE_PROBE passed \(checks) checks; synthetic network only; no production files, credentials, screenshots or models")
    }
}
#endif
