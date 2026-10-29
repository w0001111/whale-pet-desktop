#if WHALE_NATIVE_TEST
import AppKit
import QuartzCore

@main enum PetActionIntegrationProbe {
    static var checks = 0
    static func check(_ value: Bool, _ message: String) { precondition(value, message); checks += 1 }
    static func value<T>(_ object: Any, _ name: String, _ type: T.Type) -> T { Mirror(reflecting: object).children.first(where: { $0.label == name })!.value as! T }
    static func frame(_ view: PetView) -> Any { Mirror(reflecting: value(view, "displayedFrame", Any.self)).children.first!.value }
    static func grounded(_ view: PetView) {
        let f = frame(view)
        let inset = value(f, "groundInset", CGFloat.self)
        let layer = value(view, "imageLayer", CALayer.self)
        let baseline = layer.position.y - layer.bounds.height / 2 + layer.bounds.height * inset
        check(abs(baseline - 14) < 0.01, "displayed feet have one stable ground line")
    }
    static func mask(_ view: PetView) -> [Bool] {
        (0..<30).flatMap { y in (0..<30).map { x in view.opaque(at: NSPoint(x: (CGFloat(x) + 0.5) * view.bounds.width / 30, y: (CGFloat(y) + 0.5) * view.bounds.height / 30)) } }
    }
    static func main() throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let source = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let library = try PetActionLibrary.load(from: source.appendingPathComponent("assets/actions-v2"))
        check(library.clips["walk"]?.frames.count == 6, "six gait frames loaded")
        check(library.clips["eat"]?.frames.count == 4, "four whole atlas eating frames loaded")
        let view = PetView(frame: NSRect(x: 0, y: 0, width: 200, height: 204))
        view.image = NSImage(contentsOf: source.appendingPathComponent("assets/pet.png"))
        view.spriteSheet = NSImage(contentsOf: source.appendingPathComponent("assets/pet-sprites.png"))
        check(view.installActions(library), "actual generated pack installs")
        let seated = mask(view)
        view.phase = 0
        view.updateActivity(wandering: false, movementAllowed: true, idleAllowed: false, automatic: false)
        view.playAction(.walk)
        view.phase = 0.2; view.updateAnimation()
        check(view.activeActionClip == "standUp" && !view.isWalking, "rise before locomotion")
        grounded(view)
        view.phase = 1.05; view.updateAnimation()
        check(view.activeActionClip == "walk" && view.isWalking, "gait and locomotion allowed together")
        let firstKey = value(view, "displayedFrameKey", String.self)
        let firstMask = mask(view)
        grounded(view)
        view.phase = 1.3; view.updateAnimation()
        check(value(view, "displayedFrameKey", String.self) != firstKey, "gait really advances to another drawn leg frame")
        grounded(view)
        view.updateActivity(wandering: false, movementAllowed: false, idleAllowed: false, automatic: false)
        view.updateAnimation()
        check(!view.isWalking && view.activeActionClip == "stand", "blocked movement also stops gait")
        grounded(view)
        view.phase = 2
        view.playAction(.eat)
        check(view.activeActionClip == "eat" && !view.isWalking, "eating stays in place")
        let eating = mask(view)
        check(eating != firstMask && eating != seated, "hit silhouette follows drawn bowl and new body")
        check(eating.contains(true) && eating.contains(false), "transparent pixels pass through while body is clickable")
        grounded(view)
        for phase in [2.0, 2.26, 2.51, 2.76] { view.phase = phase; view.updateAnimation(); grounded(view) }
        let right = mask(view)
        view.lookingLeft = true
        let left = mask(view)
        let mirrored = (0..<30).flatMap { y in (0..<30).map { x in right[y * 30 + 29 - x] } }
        check(zip(left, mirrored).filter { $0 != $1 }.count <= 4, "mirrored alpha hits follow facing direction")
        view.setEmotion(.thinking)
        view.updateActivity(wandering: true, movementAllowed: false, idleAllowed: false, automatic: false)
        view.updateAnimation()
        check(view.blocksWalking && !view.isWalking && view.activeActionClip == nil, "conversation cancels posture and does not restart a blocked walk")
        view.setEmotion(.idle)
        view.phase = 20
        view.updateActivity(wandering: true, movementAllowed: true, idleAllowed: false, automatic: false)
        view.phase = 180; view.updateAnimation()
        check(view.activeActionClip == "walk" && view.isWalking, "continuous roaming does not sit down after two minutes")
        view.updateActivity(wandering: false, movementAllowed: true, idleAllowed: false, automatic: false)
        view.updateAnimation()
        check(view.activeActionClip == "sitDown" && !view.isWalking, "stopping continuous walk sits down")
        view.phase = 181; view.updateAnimation()
        check(view.activeActionClip == nil && !view.isWalking, "completed sit returns to original seated animation")
        view.phase = 190
        view.updateActivity(wandering: true, movementAllowed: true, idleAllowed: false, automatic: false)
        view.phase = 191; view.updateAnimation()
        check(view.isWalking, "roaming resumes its continuous gait")
        view.updateActivity(wandering: true, movementAllowed: true, idleAllowed: false, automatic: false, roamWalkingRequested: false)
        view.phase = 192; view.updateAnimation()
        check(view.activeActionClip == "stand" && !view.isWalking, "arrival rest stops legs while persistent roaming stays enabled")
        view.updateActivity(wandering: true, movementAllowed: true, idleAllowed: false, automatic: false, roamWalkingRequested: false)
        view.updateAnimation()
        check(view.activeActionClip == "stand" && !view.isWalking, "rest does not restart continuous walking on the next tick")
        view.playAction(.eat, duration: 8)
        view.updateActivity(wandering: true, movementAllowed: true, idleAllowed: false, automatic: false, roamWalkingRequested: true)
        view.updateAnimation()
        check(view.hasExclusiveAction && view.activeActionClip == "eat" && !view.isWalking, "new destination cannot cut off an exclusive eating activity")
        check(!view.tryAutomaticActivity(duration: 4), "automatic rest activity cannot overwrite manual eating")
        view.phase = 201
        view.updateActivity(wandering: false, movementAllowed: true, idleAllowed: false, automatic: false)
        view.updateAnimation()
        view.setEmotion(.happy)
        view.phase = 202; view.updateAnimation()
        let motion = value(view, "motionLayer", CALayer.self)
        let animation = motion.animation(forKey: "bob")
        check(animation != nil, "original local emotion animation remains")
        let malformed = PetActionLibrary(clips: [:], sourceDirectory: source)
        check(!view.installActions(malformed), "unusable pack rejected without replacing working library")
        check(view.actionsAvailable, "previous action pack preserved after failed replacement")
        let owner = PetApp()
        owner.petView.image = NSImage(contentsOf: source.appendingPathComponent("assets/pet.png"))
        owner.petView.spriteSheet = NSImage(contentsOf: source.appendingPathComponent("assets/pet-sprites.png"))
        check(owner.petView.installActions(library), "isolated owner action pack installs")
        owner.petView.updateActivity(wandering: false, movementAllowed: true, idleAllowed: false, automatic: false)
        func dailyItem(_ id: String) -> NSMenuItem {
            owner.makeMenu().items.first(where: { $0.title == "日常姿态" })!.submenu!.items.first(where: { $0.representedObject as? String == id })!
        }
        let walkItem = dailyItem("walk")
        check(walkItem.title == "走一走" && walkItem.state == .off, "daily walking entry has shared persistent state")
        _ = owner.perform(NSSelectorFromString("performPetAction:"), with: walkItem)
        check(value(owner, "settings", PetSettings.self).wandering && dailyItem("walk").state == .on, "daily walking enables and checks continuous roaming")
        owner.petView.phase = 180; owner.petView.updateAnimation()
        check(owner.petView.isWalking && owner.petView.activeActionClip == "walk", "daily walking does not end after eight or 120 seconds")
        _ = owner.perform(NSSelectorFromString("performPetAction:"), with: dailyItem("walk"))
        check(!value(owner, "settings", PetSettings.self).wandering && dailyItem("walk").state == .off, "clicking the checked daily entry pauses the same roaming state")
        _ = owner.perform(NSSelectorFromString("toggleWandering:"), with: nil)
        check(value(owner, "settings", PetSettings.self).wandering && dailyItem("walk").state == .on, "original start entry checks the daily entry")
        _ = owner.perform(NSSelectorFromString("toggleWandering:"), with: nil)
        check(!value(owner, "settings", PetSettings.self).wandering && dailyItem("walk").state == .off && owner.petView.activeActionClip == "sitDown", "original pause entry stops the same walk and sits down")
        _ = owner.perform(NSSelectorFromString("performPetAction:"), with: dailyItem("walk"))
        _ = owner.perform(NSSelectorFromString("performPetAction:"), with: dailyItem("sitDown"))
        check(!value(owner, "settings", PetSettings.self).wandering && dailyItem("walk").state == .off && !owner.petView.isWalking, "sitting explicitly disables continuous roaming")
        let activityNames = ["cheer":"拉拉队应援", "gaming":"打游戏", "music":"听歌"]
        for (offset, id) in ["cheer", "gaming", "music"].enumerated() {
            check(library.clips[id]?.frames.count == 4 && dailyItem(id).title == activityNames[id], "new activity has four real frames and a named menu entry")
            view.phase = 300 + Double(offset) * 10
            view.setEmotion(.idle)
            view.playExtraAction(id, duration: 4)
            check(view.activeActionClip == id && view.hasExclusiveAction && !view.isWalking, "new activity acquires the exclusive stationary action lock")
            grounded(view)
            let key = value(view, "displayedFrameKey", String.self)
            view.phase += 0.35; view.updateAnimation()
            check(value(view, "displayedFrameKey", String.self) != key, "new activity advances its drawn sprite frame")
            view.updateActivity(wandering: true, movementAllowed: true, idleAllowed: true, automatic: true, roamWalkingRequested: true)
            view.updateAnimation()
            check(view.activeActionClip == id && !view.isWalking && !view.tryAutomaticActivity(duration: 4), "roaming and automatic selection cannot interrupt a manually selected activity")
            grounded(view)
            view.phase += 4
            view.updateActivity(wandering: false, movementAllowed: true, idleAllowed: false, automatic: false)
            view.updateAnimation()
            check(!view.hasExclusiveAction, "completed activity releases its lock")
        }
        view.phase = 400; view.setEmotion(.idle)
        check(view.tryAutomaticActivity(duration: 4) && Set(["standUp","eat","cheer","gaming","music"]).contains(view.activeActionClip ?? ""), "automatic idle selection starts a valid locally cached activity")
        let oldLibrary = try PetActionLibrary.load(from: source.appendingPathComponent("assets/actions-v1"))
        let oldView = PetView(frame: view.frame)
        oldView.image = view.image; oldView.spriteSheet = view.spriteSheet
        check(oldView.installActions(oldLibrary), "previous pack remains readable for registration comparison")
        for candidate in [oldView, view] {
            candidate.phase = 500; candidate.setEmotion(.idle)
            candidate.updateActivity(wandering: false, movementAllowed: true, idleAllowed: false, automatic: false)
            candidate.playAction(.walk)
            candidate.phase = 501.2; candidate.updateAnimation()
        }
        let oldFrame = frame(oldView), newFrame = frame(view)
        check(value(oldFrame, "alpha", [UInt8].self) == value(newFrame, "alpha", [UInt8].self), "adding activity props preserves the previous walk silhouette and scale")
        check(value(oldFrame, "groundInset", CGFloat.self) == value(newFrame, "groundInset", CGFloat.self), "adding activities preserves the previous walk ground anchor")
        print("PET_ACTION_INTEGRATION passed \(checks) checks; actual asset registration, gait, ground, alpha and movement guards; no model or production state")
    }
}
#endif
