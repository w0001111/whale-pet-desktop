#if WHALE_SETUP_TEST
import AppKit
import Foundation

@main enum SetupWindowProbe {
    static var checks = 0
    static func check(_ value: Bool, _ message: String) { precondition(value, message); checks += 1 }
    static func property<T>(_ object: Any, _ name: String, _ type: T.Type) -> T {
        Mirror(reflecting: object).children.first(where: { $0.label == name })!.value as! T
    }
    static func main() {
        guard let rawRoot = ProcessInfo.processInfo.environment["WHALE_NATIVE_TEST_ROOT"] else { fatalError("Use an isolated test root") }
        let root = URL(fileURLWithPath: rawRoot).standardizedFileURL
        check(AppPaths.applicationRoot.standardizedFileURL.path == root.path, "probes use only their isolated application root")
        check(AppPaths.dataRoot.path == (rawRoot as NSString).appendingPathComponent("data"), "state stays below the isolated data directory")
        check(AppPaths.serviceURL("/api/config")?.host == "127.0.0.1", "configuration is local loopback only")
        check(AppPaths.serviceURL("https://example.com") == nil, "a route cannot replace the loopback origin")
        let awareness = DesktopAwareness()
        check(!awareness.appInfoEnabled && !awareness.screenshotEnabled, "both desktop-context choices default to off")
        var defaultCallback = false
        awareness.prepareContext { payload, _ in
            check(payload.isEmpty, "default context is empty before any foreground application is read")
            defaultCallback = true
        }
        check(defaultCallback, "default no-context path does not wait for network or capture")
        let syntheticActivity: [String: Any] = ["app": "Synthetic application", "title": "Synthetic window", "capturedAt": "2026-01-01T00:00:00Z"]
        check(DesktopAwareness.contextPayload(activity: syntheticActivity, appInfoEnabled: false).isEmpty, "metadata is not a fallback when its opt-in is off")
        let optedIn = DesktopAwareness.contextPayload(activity: syntheticActivity, appInfoEnabled: true)
        check((optedIn["activity"] as? [String: Any])?["title"] as? String == "Synthetic window" && optedIn["screen"] == nil, "application-info opt-in includes only the synthetic metadata")
        check(optedIn["appInfoOptIn"] as? Bool == true, "standalone metadata carries explicit consent to the local backend")
        let syntheticScreen: [String: Any] = ["data": "SYNTHETIC-NOT-A-REAL-SCREENSHOT", "mimeType": "image/jpeg"]
        let withScreen = DesktopAwareness.contextPayload(activity: syntheticActivity, appInfoEnabled: false, screen: syntheticScreen)
        check(withScreen["activity"] != nil && withScreen["screen"] != nil, "an explicitly supplied screenshot may carry its target metadata")
        check(withScreen["appInfoOptIn"] as? Bool == false, "screenshot-only target metadata cannot masquerade as a separate app-info opt-in")
        check(PetSettings().appInfoEnabled == false, "a new user's settings do not opt into application metadata")
        var preferences = PetSettings(); preferences.appInfoEnabled = true
        let persisted = try! JSONEncoder().encode(preferences)
        check(try! JSONDecoder().decode(PetSettings.self, from: persisted).appInfoEnabled == true, "the separate opt-in survives settings serialization")
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let setup = SetupWindowController()
        defer { setup.shutdown() }
        let mode = property(setup, "mode", NSSegmentedControl.self)
        let key = property(setup, "apiKey", NSSecureTextField.self)
        let test = property(setup, "test", NSButton.self)
        check(key.stringValue.isEmpty, "an API key never appears on construction")
        check(!test.isEnabled, "unconfigured connections cannot call the test endpoint")
        for index in 0...2 {
            mode.selectedSegment = index
            NSApp.sendAction(NSSelectorFromString("changeMode:"), to: setup, from: nil)
            setup.window.contentView?.layoutSubtreeIfNeeded()
            let paneName = ["offlinePane", "codexPane", "apiPane"][index]
            let pane = property(setup, paneName, NSStackView.self)
            check(!pane.isHidden, "the selected setup pane is visible")
            check(!pane.hasAmbiguousLayout, "setup panes have a defined layout")
            check(pane.frame.minY >= 0 && pane.frame.maxY <= (setup.window.contentView?.bounds.height ?? 0), "setup panes fit their window")
        }
        setup.applyProbeConfiguration(["mode": "api", "configured": true, "model": "synthetic-model",
            "api": ["format": "responses", "baseURL": "https://example.invalid/v1", "hasKey": true,
                    "apiKey": "SYNTHETIC-UNEXPECTED-KEY-MUST-NOT-DISPLAY"],
            "codex": ["available": false, "authenticated": false, "loginPending": false]])
        check(key.stringValue.isEmpty, "even an unexpected key in GET data is never copied into the input")
        check(key.placeholderString?.contains("留空保留") == true, "saved keys are represented only by a non-secret placeholder")
        check(test.isEnabled, "configured connections allow an explicit user test")
        setup.applyProbeConfiguration(["mode": "codex", "configured": true,
            "codex": ["available": true, "authenticated": true, "restrictedModeVerified": true, "loginPending": false]])
        let codexStatus = property(setup, "codexStatus", NSTextField.self)
        check(codexStatus.stringValue.contains("实验") && codexStatus.stringValue.contains("仅文字") && codexStatus.stringValue.contains("不支持截图"), "Codex capabilities are accurately limited to experimental text mode")
        setup.applyProbeConfiguration(["mode": "codex", "configured": false,
            "codex": ["available": true, "authenticated": true, "restrictedModeVerified": false, "loginPending": false]])
        check(codexStatus.stringValue.contains("未启用"), "unverified restricted-mode compatibility is not presented as enabled")
        check(!FileManager.default.fileExists(atPath: AppPaths.setupFile.path), "constructing settings never writes onboarding or credentials")
        print("SETUP_PROBE passed \(checks) checks; isolated paths, metadata opt-in, secure key field, offline defaults and three layouts; synthetic metadata only, no window shown, service, capture, model or permissions")
    }
}
#endif
