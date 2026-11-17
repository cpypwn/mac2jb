import SwiftUI

enum Mac2jbTheme {
    static let background = Color(red: 0.025, green: 0.10, blue: 0.085)
    static let ink = Color(red: 0.90, green: 0.98, blue: 0.94)
    static let mint = Color(red: 0.58, green: 0.96, blue: 0.77)
    static let muted = Color(red: 0.62, green: 0.75, blue: 0.69)
}

struct Mac2jbBackdrop: View {
    var body: some View {
        ZStack {
            Mac2jbTheme.background
            RadialGradient(colors: [Mac2jbTheme.mint.opacity(0.16), .clear],
                           center: .topLeading, startRadius: 0, endRadius: 650)
            RadialGradient(colors: [Color.teal.opacity(0.11), .clear],
                           center: .bottomTrailing, startRadius: 0, endRadius: 550)
        }.ignoresSafeArea()
    }
}

struct GlassPanel: ViewModifier {
    var padding: CGFloat = 24
    func body(content: Content) -> some View {
        content.padding(padding).frame(maxWidth: .infinity, alignment: .leading)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(.white.opacity(0.10), lineWidth: 1))
            .shadow(color: .black.opacity(0.12), radius: 18, y: 8)
    }
}

/// Interpolate the height used by layout, so surrounding views move with the
/// expansion rather than jumping to their final positions ahead of its drawing.
struct AnimatedExpansionLayout: AnimatableModifier {
    var height: CGFloat

    init(height: CGFloat) {
        self.height = height.isFinite ? max(0, height) : 0
    }

    var animatableData: CGFloat {
        get { height }
        set { height = newValue }
    }

    func body(content: Content) -> some View {
        content
            .frame(height: height.isFinite ? max(0, height) : 0, alignment: .top)
            .clipped()
    }
}

struct PrimaryActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    var large = false
    var compact = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: large ? 17 : compact ? 11 : 13, weight: .semibold, design: .rounded))
            .foregroundStyle(enabled ? Mac2jbTheme.background : Mac2jbTheme.muted)
            .frame(minWidth: large ? 240 : compact ? 110 : 140,
                   minHeight: large ? 54 : compact ? 32 : 40)
            .frame(maxWidth: large ? .infinity : nil)
            .padding(.horizontal, large ? 26 : compact ? 12 : 16)
            .background(enabled ? Mac2jbTheme.mint.opacity(configuration.isPressed ? 0.76 : 1) : .white.opacity(0.07),
                        in: RoundedRectangle(cornerRadius: large ? 17 : compact ? 10 : 12, style: .continuous))
            .scaleEffect(configuration.isPressed && enabled ? 0.985 : 1)
    }
}
