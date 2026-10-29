import AppKit
import CoreGraphics
import ScreenCaptureKit
import ImageIO
import Foundation

/// App metadata is event driven. A single-window image can only be prepared
/// for an explicit chat send, after the local switch, OS permission and the
/// companion service's upload budget all allow it.
final class DesktopAwareness: NSObject {
    var screenshotEnabled = false
    var appInfoEnabled = false

    private struct ExternalApplication {
        let pid: pid_t
        let name: String
    }

    private struct VisibleWindow {
        let id: CGWindowID
        let title: String
    }

    private let ownPID = ProcessInfo.processInfo.processIdentifier
    private var externalApplication: ExternalApplication?
    private var activationObserver: NSObjectProtocol?
    private var terminationObserver: NSObjectProtocol?
    private var generation: UInt64 = 0
    private var preparing = false
    private var budgetTask: URLSessionDataTask?
    private let maximumJPEGBytes = 350 * 1024
    private lazy var budgetSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 3
        configuration.timeoutIntervalForResource = 4
        return URLSession(configuration: configuration)
    }()

    func start() {
        precondition(Thread.isMainThread)
        guard activationObserver == nil else { return }
        generation &+= 1
        let workspace = NSWorkspace.shared
        recordExternal(workspace.frontmostApplication)
        activationObserver = workspace.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] notification in
            let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            self?.recordExternal(application)
        }
        terminationObserver = workspace.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  self.externalApplication?.pid == application.processIdentifier else { return }
            self.externalApplication = nil
            self.generation &+= 1
            self.recordExternal(NSWorkspace.shared.frontmostApplication)
        }
    }

    func stop() {
        precondition(Thread.isMainThread)
        let center = NSWorkspace.shared.notificationCenter
        if let observer = activationObserver { center.removeObserver(observer) }
        if let observer = terminationObserver { center.removeObserver(observer) }
        activationObserver = nil
        terminationObserver = nil
        generation &+= 1
        budgetTask?.cancel()
        budgetTask = nil
    }

    /// This method is deliberately separate from start/prepareContext. Only an
    /// explicit UI permission button should call it.
    func requestScreenPermission() -> Bool {
        if Thread.isMainThread { return CGRequestScreenCaptureAccess() }
        return DispatchQueue.main.sync { CGRequestScreenCaptureAccess() }
    }

    func currentSummary() -> String {
        precondition(Thread.isMainThread)
        recordExternal(NSWorkspace.shared.frontmostApplication)
        guard let application = liveExternalApplication() else { return "尚未记录外部应用" }
        let title = visibleWindow(for: application.pid)?.title ?? ""
        return title.isEmpty ? "前台应用：\(application.name)" : "前台应用：\(application.name) · \(title)"
    }

    /// Returns only in-memory base64 JPEG data; this class never writes images
    /// to disk and never sends them to a model. The caller owns the chat send.
    func prepareContext(completion: @escaping ([String: Any], String) -> Void) {
        precondition(Thread.isMainThread)
        guard screenshotEnabled || appInfoEnabled else {
            completion([:], "应用信息与截图均已关闭；本次不附桌面上下文")
            return
        }
        recordExternal(NSWorkspace.shared.frontmostApplication)
        let application = liveExternalApplication()
        let window = application.flatMap { visibleWindow(for: $0.pid) }
        let now = Date()
        let activity: [String: Any] = [
            "app": application?.name ?? "",
            "title": window?.title ?? "",
            "capturedAt": timestamp(now),
        ]
        var activityOnly: [String: Any] { Self.contextPayload(activity: activity, appInfoEnabled: self.appInfoEnabled) }
        func resultReason(_ payload: [String: Any], _ reason: String) -> String {
            payload["activity"] == nil ? reason.replacingOccurrences(of: "仅附应用信息", with: "本次未附截图或应用信息") : reason
        }
        func finishWithoutImage(_ reason: String) {
            let payload = activityOnly
            completion(payload, resultReason(payload, reason))
        }

        guard screenshotEnabled else {
            finishWithoutImage(application == nil ? "未记录外部应用；本次未附截图" : "仅附应用信息；截图已关闭")
            return
        }
        guard CGPreflightScreenCaptureAccess() else {
            finishWithoutImage("仅附应用信息；尚未授予屏幕录制权限")
            return
        }
        guard #available(macOS 14.0, *) else {
            finishWithoutImage("仅附应用信息；单窗口截图需要 macOS 14 或更新版本")
            return
        }
        guard !preparing else {
            finishWithoutImage("仅附应用信息；正在准备另一条消息的截图")
            return
        }
        guard let application = application, let window = window else {
            finishWithoutImage("仅附应用信息；没有可见的外部应用窗口")
            return
        }
        guard let url = AppPaths.serviceURL("/screen-budget") else {
            finishWithoutImage("仅附应用信息；无法检查截图额度")
            return
        }

        preparing = true
        let attemptGeneration = generation
        var finished = false
        var timeout: DispatchWorkItem?
        func finish(_ payload: [String: Any], _ reason: String) {
            guard !finished else { return }
            finished = true
            timeout?.cancel()
            timeout = nil
            self.preparing = false
            completion(payload, resultReason(payload, reason))
        }
        timeout = DispatchWorkItem { [weak self] in
            self?.budgetTask?.cancel()
            finish(activityOnly, "仅附应用信息；截图准备超时")
        }
        if let timeout = timeout { DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: timeout) }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 3
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        budgetTask = budgetSession.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.budgetTask = nil
                guard !finished else { return }
                guard self.screenshotEnabled, self.generation == attemptGeneration,
                      self.externalApplication?.pid == application.pid else {
                    finish(activityOnly, "仅附应用信息；应用或截图设置已改变")
                    return
                }
                guard error == nil, let http = response as? HTTPURLResponse, http.statusCode == 200,
                      let data = data,
                      let budget = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    finish(activityOnly, "仅附应用信息；无法确认本地截图额度")
                    return
                }
                let dailyUnlimited = budget["dailyUnlimited"] as? Bool == true
                let remaining = budget["remaining"] as? Int ?? 0
                guard budget["allowed"] as? Bool == true, dailyUnlimited || remaining > 0 else {
                    finish(activityOnly, "仅附应用信息；截图额度不足或尚未到允许时间")
                    return
                }
                guard CGPreflightScreenCaptureAccess() else {
                    finish(activityOnly, "仅附应用信息；屏幕录制权限不可用")
                    return
                }
                self.captureWindow(window.id, of: application, generation: attemptGeneration) { imageData, title, reason in
                    guard !finished else { return }
                    guard let imageData = imageData else {
                        finish(activityOnly, reason)
                        return
                    }
                    var capturedActivity = activity
                    if !title.isEmpty { capturedActivity["title"] = title }
                    let capturedAt = Date()
                    let screen: [String: Any] = [
                        "data": imageData.base64EncodedString(),
                        "mimeType": "image/jpeg",
                        "capturedAt": self.timestamp(capturedAt),
                    ]
                    finish(Self.contextPayload(activity: capturedActivity, appInfoEnabled: self.appInfoEnabled, screen: screen), "本次已附截图目标信息与一张窗口截图")
                }
            }
        }
        budgetTask?.resume()
    }

    /// Shared assembly gate, also exercised with synthetic metadata by privacy probes.
    static func contextPayload(activity: [String: Any], appInfoEnabled: Bool, screen: [String: Any]? = nil) -> [String: Any] {
        if let screen = screen { return ["activity": activity, "screen": screen, "appInfoOptIn": appInfoEnabled] }
        return appInfoEnabled ? ["activity": activity, "appInfoOptIn": true] : [:]
    }

    private func recordExternal(_ application: NSRunningApplication?) {
        guard let application = application, application.processIdentifier != ownPID,
              !application.isTerminated else { return }
        let value = ExternalApplication(pid: application.processIdentifier,
                                        name: shortened(application.localizedName ?? application.bundleIdentifier ?? "外部应用", limit: 80))
        if externalApplication?.pid != value.pid { generation &+= 1 }
        externalApplication = value
    }

    private func liveExternalApplication() -> ExternalApplication? {
        guard let application = externalApplication,
              let running = NSRunningApplication(processIdentifier: application.pid), !running.isTerminated else { return nil }
        return application
    }

    /// CGWindowList is front-to-back. It supplies identity/title metadata, not
    /// screen pixels. The returned id must later match exactly one SCWindow.
    private func visibleWindow(for pid: pid_t) -> VisibleWindow? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return nil }
        for row in rows {
            guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                  (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
                  (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,
                  let number = row[kCGWindowNumber as String] as? NSNumber,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.width >= 80, frame.height >= 50 else { continue }
            return VisibleWindow(id: number.uint32Value,
                                 title: shortened(row[kCGWindowName as String] as? String ?? "", limit: 200))
        }
        return nil
    }

    @available(macOS 14.0, *)
    private func captureWindow(_ windowID: CGWindowID, of application: ExternalApplication, generation attemptGeneration: UInt64,
                               completion: @escaping (Data?, String, String) -> Void) {
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { [weak self] content, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard error == nil, let content = content,
                      self.screenshotEnabled, self.generation == attemptGeneration,
                      self.externalApplication?.pid == application.pid,
                      self.visibleWindow(for: application.pid)?.id == windowID,
                      let window = content.windows.first(where: {
                          $0.windowID == windowID && $0.isOnScreen && $0.owningApplication?.processID == application.pid
                      }), window.frame.width >= 80, window.frame.height >= 50 else {
                    completion(nil, "", "仅附应用信息；目标窗口已不可见或无法读取")
                    return
                }
                let scale = min(1, 1024 / max(window.frame.width, window.frame.height))
                let configuration = SCStreamConfiguration()
                configuration.width = max(1, Int((window.frame.width * scale).rounded()))
                configuration.height = max(1, Int((window.frame.height * scale).rounded()))
                configuration.showsCursor = false
                let filter = SCContentFilter(desktopIndependentWindow: window)
                let title = self.shortened(window.title ?? "", limit: 200)
                SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { [weak self] image, error in
                    guard let self = self else { return }
                    // Resize/encoding uses only the selected window's CGImage.
                    let encoded = error == nil ? image.flatMap { self.jpegData($0) } : nil
                    DispatchQueue.main.async {
                        guard self.screenshotEnabled, self.generation == attemptGeneration,
                              self.externalApplication?.pid == application.pid,
                              self.visibleWindow(for: application.pid)?.id == windowID else {
                            completion(nil, "", "仅附应用信息；截图准备期间前台应用已改变")
                            return
                        }
                        guard let encoded = encoded else {
                            completion(nil, "", "仅附应用信息；窗口截图未能压缩到允许大小")
                            return
                        }
                        completion(encoded, title, "本次已附一张窗口截图")
                    }
                }
            }
        }
    }

    /// JPEG quality stays at 0.6; if a detailed image exceeds the byte ceiling,
    /// progressively reduce dimensions instead of increasing upload size.
    private func jpegData(_ image: CGImage) -> Data? {
        var longest = min(1024, max(image.width, image.height))
        for _ in 0..<7 {
            let ratio = min(1, Double(longest) / Double(max(image.width, image.height)))
            let width = max(1, Int((Double(image.width) * ratio).rounded()))
            let height = max(1, Int((Double(image.height) * ratio).rounded()))
            guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                          bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
            context.setFillColor(CGColor(gray: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            guard let resized = context.makeImage() else { return nil }
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, "public.jpeg" as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(destination, resized, [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { return nil }
            let result = output as Data
            if result.count <= maximumJPEGBytes { return result }
            longest = max(160, Int(Double(longest) * 0.78))
        }
        return nil
    }

    private func timestamp(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

    private func shortened(_ value: String, limit: Int) -> String {
        String(value.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ").prefix(limit))
    }
}
