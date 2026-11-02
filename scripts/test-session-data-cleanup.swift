import Foundation

@main enum TestSessionDataCleanup {
    static func main() throws {
        let manager = FileManager.default
        let parent = manager.temporaryDirectory.appendingPathComponent("mac2jb-cleanup-\(UUID().uuidString)")
        let sessions = parent.appendingPathComponent("mac2jb/Sessions")
        defer { try? manager.removeItem(at: parent) }
        try manager.createDirectory(at: sessions, withIntermediateDirectories: true)

        func folder(_ name: String) throws -> URL {
            let url = sessions.appendingPathComponent(name, isDirectory: true)
            try manager.createDirectory(at: url, withIntermediateDirectories: false)
            return url
        }

        func write(_ name: String, in folder: URL) throws {
            try Data(name.utf8).write(to: folder.appendingPathComponent(name))
        }

        let current = try folder(UUID().uuidString)
        try write("active.log", in: current)
        let pastWithExports = try folder(UUID().uuidString)
        try write("gui-session.log", in: pastWithExports)
        for name in ["savekit-exports", "dumps", "source"] {
            let retained = pastWithExports.appendingPathComponent(name, isDirectory: true)
            try manager.createDirectory(at: retained, withIntermediateDirectories: false)
            try write("keep", in: retained)
        }
        let pastRuntimeOnly = try folder(UUID().uuidString)
        try write("node", in: pastRuntimeOnly)
        let unrelated = try folder("not-a-session")
        try write("keep", in: unrelated)
        let external = parent.appendingPathComponent("external", isDirectory: true)
        try manager.createDirectory(at: external, withIntermediateDirectories: false)
        try write("keep", in: external)
        try manager.createSymbolicLink(at: pastWithExports.appendingPathComponent("external-link"),
                                       withDestinationURL: external)
        try manager.createSymbolicLink(at: sessions.appendingPathComponent(UUID().uuidString),
                                       withDestinationURL: external)

        let result = try SessionDataCleanup.clearPastSessions(in: sessions, keeping: current)
        precondition(result.sessions == 2 && result.entries == 3)
        precondition(manager.fileExists(atPath: current.appendingPathComponent("active.log").path))
        precondition(!manager.fileExists(atPath: pastWithExports.appendingPathComponent("gui-session.log").path))
        precondition(!manager.fileExists(atPath: pastRuntimeOnly.path))
        for name in ["savekit-exports", "dumps", "source"] {
            precondition(manager.fileExists(atPath: pastWithExports.appendingPathComponent(name + "/keep").path))
        }
        precondition(manager.fileExists(atPath: unrelated.appendingPathComponent("keep").path))
        precondition(manager.fileExists(atPath: external.appendingPathComponent("keep").path))

        do {
            _ = try SessionDataCleanup.clearPastSessions(in: sessions,
                keeping: sessions.appendingPathComponent(UUID().uuidString))
            fatalError("missing current session should be rejected")
        } catch SessionDataCleanup.CleanupError.invalidSessionDirectory {}

        print("session data cleanup: passed")
    }
}
