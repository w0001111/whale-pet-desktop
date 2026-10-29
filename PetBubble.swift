import AppKit

private final class ReplyBubblePanel: NSPanel {
    var allowsInlineFocus = false
    override var canBecomeKey: Bool { allowsInlineFocus }
    override var canBecomeMain: Bool { false }
}

private final class InlineReplyField: NSTextField {
    var onExplicitFocus: (() -> Void)?
    override var needsPanelToBecomeKey: Bool { true }
    override func mouseDown(with event: NSEvent) {
        onExplicitFocus?()
        super.mouseDown(with: event)
    }
}

private enum BubbleTail { case left, right, bottom, top }

private final class ReplyBubbleView: NSView {
    var tail: BubbleTail = .right { didSet { if tail != oldValue { needsDisplay = true } } }
    var onHover: ((Bool) -> Void)?
    var onOpen: (() -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking = tracking { removeTrackingArea(tracking) }
        let value = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(value)
        tracking = value
    }
    override func mouseEntered(with event: NSEvent) { onHover?(true) }
    override func mouseExited(with event: NSEvent) { onHover?(false) }
    override func mouseDown(with event: NSEvent) { onOpen?() }
    override func draw(_ dirtyRect: NSRect) {
        let body = bounds.insetBy(dx: 10, dy: 10)
        let path = NSBezierPath(roundedRect: body, xRadius: 16, yRadius: 16)
        let triangle = NSBezierPath()
        switch tail {
        case .right:
            let y = body.minY + 26
            triangle.move(to: NSPoint(x: body.maxX - 2, y: y - 7)); triangle.line(to: NSPoint(x: bounds.maxX - 1, y: y)); triangle.line(to: NSPoint(x: body.maxX - 2, y: y + 7))
        case .left:
            let y = body.minY + 26
            triangle.move(to: NSPoint(x: body.minX + 2, y: y - 7)); triangle.line(to: NSPoint(x: 1, y: y)); triangle.line(to: NSPoint(x: body.minX + 2, y: y + 7))
        case .bottom:
            let x = body.midX
            triangle.move(to: NSPoint(x: x - 8, y: body.minY + 2)); triangle.line(to: NSPoint(x: x, y: 1)); triangle.line(to: NSPoint(x: x + 8, y: body.minY + 2))
        case .top:
            let x = body.midX
            triangle.move(to: NSPoint(x: x - 8, y: body.maxY - 2)); triangle.line(to: NSPoint(x: x, y: bounds.maxY - 1)); triangle.line(to: NSPoint(x: x + 8, y: body.maxY - 2))
        }
        triangle.close()
        NSColor.windowBackgroundColor.withAlphaComponent(0.98).setFill()
        path.fill(); triangle.fill()
        NSColor.separatorColor.withAlphaComponent(0.45).setStroke()
        path.lineWidth = 0.8; path.stroke()
    }
}

/// Automatic messages stay nonactivating; explicit input shares the chat sender.
final class PetBubbleController: NSObject, NSTextFieldDelegate, NSWindowDelegate {
    private struct Message {
        let text: String
        let source: String
        let proactive: Bool
        let kind: String?
        let reminderId: String?
    }
    private let window = ReplyBubblePanel(contentRect: NSRect(x: 0, y: 0, width: 330, height: 160), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    private let canvas = ReplyBubbleView()
    private let sourceLabel = NSTextField(labelWithString: "大肥鱼")
    private let messageLabel = NSTextField(wrappingLabelWithString: "")
    private let openButton = NSButton(title: "继续聊", target: nil, action: nil)
    private let pinButton = NSButton(title: "留住", target: nil, action: nil)
    private let laterButton = NSButton(title: "稍后聊 15 分钟", target: nil, action: nil)
    private let completeButton = NSButton(title: "已完成", target: nil, action: nil)
    private let snoozeButton = NSButton(title: "10 分钟后", target: nil, action: nil)
    private let pendingButton = NSButton(title: "", target: nil, action: nil)
    private let feedback = NSTextField(wrappingLabelWithString: "")
    private let inlineInput = InlineReplyField(string: "")
    private let inlineSend = NSButton(title: "发送", target: nil, action: nil)
    private let controls = NSStackView()
    private let reminderRow = NSStackView()
    private let closeButton = NSButton(title: "×", target: nil, action: nil)
    private var messageHeightConstraint: NSLayoutConstraint!
    private var feedbackHeightConstraint: NSLayoutConstraint!
    private var dismissTimer: Timer?
    private var hovering = false
    private var lastPetFrame = NSRect.zero
    private var presenting = false
    private var pinned = false
    private var pendingCount = 0
    private var current: Message?
    private var latest: Message?
    private var actionInFlight = false
    private var actionRequestID: UUID?
    private var displayGeneration: UInt64 = 0
    private var inlineSending = false
    private var inlineEditing = false
    private var conversationBusy = false
    private var draftRevision: UInt64 = 0
    private var inlineRequestID: UUID?
    private var stopped = false
    private weak var anchor: NSWindow?
    var onOpenChat: (() -> Void)?
    var onFocus: ((Int, @escaping (Bool) -> Void) -> Void)?
    var onReminderAction: ((String, String, Int, @escaping (Bool) -> Void) -> Void)?
    var onSendReply: ((String, @escaping (Result<Void, Error>) -> Void) -> Void)? {
        didSet { updateInlineControls() }
    }
    var onDraftChanged: ((Bool) -> Void)?
    var hasLastMessage: Bool { latest != nil }
    var hasDraft: Bool { !inlineInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var isVisible: Bool { window.isVisible }
    var isSendingInline: Bool { inlineSending }
    var isEditingInline: Bool { inlineEditing }

    override init() {
        super.init()
        window.title = "大肥鱼 · 回复气泡"
        window.delegate = self
        window.becomesKeyOnlyIfNeeded = true
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = true
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isFloatingPanel = true
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.animationBehavior = .none
        window.contentView = canvas
        sourceLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        sourceLabel.textColor = .secondaryLabelColor
        messageLabel.font = .systemFont(ofSize: 14)
        messageLabel.textColor = .labelColor
        messageLabel.maximumNumberOfLines = 8
        messageLabel.lineBreakMode = .byWordWrapping
        messageLabel.usesSingleLineMode = false
        messageLabel.cell?.wraps = true
        messageLabel.cell?.isScrollable = false
        messageLabel.preferredMaxLayoutWidth = 282
        messageLabel.setAccessibilityLabel("大肥鱼的气泡回复")
        messageLabel.addGestureRecognizer(NSClickGestureRecognizer(target: self, action: #selector(openChat(_:))))
        for (button, action) in [(openButton, #selector(openChat(_:))), (pinButton, #selector(togglePin(_:))), (laterButton, #selector(focusLater(_:))), (completeButton, #selector(completeReminder(_:))), (snoozeButton, #selector(snoozeReminder(_:))), (pendingButton, #selector(showPending(_:)))] {
            button.bezelStyle = .inline
            button.font = .systemFont(ofSize: 11, weight: .medium)
            button.target = self
            button.action = action
        }
        pinButton.setAccessibilityLabel("暂时留住气泡或取消固定")
        laterButton.setAccessibilityHelp("暂停主动聊天 15 分钟；本地提醒继续按设置送达")
        feedback.font = .systemFont(ofSize: 10)
        feedback.textColor = .secondaryLabelColor
        feedback.maximumNumberOfLines = 2
        feedback.lineBreakMode = .byWordWrapping
        feedback.usesSingleLineMode = false
        feedback.cell?.wraps = true
        feedback.cell?.isScrollable = false
        feedback.preferredMaxLayoutWidth = 282
        inlineInput.placeholderString = "直接回复…"
        inlineInput.font = .systemFont(ofSize: 12)
        inlineInput.delegate = self
        inlineInput.target = self
        inlineInput.action = #selector(sendInlineReply(_:))
        inlineInput.lineBreakMode = .byTruncatingTail
        inlineInput.usesSingleLineMode = true
        inlineInput.setAccessibilityLabel("在气泡里直接回复大肥鱼")
        inlineInput.setAccessibilityHelp("输入后按回车或发送；共用聊天记录与用量，不打开聊天窗口")
        inlineInput.onExplicitFocus = { [weak self] in self?.beginInlineEditing() }
        inlineSend.bezelStyle = .inline
        inlineSend.font = .systemFont(ofSize: 11, weight: .medium)
        inlineSend.target = self
        inlineSend.action = #selector(sendInlineReply(_:))
        inlineSend.setAccessibilityLabel("发送气泡回复")
        inlineSend.setContentHuggingPriority(.required, for: .horizontal)
        inlineSend.setContentCompressionResistancePriority(.required, for: .horizontal)
        inlineInput.setContentHuggingPriority(.defaultLow, for: .horizontal)
        inlineInput.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let composer = NSStackView(views: [inlineInput, inlineSend])
        composer.orientation = .horizontal
        composer.alignment = .centerY
        composer.spacing = 8
        composer.distribution = .fill
        let replyRow = NSStackView(views: [openButton, pinButton, laterButton])
        replyRow.spacing = 8
        replyRow.alignment = .centerY
        replyRow.distribution = .fillProportionally
        reminderRow.orientation = .horizontal
        reminderRow.alignment = .centerY
        reminderRow.distribution = .fillEqually
        reminderRow.addArrangedSubview(completeButton)
        reminderRow.addArrangedSubview(snoozeButton)
        reminderRow.spacing = 12
        controls.orientation = .vertical
        controls.alignment = .leading
        controls.spacing = 5
        controls.detachesHiddenViews = true
        for view in [replyRow, reminderRow, pendingButton, feedback, composer] { controls.addArrangedSubview(view) }
        reminderRow.isHidden = true
        pendingButton.isHidden = true
        feedback.isHidden = true
        closeButton.bezelStyle = .inline
        closeButton.font = .systemFont(ofSize: 18)
        closeButton.target = self
        closeButton.action = #selector(close(_:))
        closeButton.setAccessibilityLabel("关闭回复气泡")
        for view in [sourceLabel, messageLabel, controls, closeButton] { view.translatesAutoresizingMaskIntoConstraints = false; canvas.addSubview(view) }
        messageHeightConstraint = messageLabel.heightAnchor.constraint(equalToConstant: 17)
        feedbackHeightConstraint = feedback.heightAnchor.constraint(equalToConstant: 12)
        NSLayoutConstraint.activate([
            sourceLabel.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: 24),
            sourceLabel.topAnchor.constraint(equalTo: canvas.topAnchor, constant: 20),
            sourceLabel.trailingAnchor.constraint(lessThanOrEqualTo: closeButton.leadingAnchor, constant: -8),
            closeButton.trailingAnchor.constraint(equalTo: canvas.trailingAnchor, constant: -18),
            closeButton.centerYAnchor.constraint(equalTo: sourceLabel.centerYAnchor),
            closeButton.widthAnchor.constraint(equalToConstant: 22), closeButton.heightAnchor.constraint(equalToConstant: 22),
            messageLabel.leadingAnchor.constraint(equalTo: canvas.leadingAnchor, constant: 24),
            messageLabel.trailingAnchor.constraint(equalTo: canvas.trailingAnchor, constant: -24),
            messageLabel.topAnchor.constraint(equalTo: sourceLabel.bottomAnchor, constant: 8),
            messageHeightConstraint,
            controls.topAnchor.constraint(equalTo: messageLabel.bottomAnchor, constant: 8),
            controls.leadingAnchor.constraint(equalTo: messageLabel.leadingAnchor),
            controls.trailingAnchor.constraint(equalTo: messageLabel.trailingAnchor),
            controls.bottomAnchor.constraint(equalTo: canvas.bottomAnchor, constant: -19),
            replyRow.widthAnchor.constraint(equalTo: controls.widthAnchor),
            reminderRow.widthAnchor.constraint(equalTo: controls.widthAnchor),
            pendingButton.widthAnchor.constraint(lessThanOrEqualTo: controls.widthAnchor),
            feedback.widthAnchor.constraint(equalTo: controls.widthAnchor),
            feedbackHeightConstraint,
            composer.widthAnchor.constraint(equalTo: controls.widthAnchor),
            inlineInput.heightAnchor.constraint(equalToConstant: 24),
            inlineSend.widthAnchor.constraint(equalToConstant: 50),
            inlineSend.heightAnchor.constraint(equalToConstant: 24),
        ])
        canvas.onOpen = { [weak self] in self?.openChat(nil) }
        canvas.onHover = { [weak self] hovered in
            guard let self = self else { return }
            self.hovering = hovered
            if hovered { self.dismissTimer?.invalidate(); self.dismissTimer = nil }
            else { self.scheduleDismiss(after: 7) }
        }
    }

    func show(text: String, source: String, proactive: Bool, near pet: NSWindow?, kind: String? = nil, reminderId: String? = nil) {
        let message = Message(text: text, source: source, proactive: proactive, kind: kind, reminderId: reminderId)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        latest = message
        anchor = pet
        if (pinned || hasDraft || inlineEditing || inlineSending || actionInFlight) && window.isVisible {
            pendingCount = min(1_000_000, pendingCount + 1)
            refreshCurrent()
            return
        }
        present(message, near: pet)
    }
    func remember(text: String, source: String, proactive: Bool, kind: String? = nil, reminderId: String? = nil) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        latest = Message(text: text, source: source, proactive: proactive, kind: kind, reminderId: reminderId)
        if window.isVisible {
            pendingCount = min(1_000_000, pendingCount + 1)
            refreshCurrent()
        }
    }
    @discardableResult
    func showLatest(near pet: NSWindow?) -> Bool {
        guard let latest = latest else { return false }
        present(latest, near: pet)
        return true
    }
    private func present(_ message: Message, near pet: NSWindow?) {
        displayGeneration &+= 1
        current = message
        anchor = pet
        pinned = false
        pendingCount = 0
        if !inlineSending && !hasDraft { feedback.stringValue = "" }
        refreshCurrent()
        lastPetFrame = .zero
        presenting = true
        position(near: pet)
        presenting = false
        window.orderFrontRegardless()
        scheduleDismiss(after: message.proactive || message.reminderId != nil ? 30 : 22)
    }
    @discardableResult
    func prepare(text: String, source: String, proactive: Bool, kind: String? = nil, reminderId: String? = nil) -> Bool {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return false }
        let shortened = String(clean.prefix(280))
        messageLabel.stringValue = shortened + (clean.count > 280 ? "…" : "")
        let modelSource = ["codex", "llm", "api"].contains(source)
        if reminderId != nil { sourceLabel.stringValue = "大肥鱼 · 本地提醒" }
        else if kind != nil && source == "local" { sourceLabel.stringValue = "大肥鱼 · 本地通知" }
        else if source == "local" { sourceLabel.stringValue = proactive ? "大肥鱼 · 本地互动" : "大肥鱼 · 本地回复" }
        else if modelSource { sourceLabel.stringValue = proactive ? "大肥鱼 · 主动聊天" : "大肥鱼 · AI" }
        else { sourceLabel.stringValue = "大肥鱼 · 回复" }
        pinButton.title = pinned ? "取消固定" : "留住"
        reminderRow.isHidden = reminderId == nil
        pendingButton.title = "还有 \(pendingCount) 条新消息 · 显示最新"
        pendingButton.isHidden = pendingCount == 0
        feedback.isHidden = feedback.stringValue.isEmpty
        for button in [laterButton, completeButton, snoozeButton] { button.isEnabled = !actionInFlight && !inlineSending }
        updateInlineControls()
        let width: CGFloat = 330
        let textWidth = width - 48
        // NSTextFieldCell measures the same wrapping, fallback fonts and
        // maximum line count that it draws. A separate NSString estimate can
        // disagree with the rendered field and leave it compressed to one line.
        let bodyHeight = wrappedHeight(messageLabel, width: textWidth)
        messageHeightConstraint.constant = bodyHeight
        feedbackHeightConstraint.constant = wrappedHeight(feedback, width: textWidth)
        let fullTextHeight = (messageLabel.stringValue as NSString).boundingRect(with: NSSize(width: textWidth - 4, height: 10_000), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: messageLabel.font ?? NSFont.systemFont(ofSize: 14)]).height
        openButton.title = clean.count > 280 || fullTextHeight > bodyHeight + 1 ? "看全文 / 继续聊" : "继续聊"
        controls.layoutSubtreeIfNeeded()
        let controlsHeight = ceil(controls.fittingSize.height)
        let sourceHeight = ceil(sourceLabel.fittingSize.height)
        let height = 20 + sourceHeight + 8 + bodyHeight + 8 + controlsHeight + 19
        window.setContentSize(NSSize(width: width, height: height))
        canvas.layoutSubtreeIfNeeded()
        return true
    }
    private func wrappedHeight(_ label: NSTextField, width: CGFloat) -> CGFloat {
        let measured = label.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: width, height: 10_000)).height ?? label.intrinsicContentSize.height
        return max(1, ceil(measured))
    }
    private func refreshCurrent() {
        guard let message = current else { return }
        _ = prepare(text: message.text, source: message.source, proactive: message.proactive, kind: message.kind, reminderId: message.reminderId)
        lastPetFrame = .zero
        position(near: anchor)
    }
    func position(near pet: NSWindow?) {
        guard window.isVisible || presenting else { return }
        guard let pet = pet else { return }
        guard lastPetFrame != pet.frame || !window.isVisible else { return }
        lastPetFrame = pet.frame
        let visible = (pet.screen ?? NSScreen.main)?.visibleFrame ?? pet.frame.insetBy(dx: -500, dy: -300)
        let size = window.frame.size
        let margin: CGFloat = 8
        var origin: NSPoint
        if pet.frame.minX - size.width - margin >= visible.minX + margin {
            origin = NSPoint(x: pet.frame.minX - size.width - margin, y: pet.frame.midY - 36)
            canvas.tail = .right
        } else if pet.frame.maxX + size.width + margin <= visible.maxX - margin {
            origin = NSPoint(x: pet.frame.maxX + margin, y: pet.frame.midY - 36)
            canvas.tail = .left
        } else if pet.frame.maxY + size.height + margin <= visible.maxY - margin {
            origin = NSPoint(x: pet.frame.midX - size.width / 2, y: pet.frame.maxY + margin)
            canvas.tail = .bottom
        } else {
            origin = NSPoint(x: pet.frame.midX - size.width / 2, y: pet.frame.minY - size.height - margin)
            canvas.tail = .top
        }
        origin.x = max(visible.minX + margin, min(origin.x, visible.maxX - size.width - margin))
        origin.y = max(visible.minY + margin, min(origin.y, visible.maxY - size.height - margin))
        if window.frame.origin != origin { window.setFrameOrigin(origin) }
    }
    func hide() {
        displayGeneration &+= 1
        endInlineEditing()
        dismissTimer?.invalidate(); dismissTimer = nil; hovering = false
        pinned = false; pendingCount = 0
        window.orderOut(nil)
    }
    func shutdown() {
        stopped = true
        inlineRequestID = nil
        inlineSending = false
        actionRequestID = nil
        actionInFlight = false
        hide()
        onSendReply = nil
        onDraftChanged = nil
    }
    private func scheduleDismiss(after seconds: TimeInterval) {
        dismissTimer?.invalidate()
        guard window.isVisible, !hovering, !pinned, !actionInFlight, !hasDraft, !inlineEditing, !inlineSending else { return }
        let timer = Timer(timeInterval: seconds, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.dismissTimer = nil
            guard !self.hovering, !self.pinned, !self.actionInFlight, !self.hasDraft, !self.inlineEditing, !self.inlineSending else { return }
            self.hide()
        }
        RunLoop.main.add(timer, forMode: .common)
        dismissTimer = timer
    }
    func setConversationBusy(_ busy: Bool) {
        conversationBusy = busy
        updateInlineControls()
    }
    /// Used only by an explicit user action such as the reply menu item.
    /// Automatic show/replay never calls this or takes keyboard focus.
    func focusInlineReply() {
        guard !stopped, let message = latest ?? current else { return }
        if !window.isVisible { present(message, near: anchor) }
        window.orderFrontRegardless()
        beginInlineEditing()
    }
    private func updateInlineControls() {
        inlineSend.title = inlineSending ? "回复中" : "发送"
        inlineSend.isEnabled = !stopped && !conversationBusy && !inlineSending && !actionInFlight && onSendReply != nil && hasDraft
        inlineInput.isEnabled = !stopped
        inlineInput.placeholderString = conversationBusy || inlineSending ? "可先写好下一条…" : "直接回复…"
    }
    private func notifyDraft() { onDraftChanged?(hasDraft) }
    private func beginInlineEditing() {
        guard !stopped else { return }
        dismissTimer?.invalidate(); dismissTimer = nil
        // This path is reached only after an explicit input click or reply
        // menu action. Bring the app forward so the OS routes keyboard input
        // here as well as AppKit reporting a key panel/first responder.
        NSApp.activate(ignoringOtherApps: true)
        window.allowsInlineFocus = true
        inlineEditing = true
        window.makeKey()
        window.makeFirstResponder(inlineInput)
        notifyDraft()
    }
    private func endInlineEditing() {
        if inlineInput.currentEditor() != nil { window.makeFirstResponder(nil) }
        inlineEditing = false
        window.allowsInlineFocus = false
        if window.isKeyWindow { window.resignKey() }
        notifyDraft()
    }
    func controlTextDidBeginEditing(_ obj: Notification) {
        guard obj.object as? NSTextField === inlineInput else { return }
        inlineEditing = true
        window.allowsInlineFocus = true
        dismissTimer?.invalidate(); dismissTimer = nil
        notifyDraft()
    }
    func controlTextDidChange(_ obj: Notification) {
        guard obj.object as? NSTextField === inlineInput else { return }
        draftRevision &+= 1
        if hasDraft { dismissTimer?.invalidate(); dismissTimer = nil }
        if !inlineSending && !actionInFlight {
            feedback.stringValue = inlineInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).count > 4000 ? "消息太长，请缩短到 4000 字以内。" : ""
        }
        notifyDraft()
        refreshCurrent()
        if !hasDraft && !inlineEditing { scheduleDismiss(after: 7) }
    }
    func controlTextDidEndEditing(_ obj: Notification) {
        guard obj.object as? NSTextField === inlineInput else { return }
        inlineEditing = false
        window.allowsInlineFocus = false
        notifyDraft()
        scheduleDismiss(after: 7)
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        guard control === inlineInput else { return false }
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            if textView.hasMarkedText() { return false }
            sendInlineReply(nil)
            return true
        }
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            endInlineEditing()
            scheduleDismiss(after: 7)
            return true
        }
        return false
    }
    func windowDidResignKey(_ notification: Notification) {
        inlineEditing = false
        window.allowsInlineFocus = false
        notifyDraft()
        scheduleDismiss(after: 7)
    }
    @objc private func sendInlineReply(_ sender: Any?) {
        guard !stopped, !inlineSending, !actionInFlight else { return }
        guard !conversationBusy else {
            feedback.stringValue = "上一条消息还在回复中；当前输入已保留。"
            refreshCurrent()
            return
        }
        let raw = inlineInput.stringValue
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            feedback.stringValue = "先写一句话，再按发送。"
            refreshCurrent()
            return
        }
        guard text.count <= 4000 else {
            feedback.stringValue = "消息太长，请缩短到 4000 字以内。"
            refreshCurrent()
            return
        }
        guard let onSendReply = onSendReply else {
            feedback.stringValue = "本机聊天尚未连接，输入已保留，请稍后重试。"
            refreshCurrent()
            return
        }
        let requestID = UUID()
        let sentRevision = draftRevision
        inlineRequestID = requestID
        inlineSending = true
        feedback.stringValue = "大肥鱼正在想…"
        dismissTimer?.invalidate(); dismissTimer = nil
        refreshCurrent()
        notifyDraft()
        onSendReply(text) { [weak self] result in
            let finish = {
                guard let self = self, !self.stopped, self.inlineRequestID == requestID else { return }
                self.inlineRequestID = nil
                switch result {
                case .success:
                    // A later edit belongs to the user, even when it has the
                    // same text. Only the exact submitted revision is cleared.
                    if self.draftRevision == sentRevision && self.inlineInput.stringValue == raw {
                        self.endInlineEditing()
                        self.inlineInput.stringValue = ""
                        self.draftRevision &+= 1
                        self.pinned = false
                        self.feedback.stringValue = ""
                    } else {
                        self.feedback.stringValue = "已发送；当前输入已保留。"
                    }
                case .failure(let error):
                    self.feedback.stringValue = "发送未完成，输入已保留。" + String(error.localizedDescription.prefix(130))
                }
                self.inlineSending = false
                self.notifyDraft()
                self.refreshCurrent()
                self.scheduleDismiss(after: 22)
            }
            // The shared chat calls completion before showing its answer.
            // Keep this synchronous on main so sending cannot swallow it.
            if Thread.isMainThread { finish() }
            else { DispatchQueue.main.async(execute: finish) }
        }
    }
    @objc private func close(_ sender: Any?) { hide() }
    @objc private func openChat(_ sender: Any?) { hide(); onOpenChat?() }
    @objc private func showPending(_ sender: Any?) {
        guard let latest = latest else { return }
        present(latest, near: anchor)
    }
    @objc private func togglePin(_ sender: Any?) {
        pinned.toggle()
        refreshCurrent()
        if pinned { dismissTimer?.invalidate(); dismissTimer = nil }
        else { scheduleDismiss(after: 22) }
    }
    @objc private func focusLater(_ sender: Any?) {
        guard let onFocus = onFocus, !actionInFlight else { return }
        performAction { done in onFocus(15, done) }
    }
    @objc private func completeReminder(_ sender: Any?) { reminderAction("complete") }
    @objc private func snoozeReminder(_ sender: Any?) { reminderAction("snooze") }
    private func reminderAction(_ action: String) {
        guard let id = current?.reminderId, let onReminderAction = onReminderAction, !actionInFlight else { return }
        performAction { done in onReminderAction(id, action, 10, done) }
    }
    private func performAction(_ operation: (@escaping (Bool) -> Void) -> Void) {
        let requestID = UUID()
        actionRequestID = requestID
        actionInFlight = true
        dismissTimer?.invalidate(); dismissTimer = nil
        feedback.stringValue = "正在保存…"
        refreshCurrent()
        let generation = displayGeneration
        operation { [weak self] succeeded in
            DispatchQueue.main.async {
                guard let self = self, self.actionRequestID == requestID else { return }
                self.actionRequestID = nil
                self.actionInFlight = false
                guard self.displayGeneration == generation else {
                    if self.feedback.stringValue == "正在保存…" { self.feedback.stringValue = "" }
                    self.refreshCurrent()
                    self.scheduleDismiss(after: 22)
                    return
                }
                if succeeded { self.hide() }
                else {
                    self.feedback.stringValue = "尚未保存成功，请稍后重试。"
                    self.refreshCurrent()
                    self.scheduleDismiss(after: 15)
                }
            }
        }
    }
}
