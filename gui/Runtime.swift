import Foundation
import CryptoKit
import Darwin

@_silgen_name("mac2jb_payload_bytes")
private func embeddedPayloadBytes() -> UnsafePointer<UInt8>?
@_silgen_name("mac2jb_payload_size")
private func embeddedPayloadSize() -> UInt

struct BundledRuntime {
    let root: URL

    enum RuntimeError: LocalizedError {
        case invalid(String)
        var errorDescription: String? {
            switch self { case .invalid(let message): return message }
        }
    }

    // Each launch has its own host files and pairing state. A prior session's
    // pairing command can never be consumed by a new GUI launch.
    static func prepare(sessionParent: URL? = nil) throws -> BundledRuntime {
        umask(0o077)
        guard let bytes = embeddedPayloadBytes(), embeddedPayloadSize() > 0 else {
            throw RuntimeError.invalid("The offline runtime is missing from this app. Rebuild or download a complete demo.")
        }
        let payload = Data(bytes: bytes, count: Int(embeddedPayloadSize()))
        let digest = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        guard digest == EmbeddedPayloadMetadata.sha256 else {
            throw RuntimeError.invalid("The embedded runtime failed its integrity check. Replace this copy of the demo.")
        }
        let manager = FileManager.default
        let sessions: URL
        if let sessionParent {
            try privateDirectory(sessionParent)
            sessions = sessionParent
        } else {
            let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                          appropriateFor: nil, create: true)
            let appDirectory = support.appendingPathComponent("mac2jb", isDirectory: true)
            sessions = appDirectory.appendingPathComponent("Sessions", isDirectory: true)
            try privateDirectory(appDirectory)
            try privateDirectory(sessions)
        }
        // FileManager's directory enumerator canonicalizes /var to /private/var
        // on macOS. Use the same canonical root for executable permissions.
        let root = sessions.resolvingSymlinksInPath().appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: false,
                                    attributes: [.posixPermissions: 0o700])
        do {
            let archive = root.appendingPathComponent("runtime.tar.gz")
            try payload.write(to: archive, options: .withoutOverwriting)
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: archive.path)
            // The archive has a fixed build-time digest. Also reject unsafe
            // names and every archive type except directories and plain files.
            let names = try tar(["-tzf", archive.path])
            for name in names.split(separator: "\n", omittingEmptySubsequences: true) {
                let parts = name.split(separator: "/", omittingEmptySubsequences: false)
                guard !name.hasPrefix("/"), !name.contains("\\"),
                      !parts.contains(".."), !name.contains("\r") else {
                    throw RuntimeError.invalid("The embedded archive contains an unsafe path.")
                }
            }
            let entries = try tar(["-tvzf", archive.path])
            for entry in entries.split(separator: "\n", omittingEmptySubsequences: true) {
                guard entry.first == "-" || entry.first == "d" else {
                    throw RuntimeError.invalid("The embedded archive contains an unsupported link or file type.")
                }
            }
            _ = try tar(["-xzf", archive.path, "-C", root.path,
                         "--no-same-owner", "--no-same-permissions"])
            try manager.removeItem(at: archive)
            let executablePaths = Set(["node", "mac2jb-send", "mac2jb-commands"])
            if let walker = manager.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
                for case let url as URL in walker {
                    let properties = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                    guard properties.isSymbolicLink != true else {
                        throw RuntimeError.invalid("The extracted runtime contains an unsupported link.")
                    }
                    let isRootExecutable = url.deletingLastPathComponent().resolvingSymlinksInPath().path == root.path &&
                        executablePaths.contains(url.lastPathComponent)
                    let mode = properties.isDirectory == true || isRootExecutable ? 0o700 : 0o600
                    try manager.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
                }
            }
            for path in ["node", "mac2jb-send", "mac2jb-commands", "vendor/libusbd/libusbd.dylib",
                         "scripts/gui-host.cjs", "vendor/ns2jb/run.cjs", "assets/bootstrap.bas", "source/LICENSE"] {
                guard manager.fileExists(atPath: root.appendingPathComponent(path).path) else {
                    throw RuntimeError.invalid("The embedded runtime is incomplete: \(path).")
                }
            }
            for path in executablePaths {
                guard manager.isExecutableFile(atPath: root.appendingPathComponent(path).path) else {
                    throw RuntimeError.invalid("The embedded helper is not executable: \(path).")
                }
            }
            return BundledRuntime(root: root)
        } catch {
            try? manager.removeItem(at: root)
            throw error
        }
    }

    private static func privateDirectory(_ url: URL) throws {
        let manager = FileManager.default
        if !manager.fileExists(atPath: url.path) {
            try manager.createDirectory(at: url, withIntermediateDirectories: false,
                                        attributes: [.posixPermissions: 0o700])
        }
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
              info.st_uid == getuid() else {
            throw RuntimeError.invalid("The session folder is not a private directory owned by this user: \(url.path)")
        }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    private static func tar(_ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        // Drain before waiting: listings can exceed a pipe's capacity.
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        guard process.terminationStatus == 0 else {
            throw RuntimeError.invalid("Unable to prepare the offline runtime: \(text)")
        }
        return text
    }
}
