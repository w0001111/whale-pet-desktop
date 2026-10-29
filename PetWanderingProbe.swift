#if WHALE_WANDERING_TEST
import Foundation
import CoreGraphics

@main enum PetWanderingProbe {
    static var checks = 0
    static func check(_ condition: Bool, _ message: String) { precondition(condition, message); checks += 1 }
    static let screen = CGRect(x: -900, y: 30, width: 900, height: 700)
    static let size = CGSize(width: 200, height: 204)
    static var allowed: CGRect { PetWanderingPlanner.allowedOrigins(panelSize: size, visibleFrame: screen, margin: 10) }
    static func close(_ first: CGPoint, _ second: CGPoint) -> Bool { hypot(first.x - second.x, first.y - second.y) < 0.001 }
    static func inside(_ point: CGPoint, _ bounds: CGRect) -> Bool {
        point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY
    }
    static func advance(_ planner: inout PetWanderingPlanner, _ point: CGPoint, delta: Double = 0.1,
                        paused: Bool = false, ready: Bool = true, exclusive: Bool = false) -> PetWanderingStep {
        planner.step(origin: point, panelSize: size, visibleFrame: screen, deltaTime: delta,
                     paused: paused, movementReady: ready, exclusiveActionActive: exclusive)
    }
    static func sequence(_ values: [Double]) -> () -> Double {
        var index = 0
        return { defer { index += 1 }; return values[index % values.count] }
    }
    static func main() throws {
        let center = CGPoint(x: allowed.midX, y: allowed.midY)
        var rising = PetWanderingPlanner(randomUnit: { 1 })
        let rise = advance(&rising, center, ready: false)
        check(rise.wantsWalking && !rise.isMoving && rise.origin == center, "rising requests gait without sliding")
        let paused = advance(&rising, center, paused: true)
        check(!paused.wantsWalking && !paused.isMoving && paused.origin == center, "interaction pauses route and gait together")
        var diagonal = PetWanderingPlanner(randomUnit: { 1 })
        var horizontal = PetWanderingPlanner(randomUnit: sequence([1, 0.5]))
        let d = advance(&diagonal, center), h = advance(&horizontal, center)
        check(abs(hypot(d.origin.x - center.x, d.origin.y - center.y) - 2.8) < 0.001, "diagonal travel is exactly 28 points per second")
        check(abs(hypot(h.origin.x - center.x, h.origin.y - center.y) - 2.8) < 0.001, "horizontal and diagonal speeds match")
        for (x, y) in [(0.0, 0.0), (0, 1), (1, 0), (1, 1)] {
            var planner = PetWanderingPlanner(policy: PetWanderingPolicy(speed: 120), randomUnit: sequence([x, y]))
            var position = center
            var arrived = false
            for _ in 0..<1000 {
                let step = advance(&planner, position)
                check(inside(step.origin, allowed), "all intermediate positions obey panel size and margin on negative-origin monitor")
                position = step.origin
                if step.didArrive {
                    check(!step.wantsWalking && (4...12).contains(step.restDuration!), "arrival stops gait and schedules bounded rest")
                    arrived = true; break
                }
            }
            let expected = CGPoint(x: allowed.minX + CGFloat(x) * allowed.width, y: allowed.minY + CGFloat(y) * allowed.height)
            check(arrived && close(position, expected), "all four upper/lower/left/right destinations are reachable without overshoot")
        }
        var resting = PetWanderingPlanner(policy: PetWanderingPolicy(speed: 120, minPause: 4, maxPause: 4), randomUnit: { 1 })
        var position = center
        var arrived = false
        for _ in 0..<1000 {
            let step = advance(&resting, position)
            position = step.origin
            if step.didArrive { arrived = true; break }
        }
        check(arrived, "rest test reaches its destination")
        for _ in 0..<200 {
            let step = advance(&resting, position, delta: 0.25, paused: true)
            check(step.origin == position && !step.wantsWalking, "chat hover and drag do not move or consume rest")
        }
        for _ in 0..<39 {
            let step = advance(&resting, position)
            check(step.origin == position && !step.wantsWalking, "arrival waits at least four active seconds")
        }
        for _ in 0..<100 {
            let step = advance(&resting, position, exclusive: true)
            check(step.origin == position && !step.wantsWalking, "an activity may finish after rest without being interrupted")
        }
        check(advance(&resting, position, delta: 0, ready: false).wantsWalking, "finished activity can depart immediately without adding another rest")
        var dragged = PetWanderingPlanner(randomUnit: sequence([1, 1, 0, 0]))
        _ = advance(&dragged, center, delta: 0, ready: false)
        let draggedPoint = CGPoint(x: allowed.maxX - 20, y: allowed.maxY - 20)
        let replanned = advance(&dragged, draggedPoint, delta: 0, ready: false)
        check(replanned.facingLeft == true && replanned.origin == draggedPoint, "external dragging discards old target and replans from new origin")
        let changed = dragged.step(origin: draggedPoint, panelSize: CGSize(width: 260, height: 284),
                                   visibleFrame: CGRect(x: 100, y: 100, width: 700, height: 600), deltaTime: 0,
                                   paused: false, movementReady: false)
        let changedBounds = PetWanderingPlanner.allowedOrigins(panelSize: CGSize(width: 260, height: 284),
                                                              visibleFrame: CGRect(x: 100, y: 100, width: 700, height: 600), margin: 10)
        check(inside(changed.origin, changedBounds) && !changed.isMoving, "monitor and size changes replan within new safe bounds")
        let resetPoint = center
        resting.reset()
        check(advance(&resting, resetPoint, delta: 0, ready: false).wantsWalking, "explicit reset clears old rest for a fresh user start")
        let tiny = PetWanderingPlanner.allowedOrigins(panelSize: size, visibleFrame: CGRect(x: 0, y: 0, width: 100, height: 100), margin: 10)
        check(tiny.width == 0 && tiny.height == 0 && tiny.origin == CGPoint(x: -50, y: -52), "an oversized panel has one centered origin rather than an inverted range")
        check(try PetWanderingPolicy.decode(Data("{\"version\":1}".utf8)) == .standard, "partial optional policy uses documented defaults")
        check(try PetWanderingPolicy.decode(Data("{\"version\":1,\"speed\":40,\"minPause\":5,\"maxPause\":9,\"margin\":20}".utf8)).speed == 40, "external policy configures local travel")
        for json in ["{\"version\":2}", "{\"version\":1,\"speed\":121}", "{\"version\":1,\"margin\":0}",
                     "{\"version\":1,\"minPause\":10,\"maxPause\":4}", "{\"version\":1,\"speed\":null}",
                     "{\"version\":1,\"speed\":true}", "{\"version\":1,\"unknown\":2}"] {
            do { _ = try PetWanderingPolicy.decode(Data(json.utf8)); check(false, "invalid policy was accepted") }
            catch { check(true, "malformed and unbounded policies are rejected") }
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("WhaleWanderingProbe-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("policy.json")
        check(try PetWanderingPolicy.load(from: file) == .standard, "absent optional policy uses defaults")
        try Data("{\"version\":1}".utf8).write(to: file)
        check(try PetWanderingPolicy.load(from: file) == .standard, "bounded regular policy loads once")
        let link = root.appendingPathComponent("link.json")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        do { _ = try PetWanderingPolicy.load(from: link); check(false, "symlink policy accepted") }
        catch { check(true, "policy reader refuses symbolic links") }
        try Data(repeating: 32, count: 4097).write(to: file)
        do { _ = try PetWanderingPolicy.load(from: file); check(false, "oversized policy accepted") }
        catch { check(true, "policy file size is bounded") }
        print("PET_WANDERING passed \(checks) checks; pure 2D planning, speed, boundaries, rest, pause, drag, monitor, and policy; no windows/models/permissions")
    }
}
#endif
