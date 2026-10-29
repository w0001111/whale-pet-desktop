import Foundation
import CoreGraphics
import ImageIO
import Darwin

enum PetActionLibraryError: Error, LocalizedError {
    case unsafePath, unreadable, invalidManifest, invalidImage, tooLarge
    var errorDescription: String? {
        switch self {
        case .unsafePath: return "动作素材路径不安全，未加载。"
        case .unreadable: return "动作素材暂时无法读取。"
        case .invalidManifest: return "动作包配置无效，沿用原来的动作。"
        case .invalidImage: return "动作图片或分帧配置无效。"
        case .tooLarge: return "动作包超过本地加载上限。"
        }
    }
}

struct PetActionClip {
    let id: String
    let frames: [CGImage]
    let fps: Double
    let loop: Bool
    let displayName: String
    init(id: String, frames: [CGImage], fps: Double, loop: Bool, displayName: String? = nil) {
        self.id = id; self.frames = frames; self.fps = fps; self.loop = loop
        self.displayName = displayName ?? id
    }
    var cycleDuration: Double { Double(frames.count) / fps }
}

struct PetActionSample: Equatable {
    let clipID: String
    /// Position within the clip's frames, not an index into the original sheet.
    let frameIndex: Int
    let walking: Bool
}

/// A bounded, read-once asset pack. Sampling never opens a file or decodes PNGs.
struct PetActionLibrary {
    let clips: [String: PetActionClip]
    let sourceDirectory: URL
    static let requiredClipIDs: Set<String> = ["standUp", "stand", "walk", "eat", "sitDown"]

    func frame(for sample: PetActionSample) -> CGImage? {
        guard let clip = clips[sample.clipID], clip.frames.indices.contains(sample.frameIndex) else { return nil }
        return clip.frames[sample.frameIndex]
    }

    private struct Manifest: Decodable {
        let version: Int
        let sheets: [SheetSpec]
        let clips: [ClipSpec]
    }
    private struct SheetSpec: Decodable {
        let id: String
        let file: String
        let columns: Int
        let rows: Int
        let regions: [[Int]]?
    }
    private struct ClipSpec: Decodable {
        let id: String
        let sheet: String
        let frames: [Int]
        let fps: Double
        let loop: Bool
        let displayName: String?
    }

    static func load(from directory: URL) throws -> PetActionLibrary {
        guard directory.isFileURL, directory.path.hasPrefix("/"), directory.standardizedFileURL == directory.resolvingSymlinksInPath().standardizedFileURL else { throw PetActionLibraryError.unsafePath }
        let fd = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw errno == ELOOP ? PetActionLibraryError.unsafePath : PetActionLibraryError.unreadable }
        defer { close(fd) }
        let bytes = try readFile("manifest.json", directoryFD: fd, limit: 128 * 1024)
        let raw: [String: Any]
        let manifest: Manifest
        do {
            guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw PetActionLibraryError.invalidManifest }
            raw = value
            manifest = try JSONDecoder().decode(Manifest.self, from: bytes)
        } catch { throw PetActionLibraryError.invalidManifest }
        guard Set(raw.keys) == ["version", "sheets", "clips"], manifest.version == 1,
              !manifest.sheets.isEmpty, manifest.sheets.count <= 8,
              !manifest.clips.isEmpty, manifest.clips.count <= 32,
              let rawSheets = raw["sheets"] as? [[String: Any]], let rawClips = raw["clips"] as? [[String: Any]],
              rawSheets.allSatisfy({ value in
                  let fields = Set(value.keys), required: Set<String> = ["id", "file", "columns", "rows"]
                  return required.isSubset(of: fields) && fields.isSubset(of: required.union(["regions"])) &&
                      (value["regions"] == nil || value["regions"] is [[Any]])
              }),
              rawClips.allSatisfy({ value in
                  let fields = Set(value.keys), required: Set<String> = ["id", "sheet", "frames", "fps", "loop"]
                  return required.isSubset(of: fields) && fields.isSubset(of: required.union(["displayName"])) &&
                      (value["displayName"] == nil || (value["displayName"] as? String).map(validDisplayName) == true)
              }) else { throw PetActionLibraryError.invalidManifest }
        var specs: [String: SheetSpec] = [:]
        var images: [String: CGImage] = [:]
        var totalBytes = bytes.count
        var totalPixels = 0
        var files = Set<String>()
        for spec in manifest.sheets {
            guard validID(spec.id), specs[spec.id] == nil, validFilename(spec.file), files.insert(spec.file).inserted,
                  (1...8).contains(spec.columns), (1...8).contains(spec.rows), spec.columns * spec.rows <= 64 else { throw PetActionLibraryError.invalidManifest }
            let data = try readFile(spec.file, directoryFD: fd, limit: 24 * 1024 * 1024)
            totalBytes += data.count
            guard totalBytes <= 48 * 1024 * 1024 else { throw PetActionLibraryError.tooLarge }
            guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  CGImageSourceGetCount(source) == 1, CGImageSourceGetType(source) as String? == "public.png",
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
                  let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
                  width > 0, height > 0, width <= 4096, height <= 4096 else { throw PetActionLibraryError.invalidImage }
            if let regions = spec.regions {
                guard regions.count == spec.columns * spec.rows,
                      regions.allSatisfy({ region in
                          region.count == 4 && region[0] >= 0 && region[1] >= 0 && (32...2048).contains(region[2]) && region[2] == region[3] &&
                              region[0] <= width - region[2] && region[1] <= height - region[3]
                      }) else { throw PetActionLibraryError.invalidImage }
            } else {
                guard (32...2048).contains(width / spec.columns), width / spec.columns == height / spec.rows else { throw PetActionLibraryError.invalidImage }
            }
            totalPixels += width * height
            guard totalPixels <= 24 * 1024 * 1024 else { throw PetActionLibraryError.tooLarge }
            guard let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
                  [.first, .last, .premultipliedFirst, .premultipliedLast, .alphaOnly].contains(image.alphaInfo) else { throw PetActionLibraryError.invalidImage }
            // A 1024px image divided into 3 cells leaves one pixel. The pack
            // may discard only this tiny, completely transparent outer strip.
            let trailingWidth = spec.regions == nil ? width % spec.columns : 0, trailingHeight = spec.regions == nil ? height % spec.rows : 0
            if trailingWidth > 0 {
                guard let strip = image.cropping(to: CGRect(x: width - trailingWidth, y: 0, width: trailingWidth, height: height)), transparent(strip) else { throw PetActionLibraryError.invalidImage }
            }
            if trailingHeight > 0 {
                guard let strip = image.cropping(to: CGRect(x: 0, y: height - trailingHeight, width: width, height: trailingHeight)), transparent(strip) else { throw PetActionLibraryError.invalidImage }
            }
            specs[spec.id] = spec
            images[spec.id] = image
        }
        var result: [String: PetActionClip] = [:]
        var crops: [String: CGImage] = [:]
        var frameCount = 0
        for spec in manifest.clips {
            guard validID(spec.id), result[spec.id] == nil, let sheet = specs[spec.sheet], let image = images[spec.sheet],
                  !spec.frames.isEmpty, spec.frames.count <= 64, spec.frames.allSatisfy({ (0..<(sheet.rows * sheet.columns)).contains($0) }),
                  spec.fps.isFinite, (0.5...30).contains(spec.fps) else { throw PetActionLibraryError.invalidManifest }
            frameCount += spec.frames.count
            guard frameCount <= 192 else { throw PetActionLibraryError.tooLarge }
            let cellWidth = image.width / sheet.columns, cellHeight = image.height / sheet.rows
            var frames: [CGImage] = []
            for index in spec.frames {
                let key = "\(spec.sheet):\(index)"
                if crops[key] == nil {
                    // Core Graphics pixel crop coordinates match top-to-bottom sheet rows.
                    let rect: CGRect
                    if let region = sheet.regions?[index] {
                        rect = CGRect(x: region[0], y: region[1], width: region[2], height: region[3])
                    } else {
                        rect = CGRect(x: (index % sheet.columns) * cellWidth, y: (index / sheet.columns) * cellHeight, width: cellWidth, height: cellHeight)
                    }
                    guard let crop = image.cropping(to: rect) else { throw PetActionLibraryError.invalidImage }
                    crops[key] = crop
                }
                frames.append(crops[key]!)
            }
            result[spec.id] = PetActionClip(id: spec.id, frames: frames, fps: spec.fps, loop: spec.loop, displayName: spec.displayName)
        }
        guard requiredClipIDs.isSubset(of: Set(result.keys)) else { throw PetActionLibraryError.invalidManifest }
        return PetActionLibrary(clips: result, sourceDirectory: directory)
    }

    private static func validID(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z][A-Za-z0-9_-]{0,39}$", options: .regularExpression) != nil
    }
    private static func validDisplayName(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 24 && value == value.trimmingCharacters(in: .whitespacesAndNewlines) &&
            value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) && !CharacterSet.newlines.contains($0) }
    }
    private static func transparent(_ image: CGImage) -> Bool {
        let bitmap = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
        guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: bitmap), let bytes = context.data?.assumingMemoryBound(to: UInt8.self) else { return false }
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return (0..<(image.width * image.height)).allSatisfy { bytes[$0 * 4 + 3] == 0 }
    }
    private static func validFilename(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\\.png$", options: .regularExpression) != nil && !value.contains("..")
    }
    private static func readFile(_ name: String, directoryFD: Int32, limit: Int) throws -> Data {
        guard !name.contains("/"), !name.contains("\\"), name != ".", name != ".." else { throw PetActionLibraryError.unsafePath }
        let fd = openat(directoryFD, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw errno == ELOOP ? PetActionLibraryError.unsafePath : PetActionLibraryError.unreadable }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { throw PetActionLibraryError.unsafePath }
        guard info.st_size >= 0, info.st_size <= limit else { throw PetActionLibraryError.tooLarge }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let count = read(fd, &buffer, buffer.count)
            if count < 0 { if errno == EINTR { continue }; throw PetActionLibraryError.unreadable }
            if count == 0 { break }
            guard data.count <= limit - count else { throw PetActionLibraryError.tooLarge }
            data.append(buffer, count: count)
        }
        return data
    }
}

enum PetActionKind: String, CaseIterable {
    case standUp, stand, walk, eat, sitDown
}

/// Small local choreography. Times are caller-supplied monotonic animation time.
struct PetActionTimeline {
    private struct Step {
        let clipID: String
        let duration: Double
    }
    private let clips: [String: PetActionClip]
    private var steps: [Step] = []
    private var startedAt: Double = 0
    private(set) var action: PetActionKind?
    init(library: PetActionLibrary) { clips = library.clips }

    @discardableResult
    mutating func play(_ action: PetActionKind, at time: Double, duration: Double? = nil, continuous: Bool = false) -> Bool {
        guard time.isFinite, duration == nil || (duration!.isFinite && duration! > 0 && duration! <= 120),
              !continuous || (action == .walk && duration == nil),
              PetActionLibrary.requiredClipIDs.isSubset(of: Set(clips.keys)) else { return false }
        let rise = clips["standUp"]!.cycleDuration, sit = clips["sitDown"]!.cycleDuration
        let hold = duration ?? (action == .walk || action == .eat ? 8 : 12)
        switch action {
        case .standUp: steps = [Step(clipID: "standUp", duration: rise), Step(clipID: "stand", duration: hold), Step(clipID: "sitDown", duration: sit)]
        case .stand: steps = [Step(clipID: "stand", duration: hold), Step(clipID: "sitDown", duration: sit)]
        case .walk:
            steps = continuous ? [Step(clipID: "standUp", duration: rise), Step(clipID: "walk", duration: .infinity)] : [Step(clipID: "standUp", duration: rise), Step(clipID: "walk", duration: hold), Step(clipID: "stand", duration: 2), Step(clipID: "sitDown", duration: sit)]
        case .eat: steps = [Step(clipID: "eat", duration: hold)]
        case .sitDown: steps = [Step(clipID: "sitDown", duration: sit)]
        }
        startedAt = time
        self.action = action
        return true
    }
    mutating func cancel() { steps = []; action = nil }
    /// Extra clips are driven entirely by the external manifest. Core actions
    /// retain their choreography through play(_:at:duration:continuous:).
    @discardableResult
    mutating func playClip(_ id: String, at time: Double, duration: Double? = nil) -> Bool {
        guard time.isFinite, !PetActionLibrary.requiredClipIDs.contains(id), let clip = clips[id], !clip.frames.isEmpty else { return false }
        let hold = duration ?? (clip.loop ? 8 : clip.cycleDuration)
        guard hold.isFinite, hold > 0, hold <= 120 else { return false }
        steps = [Step(clipID: id, duration: hold)]
        startedAt = time
        action = nil
        return true
    }
    func sample(at time: Double, reducedMotion: Bool = false) -> PetActionSample? {
        guard time.isFinite, !steps.isEmpty else { return nil }
        var elapsed = max(0, time - startedAt)
        for step in steps {
            if elapsed < step.duration {
                guard let clip = clips[step.clipID], !clip.frames.isEmpty else { return nil }
                if reducedMotion {
                    if step.clipID == "walk" || step.clipID == "standUp" { return PetActionSample(clipID: "stand", frameIndex: 0, walking: false) }
                    return PetActionSample(clipID: step.clipID, frameIndex: step.clipID == "sitDown" ? clip.frames.count - 1 : 0, walking: false)
                }
                let phase = clip.loop ? elapsed.truncatingRemainder(dividingBy: clip.cycleDuration) : min(elapsed, clip.cycleDuration)
                let index = Int(floor(phase * clip.fps))
                return PetActionSample(clipID: step.clipID, frameIndex: clip.loop ? index % clip.frames.count : min(index, clip.frames.count - 1), walking: step.clipID == "walk")
            }
            elapsed -= step.duration
        }
        return nil
    }
}
