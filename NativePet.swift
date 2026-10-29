import AppKit
import Foundation
import QuartzCore

private let dataRoot = AppPaths.dataRoot

struct PetSettings: Codable {
    var x: Double?
    var y: Double?
    var height: Double = 180
    var wandering = false
    var screenshotEnabled: Bool?
    var appInfoEnabled: Bool? = false
    var proactiveCursor: String?
    var automaticActions: Bool?
}

/// Only an absent file inside a readable data directory is a first launch.
/// Permission, I/O and decoding failures must never become default settings.
func loadPetSettings(from file: URL) throws -> PetSettings {
    do { return try JSONDecoder().decode(PetSettings.self, from: Data(contentsOf: file)) }
    catch {
        let value = error as NSError
        guard value.domain == NSCocoaErrorDomain && value.code == CocoaError.fileReadNoSuchFile.rawValue else { throw error }
        // Existing settings need only their own file access. Enumerating the
        // whole directory is reserved for proving a genuine first launch.
        let entries = try FileManager.default.contentsOfDirectory(at: file.deletingLastPathComponent(), includingPropertiesForKeys: nil)
        guard !entries.contains(where: { $0.lastPathComponent == file.lastPathComponent }) else { throw error }
        return PetSettings()
    }
}

struct ChatRecord: Codable {
    var role: String
    var content: String
    var time: Date = Date()
    var model: String?
    var source: String?
    var messageId: String?
    var reminderId: String?
    var kind: String?
}

@discardableResult
private func writePrivateJSON<T: Encodable>(_ value: T, to file: URL) -> Bool {
    do {
        try FileManager.default.createDirectory(at: dataRoot, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(value).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return true
    } catch {
        NSLog("DesktopWhalePet: unable to save local data: %@", error.localizedDescription)
        return false
    }
}

private func readJSON<T: Decodable>(_ type: T.Type, from file: URL) -> T? {
    guard let data = try? Data(contentsOf: file) else { return nil }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try? decoder.decode(type, from: data)
}

final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class ChatPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func cancelOperation(_ sender: Any?) { orderOut(sender) }
}

final class PetView: NSView {
    private struct CachedFrame {
        let image: CGImage
        let width: Int
        let height: Int
        let alpha: [UInt8]
        let groundInset: CGFloat
    }

    weak var owner: PetApp?
    var image: NSImage? { didSet { rebuildFrames() } }
    var spriteSheet: NSImage? { didSet { rebuildFrames() } }
    private var frames: [CachedFrame] = []
    private var actionFrames: [String: [CachedFrame]] = [:]
    private var actionTimeline: PetActionTimeline?
    private var actionSample: PetActionSample?
    private var displayedFrame: CachedFrame?
    private var displayedFrameKey = ""
    private var movementAllowed = false
    private var manualActionActive = false
    private var continuousWalking = false
    private var nextDailyAction = 25.0
    private(set) var extraActions: [(id: String, title: String)] = []
    var actionsAvailable: Bool { !actionFrames.isEmpty }
    var isWalking: Bool { movementAllowed && !reducedMotion && actionSample?.walking == true }
    var activeActionClip: String? { actionSample?.clipID }
    var hasExclusiveAction: Bool { manualActionActive && actionTimeline?.sample(at: phase) != nil }
    var blocksWalking: Bool { emotion == .thinking || emotion == .listening || emotion == .sleepy }
    private(set) var frameIndex = 0
    private var nextBlink = Double.random(in: 4...6)
    private var blinkStarted: Double?
    private var nextIdleWave = 10.0
    private var waveStarted = 0.0
    private var waveUntil = 0.0
    var phase: Double = 0
    var lookingLeft = false { didSet { if lookingLeft != oldValue { setFacing(); installMotionAnimations() } } }
    private(set) var emotion: PetEmotion = .idle
    private var emotionUntil: Double?
    var reducedMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    var thinking: Bool {
        get { emotion == .thinking }
        set {
            if newValue { setEmotion(.thinking) }
            else if emotion == .thinking { setEmotion(.idle) }
        }
    }
    var dragging = false
    var isHovered: Bool { hovered }
    private var startMouse = NSPoint.zero
    private var startWindow = NSPoint.zero
    private var moved = false
    private var hovered = false
    private var tracking: NSTrackingArea?

    // Core Animation keeps bobbing and breathing out of the app's draw loop.
    private let shadowLayer = CALayer()
    private let motionLayer = CALayer()
    private let breathLayer = CALayer()
    private let imageLayer = CALayer()
    private let fallbackLayer = CATextLayer()
    private var emotionAnimator: PetEmotionAnimator!

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.masksToBounds = false
        shadowLayer.backgroundColor = NSColor.black.withAlphaComponent(0.10).cgColor
        layer?.addSublayer(shadowLayer)
        layer?.addSublayer(motionLayer)
        motionLayer.addSublayer(breathLayer)
        breathLayer.addSublayer(imageLayer)
        breathLayer.addSublayer(fallbackLayer)
        imageLayer.contentsGravity = .resizeAspect
        imageLayer.minificationFilter = .linear
        imageLayer.magnificationFilter = .linear
        fallbackLayer.string = "🐋"
        fallbackLayer.fontSize = 90
        fallbackLayer.alignmentMode = .center
        fallbackLayer.contentsScale = 2
        emotionAnimator = PetEmotionAnimator(motion: motionLayer, breath: breathLayer, parent: layer!)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(motionPreferenceChanged(_:)), name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
        toolTip = "蓝色大肥鱼 · 点我聊天，拖动移动，右键更多"
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("蓝色大肥鱼桌面宠物")
        setAccessibilityHelp("点击打开聊天，拖动移动，右键打开宠物菜单")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    var characterAspectRatio: CGFloat {
        if let first = frames.first { return CGFloat(first.width) / CGFloat(first.height) }
        return (spriteSheet ?? image).map { $0.size.width / max(1, $0.size.height) } ?? 1
    }

    private func cachedFrame(_ source: CGImage) -> CachedFrame? {
        // Rasterize once at the largest supported Retina display size, never per timer tick.
        let factor = min(1.0, 520.0 / Double(max(source.width, source.height)))
        let width = max(1, Int((Double(source.width) * factor).rounded()))
        let height = max(1, Int((Double(source.height) * factor).rounded()))
        let info = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info) else { return nil }
        context.interpolationQuality = .high
        context.draw(source, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let rendered = context.makeImage(), let data = context.data else { return nil }
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        let alpha = (0..<(width * height)).map { bytes[$0 * 4 + 3] }
        var groundRow = height - 1
        let minimum = max(3, width / 60)
        for y in stride(from: height - 1, through: 0, by: -1) {
            if (0..<width).reduce(0, { $0 + (alpha[y * width + $1] > 96 ? 1 : 0) }) >= minimum { groundRow = y; break }
        }
        return CachedFrame(image: rendered, width: width, height: height, alpha: alpha, groundInset: CGFloat(height - groundRow - 1) / CGFloat(height))
    }

    private func rebuildFrames() {
        frames.removeAll(keepingCapacity: true)
        if let sheet = spriteSheet, let cg = sheet.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            let width = cg.width / 2
            let height = cg.height / 2
            if width > 0 && height > 0 {
                for index in 0..<4 {
                    // CGImage pixel rectangles are top-origin, matching the asset's cell order.
                    let rect = CGRect(x: (index % 2) * width, y: (index / 2) * height, width: width, height: height)
                    if let crop = cg.cropping(to: rect), let frame = cachedFrame(crop) { frames.append(frame) }
                }
            }
        }
        if frames.count != 4 {
            frames.removeAll(keepingCapacity: true)
            if let cg = image?.cgImage(forProposedRect: nil, context: nil, hints: nil), let frame = cachedFrame(cg) {
                frames.append(frame)
            }
        }
        frameIndex = 0
        displayedFrameKey = ""
        showFrame()
        layoutLayers()
    }

    override func layout() { super.layout(); layoutLayers() }
    override func setFrameSize(_ newSize: NSSize) { super.setFrameSize(newSize); layoutLayers() }

    private func layoutLayers() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        let target = bounds.insetBy(dx: 8, dy: 10)
        let height = min(target.height, target.width / max(0.01, characterAspectRatio))
        let width = height * characterAspectRatio
        let y = actionSample != nil ? 14 - height * (displayedFrame?.groundInset ?? 0) : bounds.midY - height / 2
        let imageRect = CGRect(x: bounds.midX - width / 2, y: y, width: width, height: height)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        shadowLayer.frame = CGRect(x: bounds.width * 0.22, y: 4, width: bounds.width * 0.56, height: 7)
        shadowLayer.cornerRadius = 3.5
        motionLayer.frame = bounds
        breathLayer.frame = motionLayer.bounds
        imageLayer.bounds = CGRect(origin: .zero, size: imageRect.size)
        imageLayer.position = CGPoint(x: imageRect.midX, y: imageRect.midY)
        fallbackLayer.frame = imageRect
        fallbackLayer.isHidden = !frames.isEmpty
        emotionAnimator?.layout(in: bounds)
        CATransaction.commit()
        setFacing()
        installMotionAnimations()
    }

    private func installMotionAnimations() {
        guard bounds.width > 0 else { return }
        // A drawn walk/eating sequence already moves the body. Keep emotion
        // symbols but avoid stacking whole-body bob/jumps over the gait.
        emotionAnimator?.apply(emotion, hovered: hovered, facingLeft: lookingLeft, reducedMotion: reducedMotion || actionSample != nil)
    }
    @objc private func motionPreferenceChanged(_ notification: Notification) { installMotionAnimations(); updateAnimation() }

    private func setFacing() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.transform = CATransform3DMakeScale(lookingLeft ? -1 : 1, 1, 1)
        CATransaction.commit()
    }

    private func showFrame() {
        let frame: CachedFrame?
        let key: String
        if let sample = actionSample, let clip = actionFrames[sample.clipID], clip.indices.contains(sample.frameIndex) {
            frame = clip[sample.frameIndex]
            key = "action:\(sample.clipID):\(sample.frameIndex)"
        } else {
            frame = frames.isEmpty ? nil : frames[min(frameIndex, frames.count - 1)]
            key = "seated:\(frameIndex)"
        }
        guard key != displayedFrameKey else { return }
        let actionChanged = displayedFrameKey.hasPrefix("action:") != key.hasPrefix("action:")
        displayedFrame = frame
        displayedFrameKey = key
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.contents = frame?.image
        fallbackLayer.isHidden = frame != nil
        CATransaction.commit()
        // Generated sheets can place the same shoe baseline at different
        // vertical offsets. Translate the canvas to one ground line; do not
        // resize or re-centre each body, and keep the hit test on this layer.
        if actionSample != nil || actionChanged { layoutLayers() }
        if actionChanged {
            installMotionAnimations()
            if !reducedMotion { let fade = CATransition(); fade.type = .fade; fade.duration = 0.12; imageLayer.add(fade, forKey: "pose-transition") }
        }
    }

    /// Trim one common transparent border for the whole pack. Every frame
    /// keeps the same registration; individual poses are never re-centred.
    @discardableResult
    func installActions(_ library: PetActionLibrary) -> Bool {
        var union = CGRect.null
        for clip in library.clips.values {
            for image in clip.frames {
                guard let frame = cachedFrame(image) else { return false }
                var minX = frame.width, minY = frame.height, maxX = -1, maxY = -1
                for y in 0..<frame.height { for x in 0..<frame.width where frame.alpha[y * frame.width + x] > 20 {
                    minX = min(minX, x); minY = min(minY, y); maxX = max(maxX, x); maxY = max(maxY, y)
                } }
                guard maxX >= minX, maxY >= minY else { return false }
                union = union.union(CGRect(x: Double(minX) / Double(frame.width), y: Double(minY) / Double(frame.height), width: Double(maxX - minX + 1) / Double(frame.width), height: Double(maxY - minY + 1) / Double(frame.height)))
            }
        }
        guard !union.isNull else { return false }
        let side = min(1, max(0.25, max(union.width, union.height) + 0.06))
        let origin = CGPoint(x: max(0, min(1 - side, union.midX - side / 2)), y: max(0, min(1 - side, union.midY - side / 2)))
        var prepared: [String: [CachedFrame]] = [:]
        for (id, clip) in library.clips {
            var values: [CachedFrame] = []
            for image in clip.frames {
                let size = max(1, min(image.width, Int(ceil(side * CGFloat(image.width)))))
                let x = max(0, min(image.width - size, Int(floor(origin.x * CGFloat(image.width)))))
                let y = max(0, min(image.height - size, Int(floor(origin.y * CGFloat(image.height)))))
                guard let crop = image.cropping(to: CGRect(x: x, y: y, width: size, height: size)), let frame = cachedFrame(crop) else { return false }
                values.append(frame)
            }
            prepared[id] = values
        }
        actionFrames = prepared
        extraActions = library.clips.values.filter { !PetActionLibrary.requiredClipIDs.contains($0.id) }.sorted { $0.id < $1.id }.map { ($0.id, $0.displayName) }
        actionTimeline = PetActionTimeline(library: library)
        actionSample = nil; manualActionActive = false; continuousWalking = false
        displayedFrameKey = ""; showFrame()
        return true
    }

    func playAction(_ kind: PetActionKind, duration: Double? = nil) {
        guard actionTimeline?.play(kind, at: phase, duration: duration) == true else { return }
        manualActionActive = true; continuousWalking = false
        nextDailyAction = phase + Double.random(in: 90...180)
        updateAnimation()
    }
    func startWandering() {
        guard actionTimeline?.play(.walk, at: phase, continuous: true) == true else { return }
        manualActionActive = false; continuousWalking = true
        updateAnimation()
    }
    func playExtraAction(_ id: String, duration: Double? = nil) {
        guard actionTimeline?.playClip(id, at: phase, duration: duration) == true else { return }
        manualActionActive = true; continuousWalking = false
        nextDailyAction = phase + Double.random(in: 90...180)
        updateAnimation()
    }
    @discardableResult
    func tryAutomaticActivity(duration: Double) -> Bool {
        guard duration.isFinite, duration > 0, duration <= 120,
              !hasExclusiveAction, !reducedMotion, emotion == .idle else { return false }
        let candidates = ["standUp", "eat"] + extraActions.map(\.id)
        guard let selected = candidates.filter({ actionFrames[$0]?.isEmpty == false }).randomElement() else { return false }
        if let kind = PetActionKind(rawValue: selected) { playAction(kind, duration: duration) }
        else { playExtraAction(selected, duration: duration) }
        return hasExclusiveAction
    }
    func updateActivity(wandering: Bool, movementAllowed: Bool, idleAllowed: Bool, automatic: Bool, roamWalkingRequested: Bool = true) {
        self.movementAllowed = movementAllowed && roamWalkingRequested && !reducedMotion
        guard actionsAvailable else { return }
        if actionTimeline?.sample(at: phase) == nil { actionTimeline?.cancel(); manualActionActive = false; continuousWalking = false }
        if !manualActionActive {
            if wandering && self.movementAllowed && !continuousWalking {
                continuousWalking = actionTimeline?.play(.walk, at: phase, continuous: true) == true
            } else if !wandering && continuousWalking {
                continuousWalking = false
                playAction(.sitDown)
            }
            if !wandering && !continuousWalking && automatic && idleAllowed && !reducedMotion && emotion == .idle && phase >= nextDailyAction {
                _ = tryAutomaticActivity(duration: 8)
            }
        }
    }

    func setEmotion(_ value: PetEmotion, duration: Double? = nil) {
        if value == .thinking || value == .listening || value == .sleepy {
            actionTimeline?.cancel(); manualActionActive = false; continuousWalking = false; actionSample = nil
            showFrame()
        }
        emotionUntil = duration.map { phase + $0 }
        if emotion != value {
            emotion = value
            installMotionAnimations()
        }
        setAccessibilityValue(value.title)
        updateAnimation()
    }

    func triggerWave(duration: Double = 1.0) {
        guard !reducedMotion, emotion != .sleepy, emotion != .thinking else { return }
        if phase >= waveUntil { waveStarted = phase }
        waveUntil = max(waveUntil, phase + duration)
        updateAnimation()
    }

    func updateAnimation() {
        if let until = emotionUntil, phase >= until { setEmotion(.idle); return }
        let previousAction = actionSample
        actionSample = actionTimeline?.sample(at: phase, reducedMotion: reducedMotion)
        if actionSample?.walking == true && !movementAllowed { actionSample = PetActionSample(clipID: "stand", frameIndex: 0, walking: false) }
        guard frames.count == 4 else { showFrame(); return }
        if emotion == .idle && !reducedMotion && phase >= nextIdleWave {
            nextIdleWave = phase + 10
            if phase >= waveUntil { waveStarted = phase }
            waveUntil = max(waveUntil, phase + 1)
        }
        let previous = frameIndex
        if emotion == .sleepy {
            frameIndex = 1
        } else if reducedMotion {
            frameIndex = emotion == .happy ? 2 : 0
        } else if emotion == .happy {
            frameIndex = 2 + Int(phase / 0.22) % 2
        } else if emotion == .curious || emotion == .listening || emotion == .thinking {
            frameIndex = 0
        } else if phase < waveUntil {
            frameIndex = 2 + Int((phase - waveStarted) / 0.20) % 2
        } else {
            if phase >= nextBlink { blinkStarted = phase; nextBlink = phase + Double.random(in: 4...6) }
            frameIndex = blinkStarted.map { phase - $0 < 0.15 } == true ? 1 : 0
        }
        if frameIndex != previous || actionSample != previousAction {
            showFrame()
        }
        let titles = ["standUp":"正在站起来", "stand":"站着等待", "walk":"正在走路", "eat":"正在吃饭", "sitDown":"正在坐下", "cheer":"拉拉队应援", "gaming":"正在打游戏", "music":"正在听歌"]
        setAccessibilityValue(actionSample.flatMap { sample in titles[sample.clipID] ?? extraActions.first(where: { $0.id == sample.clipID })?.title } ?? emotion.title)
    }

    func opaque(at local: NSPoint) -> Bool {
        guard bounds.contains(local), let root = layer else { return false }
        let imagePresentation = imageLayer.presentation()
        let target = imagePresentation ?? imageLayer
        let origin = imagePresentation == nil ? root : (root.presentation() ?? root)
        let point = target.convert(local, from: origin)
        guard target.bounds.contains(point), target.bounds.width > 0, target.bounds.height > 0 else { return false }
        guard let frame = displayedFrame else { return true }
        let u = (point.x - target.bounds.minX) / target.bounds.width
        let v = (point.y - target.bounds.minY) / target.bounds.height
        let x = max(0, min(frame.width - 1, Int(u * CGFloat(frame.width))))
        let y = max(0, min(frame.height - 1, Int((1 - v) * CGFloat(frame.height))))
        return frame.alpha[y * frame.width + x] > 20
    }

    override func hitTest(_ point: NSPoint) -> NSView? { opaque(at: convert(point, from: superview)) ? self : nil }
    override func accessibilityPerformPress() -> Bool { triggerWave(); owner?.showChat(nil); return true }
    override func updateTrackingAreas() {
        if let tracking = tracking { removeTrackingArea(tracking) }
        tracking = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        if let tracking = tracking { addTrackingArea(tracking) }
        super.updateTrackingAreas()
    }
    override func mouseEntered(with event: NSEvent) {
        hovered = true
        installMotionAnimations()
        triggerWave()
        NSCursor.openHand.set()
    }
    override func mouseExited(with event: NSEvent) { hovered = false; installMotionAnimations() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.control) { rightMouseDown(with: event); return }
        startMouse = NSEvent.mouseLocation
        startWindow = window?.frame.origin ?? .zero
        moved = false
        dragging = true
        NSCursor.closedHand.set()
    }
    override func mouseDragged(with event: NSEvent) {
        guard let owner = owner else { return }
        let mouse = NSEvent.mouseLocation
        let dx = mouse.x - startMouse.x
        let dy = mouse.y - startMouse.y
        if abs(dx) + abs(dy) > 4 { moved = true }
        owner.movePet(to: NSPoint(x: startWindow.x + dx, y: startWindow.y + dy), save: false)
    }
    override func mouseUp(with event: NSEvent) {
        dragging = false
        NSCursor.openHand.set()
        owner?.savePetPosition()
        if !moved { triggerWave(); owner?.showChat(nil) }
    }
    override func rightMouseDown(with event: NSEvent) {
        guard let menu = owner?.makeMenu() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }
}
final class ChatController: NSObject, NSWindowDelegate {
    weak var owner: PetApp?
    let window: ChatPanel
    private let transcript = NSTextView()
    private let input = NSTextField()
    private let send = NSButton(title: "发送", target: nil, action: nil)
    private let status = NSTextField(labelWithString: "连接本地桌宠服务中…")
    private let awareness = DesktopAwareness()
    private let transcriptScroll = NSScrollView()
    private let screenshotToggle = NSButton(checkboxWithTitle: "聊天附图（API 视觉模型）", target: nil, action: nil)
    private let appInfoToggle = NSButton(checkboxWithTitle: "聊天时附带应用信息（应用名、窗口标题）", target: nil, action: nil)
    private let captureNote = NSTextField(wrappingLabelWithString: "窗口截图需 API 视觉模型；Codex 模式仅文字。正在读取频率设置…")
    private let contextLabel = NSTextField(labelWithString: "当前目标应用：尚未记录")
    private let contextStatus = NSTextField(wrappingLabelWithString: "最近截图：尚未发送")
    private var messages: [ChatRecord] = []
    private var busy = false { didSet { onBusyChanged?(busy) } }
    var onBusyChanged: ((Bool) -> Void)?
    private var scrollGeneration: UInt64 = 0
    private var pendingInlineCompletion: ((Result<Void, Error>) -> Void)?
    private var requestGeneration: UInt64 = 0
    private var request: URLSessionDataTask?
    private var policyRequest: URLSessionDataTask?
    private var screenshotPolicy: ScreenshotPolicy?
    private var policyGeneration: UInt64 = 0
    private let chatFile = dataRoot.appendingPathComponent("chat.json")

    override init() {
        window = ChatPanel(contentRect: NSRect(x: 0, y: 0, width: 450, height: 650),
                           styleMask: [.titled, .closable, .resizable, .miniaturizable],
                           backing: .buffered, defer: false)
        super.init()
        window.title = "大肥鱼 · 桌面聊天"
        window.minSize = NSSize(width: 380, height: 500)
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.delegate = self
        messages = readJSON([ChatRecord].self, from: chatFile) ?? []
        awareness.start()
        buildUI()
        redrawTranscript()
    }

    private func buildUI() {
        let root = NSView()
        window.contentView = root
        let title = NSTextField(labelWithString: "🐋  蓝色大肥鱼")
        title.font = .systemFont(ofSize: 18, weight: .semibold)
        let subtitle = NSTextField(labelWithString: "桌面上的聊天搭子，想聊就点我。")
        subtitle.font = .systemFont(ofSize: 12)
        subtitle.textColor = .secondaryLabelColor
        let connection = NSButton(title: "AI 连接设置", target: self, action: #selector(showAISettings(_:)))
        connection.bezelStyle = .inline
        connection.font = .systemFont(ofSize: 11)
        let titleRow = NSStackView(views: [title, connection])
        titleRow.spacing = 12
        let header = NSStackView(views: [titleRow, subtitle])
        header.orientation = .vertical
        header.alignment = .leading
        header.spacing = 5
        screenshotToggle.target = self
        screenshotToggle.action = #selector(toggleScreenshot(_:))
        screenshotToggle.state = .off
        appInfoToggle.target = self
        appInfoToggle.action = #selector(toggleAppInfo(_:))
        appInfoToggle.state = .off
        appInfoToggle.font = .systemFont(ofSize: 12)
        appInfoToggle.setAccessibilityLabel("聊天时附带应用信息，包含应用名和窗口标题")
        captureNote.font = .systemFont(ofSize: 11)
        captureNote.textColor = .secondaryLabelColor
        contextLabel.font = .systemFont(ofSize: 11)
        contextLabel.textColor = .secondaryLabelColor
        contextLabel.lineBreakMode = .byTruncatingTail
        contextStatus.font = .systemFont(ofSize: 11)
        contextStatus.textColor = .secondaryLabelColor
        let screenshotSettings = NSButton(title: "截图设置", target: self, action: #selector(showScreenshotSettings(_:)))
        screenshotSettings.bezelStyle = .inline
        screenshotSettings.font = .systemFont(ofSize: 11)
        screenshotSettings.setAccessibilityLabel("截图设置")
        let screenshotRow = NSStackView(views: [screenshotToggle, screenshotSettings])
        screenshotRow.spacing = 10
        screenshotRow.alignment = .centerY
        let awarenessBox = NSStackView(views: [appInfoToggle, screenshotRow, captureNote, contextLabel, contextStatus])
        awarenessBox.orientation = .vertical
        awarenessBox.alignment = .leading
        awarenessBox.spacing = 4
        let scroll = transcriptScroll
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 10
        transcript.isEditable = false
        transcript.isSelectable = true
        transcript.isRichText = true
        transcript.drawsBackground = true
        transcript.backgroundColor = .textBackgroundColor
        transcript.textContainerInset = NSSize(width: 12, height: 12)
        transcript.isVerticallyResizable = true
        transcript.isHorizontallyResizable = false
        transcript.autoresizingMask = [.width]
        transcript.minSize = NSSize(width: 0, height: 0)
        transcript.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        transcript.textContainer?.widthTracksTextView = true
        scroll.documentView = transcript
        input.placeholderString = "说点什么…"
        input.font = .systemFont(ofSize: 14)
        input.bezelStyle = .roundedBezel
        input.focusRingType = .none
        input.target = self
        input.action = #selector(sendMessage(_:))
        input.setAccessibilityLabel("给大肥鱼发消息")
        send.target = self
        send.action = #selector(sendMessage(_:))
        send.bezelStyle = .rounded
        let inputRow = NSStackView(views: [input, send])
        inputRow.orientation = .horizontal
        inputRow.spacing = 8
        input.setContentHuggingPriority(.defaultLow, for: .horizontal)
        send.setContentHuggingPriority(.required, for: .horizontal)
        status.font = .systemFont(ofSize: 11)
        status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byTruncatingTail
        let clear = NSButton(title: "新对话", target: self, action: #selector(clearHistory(_:)))
        clear.bezelStyle = .inline
        clear.font = .systemFont(ofSize: 11)
        let tasks = NSButton(title: "后台任务", target: self, action: #selector(showTasks(_:)))
        tasks.bezelStyle = .inline
        tasks.font = .systemFont(ofSize: 11)
        let memory = NSButton(title: "记忆", target: self, action: #selector(showMemory(_:)))
        memory.bezelStyle = .inline
        memory.font = .systemFont(ofSize: 11)
        let footer = NSStackView(views: [status, tasks, memory, clear])
        footer.spacing = 6
        status.setContentHuggingPriority(.defaultLow, for: .horizontal)
        tasks.setContentHuggingPriority(.required, for: .horizontal)
        memory.setContentHuggingPriority(.required, for: .horizontal)
        clear.setContentHuggingPriority(.required, for: .horizontal)
        let proactive = NSButton(title: "主动聊天", target: self, action: #selector(showProactiveSettings(_:)))
        proactive.bezelStyle = .inline
        proactive.font = .systemFont(ofSize: 11)
        let reminders = NSButton(title: "提醒与待办", target: self, action: #selector(showLocalTasks(_:)))
        let usage = NSButton(title: "用量与预算", target: self, action: #selector(showUsage(_:)))
        for button in [reminders, usage] { button.bezelStyle = .inline; button.font = .systemFont(ofSize: 11) }
        let proactiveRow = NSStackView(views: [proactive, reminders, usage])
        proactiveRow.spacing = 12
        proactiveRow.alignment = .centerY
        for view in [header, awarenessBox, scroll, inputRow, proactiveRow, footer] { view.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(view) }
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            header.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            awarenessBox.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12),
            awarenessBox.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 18),
            awarenessBox.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -18),
            captureNote.widthAnchor.constraint(equalTo: awarenessBox.widthAnchor),
            contextLabel.widthAnchor.constraint(equalTo: awarenessBox.widthAnchor),
            contextStatus.widthAnchor.constraint(equalTo: awarenessBox.widthAnchor),
            scroll.topAnchor.constraint(equalTo: awarenessBox.bottomAnchor, constant: 12),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            scroll.bottomAnchor.constraint(equalTo: inputRow.topAnchor, constant: -12),
            inputRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            inputRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            inputRow.heightAnchor.constraint(equalToConstant: 34),
            inputRow.bottomAnchor.constraint(equalTo: proactiveRow.topAnchor, constant: -7),
            proactiveRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            proactiveRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            proactiveRow.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -5),
            proactiveRow.heightAnchor.constraint(equalToConstant: 18),
            footer.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            footer.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            footer.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
            footer.heightAnchor.constraint(equalToConstant: 20),
            send.widthAnchor.constraint(equalToConstant: 60)
        ])
    }

    func show(near pet: NSWindow?) {
        if !window.isVisible {
            let screen = pet?.screen ?? NSScreen.main
            let visible = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1200, height: 800)
            let petFrame = pet?.frame ?? visible
            let x = max(visible.minX + 12, min(petFrame.minX - window.frame.width - 14, visible.maxX - window.frame.width - 12))
            let y = max(visible.minY + 12, min(petFrame.midY - window.frame.height / 2, visible.maxY - window.frame.height - 12))
            window.setFrameOrigin(NSPoint(x: x, y: y))
        }
        NSApp.activate(ignoringOtherApps: true)
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(input)
        scrollToLatestMessage()
        refreshContextLabel()
        checkHealth()
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); if !busy { owner?.petView.setEmotion(.idle) }; return false }
    @objc private func showTasks(_ sender: Any?) { owner?.showTasks(sender) }
    @objc private func showAISettings(_ sender: Any?) { owner?.showAISettings(sender) }
    @objc private func showMemory(_ sender: Any?) { owner?.showMemory(sender) }
    @objc private func showScreenshotSettings(_ sender: Any?) { owner?.showScreenshotSettings(sender) }
    @objc private func showProactiveSettings(_ sender: Any?) { owner?.showProactiveSettings(sender) }
    @objc private func showLocalTasks(_ sender: Any?) { owner?.showLocalTasks(sender) }
    @objc private func showUsage(_ sender: Any?) { owner?.showUsage(sender) }
    var isBusy: Bool { busy }
    var hasDraft: Bool { !input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    func configureAwareness(enabled: Bool, appInfoEnabled: Bool = false) {
        awareness.screenshotEnabled = enabled
        awareness.appInfoEnabled = appInfoEnabled
        screenshotToggle.state = enabled ? .on : .off
        appInfoToggle.state = appInfoEnabled ? .on : .off
        refreshContextLabel()
    }

    func shutdown() {
        requestGeneration &+= 1
        request?.cancel(); request = nil
        policyRequest?.cancel(); awareness.stop()
        finishRequest(.failure(NSError(domain: "WhaleChat", code: 6, userInfo: [NSLocalizedDescriptionKey: "桌宠正在关闭，草稿已保留。"])))
    }

    func applyScreenshotPolicy(_ policy: ScreenshotPolicy) {
        guard policy.isValid else { return }
        policyGeneration &+= 1
        policyRequest?.cancel()
        policyRequest = nil
        screenshotPolicy = policy
        captureNote.stringValue = "窗口截图仅发给 API 视觉模型 · " + policy.summary
    }

    private func refreshScreenshotPolicy() {
        guard let token = token(), let url = AppPaths.serviceURL("/api/screen-policy") else { return }
        policyRequest?.cancel()
        policyGeneration &+= 1
        let generation = policyGeneration
        var request = URLRequest(url: url)
        request.timeoutInterval = 6
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        policyRequest = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.policyGeneration == generation else { return }
                self.policyRequest = nil
                guard error == nil, let response = response as? HTTPURLResponse, response.statusCode == 200,
                      let data = data, let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      let item = value["policy"] as? [String: Any], let seconds = item["minIntervalSeconds"] as? Int,
                      let limit = item["dailyLimit"] as? Int else { return }
                self.applyScreenshotPolicy(ScreenshotPolicy(minIntervalSeconds: seconds, dailyLimit: limit))
            }
        }
        policyRequest?.resume()
    }

    private func refreshContextLabel() {
        contextLabel.stringValue = "本地目标预览：" + awareness.currentSummary()
    }

    @objc private func toggleAppInfo(_ sender: Any?) {
        guard !busy else { return }
        let enabled = appInfoToggle.state == .on
        awareness.appInfoEnabled = enabled
        owner?.saveAppInfoPreference(enabled)
        contextStatus.stringValue = enabled ? "应用信息已开启；只在发送聊天时附应用名和窗口标题。" : "应用信息已关闭；仅在显式附图时附带截图目标信息。"
    }

    @objc private func toggleScreenshot(_ sender: Any?) {
        guard !busy else { return }
        let requested = screenshotToggle.state == .on
        let enabled = requested && awareness.requestScreenPermission()
        awareness.screenshotEnabled = enabled
        screenshotToggle.state = enabled ? .on : .off
        owner?.saveScreenshotPreference(enabled)
        if requested && !enabled {
            contextStatus.stringValue = "未开启截图：请在系统设置的屏幕录制权限中授权后再勾选。"
        } else {
            contextStatus.stringValue = enabled ? "截图已开启；发送聊天时按额度附图与截图目标信息。" : awareness.appInfoEnabled ? "截图已关闭；聊天仅附你已开启的应用信息。" : "截图和应用信息均已关闭；聊天不附桌面上下文。"
        }
        refreshContextLabel()
    }

    private func updateAwarenessResult(_ object: [String: Any]) {
        guard let result = object["awareness"] as? [String: Any] else {
            contextStatus.stringValue = "本轮截图发送状态未确认。"
            return
        }
        let used = result["screenUsed"] as? Bool == true
        let activityUsed = result["activityUsed"] as? Bool == true
        let reason = result["reason"] as? String ?? result["screenReason"] as? String ?? ""
        let budget = result["budget"] as? [String: Any]
        if let seconds = budget?["minIntervalSeconds"] as? Int, let limit = budget?["limit"] as? Int {
            applyScreenshotPolicy(ScreenshotPolicy(minIntervalSeconds: seconds, dailyLimit: limit))
        }
        let intervalText = screenshotPolicy?.intervalLabel ?? "尚未到允许时间"
        let dailyText = screenshotPolicy.map { $0.dailyLimit == 0 ? "每日不限张数" : "今天已达 \($0.dailyLimit) 张上限" } ?? "今天已达截图上限"
        let reasons = ["cooldown": intervalText, "daily_limit": dailyText, "invalid_image": "截图不可用", "storage_error": "额度记录不可用", "request_not_sent": "请求尚未发送", "not_requested": "截图未开启", "provider_unsupported": "Codex 模式仅支持文字；截图需 API 视觉模型"]
        let label: String
        if used { label = "本轮已发送当前窗口截图" }
        else if reason != "not_requested", let detail = reasons[reason] { label = "本轮未发送截图：" + detail }
        else { label = activityUsed ? "本轮仅附简短应用信息" : "本轮未附截图或应用信息" }
        let unlimited = budget?["dailyUnlimited"] as? Bool == true || (budget?["limit"] as? Int) == 0
        let remaining = result["remainingToday"] as? Int ?? budget?["remaining"] as? Int
        let limit = budget?["limit"] as? Int ?? screenshotPolicy?.dailyLimit
        let remainingLabel = unlimited ? " · 每日不限张数" : remaining.flatMap { count in limit.map { " · 今日截图余量 \(count)/\($0)" } } ?? ""
        contextStatus.stringValue = label + remainingLabel
    }

    private func redrawTranscript() {
        let text = NSMutableAttributedString()
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        paragraph.paragraphSpacing = 13
        if messages.isEmpty {
            text.append(NSAttributedString(string: "你来啦。想聊天就发一句，本鱼先不偷吃你的额度。🐋\n",
                                           attributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: paragraph]))
        }
        for message in messages {
            let label: String
            if message.role == "user" { label = "你" }
            else if message.role == "assistant" {
                if message.model == "local-reminder" { label = message.reminderId == nil ? "大肥鱼 · 本地通知" : "大肥鱼 · 本地提醒" }
                else { label = message.source == "local" ? "大肥鱼 · 本地互动" : "大肥鱼" + (message.model.map { " · " + $0 } ?? "") }
            }
            else { label = "连接提示" }
            text.append(NSAttributedString(string: label + "\n", attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: message.role == "user" ? NSColor.secondaryLabelColor : NSColor.systemBlue]))
            text.append(NSAttributedString(string: message.content + "\n\n", attributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: message.role == "notice" ? NSColor.secondaryLabelColor : NSColor.labelColor, .paragraphStyle: paragraph]))
        }
        transcript.textStorage?.setAttributedString(text)
        scrollToLatestMessage()
    }

    /// Layout may still use the old document height just after a window opens
    /// or an attributed string changes. Settle once now and once next turn.
    private func scrollToLatestMessage() {
        scrollGeneration &+= 1
        let generation = scrollGeneration
        guard window.isVisible else { return }
        layoutAndScrollLatest()
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.scrollGeneration == generation, self.window.isVisible else { return }
            self.layoutAndScrollLatest()
        }
    }
    private func layoutAndScrollLatest() {
        window.contentView?.layoutSubtreeIfNeeded()
        guard let container = transcript.textContainer, let manager = transcript.layoutManager else { return }
        let width = max(1, transcriptScroll.contentSize.width)
        if abs(transcript.frame.width - width) > 0.5 { transcript.setFrameSize(NSSize(width: width, height: transcript.frame.height)) }
        container.containerSize = NSSize(width: max(1, width - transcript.textContainerInset.width * 2), height: CGFloat.greatestFiniteMagnitude)
        manager.ensureLayout(for: container)
        let height = max(transcriptScroll.contentSize.height, ceil(manager.usedRect(for: container).maxY + transcript.textContainerInset.height * 2))
        if abs(transcript.frame.height - height) > 0.5 { transcript.setFrameSize(NSSize(width: width, height: height)) }
        let length = transcript.textStorage?.length ?? 0
        transcript.scrollRangeToVisible(NSRange(location: length, length: 0))
        transcriptScroll.reflectScrolledClipView(transcriptScroll.contentView)
    }

    private func finishRequest(_ result: Result<Void, Error>) {
        let completion = pendingInlineCompletion
        pendingInlineCompletion = nil
        busy = false
        send.isEnabled = true; send.title = "发送"
        screenshotToggle.isEnabled = true
        appInfoToggle.isEnabled = true
        owner?.petView.thinking = false
        request = nil
        completion?(result)
    }

    private func token() -> String? {
        guard let data = try? Data(contentsOf: dataRoot.appendingPathComponent("service.json")),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return object["token"] as? String ?? object["accessToken"] as? String
    }

    private func checkHealth() {
        guard !busy, let url = AppPaths.serviceURL("/health") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 4
        if let token = token() { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, !self.busy else { return }
                if error == nil, let response = response as? HTTPURLResponse, response.statusCode == 200 {
                    let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                    let configured = (object?["configured"] as? Bool) == true
                    self.status.stringValue = configured ? "AI 已连接 · 发消息时使用额度" : "本地服务就绪 · 可在 AI 连接设置中配置"
                    self.refreshScreenshotPolicy()
                } else { self.status.stringValue = "服务启动中或离线 · 可稍后重试" }
            }
        }.resume()
    }

    @objc private func sendMessage(_ sender: Any?) {
        beginChat(message: input.stringValue, fromBubble: false, completion: nil)
    }

    func sendInlineReply(_ text: String, completion: @escaping (Result<Void, Error>) -> Void) {
        beginChat(message: text, fromBubble: true, completion: completion)
    }

    private func beginChat(message raw: String, fromBubble: Bool, completion: ((Result<Void, Error>) -> Void)?) {
        func reject(_ text: String, code: Int) {
            status.stringValue = text
            completion?(.failure(NSError(domain: "WhaleChat", code: code, userInfo: [NSLocalizedDescriptionKey: text])))
        }
        guard !busy else { reject("正在处理上一条消息，请稍后再发送。", code: 1); return }
        let message = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { reject("请输入要发送的内容。", code: 2); return }
        guard message.count <= 4000 else { reject("消息太长了，请缩短到 4000 字以内。", code: 3); return }
        guard let token = token(), let url = AppPaths.serviceURL("/api/chat") else {
            owner?.petView.setEmotion(.curious, duration: 12)
            reject("本地服务尚未准备好，请稍等几秒再试。", code: 4)
            return
        }
        let history = messages.filter { ($0.role == "user" || $0.role == "assistant") && $0.source != "local" }.suffix(24).map { ["role": $0.role, "content": $0.content] }
        let recentProactive: [[String: Any]] = messages.filter { $0.messageId != nil && $0.model != "local-reminder" }.suffix(3).compactMap { record in
            guard let id = record.messageId else { return nil }
            return ["id": id, "at": ISO8601DateFormatter().string(from: record.time), "content": String(record.content.prefix(2000)), "source": record.source == "api" ? "api" : record.source == "local" ? "local" : "codex"]
        }
        requestGeneration &+= 1
        let generation = requestGeneration
        pendingInlineCompletion = completion
        busy = true
        let old = messages
        messages.append(ChatRecord(role: "user", content: message))
        guard saveMessages() else {
            messages = old
            status.stringValue = "消息尚未保存，未发送；请检查本地存储后重试。"
            finishRequest(.failure(NSError(domain: "WhaleChat", code: 5, userInfo: [NSLocalizedDescriptionKey: status.stringValue])))
            return
        }
        redrawTranscript()
        if !fromBubble { input.stringValue = "" }
        send.isEnabled = false
        send.title = "回复中"
        screenshotToggle.isEnabled = false
        appInfoToggle.isEnabled = false
        owner?.petView.thinking = true
        status.stringValue = "准备当前窗口上下文…"
        awareness.prepareContext { [weak self] extra, detail in
            guard let self = self, self.requestGeneration == generation, self.busy else { return }
            self.refreshContextLabel()
            self.contextStatus.stringValue = "本轮准备：" + detail
            var payload: [String: Any] = ["message": message, "history": history]
            if !recentProactive.isEmpty { payload["recentProactive"] = recentProactive }
            if let activity = extra["activity"] { payload["activity"] = activity }
            if let screen = extra["screen"] { payload["screen"] = screen }
            payload["appInfoOptIn"] = extra["appInfoOptIn"] as? Bool == true
            self.submitChat(payload: payload, token: token, url: url, generation: generation)
        }
    }

    private func submitChat(payload: [String: Any], token: String, url: URL, generation: UInt64) {
        status.stringValue = "大肥鱼正在想…"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        self.request = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self, self.requestGeneration == generation, self.busy else { return }
                guard error == nil, let data = data, let response = response as? HTTPURLResponse else {
                    self.owner?.petView.setEmotion(.curious, duration: 12)
                    self.status.stringValue = "连接中断，消息没有得到模型回复"
                    self.contextStatus.stringValue = "本轮未取得回复；截图发送状态未确认。"
                    self.appendNotice("暂时没连上 AI 服务。可在“AI 连接设置”检查配置后重试。")
                    self.finishRequest(.failure(NSError(domain: "WhaleChat", code: 7, userInfo: [NSLocalizedDescriptionKey: "连接中断，尚未取得回复；草稿已保留，可以重试。"])))
                    return
                }
                let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
                self.updateAwarenessResult(object)
                guard (200..<300).contains(response.statusCode), let text = object["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    self.owner?.petView.setEmotion(.curious, duration: 12)
                    self.status.stringValue = "本次调用失败（HTTP \(response.statusCode)）"
                    let detail = String((object["error"] as? String ?? object["errorCode"] as? String ?? "REQUEST_FAILED").prefix(160))
                    self.appendNotice("本次没有取得模型回复。错误：\(detail)。请稍后重试或检查账号授权。")
                    self.finishRequest(.failure(NSError(domain: "WhaleChat", code: response.statusCode, userInfo: [NSLocalizedDescriptionKey: "这次尚未取得回复：" + detail])))
                    return
                }
                let model = object["model"] as? String
                let source = object["source"] as? String ?? "unknown"
                self.messages.append(ChatRecord(role: "assistant", content: text, model: model, source: source))
                let saved = self.saveMessages()
                self.redrawTranscript()
                if !saved { self.status.stringValue = "已取得回复，但本地历史暂未保存；请勿重复发送。" }
                else if ["codex", "llm", "api"].contains(source) { self.status.stringValue = "AI · " + (model ?? "已回复") }
                else if source == "local" { self.status.stringValue = "本地回复 · 未调用 AI" }
                else { self.status.stringValue = "已收到回复 · 来源 " + source }
                // Release the shared slot and let the bubble finish its draft
                // before presenting this reply. Neither surface opens the other.
                self.finishRequest(.success(()))
                self.owner?.showReplyBubble(text: text, source: source, proactive: false)
            }
        }
        self.request?.resume()
    }

    private func appendNotice(_ text: String) {
        messages.append(ChatRecord(role: "notice", content: text, source: "local-error"))
        saveMessages()
        redrawTranscript()
    }
    @discardableResult
    private func saveMessages() -> Bool {
        if messages.count > 300 { messages = Array(messages.suffix(300)) }
        return writePrivateJSON(messages, to: chatFile)
    }
    func receiveProactive(_ message: ProactiveMessage) -> Bool {
        guard !message.id.isEmpty, message.id.count <= 200, !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, message.text.count <= 20000, ["codex", "llm", "api", "local"].contains(message.source) else { return false }
        if messages.contains(where: { $0.messageId == message.id }) { return true }
        let old = messages
        var record = ChatRecord(role: "assistant", content: message.text, model: message.model, source: message.source, messageId: message.id)
        if let raw = message.at {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) { record.time = date }
        }
        messages.append(record)
        guard saveMessages() else { messages = old; status.stringValue = "主动消息尚未保存，稍后会重新读取。"; return false }
        redrawTranscript()
        if !busy && !hasDraft { owner?.showReplyBubble(text: message.text, source: message.source, proactive: true) }
        else { owner?.rememberReplyBubble(text: message.text, source: message.source, proactive: true) }
        return true
    }
    /// ACK is allowed only after the local delivery is durable. It has its own
    /// message ID and is never sent back as a proactive model conversation.
    func receiveLocalEvent(_ event: LocalDeliveryEvent) -> Bool {
        guard !event.id.isEmpty, event.id.count <= 200, !event.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, event.text.count <= 20000 else { return false }
        if messages.contains(where: { $0.messageId == event.id }) { return true }
        let old = messages
        var record = ChatRecord(role: "assistant", content: event.text, model: "local-reminder", source: "local", messageId: event.id, reminderId: event.reminderId, kind: event.kind)
        if let raw = event.at {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) { record.time = date }
        }
        messages.append(record)
        guard saveMessages() else { messages = old; status.stringValue = "本地提醒尚未保存，稍后会重试。"; return false }
        redrawTranscript()
        owner?.showReplyBubble(text: event.text, source: "local", proactive: false, kind: event.kind, reminderId: event.reminderId)
        return true
    }
    @discardableResult
    func replayLatestReply() -> Bool {
        guard let record = messages.last(where: { $0.role == "assistant" }) else { return false }
        owner?.showReplyBubble(text: record.content, source: record.source ?? "unknown", proactive: record.messageId != nil && record.model != "local-reminder", kind: record.kind, reminderId: record.reminderId)
        return true
    }
    @objc private func clearHistory(_ sender: Any?) {
        guard !busy else { status.stringValue = "请等当前回复完成后再开始新对话。"; return }
        let alert = NSAlert()
        alert.messageText = "开始一段新对话？"
        alert.informativeText = "当前聊天保留在本机历史会话中，聊天窗口从空白开始。长期记忆、账号授权和宠物设置保留。"
        alert.addButton(withTitle: "新对话")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self = self, !self.busy else { return }
            guard let token = self.token(), let url = AppPaths.serviceURL("/api/chat/new") else { self.appendNotice("本机服务未准备好，尚未开始新对话。"); return }
            var urlRequest = URLRequest(url: url)
            urlRequest.httpMethod = "POST"
            urlRequest.timeoutInterval = 12
            urlRequest.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            urlRequest.httpBody = Data("{}".utf8)
            self.busy = true
            self.send.isEnabled = false
            self.screenshotToggle.isEnabled = false
            self.appInfoToggle.isEnabled = false
            self.status.stringValue = "正在开始新对话…"
            self.request = URLSession.shared.dataTask(with: urlRequest) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    defer { self.busy = false; self.send.isEnabled = true; self.screenshotToggle.isEnabled = true; self.appInfoToggle.isEnabled = true; self.request = nil }
                    guard error == nil, let data = data, let response = response as? HTTPURLResponse else { self.appendNotice("连接中断，尚未确认新对话，原记录保留。"); return }
                    guard response.statusCode == 200 else {
                        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                        let detail = object?["error"] as? String ?? "本机服务暂不可用。"
                        self.appendNotice("未能开始新对话，原记录保留。" + detail)
                        return
                    }
                    self.messages = []
                    self.saveMessages()
                    self.redrawTranscript()
                    self.status.stringValue = "新对话已开始 · 长期记忆保留"
                }
            }
            self.request?.resume()
        }
    }
}

final class PetApp: NSObject, NSApplicationDelegate {
    let petView = PetView(frame: .zero)
    private var panel: PetPanel!
    private var chat: ChatController!
    private var tasks: TaskWindowController!
    private var memory: MemoryWindowController!
    private var screenshotSettings: ScreenshotSettingsController!
    private var bubble: PetBubbleController!
    private var proactiveSettings: ProactiveSettingsController!
    private var proactiveClient: ProactiveInboxClient!
    private var toolsController: LocalToolsController!
    private var setupController: SetupWindowController!
    private var serviceProcess: Process?
    private var proactivePolicy: ProactivePolicy?
    private var previousChatApplication: NSRunningApplication?
    private var statusItem: NSStatusItem!
    private var settings = PetSettings()
    private var timer: Timer?
    private var lastTick = Date()
    private var wanderingPlanner = PetWanderingPlanner()
    private var lastSave = Date()
    private var ownsLifecycle = false
    private var settingsReady = false
    private let settingsFile = dataRoot.appendingPathComponent("settings.json")

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let identifier = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: identifier).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            existing.activate(options: [])
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy(.accessory)
        try? FileManager.default.createDirectory(at: dataRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let loaded = loadSettingsOrPrompt() else { NSApp.terminate(nil); return }
        settings = loaded
        settingsReady = true
        ownsLifecycle = true
        settings.height = min(260, max(120, settings.height))
        petView.owner = self
        if let asset = Optional(AppPaths.assetsRoot.appendingPathComponent("pet.png")) { petView.image = NSImage(contentsOf: asset) }
        if let sheet = Optional(AppPaths.assetsRoot.appendingPathComponent("pet-sprites.png")) { petView.spriteSheet = NSImage(contentsOf: sheet) }
        panel = PetPanel(contentRect: NSRect(x: 0, y: 0, width: 180, height: 200),
                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "蓝色大肥鱼桌面宠物"
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = false
        panel.acceptsMouseMovedEvents = true
        panel.animationBehavior = .none
        panel.contentView = petView
        resizePet(to: settings.height, save: false)
        if let x = settings.x, let y = settings.y {
            movePet(to: NSPoint(x: x, y: y), save: false)
        } else { returnPet(nil) }
        panel.orderFrontRegardless()
        chat = ChatController()
        chat.owner = self
        chat.configureAwareness(enabled: settings.screenshotEnabled == true, appInfoEnabled: settings.appInfoEnabled == true)
        tasks = TaskWindowController()
        setupController = SetupWindowController()
        memory = MemoryWindowController()
        screenshotSettings = ScreenshotSettingsController()
        screenshotSettings.onPolicyChanged = { [weak self] policy in self?.chat?.applyScreenshotPolicy(policy) }
        bubble = PetBubbleController()
        bubble.onSendReply = { [weak self] text, completion in
            guard let self = self, let chat = self.chat else {
                completion(.failure(NSError(domain: "WhaleChat", code: 4, userInfo: [NSLocalizedDescriptionKey: "聊天尚未准备好，请稍后重试。"])))
                return
            }
            chat.sendInlineReply(text, completion: completion)
        }
        chat.onBusyChanged = { [weak self] busy in self?.bubble?.setConversationBusy(busy) }
        bubble.onDraftChanged = { [weak self] _ in self?.proactiveClient?.refreshPresence() }
        bubble.onOpenChat = { [weak self] in self?.showChat(nil) }
        bubble.onFocus = { [weak self] minutes, completion in
            guard let self = self else { completion(false); return }
            self.toolsController.focus(minutes: minutes) { [weak self] succeeded in
                if succeeded { self?.proactiveClient?.refreshPolicy() }
                completion(succeeded)
            }
        }
        bubble.onReminderAction = { [weak self] id, action, minutes, completion in
            guard let self = self else { completion(false); return }
            self.toolsController.performReminderAction(id: id, action: action, minutes: minutes, completion: completion)
        }
        proactiveSettings = ProactiveSettingsController()
        proactiveClient = ProactiveInboxClient(cursor: settings.proactiveCursor)
        proactiveClient.presence = { [weak self] in (busy: self?.chat?.isBusy == true || self?.bubble?.isSendingInline == true, typing: self?.chat?.hasDraft == true || self?.bubble?.hasDraft == true || self?.bubble?.isEditingInline == true) }
        proactiveClient.onMessage = { [weak self] message in self?.chat?.receiveProactive(message) ?? false }
        proactiveClient.onCursor = { [weak self] cursor in
            guard let self = self, self.settings.proactiveCursor != cursor else { return }
            self.settings.proactiveCursor = cursor
            self.savePetPosition()
        }
        proactiveClient.onPolicy = { [weak self] policy, _ in
            guard let self = self, self.proactivePolicy != policy else { return }
            self.proactivePolicy = policy
            self.statusItem?.menu = self.makeMenu()
        }
        proactiveSettings.onPolicyChanged = { [weak self] policy, status in self?.proactiveClient?.accept(policy: policy, status: status) }
        proactiveSettings.onPreview = { [weak self] message, cursor in self?.proactiveClient?.acceptPreview(message, cursor: cursor) ?? false }
        toolsController = LocalToolsController()
        toolsController.onLocalEvent = { [weak self] event in self?.chat?.receiveLocalEvent(event) ?? false }
        toolsController.onSettingsChanged = { [weak self] in
            self?.proactiveClient?.refreshPolicy()
            if let self = self { self.statusItem?.menu = self.makeMenu() }
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🐋"
        statusItem.button?.toolTip = "大肥鱼桌面宠物"
        statusItem.menu = makeMenu()
        reloadActions(announce: false)
        startService()
        proactiveClient.start()
        toolsController.start()
        timer = Timer(timeInterval: 1.0 / 15.0, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        RunLoop.main.add(timer!, forMode: .common)
        if ProcessInfo.processInfo.arguments.contains("--show-chat") { showChat(nil) }
        if !FileManager.default.fileExists(atPath: AppPaths.setupFile.path) {
            setupController.show(firstLaunch: true)
        }
    }

    private func startService() {
        let executable = AppPaths.nodeBinary
        let entry = AppPaths.resourceRoot.appendingPathComponent("service.mjs")
        guard FileManager.default.isExecutableFile(atPath: executable.path), FileManager.default.fileExists(atPath: entry.path) else { return }
        let process = Process()
        process.executableURL = executable
        process.arguments = [entry.path]
        process.currentDirectoryURL = AppPaths.applicationRoot
        var environment = ProcessInfo.processInfo.environment
        environment["WHALE_PET_DATA_DIR"] = AppPaths.applicationRoot.path
        environment["WHALE_PET_RESOURCE_DIR"] = AppPaths.resourceRoot.path
        environment["WHALE_PET_CODEX_BINARY"] = AppPaths.codexBinary.path
        environment["WHALE_PET_PORT"] = environment["WHALE_PET_PORT"] ?? "43928"
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run(); serviceProcess = process }
        catch { NSLog("Whale Pet: bundled local service could not start: %@", error.localizedDescription) }
    }

    private func loadSettingsOrPrompt() -> PetSettings? {
        while true {
            do { return try loadPetSettings(from: settingsFile) }
            catch {
                let alert = NSAlert()
                alert.messageText = "暂时无法读取大肥鱼设置"
                alert.informativeText = "原设置文件会保留，不会用默认值覆盖。请确认数据目录所在磁盘已连接且当前账号有读写权限，再点重试。若设置文件已损坏，请先从备份恢复。"
                alert.addButton(withTitle: "重试")
                alert.addButton(withTitle: "退出")
                NSApp.activate(ignoringOtherApps: true)
                if alert.runModal() != .alertFirstButtonReturn { return nil }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard ownsLifecycle, panel != nil else { return false }
        returnPet(nil)
        panel.orderFrontRegardless()
        return true
    }
    func applicationWillTerminate(_ notification: Notification) {
        guard ownsLifecycle else { return }
        timer?.invalidate()
        chat?.shutdown()
        tasks?.shutdown()
        memory?.shutdown()
        screenshotSettings?.shutdown()
        proactiveSettings?.shutdown()
        proactiveClient?.shutdown()
        toolsController?.shutdown()
        setupController?.shutdown()
        bubble?.shutdown()
        if panel != nil { savePetPosition() }
        if serviceProcess?.isRunning == true { serviceProcess?.terminate() }
        serviceProcess = nil
    }

    @objc private func tick() {
        let now = Date()
        let delta = max(0, min(0.1, now.timeIntervalSince(lastTick)))
        lastTick = now
        petView.phase += delta
        // Hidden drafts remain saved, without pinning the pet forever after chat closes.
        let interactionBusy = chat.isBusy || bubble?.isSendingInline == true || bubble?.isVisible == true
        let canMove = !petView.reducedMotion && !petView.dragging && !petView.isHovered && !petView.blocksWalking && !chat.window.isVisible && !interactionBusy
        let visible = (panel.screen ?? NSScreen.main)?.visibleFrame ?? panel.frame
        let intent = wanderingPlanner.step(origin: panel.frame.origin, panelSize: panel.frame.size, visibleFrame: visible,
                                            deltaTime: 0, paused: !settings.wandering || !canMove,
                                            movementReady: false, exclusiveActionActive: petView.hasExclusiveAction)
        petView.updateActivity(wandering: settings.wandering, movementAllowed: canMove, idleAllowed: canMove,
                               automatic: settings.automaticActions != false, roamWalkingRequested: intent.wantsWalking)
        petView.updateAnimation()
        // Reading pointer location needs no event-monitor or Accessibility permission.
        // Give truly transparent pixels back to the underlying desktop/app.
        let pointer = NSEvent.mouseLocation
        let localPointer = NSPoint(x: pointer.x - panel.frame.minX, y: pointer.y - panel.frame.minY)
        let ignoreMouse = !petView.dragging && !petView.opaque(at: localPointer)
        if panel.ignoresMouseEvents != ignoreMouse { panel.ignoresMouseEvents = ignoreMouse }
        let movement = wanderingPlanner.step(origin: panel.frame.origin, panelSize: panel.frame.size, visibleFrame: visible,
                                              deltaTime: delta, paused: !settings.wandering || !canMove,
                                              movementReady: !petView.actionsAvailable || petView.isWalking,
                                              exclusiveActionActive: petView.hasExclusiveAction)
        if let facingLeft = movement.facingLeft { petView.lookingLeft = facingLeft }
        if movement.origin != panel.frame.origin {
            panel.setFrameOrigin(movement.origin)
            if now.timeIntervalSince(lastSave) > 3 { savePetPosition(); lastSave = now }
        }
        if movement.didArrive {
            petView.updateActivity(wandering: settings.wandering, movementAllowed: canMove, idleAllowed: false,
                                   automatic: false, roamWalkingRequested: false)
            if settings.automaticActions != false && Bool.random(), let duration = movement.restDuration {
                _ = petView.tryAutomaticActivity(duration: duration)
            }
            petView.updateAnimation()
        }
        bubble?.position(near: panel)
    }

    func movePet(to point: NSPoint, save: Bool) {
        guard panel != nil else { return }
        let frame = NSRect(origin: point, size: panel.frame.size)
        let screen = NSScreen.screens.max { lhs, rhs in
            let a = lhs.visibleFrame.intersection(frame), b = rhs.visibleFrame.intersection(frame)
            return a.width * a.height < b.width * b.height
        } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let x = max(visible.minX, min(point.x, visible.maxX - frame.width))
        let y = max(visible.minY, min(point.y, visible.maxY - frame.height))
        panel.setFrameOrigin(NSPoint(x: x, y: y))
        wanderingPlanner.reset()
        bubble?.position(near: panel)
        if save { savePetPosition() }
    }
    func savePetPosition() {
        guard settingsReady, let panel = panel else { return }
        settings.x = panel.frame.minX
        settings.y = panel.frame.minY
        writePrivateJSON(settings, to: settingsFile)
    }
    func saveScreenshotPreference(_ enabled: Bool) {
        settings.screenshotEnabled = enabled
        savePetPosition()
    }
    func saveAppInfoPreference(_ enabled: Bool) {
        settings.appInfoEnabled = enabled
        savePetPosition()
    }
    private func resizePet(to height: Double, save: Bool) {
        settings.height = height
        let ratio = petView.characterAspectRatio
        let width = max(100, min(280, height * Double(ratio))) + 20
        panel.setContentSize(NSSize(width: width, height: height + 24))
        petView.frame = NSRect(origin: .zero, size: panel.contentView?.bounds.size ?? .zero)
        movePet(to: panel.frame.origin, save: save)
    }
    @objc func showChat(_ sender: Any?) {
        if let external = NSWorkspace.shared.frontmostApplication, external.processIdentifier != ProcessInfo.processInfo.processIdentifier { previousChatApplication = external }
        bubble?.hide()
        chat?.show(near: panel)
        if let chat = chat {
            petView.lookingLeft = chat.window.frame.midX < panel.frame.midX
            if !chat.isBusy { petView.setEmotion(.listening, duration: 30) }
        }
    }
    func restoreChatFocus() {
        guard NSApp.isActive, let previous = previousChatApplication, !previous.isTerminated else { return }
        previous.activate(options: [])
    }
    @objc func showTasks(_ sender: Any?) { tasks?.show(near: panel) }
    @objc func showAISettings(_ sender: Any?) { setupController?.show(firstLaunch: false) }
    @objc func showMemory(_ sender: Any?) { memory?.show(near: panel) }
    @objc func showScreenshotSettings(_ sender: Any?) { screenshotSettings?.show(near: panel) }
    @objc func showProactiveSettings(_ sender: Any?) { proactiveSettings?.show(near: panel) }
    @objc func showLocalTasks(_ sender: Any?) { toolsController?.show(tab: "tasks", near: panel) }
    @objc func showUsage(_ sender: Any?) { toolsController?.show(tab: "usage", near: panel) }
    @objc private func toggleProactive(_ sender: Any?) { proactiveClient?.toggleEnabled() }
    func showReplyBubble(text: String, source: String, proactive: Bool, kind: String? = nil, reminderId: String? = nil) {
        if kind == nil || chat?.isBusy != true { petView.setEmotion(PetEmotion.forReply(text), duration: 14) }
        bubble?.show(text: text, source: source, proactive: proactive, near: panel, kind: kind, reminderId: reminderId)
    }
    func rememberReplyBubble(text: String, source: String, proactive: Bool) { bubble?.remember(text: text, source: source, proactive: proactive) }
    @objc private func showLastBubble(_ sender: Any?) {
        if bubble?.showLatest(near: panel) == true { return }
        if chat?.replayLatestReply() != true { showChat(sender) }
    }
    @objc private func openBubbleReply(_ sender: Any?) {
        if bubble?.showLatest(near: panel) != true && chat?.replayLatestReply() != true {
            bubble?.show(text: "想说什么？直接在这里聊吧。🐋", source: "local", proactive: false, near: panel)
        }
        bubble?.focusInlineReply()
    }
    @objc private func previewEmotion(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let emotion = PetEmotion(rawValue: raw) else { return }
        petView.setEmotion(emotion, duration: 12)
    }
    private func reloadActions(announce: Bool) {
        let succeeded: Bool
        do { succeeded = petView.installActions(try PetActionLibrary.load(from: AppPaths.assetsRoot.appendingPathComponent("actions-v2", isDirectory: true))) }
        catch { succeeded = false }
        let policy = try? PetWanderingPolicy.load(from: AppPaths.assetsRoot.appendingPathComponent("wandering-policy.json"))
        wanderingPlanner.reset(policy: policy)
        statusItem?.menu = makeMenu()
        if announce {
            showReplyBubble(text: succeeded ? "日常姿态已重新加载：走路、吃饭、拉拉队应援、打游戏和听歌。🐋" : "动作素材暂时没能加载，先沿用原来的动作；可以稍后再试。", source: "local", proactive: false)
        }
    }
    @objc private func reloadPetActions(_ sender: Any?) { reloadActions(announce: true) }
    @objc private func performPetAction(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, chat?.isBusy != true else { return }
        petView.setEmotion(.idle)
        if let kind = PetActionKind(rawValue: raw) {
            if kind == .walk { toggleWandering(sender) }
            else if kind == .sitDown { setWandering(false) }
            else { petView.playAction(kind) }
        } else { petView.playExtraAction(raw) }
    }
    @objc private func toggleDailyActions(_ sender: Any?) {
        settings.automaticActions = !(settings.automaticActions != false)
        savePetPosition()
        statusItem.menu = makeMenu()
    }
    @objc func returnPet(_ sender: Any?) {
        guard let visible = NSScreen.main?.visibleFrame else { return }
        movePet(to: NSPoint(x: visible.maxX - panel.frame.width - 32, y: visible.minY + 24), save: true)
        panel.orderFrontRegardless()
    }
    @objc private func toggleWandering(_ sender: Any?) {
        setWandering(!settings.wandering)
    }
    private func setWandering(_ enabled: Bool) {
        settings.wandering = enabled
        wanderingPlanner.reset()
        if enabled {
            if chat?.isBusy != true { petView.setEmotion(.idle); petView.startWandering() }
        } else { petView.playAction(.sitDown) }
        savePetPosition()
        statusItem?.menu = makeMenu()
    }
    @objc private func setSize(_ sender: NSMenuItem) {
        resizePet(to: Double(sender.tag), save: true)
        statusItem.menu = makeMenu()
    }
    @objc private func quit(_ sender: Any?) { NSApp.terminate(nil) }
    @objc private func wave(_ sender: Any?) { petView.triggerWave(duration: 1.3) }

    func makeMenu() -> NSMenu {
        let menu = NSMenu()
        let title = NSMenuItem(title: "蓝色大肥鱼 · 桌面宠物", action: nil, keyEquivalent: "")
        title.isEnabled = false
        menu.addItem(title)
        menu.addItem(.separator())
        let setup = NSMenuItem(title: "AI 连接设置", action: #selector(showAISettings(_:)), keyEquivalent: "")
        setup.target = self
        menu.addItem(setup)
        let open = NSMenuItem(title: "打开聊天", action: #selector(showChat(_:)), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        let inlineReply = NSMenuItem(title: "气泡里回复", action: #selector(openBubbleReply(_:)), keyEquivalent: "")
        inlineReply.target = self
        menu.addItem(inlineReply)
        let lastBubble = NSMenuItem(title: "重显上一条气泡", action: #selector(showLastBubble(_:)), keyEquivalent: "")
        lastBubble.target = self
        menu.addItem(lastBubble)
        let reminders = NSMenuItem(title: "提醒与待办", action: #selector(showLocalTasks(_:)), keyEquivalent: "")
        reminders.target = self
        menu.addItem(reminders)
        let usage = NSMenuItem(title: "用量与预算", action: #selector(showUsage(_:)), keyEquivalent: "")
        usage.target = self
        menu.addItem(usage)
        let tasks = NSMenuItem(title: "后台任务", action: #selector(showTasks(_:)), keyEquivalent: "")
        tasks.target = self
        menu.addItem(tasks)
        let memory = NSMenuItem(title: "长期记忆", action: #selector(showMemory(_:)), keyEquivalent: "")
        memory.target = self
        menu.addItem(memory)
        let screenshots = NSMenuItem(title: "截图设置", action: #selector(showScreenshotSettings(_:)), keyEquivalent: "")
        screenshots.target = self
        menu.addItem(screenshots)
        let proactive = NSMenuItem(title: "主动聊天设置", action: #selector(showProactiveSettings(_:)), keyEquivalent: "")
        proactive.target = self
        menu.addItem(proactive)
        let pause = NSMenuItem(title: proactivePolicy?.enabled == true ? "暂停主动聊天" : "恢复主动聊天", action: #selector(toggleProactive(_:)), keyEquivalent: "")
        pause.target = self
        pause.isEnabled = proactivePolicy != nil
        menu.addItem(pause)
        let wave = NSMenuItem(title: "挥个手", action: #selector(wave(_:)), keyEquivalent: "")
        wave.target = self
        menu.addItem(wave)
        let expressions = NSMenuItem(title: "情绪动作预览", action: nil, keyEquivalent: "")
        let expressionMenu = NSMenu()
        for emotion in PetEmotion.allCases {
            let item = NSMenuItem(title: emotion.title, action: #selector(previewEmotion(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = emotion.rawValue
            expressionMenu.addItem(item)
        }
        expressions.submenu = expressionMenu
        menu.addItem(expressions)
        let daily = NSMenuItem(title: "日常姿态", action: nil, keyEquivalent: "")
        let dailyMenu = NSMenu()
        for (title, kind) in [("站起来", PetActionKind.standUp), ("走一走", .walk), ("吃饭", .eat), ("坐下休息", .sitDown)] {
            let item = NSMenuItem(title: title, action: #selector(performPetAction(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = kind.rawValue
            item.isEnabled = petView.actionsAvailable && chat?.isBusy != true
            if kind == .walk {
                item.state = settings.wandering ? .on : .off
                item.toolTip = "在屏幕各处散步，到达后停一会儿；再次点击暂停。聊天、气泡、鼠标停留或拖动时暂停，坐下休息也会结束散步。"
            }
            dailyMenu.addItem(item)
        }
        for extra in petView.extraActions {
            let item = NSMenuItem(title: extra.title, action: #selector(performPetAction(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = extra.id
            item.isEnabled = chat?.isBusy != true
            dailyMenu.addItem(item)
        }
        dailyMenu.addItem(.separator())
        let automatic = NSMenuItem(title: "空闲时自动做日常动作", action: #selector(toggleDailyActions(_:)), keyEquivalent: "")
        automatic.target = self; automatic.state = settings.automaticActions != false ? .on : .off
        automatic.toolTip = "空闲时偶尔站起或吃饭，全部本地播放。"
        dailyMenu.addItem(automatic)
        let reload = NSMenuItem(title: "重新加载动作素材", action: #selector(reloadPetActions(_:)), keyEquivalent: "")
        reload.target = self; dailyMenu.addItem(reload)
        daily.submenu = dailyMenu; menu.addItem(daily)
        let home = NSMenuItem(title: "找回宠物", action: #selector(returnPet(_:)), keyEquivalent: "")
        home.target = self
        menu.addItem(home)
        let walk = NSMenuItem(title: settings.wandering ? "暂停散步" : "开始散步", action: #selector(toggleWandering(_:)), keyEquivalent: "")
        walk.target = self
        menu.addItem(walk)
        let size = NSMenuItem(title: "宠物大小", action: nil, keyEquivalent: "")
        let sizes = NSMenu()
        for (label, height) in [("小", 140), ("中", 180), ("大", 220)] {
            let item = NSMenuItem(title: label, action: #selector(setSize(_:)), keyEquivalent: "")
            item.target = self
            item.tag = height
            item.state = Int(settings.height) == height ? .on : .off
            sizes.addItem(item)
        }
        size.submenu = sizes
        menu.addItem(size)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "退出大肥鱼", action: #selector(quit(_:)), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        return menu
    }
}

#if !WHALE_NATIVE_TEST
@main
enum DesktopWhaleMain {
    static func main() {
        if CommandLine.arguments.contains("--version") { print("Whale Pet " + AppPaths.version); return }
        if CommandLine.arguments.contains("--diagnostics") { AppPaths.printDiagnostics(); return }
        let app = NSApplication.shared
        let delegate = PetApp()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
#endif
