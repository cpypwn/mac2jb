import AppKit
import SwiftUI
import Foundation

if CommandLine.arguments.dropFirst().first == "--finish-update" {
    guard CommandLine.arguments.count == 3 else { exit(2) }
    exit(UpdateInstaller.finish(planURL: URL(fileURLWithPath: CommandLine.arguments[2])))
}

if CommandLine.arguments.contains("--self-test") {
    do {
        let testParent = FileManager.default.temporaryDirectory.appendingPathComponent("mac2jb-selftest-" + UUID().uuidString)
        let runtime = try BundledRuntime.prepare(sessionParent: testParent)
        defer { try? FileManager.default.removeItem(at: testParent) }
        var checks: [(String, [String])] = [
            ("scripts/install-driver.sh", ["--verify"]),
            ("node", ["--version"]),
            ("mac2jb-send", ["assets/bootstrap.bas", "--dry-run"]),
            ("mac2jb-commands", ["--dry-run"]),
            ("mac2jb-commands", ["--dry-run", "--demo"]),
            ("mac2jb-commands", ["--dry-run", "--commands", "load,run,remove"]),
            ("mac2jb-commands", ["--dry-run", "--commands", "start", "--start-prefix"]),
            ("mac2jb-commands", ["--dry-run", "--start-arity", "9", "--commands", "start", "--start-command",
                                 "V=START(39380,192,0,2,1,0,1,281474976710655,42)"]),
            ("mac2jb-commands", ["--dry-run", "--save-bootstrap"]),
            ("mac2jb-commands", ["--dry-run", "--save-bootstrap", "--demo"]),
            ("mac2jb-keyboard", ["--self-test"]),
            ("mac2jb-commands", ["--dry-run", "--gui-events", "--load-confirm-wait-ms", "1000",
                                 "--load-wait-ms", "3000", "--run-wait-ms", "3000", "--remove-wait-ms", "3000"]),
            ("mac2jb-commands", ["--gui-timing-test", "--gui-events", "--load-confirm-wait-ms", "10",
                                 "--load-wait-ms", "10", "--run-wait-ms", "10", "--remove-wait-ms", "10"]),
            ("mac2jb-commands", ["--gui-timing-test", "--gui-events", "--demo", "--load-confirm-wait-ms", "10",
                                 "--load-wait-ms", "10", "--run-wait-ms", "10", "--remove-wait-ms", "10"]),
            ("node", ["--check", "scripts/gui-session.cjs"]),
            ("node", ["--check", "scripts/gui-attach.cjs"]),
            ("node", ["--check", "scripts/rpc-attachment.cjs"]),
            ("node", ["--check", "scripts/host-profiles.cjs"]),
            ("node", ["--check", "scripts/prepare-host-profiles.cjs"]),
            ("node", ["scripts/prepare-host-profiles.cjs", "--check"]),
            ("node", ["scripts/prepare-seedsow-host.cjs", "--check"]),
            ("node", ["integrations/civswitch/verify.cjs", "--runtime"]),
            ("node", ["scripts/gui-civhomebrew.cjs", "--self-test", runtime.root.path]),
            ("node", ["scripts/gui-civswitch-moonlight.cjs", "--self-test", runtime.root.path]),
            ("node", ["--check", "integrations/civswitch/probe.cjs"]),
            ("node", ["--check", "integrations/civswitch/send-payload.cjs"]),
            ("node", ["--check", "integrations/civswitch/install-persistent.cjs"]),
            ("node", ["--check", "integrations/civswitch/fs-host.cjs"]),
            ("node", ["--check", "scripts/prepare-civswitch-savekit.cjs"]),
            ("node", ["scripts/prepare-civswitch-savekit.cjs", "--check-source"]),
            ("node", ["--check", "integrations/civswitch/backup-single.js"]),
            ("node", ["-e", "require(require.resolve('terser', {paths: [process.cwd() + '/vendor/CivSwitch/installer-creator']}))"]),
            ("mac2jb-civswitch-hid", ["--payload", runtime.root.appendingPathComponent("integrations/civswitch/payload.txt").path, "--dry-run"]),
            ("node", ["scripts/gui-savekit.cjs", "--self-test"]),
            ("node", ["scripts/gui-savekit-tools.cjs", "--self-test"]),
            ("node", ["scripts/check-savekit-research.cjs"]),
            ("node", ["--check", "scripts/usb-controllers.cjs"]),
            ("node", ["scripts/gui-dnswitch.cjs", "--self-test"]),
            ("node", ["scripts/gui-webkit-research.cjs", "--self-test"]),
            ("node", ["scripts/gui-bundled-browser-probes.cjs", "--self-test"]),
            ("node", ["scripts/check-webkit-research.cjs"]),
            ("homebrew/python/bin/python3", ["integrations/nsp-box/cli.py", "--self-test"]),
            ("node", ["scripts/gui-nxformat.cjs", "--self-test", runtime.root.path]),
            ("node", ["scripts/gui-nup.cjs", "--self-test", runtime.root.path]),
            ("node", ["--check", "scripts/gui-keyboard.cjs"]),
            ("node", ["scripts/gui-keyboard.cjs", "--self-test"]),
            ("node", ["--check", "scripts/gui-dump.cjs"]),
            ("node", ["--check", "scripts/gui-homebrew.cjs"]),
            ("node", ["--check", "scripts/gui-hblauncher.cjs"]),
            ("node", ["--check", "scripts/gui-gpubrewlauncher.cjs"]),
            ("node", ["--check", "scripts/gui-mintbrew.cjs"]),
            ("node", ["scripts/prepare-mintbrew.cjs", "--check-runtime"]),
            ("node", ["scripts/check-homebrew-runtime.cjs"]),
            ("node", ["--check", "scripts/gui-stremio.cjs"]),
            ("node", ["scripts/check-stremio-runtime.cjs"]),
            ("node", ["scripts/gui-ouncecake.cjs", "--self-test"]),
            ("node", ["scripts/gui-host.cjs", "--self-test"])
        ]
        if AppBuildIdentity.isTestBuild {
            checks += [
                ("node", ["--check", "integrations/civswitch/send-hello.cjs"]),
                ("node", ["--check", "integrations/civswitch/hello.js"])
            ]
        }
        for (tool, arguments) in checks {
            let task = Process()
            task.executableURL = tool.hasSuffix(".sh") ? URL(fileURLWithPath: "/bin/bash") : runtime.root.appendingPathComponent(tool)
            task.arguments = tool.hasSuffix(".sh") ? [runtime.root.appendingPathComponent(tool).path] + arguments : arguments
            task.currentDirectoryURL = runtime.root
            try task.run()
            task.waitUntilExit()
            guard task.terminationStatus == 0 else {
                throw NSError(domain: "mac2jb.selftest", code: Int(task.terminationStatus),
                              userInfo: [NSLocalizedDescriptionKey: "Check failed: \(tool)"])
            }
        }
        try FileManager.default.removeItem(at: runtime.root)
        for host in HostProfile.allCases where host != .defaultHost {
            let selected = try BundledRuntime.prepare(sessionParent: testParent, host: host)
            guard selected.host == host else {
                throw BundledRuntime.RuntimeError.invalid("The prepared host does not match \(host.label).")
            }
            let hostEntry = "vendor/ns2jb/run.cjs"
            for (tool, arguments) in [
                ("node", ["scripts/prepare-host-profiles.cjs", "--check"]),
                ("node", ["--check", hostEntry]),
                ("mac2jb-send", ["assets/bootstrap.bas", "--dry-run"])
            ] {
                let task = Process()
                task.executableURL = selected.root.appendingPathComponent(tool)
                task.arguments = arguments; task.currentDirectoryURL = selected.root
                try task.run(); task.waitUntilExit()
                guard task.terminationStatus == 0 else {
                    throw BundledRuntime.RuntimeError.invalid("Packaged \(host.label) check failed: \(tool).")
                }
            }
            try FileManager.default.removeItem(at: selected.root)
            print("\(host.label): fresh offline runtime selection passed.")
        }
        print("\(AppBuildIdentity.diagnosticLabel): embedded runtime and dry-run checks passed; no USB input sent.")
        try? FileManager.default.removeItem(at: testParent)
        exit(0)
    } catch {
        fputs("mac2jb self-test failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

struct Mac2jbApp: App {
    @StateObject private var model = SessionModel()
    @StateObject private var updater = AppUpdater()
    var body: some Scene {
        WindowGroup("mac2jb") {
            ContentView(model: model, updater: updater)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    model.cancel()
                }
        }
        .defaultSize(width: 900, height: 700)
        .windowStyle(.hiddenTitleBar)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .appInfo) {
                Button("Setup Guide…") {
                    NSWorkspace.shared.open(URL(string: "https://github.com/cpypwn/mac2jb#prerequisites")!)
                }
                Button("Check for Updates…") { updater.check() }.disabled(updater.isWorking)
                Toggle("Check for Updates Automatically", isOn: $updater.checksAutomatically)
                    .disabled(AppBuildIdentity.isTestBuild)
            }
        }
    }
}

NSApplication.shared.setActivationPolicy(.regular)
Mac2jbApp.main()
