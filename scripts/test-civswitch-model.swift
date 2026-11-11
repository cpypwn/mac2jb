import Foundation

@main struct CivSwitchModelTest {
    @MainActor static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mac2jb-civ-model-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let worker = root.appendingPathComponent("node")
        let program = """
        #!/bin/sh
        IFS= read -r mode < response
        case "$mode" in
          old) printf 'MAC2JB_CIVSWITCH {"type":"loader-ready","message":"Old trigger restored"}\\n' ;;
          new) printf 'MAC2JB_CIVSWITCH {"type":"loader-ready","message":"New loader verified"}\\n' ;;
        esac
        """
        try program.write(to: worker, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: worker.path)
        let response = root.appendingPathComponent("response")
        let model = CivSwitchModel()

        try "old".write(to: response, atomically: true, encoding: .utf8)
        model.attachExisting(consoleAddress: "10.0.0.91", runtimeRoot: root)
        for _ in 0..<200 where model.phase != .verified {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(model.phase == .verified && model.log.contains("Old trigger restored"),
                     "The first verified attach should record its activity")

        try "new".write(to: response, atomically: true, encoding: .utf8)
        model.attachExisting(consoleAddress: "10.0.0.91", runtimeRoot: root)
        precondition(!model.log.contains("Old trigger restored"),
                     "A new attach should clear the previous session's visible activity")
        for _ in 0..<200 where model.phase != .verified {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        precondition(model.phase == .verified && model.log.contains("New loader verified") &&
                     !model.log.contains("Old trigger restored"),
                     "The new attach should show only its own activity")
        print("CivSwitch attach activity checks passed")
    }
}
