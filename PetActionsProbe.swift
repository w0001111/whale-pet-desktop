#if WHALE_ACTION_TEST
import Foundation
import CoreGraphics
import ImageIO

@main enum PetActionsProbe {
    private static var checks = 0
    private static func require(_ value: Bool, _ message: String) {
        precondition(value, message)
        checks += 1
    }
    private static func rejected(_ message: String, _ body: () throws -> Void) {
        do { try body(); preconditionFailure(message) } catch { checks += 1 }
    }
    private static func makePNG(_ file: URL, columns: Int, rows: Int, tail: Int = 0, opaqueTail: Bool = false, cellHeight: Int = 32) throws {
        let cellWidth = 32, width = columns * cellWidth + tail, height = rows * cellHeight + tail
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let offset = (y * width + x) * 4
                if x >= columns * cellWidth || y >= rows * cellHeight {
                    if opaqueTail { bytes[offset + 3] = 255 }
                    continue
                }
                if x % cellWidth < 2 || y % cellHeight < 2 { continue }
                let index = (y / cellHeight) * columns + x / cellWidth
                bytes[offset] = UInt8(20 + index * 20)
                bytes[offset + 1] = UInt8(30 + index * 15)
                bytes[offset + 2] = UInt8(40 + index * 10)
                bytes[offset + 3] = 255
            }
        }
        let provider = CGDataProvider(data: Data(bytes) as CFData)!
        let bitmap = CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue)
        let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: bitmap, provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        let destination = CGImageDestinationCreateWithURL(file as CFURL, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw PetActionLibraryError.invalidImage }
    }
    private static func red(_ image: CGImage) -> UInt8 {
        let bitmap = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
        let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: bitmap)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return context.data!.assumingMemoryBound(to: UInt8.self)[((image.height / 2) * image.width + image.width / 2) * 4]
    }
    private static func manifest() -> [String: Any] {
        ["version": 1,
         "sheets": [["id":"movement","file":"movement.png","columns":3,"rows":3], ["id":"eating","file":"eating.png","columns":2,"rows":2]],
         "clips": [["id":"standUp","sheet":"movement","frames":[0,1,2],"fps":4,"loop":false],
                   ["id":"stand","sheet":"movement","frames":[2],"fps":1,"loop":true],
                   ["id":"walk","sheet":"movement","frames":[3,4,5,6,7,8],"fps":6,"loop":true],
                   ["id":"eat","sheet":"eating","frames":[0,1,2,3],"fps":4,"loop":true],
                   ["id":"sitDown","sheet":"movement","frames":[2,1,0],"fps":4,"loop":false]]]
    }
    private static func save(_ value: [String: Any], to directory: URL) throws {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: directory.appendingPathComponent("manifest.json"))
    }
    static func main() throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSTemporaryDirectory(), isDirectory: true).appendingPathComponent("pet-actions-probe-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let movement = directory.appendingPathComponent("movement.png"), eating = directory.appendingPathComponent("eating.png")
        try makePNG(movement, columns: 3, rows: 3)
        try makePNG(eating, columns: 2, rows: 2)
        let valid = manifest()
        try save(valid, to: directory)
        let library = try PetActionLibrary.load(from: directory)
        require(library.clips.count == 5, "all required clips load")
        require(library.clips["standUp"]!.frames.count == 3 && library.clips["walk"]!.frames.count == 6 && library.clips["eat"]!.frames.count == 4, "clip lengths preserved")
        require(red(library.clips["stand"]!.frames[0]) == 60, "stand references original cell 2")
        require(red(library.clips["walk"]!.frames[0]) == 80, "walk starts on original cell 3")
        require(red(library.clips["walk"]!.frames[3]) == 140, "top-to-bottom crop order is stable")
        require(red(library.clips["sitDown"]!.frames[2]) == 20, "sitDown reverse ends in cell 0")
        require(library.frame(for: PetActionSample(clipID: "missing", frameIndex: 0, walking: false)) == nil, "unknown samples do not crash")
        require(library.frame(for: PetActionSample(clipID: "walk", frameIndex: 20, walking: true)) == nil, "out-of-range samples do not crash")
        let off = directory.appendingPathComponent("movement.off")
        try FileManager.default.moveItem(at: movement, to: off)
        require(red(library.clips["walk"]!.frames[0]) == 80, "loaded image frames remain usable without files")
        try FileManager.default.moveItem(at: off, to: movement)

        var timeline = PetActionTimeline(library: library)
        require(timeline.sample(at: 0) == nil, "unstarted timeline is empty")
        require(timeline.play(.walk, at: 10), "walk starts")
        require(timeline.sample(at: 9) == PetActionSample(clipID: "standUp", frameIndex: 0, walking: false), "early clocks cannot skip the rise")
        require(timeline.sample(at: 10.25)?.frameIndex == 1, "rise advances frames")
        require(timeline.sample(at: 10.75) == PetActionSample(clipID: "walk", frameIndex: 0, walking: true), "walking starts after rise")
        require(timeline.sample(at: 11.75) == PetActionSample(clipID: "walk", frameIndex: 0, walking: true), "walk repeats at cycle boundary")
        require(timeline.sample(at: 18.75)?.clipID == "stand", "manual walk rests after eight seconds")
        require(timeline.sample(at: 20.75)?.clipID == "sitDown", "manual walk eventually sits")
        require(timeline.sample(at: 21.5) == nil, "manual choreography completes")
        require(timeline.play(.walk, at: 0, continuous: true), "continuous walk starts")
        require(timeline.sample(at: 3600)?.walking == true && timeline.sample(at: 3600)?.clipID == "walk", "continuous wandering never sits at 120 seconds")
        require(timeline.sample(at: Double.greatestFiniteMagnitude)?.frameIndex ?? -1 >= 0, "long-running looping phase stays bounded before integer conversion")
        require(timeline.sample(at: 3600, reducedMotion: true) == PetActionSample(clipID: "stand", frameIndex: 0, walking: false), "reduced motion has no gait or walking movement")
        require(!timeline.play(.eat, at: 0, continuous: true), "only walk supports continuous playback")
        require(!timeline.play(.walk, at: 0, duration: 8, continuous: true), "ambiguous continuous hold duration is rejected")
        timeline.cancel(); require(timeline.sample(at: 0) == nil && timeline.action == nil, "cancel clears the choreography")
        require(timeline.play(.standUp, at: 0, duration: 3), "standUp accepts explicit hold")
        require(timeline.sample(at: 0.75)?.clipID == "stand" && timeline.sample(at: 3.75)?.clipID == "sitDown", "standUp holds then sits")
        require(timeline.play(.stand, at: 0, duration: 2), "stand pose starts")
        require(timeline.sample(at: 2)?.clipID == "sitDown", "stand pose honors its hold")
        require(timeline.play(.eat, at: 0), "eating starts")
        require(timeline.sample(at: 0.5)?.frameIndex == 2 && timeline.sample(at: 1)?.frameIndex == 0, "eating cycles through all spoon phases")
        require(timeline.sample(at: 8) == nil, "eating stops without model work")
        require(timeline.sample(at: 0.5, reducedMotion: true)?.frameIndex == 0, "reduced eating is static")
        require(timeline.play(.sitDown, at: 0), "sitDown starts")
        require(timeline.sample(at: 0, reducedMotion: true)?.frameIndex == 2, "reduced sitDown immediately presents settled seated frame")
        require(!timeline.play(.eat, at: .nan) && !timeline.play(.eat, at: 0, duration: .infinity) && !timeline.play(.eat, at: 0, duration: 0), "invalid clocks and holds do not start new actions")
        require(timeline.sample(at: .nan) == nil, "invalid sample clocks are ignored")

        var extended = valid
        var extraClips = extended["clips"] as! [[String: Any]]
        extraClips.append(["id":"stretch","displayName":"伸懒腰","sheet":"movement","frames":[0,1,2],"fps":3,"loop":true])
        extraClips.append(["id":"nod","sheet":"movement","frames":[2,1],"fps":2,"loop":false])
        extended["clips"] = extraClips
        try save(extended, to: directory)
        let extraLibrary = try PetActionLibrary.load(from: directory)
        require(extraLibrary.clips["stretch"]?.displayName == "伸懒腰" && extraLibrary.clips["nod"]?.displayName == "nod", "external clip labels load with id fallback")
        var extraTimeline = PetActionTimeline(library: extraLibrary)
        require(extraTimeline.playClip("stretch", at: 0) && extraTimeline.action == nil, "extra clip starts without adding an enum case")
        require(extraTimeline.sample(at: 0.4) == PetActionSample(clipID: "stretch", frameIndex: 1, walking: false), "extra clip animates without requesting movement")
        require(extraTimeline.sample(at: 1)?.frameIndex == 0 && extraTimeline.sample(at: 8) == nil, "looping extra defaults to eight seconds")
        require(extraTimeline.playClip("nod", at: 0) && extraTimeline.sample(at: 0.6)?.frameIndex == 1 && extraTimeline.sample(at: 1) == nil, "nonlooping extra defaults to one cycle")
        require(extraTimeline.playClip("stretch", at: 0, duration: 3) && extraTimeline.sample(at: 2.9)?.clipID == "stretch" && extraTimeline.sample(at: 3) == nil, "extra duration override is bounded")
        require(extraTimeline.sample(at: 1.5, reducedMotion: true)?.frameIndex == 0 && extraTimeline.sample(at: 1.5, reducedMotion: true)?.walking == false, "extra clip honors reduced motion")
        require(!extraTimeline.playClip("missing", at: 0) && !extraTimeline.playClip("walk", at: 0), "unknown and core IDs cannot bypass action choreography")
        require(!extraTimeline.playClip("stretch", at: .nan) && !extraTimeline.playClip("stretch", at: 0, duration: 0) && !extraTimeline.playClip("stretch", at: 0, duration: 121) && !extraTimeline.playClip("stretch", at: 0, duration: .infinity), "invalid extra clocks and durations are rejected")
        for label: Any in ["", " ", String(repeating: "a", count: 25), "坏\n标签", "坏\u{007f}标签", " 前空格", 12, NSNull()] {
            var badExtra = extended
            var values = badExtra["clips"] as! [[String: Any]]
            values[5]["displayName"] = label
            badExtra["clips"] = values
            try save(badExtra, to: directory)
            rejected("invalid external displayName accepted") { _ = try PetActionLibrary.load(from: directory) }
        }
        try save(valid, to: directory)

        var atlas = valid
        var atlasSheets = atlas["sheets"] as! [[String: Any]]
        let regions = [[0,0,32,32], [64,0,32,32], [0,32,32,32], [64,32,32,32]]
        atlasSheets[1]["regions"] = regions
        atlas["sheets"] = atlasSheets
        try makePNG(eating, columns: 3, rows: 2)
        try save(atlas, to: directory)
        let atlasLibrary = try PetActionLibrary.load(from: directory)
        require(atlasLibrary.clips["eat"]!.frames.allSatisfy { $0.width == 32 && $0.height == 32 }, "atlas uses explicit square regions instead of non-square grid")
        require(red(atlasLibrary.clips["eat"]!.frames[0]) == 20 && red(atlasLibrary.clips["eat"]!.frames[1]) == 60 && red(atlasLibrary.clips["eat"]!.frames[2]) == 80 && red(atlasLibrary.clips["eat"]!.frames[3]) == 120, "atlas frame order maps through explicit regions")
        for value: Any in [NSNull(), "not-regions", [1,2,3,4], [], [[0,0,32,32]], [[0,0,32]], [[0,0,32,31],[0,0,32,32],[0,0,32,32],[0,0,32,32]], [[-1,0,32,32],[0,0,32,32],[0,0,32,32],[0,0,32,32]], [[65,0,32,32],[0,0,32,32],[0,0,32,32],[0,0,32,32]], [[0,33,32,32],[0,0,32,32],[0,0,32,32],[0,0,32,32]], [[0,0,31,31],[0,0,32,32],[0,0,32,32],[0,0,32,32]], [[0,0,2049,2049],[0,0,32,32],[0,0,32,32],[0,0,32,32]], [[0.5,0,32,32],[0,0,32,32],[0,0,32,32],[0,0,32,32]]] {
            var badAtlas = atlas
            var values = badAtlas["sheets"] as! [[String: Any]]
            values[1]["regions"] = value
            badAtlas["sheets"] = values
            try save(badAtlas, to: directory)
            rejected("invalid atlas regions accepted") { _ = try PetActionLibrary.load(from: directory) }
        }
        try makePNG(eating, columns: 2, rows: 2, tail: 1, opaqueTail: true)
        atlasSheets[1]["regions"] = [[0,0,32,32],[32,0,32,32],[0,32,32,32],[32,32,32,32]]
        atlas["sheets"] = atlasSheets
        try save(atlas, to: directory)
        require(try PetActionLibrary.load(from: directory).clips["eat"]!.frames.count == 4, "explicit regions do not require unused outside pixels to be transparent")
        try makePNG(eating, columns: 2, rows: 2)
        try save(valid, to: directory)

        try makePNG(movement, columns: 3, rows: 3, tail: 1)
        let padded = try PetActionLibrary.load(from: directory)
        require(padded.clips["walk"]!.frames[0].width == 32 && red(padded.clips["walk"]!.frames[3]) == 140, "one transparent tail pixel may be discarded from a 3x3 sheet")
        try makePNG(movement, columns: 3, rows: 3, tail: 1, opaqueTail: true)
        rejected("visible discarded border accepted") { _ = try PetActionLibrary.load(from: directory) }
        try makePNG(movement, columns: 3, rows: 3, cellHeight: 33)
        rejected("non-square cells accepted") { _ = try PetActionLibrary.load(from: directory) }
        try makePNG(movement, columns: 3, rows: 3)

        var bad = valid; bad["version"] = 2
        try save(bad, to: directory); rejected("unsupported version accepted") { _ = try PetActionLibrary.load(from: directory) }
        bad = valid; bad["unexpected"] = true
        try save(bad, to: directory); rejected("unknown top-level field accepted") { _ = try PetActionLibrary.load(from: directory) }
        bad = valid; var sheets = bad["sheets"] as! [[String: Any]]; sheets[0]["file"] = "../outside.png"; bad["sheets"] = sheets
        try save(bad, to: directory); rejected("traversal accepted") { _ = try PetActionLibrary.load(from: directory) }
        bad = valid; sheets = bad["sheets"] as! [[String: Any]]; sheets[0]["columns"] = 0; bad["sheets"] = sheets
        try save(bad, to: directory); rejected("zero-sized grid accepted") { _ = try PetActionLibrary.load(from: directory) }
        bad = valid; var clips = bad["clips"] as! [[String: Any]]; clips[2]["frames"] = [9]; bad["clips"] = clips
        try save(bad, to: directory); rejected("outside frame accepted") { _ = try PetActionLibrary.load(from: directory) }
        bad = valid; clips = bad["clips"] as! [[String: Any]]; clips[2]["fps"] = 0; bad["clips"] = clips
        try save(bad, to: directory); rejected("zero fps accepted") { _ = try PetActionLibrary.load(from: directory) }
        bad = valid; clips = bad["clips"] as! [[String: Any]]; clips[2]["id"] = "stand"; bad["clips"] = clips
        try save(bad, to: directory); rejected("duplicate clip accepted") { _ = try PetActionLibrary.load(from: directory) }
        bad = valid; clips = bad["clips"] as! [[String: Any]]; clips.removeLast(); bad["clips"] = clips
        try save(bad, to: directory); rejected("missing required clip accepted") { _ = try PetActionLibrary.load(from: directory) }
        try save(valid, to: directory)
        try FileManager.default.moveItem(at: movement, to: off)
        try FileManager.default.createSymbolicLink(at: movement, withDestinationURL: off)
        rejected("symlinked image accepted") { _ = try PetActionLibrary.load(from: directory) }
        try FileManager.default.removeItem(at: movement); try FileManager.default.moveItem(at: off, to: movement)
        let alias = directory.deletingLastPathComponent().appendingPathComponent(directory.lastPathComponent + "-alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: directory)
        rejected("symlinked root accepted") { _ = try PetActionLibrary.load(from: alias) }
        try FileManager.default.removeItem(at: alias)
        let manifestFile = directory.appendingPathComponent("manifest.json")
        try Data(repeating: 32, count: 128 * 1024 + 1).write(to: manifestFile)
        rejected("oversized manifest accepted") { _ = try PetActionLibrary.load(from: directory) }
        try save(valid, to: directory)
        try Data("not-png".utf8).write(to: eating)
        rejected("malformed PNG accepted") { _ = try PetActionLibrary.load(from: directory) }
        print("PET_ACTIONS_PROBE passed \(checks) checks; local synthetic PNGs and clocks only; no model, network, permissions or production files")
    }
}
#endif
