import AppKit
import SwiftUI
import Foundation

// Hardware-free verification is also available from the single executable.
if CommandLine.arguments.contains("--self-test") {
    do {
        let testParent = FileManager.default.temporaryDirectory.appendingPathComponent("mac2jb-selftest-" + UUID().uuidString)
        let runtime = try BundledRuntime.prepare(sessionParent: testParent)
        defer { try? FileManager.default.removeItem(at: testParent) }
        let checks: [(String, [String])] = [
            ("node", ["--version"]),
            ("mac2jb-send", ["assets/bootstrap.bas", "--dry-run"]),
            ("mac2jb-commands", ["--dry-run"]),
            ("node", ["scripts/gui-host.cjs", "--self-test"])
        ]
        for (tool, arguments) in checks {
            let task = Process()
            task.executableURL = runtime.root.appendingPathComponent(tool)
            task.arguments = arguments
            task.currentDirectoryURL = runtime.root
            try task.run()
            task.waitUntilExit()
            guard task.terminationStatus == 0 else {
                throw NSError(domain: "mac2jb.selftest", code: Int(task.terminationStatus),
                              userInfo: [NSLocalizedDescriptionKey: "Check failed: \(tool)"])
            }
        }
        print("mac2jb 0.3.0-demo: embedded runtime and dry-run checks passed; no USB input sent.")
        try? FileManager.default.removeItem(at: runtime.root)
        exit(0)
    } catch {
        fputs("mac2jb self-test failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

struct Mac2jbApp: App {
    @StateObject private var model = SessionModel()
    var body: some Scene {
        WindowGroup("mac2jb") {
            ContentView(model: model)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    model.cancel()
                }
        }
        .defaultSize(width: 1110, height: 800)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}

NSApplication.shared.setActivationPolicy(.regular)
Mac2jbApp.main()
