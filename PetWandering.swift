import Foundation
import CoreGraphics
import Darwin

/// Local movement policy. Read once at launch/reload; animation ticks never touch disk.
struct PetWanderingPolicy: Equatable {
    var speed: Double = 28
    var minPause: Double = 4
    var maxPause: Double = 12
    var margin: Double = 10

    static let standard = PetWanderingPolicy()

    static func load(from url: URL) throws -> PetWanderingPolicy {
        let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        if descriptor < 0 {
            if errno == ENOENT { return .standard }
            throw PolicyError.invalidFile
        }
        defer { close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              metadata.st_mode & S_IFMT == S_IFREG,
              metadata.st_size > 0, metadata.st_size <= 4096 else { throw PolicyError.invalidFile }
        var bytes = [UInt8](repeating: 0, count: Int(metadata.st_size) + 1)
        let count = bytes.withUnsafeMutableBytes { read(descriptor, $0.baseAddress, $0.count) }
        guard count == metadata.st_size else { throw PolicyError.invalidFile }
        return try decode(Data(bytes.prefix(count)))
    }

    static func decode(_ data: Data) throws -> PetWanderingPolicy {
        struct Spec: Decodable {
            let version: Int
            let speed: Double?
            let minPause: Double?
            let maxPause: Double?
            let margin: Double?
        }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys).isSubset(of: ["version", "speed", "minPause", "maxPause", "margin"]),
              !object.values.contains(where: { $0 is NSNull }) else { throw PolicyError.invalidPolicy }
        let spec = try JSONDecoder().decode(Spec.self, from: data)
        let policy = PetWanderingPolicy(speed: spec.speed ?? 28, minPause: spec.minPause ?? 4,
                                        maxPause: spec.maxPause ?? 12, margin: spec.margin ?? 10)
        guard spec.version == 1, policy.speed.isFinite, (8...120).contains(policy.speed),
              policy.minPause.isFinite, policy.maxPause.isFinite,
              (1...60).contains(policy.minPause), (policy.minPause...60).contains(policy.maxPause),
              policy.margin.isFinite, (10...100).contains(policy.margin) else { throw PolicyError.invalidPolicy }
        return policy
    }

    enum PolicyError: Error { case invalidFile, invalidPolicy }
}

struct PetWanderingStep {
    let origin: CGPoint
    let wantsWalking: Bool
    let isMoving: Bool
    let facingLeft: Bool?
    let didArrive: Bool
    let restDuration: Double?
}

/// One owner for destinations, equal-speed travel, and arrival rests. No window or model APIs.
struct PetWanderingPlanner {
    private(set) var policy: PetWanderingPolicy
    private let randomUnit: () -> Double
    private var target: CGPoint?
    private var restRemaining: Double?
    private var bounds: CGRect?
    private var expectedOrigin: CGPoint?

    init(policy: PetWanderingPolicy = .standard, randomUnit: @escaping () -> Double = { Double.random(in: 0...1) }) {
        self.policy = policy
        self.randomUnit = randomUnit
    }

    mutating func reset(policy: PetWanderingPolicy? = nil) {
        if let policy { self.policy = policy }
        target = nil; restRemaining = nil; bounds = nil; expectedOrigin = nil
    }

    /// Call with deltaTime=0 to obtain intent before updating the character's gait.
    /// movementReady prevents a rising character from sliding across the desktop.
    mutating func step(origin: CGPoint, panelSize: CGSize, visibleFrame: CGRect, deltaTime: Double,
                       paused: Bool, movementReady: Bool, exclusiveActionActive: Bool = false) -> PetWanderingStep {
        let permitted = Self.allowedOrigins(panelSize: panelSize, visibleFrame: visibleFrame, margin: policy.margin)
        if bounds != permitted || expectedOrigin.map({ Self.distance($0, origin) > 0.5 }) == true {
            target = nil; restRemaining = nil
        }
        bounds = permitted
        expectedOrigin = origin
        func result(_ point: CGPoint, walking: Bool = false, moving: Bool = false, facing: Bool? = nil,
                    arrived: Bool = false, rest: Double? = nil) -> PetWanderingStep {
            PetWanderingStep(origin: point, wantsWalking: walking, isMoving: moving,
                             facingLeft: facing, didArrive: arrived, restDuration: rest)
        }
        guard !paused else { return result(origin) }
        let position = CGPoint(x: min(permitted.maxX, max(permitted.minX, origin.x)),
                               y: min(permitted.maxY, max(permitted.minY, origin.y)))
        expectedOrigin = position
        let delta = deltaTime.isFinite ? min(0.25, max(0, deltaTime)) : 0
        if let remaining = restRemaining {
            let next = max(0, remaining - delta)
            restRemaining = next
            if next > 0 || exclusiveActionActive { return result(position) }
            restRemaining = nil
        }
        guard !exclusiveActionActive else { return result(position) }
        if target == nil { target = chooseTarget(in: permitted, from: position) }
        guard let target else { return result(position) }
        let dx = target.x - position.x, dy = target.y - position.y
        let distance = hypot(dx, dy)
        guard distance > 0.01 else { return arrive(at: target) }
        let facing = abs(dx) > 0.1 ? dx < 0 : nil
        guard movementReady, delta > 0 else { return result(position, walking: true, facing: facing) }
        let travel = min(distance, CGFloat(policy.speed * delta))
        let next = CGPoint(x: position.x + dx * travel / distance, y: position.y + dy * travel / distance)
        expectedOrigin = next
        if travel >= distance - 0.001 { return arrive(at: target, moving: true, facing: facing) }
        return result(next, walking: true, moving: true, facing: facing)
    }

    static func allowedOrigins(panelSize: CGSize, visibleFrame: CGRect, margin: Double) -> CGRect {
        let inset = CGFloat(margin)
        let availableWidth = max(0, visibleFrame.width - panelSize.width - 2 * inset)
        let availableHeight = max(0, visibleFrame.height - panelSize.height - 2 * inset)
        let x = availableWidth > 0 ? visibleFrame.minX + inset : visibleFrame.midX - panelSize.width / 2
        let y = availableHeight > 0 ? visibleFrame.minY + inset : visibleFrame.midY - panelSize.height / 2
        return CGRect(x: x, y: y, width: availableWidth, height: availableHeight)
    }

    private mutating func arrive(at point: CGPoint, moving: Bool = false, facing: Bool? = nil) -> PetWanderingStep {
        target = nil
        let duration = policy.minPause + unit() * (policy.maxPause - policy.minPause)
        restRemaining = duration
        expectedOrigin = point
        return PetWanderingStep(origin: point, wantsWalking: false, isMoving: moving,
                                facingLeft: facing, didArrive: true, restDuration: duration)
    }

    private func unit() -> Double { min(1, max(0, randomUnit())) }
    private func chooseTarget(in rect: CGRect, from origin: CGPoint) -> CGPoint? {
        guard rect.width > 0 || rect.height > 0 else { return nil }
        let minimum = min(80, hypot(rect.width, rect.height) / 4)
        for _ in 0..<8 {
            let point = CGPoint(x: rect.minX + CGFloat(unit()) * rect.width,
                                y: rect.minY + CGFloat(unit()) * rect.height)
            if Self.distance(point, origin) >= minimum { return point }
        }
        return [CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.minX, y: rect.maxY),
                CGPoint(x: rect.maxX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.maxY)]
            .max(by: { Self.distance($0, origin) < Self.distance($1, origin) })
    }

    private static func distance(_ first: CGPoint, _ second: CGPoint) -> CGFloat {
        hypot(first.x - second.x, first.y - second.y)
    }
}
