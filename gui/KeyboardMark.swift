import SwiftUI

// Original vector face inspired by the classic Mac smile in the reference.
// The mark is used only for the application icon.
struct KeyboardMark: Shape {
    func path(in rect: CGRect) -> Path {
        var face = Path()
        // Short upright eyes, a bent nose, and a gently upturned smile.
        face.move(to: CGPoint(x: 25, y: 19))
        face.addLine(to: CGPoint(x: 25, y: 31))
        face.move(to: CGPoint(x: 75, y: 19))
        face.addLine(to: CGPoint(x: 75, y: 31))
        face.move(to: CGPoint(x: 51, y: 19))
        face.addLine(to: CGPoint(x: 51, y: 43))
        face.addQuadCurve(to: CGPoint(x: 46, y: 48), control: CGPoint(x: 51, y: 48))
        face.addLine(to: CGPoint(x: 40, y: 48))
        face.move(to: CGPoint(x: 30, y: 61))
        face.addQuadCurve(to: CGPoint(x: 70, y: 58), control: CGPoint(x: 52, y: 70))
        let outline = face.strokedPath(StrokeStyle(lineWidth: 5.5, lineCap: .square, lineJoin: .round))
        let scale = min(rect.width / 100, rect.height / 80)
        return outline.applying(CGAffineTransform(scaleX: scale, y: scale))
            .offsetBy(dx: rect.midX - 50 * scale, dy: rect.midY - 40 * scale)
    }
}
