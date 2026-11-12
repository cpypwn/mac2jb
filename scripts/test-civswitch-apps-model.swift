import Foundation

@main struct CivSwitchAppsModelTest {
    @MainActor static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac2jb-civ-apps-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts"),
                                                withIntermediateDirectories: true)
        let worker = root.appendingPathComponent("node")
        let program = """
        #!/bin/sh
        IFS= read -r mode < "$3/response"
        case "$mode" in
          ready) printf 'MAC2JB_CIVHOMEBREW {"type":"probe-ready"}\\n' ;;
          failed) printf 'MAC2JB_CIVHOMEBREW {"type":"failed","message":"Companion unavailable"}\\n' ;;
          ready-exit) printf 'MAC2JB_CIVHOMEBREW {"type":"probe-ready"}\\n'; exit 2 ;;
          moonlight-failed) printf 'MAC2JB_CIV_MOONLIGHT {"type":"failed","message":"Moonlight install failed"}\\n'; exit 2 ;;
          moonlight-exit) exit 2 ;;
          sw2nes-installed) printf 'MAC2JB_CIV_SW2NES {"type":"installed"}\\n' ;;
          jellyfin-launched) printf 'MAC2JB_CIV_JELLYFIN {"type":"launched"}\\n' ;;
          package-installed) test "$5" = "$3/test.civapp" || exit 3; printf 'MAC2JB_CIV_PACKAGE {"type":"installed","message":"Sample installed in CivHomebrew"}\\n' ;;
          app-failed) printf 'MAC2JB_CIVHOMEBREW {"type":"failed","message":"App action failed"}\\n'; exit 2 ;;
          app-blocked) printf 'MAC2JB_CIVHOMEBREW {"type":"blocked","message":"Close the foreground app on your Switch"}\\n' ;;
        esac
        """
        try program.write(to: worker, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: worker.path)
        try "".write(to: root.appendingPathComponent("scripts/gui-civhomebrew.cjs"),
                     atomically: true, encoding: .utf8)
        try "".write(to: root.appendingPathComponent("scripts/gui-civswitch-moonlight.cjs"),
                     atomically: true, encoding: .utf8)
        try "".write(to: root.appendingPathComponent("scripts/gui-civswitch-sw2nes.cjs"),
                     atomically: true, encoding: .utf8)
        try "".write(to: root.appendingPathComponent("scripts/gui-civswitch-jellyfin.cjs"),
                     atomically: true, encoding: .utf8)
        try "".write(to: root.appendingPathComponent("scripts/gui-civswitch-package.cjs"),
                     atomically: true, encoding: .utf8)
        let response = root.appendingPathComponent("response")
        let model = CivSwitchAppsModel()

        func probe(_ mode: String) async throws {
            try mode.write(to: response, atomically: true, encoding: .utf8)
            model.connect(address: "10.0.0.91", runtimeRoot: root)
            for _ in 0..<200 where model.busy {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            precondition(!model.busy, "CivHomebrew probe did not finish")
        }

        try await probe("ready")
        precondition(model.companionReady, "A verified companion should be ready")
        try "moonlight-failed".write(to: response, atomically: true, encoding: .utf8)
        model.installMoonlight(address: "10.0.0.91", runtimeRoot: root)
        for _ in 0..<200 where model.busy {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(model.companionReady && model.status == "Moonlight install failed",
                     "A failed Moonlight action must preserve the verified companion")
        try "moonlight-exit".write(to: response, atomically: true, encoding: .utf8)
        model.launchMoonlight(address: "10.0.0.91", runtimeRoot: root)
        for _ in 0..<200 where model.busy {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(model.companionReady && model.status == "Moonlight launch failed",
                     "A failed action process must preserve the verified companion")
        try "sw2nes-installed".write(to: response, atomically: true, encoding: .utf8)
        model.installSW2NES(address: "10.0.0.91", runtimeRoot: root)
        for _ in 0..<200 where model.busy {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(model.companionReady && model.status == "SW2NES installed in CivHomebrew",
                     "Installing SW2NES must leave other CivHomebrew options available")
        try "jellyfin-launched".write(to: response, atomically: true, encoding: .utf8)
        model.launchJellyfin(address: "10.0.0.91", runtimeRoot: root)
        for _ in 0..<200 where model.busy {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(model.companionReady && model.status == "Jellyfin is opening on your Switch",
                     "Opening Jellyfin must preserve the verified companion")
        try "package-installed".write(to: response, atomically: true, encoding: .utf8)
        model.installPackage(root.appendingPathComponent("test.civapp"), address: "10.0.0.91", runtimeRoot: root)
        for _ in 0..<200 where model.busy {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(model.companionReady && model.status == "Sample installed in CivHomebrew",
                     "Installing a selected package must preserve the verified companion")
        try "app-failed".write(to: response, atomically: true, encoding: .utf8)
        model.installTrigger(address: "10.0.0.91", runtimeRoot: root)
        for _ in 0..<200 where model.busy {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(model.companionReady && model.status == "App action failed",
                     "A failed CivHomebrew action must preserve the verified companion")
        try "app-blocked".write(to: response, atomically: true, encoding: .utf8)
        model.stop(address: "10.0.0.91", runtimeRoot: root)
        for _ in 0..<200 where model.busy {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(model.companionReady && model.status == "Close the foreground app on your Switch",
                     "A blocked stop must tell the user how to leave the foreground app")
        try "failed".write(to: response, atomically: true, encoding: .utf8)
        model.connect(address: "10.0.0.91", runtimeRoot: root)
        precondition(!model.companionReady, "Starting a new probe must clear old connection state")
        for _ in 0..<200 where model.busy {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(!model.companionReady && !model.busy, "A failed probe must leave the companion disconnected")

        try await probe("ready-exit")
        precondition(!model.companionReady, "A process failure must clear a transient ready event")
        print("CivHomebrew connection state checks passed")
    }
}
