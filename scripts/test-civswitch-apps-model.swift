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
          app-failed) printf 'MAC2JB_CIVHOMEBREW {"type":"failed","message":"App action failed"}\\n'; exit 2 ;;
        esac
        """
        try program.write(to: worker, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: worker.path)
        try "".write(to: root.appendingPathComponent("scripts/gui-civhomebrew.cjs"),
                     atomically: true, encoding: .utf8)
        try "".write(to: root.appendingPathComponent("scripts/gui-civswitch-moonlight.cjs"),
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
        try "app-failed".write(to: response, atomically: true, encoding: .utf8)
        model.installTrigger(address: "10.0.0.91", runtimeRoot: root)
        for _ in 0..<200 where model.busy {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(model.companionReady && model.status == "App action failed",
                     "A failed CivHomebrew action must preserve the verified companion")
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
