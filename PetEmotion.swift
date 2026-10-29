import AppKit
import QuartzCore

/// Companion expressions are chosen locally. They never make a model request.
enum PetEmotion: String, CaseIterable {
    case idle, happy, curious, sleepy, listening, thinking

    var title: String {
        switch self {
        case .idle: return "自在待机"
        case .happy: return "开心"
        case .curious: return "疑惑"
        case .sleepy: return "困倦"
        case .listening: return "认真听"
        case .thinking: return "思考"
        }
    }
    var symbol: String {
        switch self {
        case .idle: return ""
        case .happy: return "✦  ✧"
        case .curious: return "？"
        case .sleepy: return "z z Z"
        case .listening: return "♡"
        case .thinking: return "· · ·"
        }
    }
    static func forReply(_ text: String) -> PetEmotion {
        let value = text.lowercased()
        if ["晚安", "困了", "休息一下", "睡觉", "睡个", "早点休息", "good night"].contains(where: value.contains) { return .sleepy }
        if ["不确定", "没听懂", "没看清", "什么意思", "请确认", "能再", "？", "?"].contains(where: value.contains) { return .curious }
        if ["开心", "哈哈", "太好了", "完成了", "成功", "恭喜", "谢谢", "好耶", "🎉", "😊"].contains(where: value.contains) { return .happy }
        return .listening
    }
}

/// Core Animation animates cached layers; the sprite is never rerasterized per tick.
final class PetEmotionAnimator {
    private let motion: CALayer
    private let breath: CALayer
    private let symbol = CATextLayer()

    init(motion: CALayer, breath: CALayer, parent: CALayer) {
        self.motion = motion
        self.breath = breath
        symbol.alignmentMode = .center
        symbol.font = NSFont.systemFont(ofSize: 20, weight: .semibold)
        symbol.fontSize = 20
        symbol.contentsScale = 2
        symbol.foregroundColor = NSColor.systemBlue.cgColor
        symbol.isHidden = true
        parent.addSublayer(symbol)
    }

    func layout(in bounds: CGRect) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        symbol.frame = CGRect(x: max(0, bounds.midX - 45), y: max(0, bounds.maxY - 33), width: 90, height: 28)
        CATransaction.commit()
    }

    func apply(_ emotion: PetEmotion, hovered: Bool, facingLeft: Bool, reducedMotion: Bool) {
        motion.removeAllAnimations()
        breath.removeAllAnimations()
        symbol.removeAllAnimations()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        motion.transform = CATransform3DIdentity
        breath.transform = CATransform3DIdentity
        symbol.string = emotion.symbol
        symbol.isHidden = emotion == .idle
        symbol.opacity = 1
        symbol.foregroundColor = (emotion == .happy ? NSColor.systemOrange : NSColor.systemBlue).cgColor
        if emotion == .listening {
            let direction: CGFloat = facingLeft ? -1 : 1
            motion.transform = CATransform3DRotate(CATransform3DMakeTranslation(direction * 3, 0, 0), direction * 0.045, 0, 0, 1)
        } else if emotion == .curious {
            motion.transform = CATransform3DMakeRotation(-0.07, 0, 0, 1)
        }
        CATransaction.commit()
        guard !reducedMotion else { return }

        let bob = CABasicAnimation(keyPath: "position.y")
        let amplitude = emotion == .sleepy ? 1.2 : (hovered ? 4.0 : 2.5)
        bob.fromValue = motion.position.y - amplitude
        bob.toValue = motion.position.y + amplitude
        bob.duration = emotion == .sleepy ? 2.8 : 1.5
        bob.autoreverses = true
        bob.repeatCount = .infinity
        bob.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        motion.add(bob, forKey: "bob")

        let breathing = CABasicAnimation(keyPath: "transform.scale")
        breathing.fromValue = emotion == .sleepy ? 0.992 : 0.988
        breathing.toValue = emotion == .sleepy ? 1.008 : 1.012
        breathing.duration = emotion == .sleepy ? 2.5 : 1.25
        breathing.autoreverses = true
        breathing.repeatCount = .infinity
        breathing.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        breath.add(breathing, forKey: "breath")

        if emotion == .happy {
            let jump = CAKeyframeAnimation(keyPath: "position.y")
            jump.values = [motion.position.y, motion.position.y + 9, motion.position.y, motion.position.y + 4, motion.position.y]
            jump.keyTimes = [0, 0.22, 0.48, 0.68, 1]
            jump.duration = 1.2
            jump.repeatCount = .infinity
            jump.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            motion.add(jump, forKey: "bob")
        } else if emotion == .curious {
            let tilt = CABasicAnimation(keyPath: "transform.rotation.z")
            tilt.fromValue = -0.09
            tilt.toValue = 0.07
            tilt.duration = 1.2
            tilt.autoreverses = true
            tilt.repeatCount = .infinity
            tilt.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            motion.add(tilt, forKey: "tilt")
        }
        if emotion != .idle {
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = emotion == .thinking ? 0.25 : 0.6
            pulse.toValue = 1
            pulse.duration = emotion == .thinking ? 0.6 : 1.3
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            symbol.add(pulse, forKey: "expression")
        }
    }
}
