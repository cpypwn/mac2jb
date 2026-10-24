import SwiftUI

// Original mac2jb artwork. This geometry is shared by the sidebar and app-icon
// generator; it does not export, trace, or modify an Apple SF Symbol.
struct KeyboardMark: Shape {
    func path(in rect: CGRect) -> Path {
        var result = Path()
        var body = Path()
        body.addRoundedRect(in: CGRect(x: 6, y: 28, width: 88, height: 44),
                            cornerSize: CGSize(width: 7, height: 7))
        result.addPath(body.strokedPath(StrokeStyle(lineWidth: 4.4, lineJoin: .round)))

        // A bent USB cable and separate plug give the mark its own silhouette.
        var cable = Path()
        cable.move(to: CGPoint(x: 50, y: 28))
        cable.addLine(to: CGPoint(x: 50, y: 21))
        cable.addQuadCurve(to: CGPoint(x: 57, y: 14), control: CGPoint(x: 50, y: 14))
        cable.addLine(to: CGPoint(x: 67, y: 14))
        cable.addQuadCurve(to: CGPoint(x: 74, y: 7), control: CGPoint(x: 74, y: 14))
        result.addPath(cable.strokedPath(StrokeStyle(lineWidth: 3.4, lineCap: .round, lineJoin: .round)))
        var plug = Path()
        plug.addRoundedRect(in: CGRect(x: 69, y: 0, width: 10, height: 7),
                            cornerSize: CGSize(width: 2, height: 2))
        result.addPath(plug.strokedPath(StrokeStyle(lineWidth: 2.2)))

        // Outlined keycaps, a tall Return key, and a long spacebar.
        var keycaps = Path()
        for y in [36.0, 46.0] {
            for x in [14.0, 24.0, 34.0, 44.0, 54.0, 64.0] {
                keycaps.addRoundedRect(in: CGRect(x: x, y: y, width: 6, height: 5),
                                       cornerSize: CGSize(width: 1.1, height: 1.1))
            }
        }
        keycaps.addRoundedRect(in: CGRect(x: 76, y: 36, width: 10, height: 15),
                               cornerSize: CGSize(width: 1.5, height: 1.5))
        for key in [CGRect(x: 14, y: 58, width: 9, height: 5),
                    CGRect(x: 29, y: 58, width: 42, height: 5),
                    CGRect(x: 77, y: 58, width: 9, height: 5)] {
            keycaps.addRoundedRect(in: key, cornerSize: CGSize(width: 1.1, height: 1.1))
        }
        result.addPath(keycaps.strokedPath(StrokeStyle(lineWidth: 1.9, lineJoin: .round)))

        let scale = min(rect.width / 100, rect.height / 80)
        return result.applying(CGAffineTransform(scaleX: scale, y: scale))
            .offsetBy(dx: rect.midX - 50 * scale, dy: rect.midY - 40 * scale)
    }
}
