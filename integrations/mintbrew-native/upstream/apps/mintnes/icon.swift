import AppKit
import SwiftUI

@main
struct MintNESIcon {
    static func main() throws {
        let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 128,
            pixelsHigh: 128, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0,
            bitsPerPixel: 0)!
        let graphics = NSGraphicsContext(bitmapImageRep: bitmap)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics
        NSAppearance(named: .aqua)!.performAsCurrentDrawingAppearance {
            let context = graphics.cgContext
            context.scaleBy(x: 128.0 / 1024.0, y: 128.0 / 1024.0)
            context.translateBy(x: 0, y: 1024)
            context.scaleBy(x: 1, y: -1)
            context.setAllowsAntialiasing(true)
            context.setShouldAntialias(true)
            context.setFillColor(NSColor(srgbRed: 0.08, green: 0.15,
                blue: 0.18, alpha: 1).cgColor)
            context.addPath(CGPath(roundedRect: CGRect(x: 100, y: 100,
                width: 824, height: 824), cornerWidth: 184, cornerHeight: 184,
                transform: nil))
            context.fillPath()
            context.setFillColor(NSColor.systemMint.usingColorSpace(.sRGB)!.cgColor)
            context.addPath(KeyboardMark().path(in: CGRect(x: 208, y: 232,
                width: 608, height: 486.4)).cgPath)
            context.fillPath()
        }
        NSGraphicsContext.restoreGraphicsState()
        try bitmap.representation(using: .png, properties: [:])!
            .write(to: URL(fileURLWithPath: output))
    }
}
