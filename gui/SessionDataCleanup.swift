import Foundation

struct SessionDataCleanup {
    struct Result {
        let sessions: Int
        let entries: Int
    }

    enum CleanupError: LocalizedError {
        case invalidSessionDirectory

        var errorDescription: String? {
            "The current session directory could not be verified. No session data was cleared."
        }
    }

    private static let retainedEntries: Set<String> = ["savekit-exports", "dumps", "source"]

    static func clearPastSessions(in sessionsDirectory: URL, keeping currentSession: URL,
                                  manager: FileManager = .default) throws -> Result {
        let sessions = sessionsDirectory.standardizedFileURL.resolvingSymlinksInPath()
        let current = currentSession.standardizedFileURL.resolvingSymlinksInPath()
        guard sessions.lastPathComponent == "Sessions",
              sessions.deletingLastPathComponent().lastPathComponent == "mac2jb",
              current.deletingLastPathComponent() == sessions,
              UUID(uuidString: current.lastPathComponent) != nil,
              currentSession.standardizedFileURL.path == current.path,
              (try? manager.destinationOfSymbolicLink(atPath: current.path)) == nil,
              let sessionValues = try? current.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
              sessionValues.isDirectory == true, sessionValues.isSymbolicLink != true else {
            throw CleanupError.invalidSessionDirectory
        }

        let children = try manager.contentsOfDirectory(at: sessions,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [])
        var sessionsCleared = 0
        var entriesCleared = 0
        for candidate in children {
            guard candidate.standardizedFileURL.path != current.path,
                  UUID(uuidString: candidate.lastPathComponent) != nil,
                  (try? manager.destinationOfSymbolicLink(atPath: candidate.path)) == nil,
                  let values = try? candidate.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
                  values.isDirectory == true, values.isSymbolicLink != true,
                  candidate.standardizedFileURL.resolvingSymlinksInPath().deletingLastPathComponent() == sessions else {
                continue
            }
            let entries = try manager.contentsOfDirectory(at: candidate, includingPropertiesForKeys: nil,
                                                          options: [])
            var cleared = false
            for entry in entries where !retainedEntries.contains(entry.lastPathComponent) {
                try manager.removeItem(at: entry)
                entriesCleared += 1
                cleared = true
            }
            if try manager.contentsOfDirectory(at: candidate, includingPropertiesForKeys: nil,
                                               options: []).isEmpty {
                try manager.removeItem(at: candidate)
            }
            if cleared { sessionsCleared += 1 }
        }
        return Result(sessions: sessionsCleared, entries: entriesCleared)
    }
}
