import Foundation

/// Bundled code/assets are read-only; all user state lives in one separate data directory.
enum AppPaths {
    static let environment = ProcessInfo.processInfo.environment

    static let applicationRoot: URL = {
#if WHALE_NATIVE_TEST
        guard let root = environment["WHALE_NATIVE_TEST_ROOT"], !root.isEmpty else {
            preconditionFailure("Native probes require WHALE_NATIVE_TEST_ROOT; real user data is never a test fallback.")
        }
        return URL(fileURLWithPath: root, isDirectory: true)
#else
        if let override = environment["WHALE_PET_DATA_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: NSString(string: override).expandingTildeInPath, isDirectory: true).standardizedFileURL
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/WhalePet", isDirectory: true)
#endif
    }()
    static var dataRoot: URL { applicationRoot.appendingPathComponent("data", isDirectory: true) }

    static let resourceRoot: URL = {
        if let override = environment["WHALE_PET_RESOURCE_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true).standardizedFileURL
        }
        return (Bundle.main.resourceURL ?? Bundle.main.bundleURL)
            .appendingPathComponent("service", isDirectory: true)
    }()

    static var assetsRoot: URL { resourceRoot.appendingPathComponent("assets", isDirectory: true) }
    static var serviceFile: URL { dataRoot.appendingPathComponent("service.json") }
    static var setupFile: URL { dataRoot.appendingPathComponent("onboarding.json") }
    static var nodeBinary: URL {
        if let override = environment["NODE_BINARY"], !override.isEmpty {
            return URL(fileURLWithPath: NSString(string: override).expandingTildeInPath)
        }
        return (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("runtime/bin/node")
    }

    static func serviceURL(_ route: String) -> URL? {
        guard route.hasPrefix("/"), !route.hasPrefix("//") else { return nil }
        let file = serviceCredentials()
        let configured = environment["WHALE_PET_PORT"].flatMap(Int.init) ?? file?["port"] as? Int ?? 43928
        guard (1024...65535).contains(configured) else { return nil }
        return URL(string: "http://127.0.0.1:\(configured)" + route)
    }

    static func serviceCredentials() -> [String: Any]? {
        guard let data = try? Data(contentsOf: serviceFile) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    static func serviceToken() -> String? {
        let credentials = serviceCredentials()
        let token = credentials?["token"] as? String ?? credentials?["accessToken"] as? String
        return token?.isEmpty == false ? token : nil
    }

    static func prepareDataDirectory() throws {
        try FileManager.default.createDirectory(at: dataRoot, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
    }

    static var codexBinary: URL {
        if let override = environment["WHALE_PET_CODEX_BINARY"], !override.isEmpty { return URL(fileURLWithPath: override) }
        return (Bundle.main.resourceURL ?? Bundle.main.bundleURL).appendingPathComponent("runtime/codex")
    }

    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0" }

    static func printDiagnostics() {
        let fm = FileManager.default
        let object: [String: Any] = ["version": version, "applicationDirectory": applicationRoot.path, "dataDirectory": dataRoot.path,
            "resourceDirectory": resourceRoot.path, "serviceEntryExists": fm.fileExists(atPath: resourceRoot.appendingPathComponent("service.mjs").path),
            "assetsExist": fm.fileExists(atPath: assetsRoot.appendingPathComponent("pet.png").path),
            "nodeExecutableExists": fm.isExecutableFile(atPath: nodeBinary.path),
            "codexExecutableExists": fm.isExecutableFile(atPath: codexBinary.path),
            "serviceURL": serviceURL("/")?.absoluteString ?? "invalid-port", "offlinePetAvailable": true,
            "screenshotsDefaultEnabled": PetSettings().screenshotEnabled == true,
            "appInfoDefaultEnabled": PetSettings().appInfoEnabled == true]
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
           let text = String(data: data, encoding: .utf8) { print(text) }
    }
}
