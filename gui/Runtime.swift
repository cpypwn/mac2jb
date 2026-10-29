import Foundation
import CryptoKit
import Darwin

@_silgen_name("mac2jb_payload_bytes")
private func embeddedPayloadBytes() -> UnsafePointer<UInt8>?
@_silgen_name("mac2jb_payload_size")
private func embeddedPayloadSize() -> UInt

struct BundledRuntime {
    let root: URL
    var host: HostProfile {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("selected-host.json")),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = value["id"] as? String else { return .kurumuz }
        return HostProfile(rawValue: id) ?? .kurumuz
    }

    enum RuntimeError: LocalizedError {
        case invalid(String)
        var errorDescription: String? {
            switch self { case .invalid(let message): return message }
        }
    }

    // Each launch has its own host files and pairing state. A prior session's
    // pairing command can never be consumed by a new GUI launch.
    static func prepare(sessionParent: URL? = nil, host: HostProfile = .kurumuz) throws -> BundledRuntime {
        umask(0o077)
        guard let bytes = embeddedPayloadBytes(), embeddedPayloadSize() > 0 else {
            throw RuntimeError.invalid("The offline runtime is missing from this app. Rebuild or download a complete app.")
        }
        let payload = Data(bytes: bytes, count: Int(embeddedPayloadSize()))
        let digest = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        guard digest == EmbeddedPayloadMetadata.sha256 else {
            throw RuntimeError.invalid("The embedded runtime failed its integrity check. Replace this copy of the app.")
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
        // Foundation preserves some macOS aliases (/var and /tmp) that Node
        // resolves. Use Darwin's canonical path for every helper and path gate.
        guard let resolvedSessions = realpath(sessions.path, nil) else {
            throw RuntimeError.invalid("Unable to resolve the private session directory.")
        }
        let canonicalSessions = URL(fileURLWithPath: String(cString: resolvedSessions), isDirectory: true)
        free(resolvedSessions)
        let root = canonicalSessions.appendingPathComponent(UUID().uuidString, isDirectory: true)
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
            let executablePaths = Set(["node", "mac2jb-send", "mac2jb-commands", "mac2jb-keyboard",
                                       "homebrew/bin/spirv-val", "homebrew/bin/glslangValidator", "homebrew/python/bin/python3",
                                       "homebrew/python/bin/python3.13"])
            if let walker = manager.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
                for case let url as URL in walker {
                    let properties = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                    guard properties.isSymbolicLink != true else {
                        throw RuntimeError.invalid("The extracted runtime contains an unsupported link.")
                    }
                    guard let resolvedEntry = realpath(url.path, nil) else {
                        throw RuntimeError.invalid("An extracted runtime file could not be resolved.")
                    }
                    let canonicalPath = String(cString: resolvedEntry)
                    free(resolvedEntry)
                    guard canonicalPath.hasPrefix(root.path + "/") else {
                        throw RuntimeError.invalid("The extracted runtime contains a path outside its session folder.")
                    }
                    let relativePath = String(canonicalPath.dropFirst(root.path.count + 1))
                    let mode = properties.isDirectory == true || executablePaths.contains(relativePath) ? 0o700 : 0o600
                    try manager.setAttributes([.posixPermissions: mode], ofItemAtPath: url.path)
                }
            }
            for path in ["node", "mac2jb-send", "mac2jb-commands", "mac2jb-keyboard", "vendor/libusbd/libusbd.dylib",
                         "scripts/gui-keyboard.cjs", "scripts/usb-controllers.cjs",
                         "scripts/gui-host.cjs", "scripts/gui-session.cjs", "scripts/gui-dump.cjs",
                         "scripts/gui-attach.cjs", "scripts/rpc-attachment.cjs",
                         "scripts/host-profiles.cjs", "scripts/prepare-host-profiles.cjs", "packaging/host-profiles.json",
                         "vendor/ns2jb-hosts/pepsipu/run.cjs", "vendor/ns2jb-hosts/kurumuz/run.cjs",
                         "scripts/gui-homebrew.cjs", "scripts/gui-stremio.cjs", "stremio/pipeline.cjs", "stremio/source-preferences.cjs", "stremio/app/app.json", "scripts/check-homebrew-runtime.cjs",
                         "scripts/gui-hblauncher.cjs", "vendor/HBLauncher/homebrew-launcher/launcher.cjs",
                         "scripts/gui-mintbrew.cjs", "scripts/prepare-mintbrew.cjs",
                         "vendor/MintBrew/manifest.json", "vendor/MintBrew/homebrew-launcher/launcher.cjs", "vendor/MintBrew/apps/hello-world/app.json",
                         "vendor/MintBrew/apps/froggy-road/app.json", "vendor/MintBrew/apps/cpu-gpu-probe/app.json",
                         "vendor/MintBrew/apps/chip8-test/app.json", "vendor/MintBrew/apps/ftpd-sb/app.json",
                         "vendor/MintBrew/apps/izdoom/app.json", "vendor/MintBrew/apps/stremio/app.json",
                         "vendor/MintBrew/apps/ouncecake/app.json",
                         "integrations/mintbrew-stremio/adapter.cjs", "integrations/mintbrew-ouncecake/service.cjs",
                         "packaging/ftpd-sb-v0.1.0-SHA256SUMS", "packaging/ftpd-sb-v0.1.0-release-SHA256SUMS",
                         "packaging/ftpd-sb-v0.1.0-provenance.json",
                         "vendor/HBLauncher/apps/ftpd-sb/app.json", "packaging/HBLauncher-v0.2.0-SHA256SUMS",
                         "scripts/gui-gpubrewlauncher.cjs", "vendor/GPUBrewLauncher/homebrew-launcher/launcher.cjs",
                         "vendor/GPUBrewLauncher/CREDITS", "packaging/GPUBrewLauncher-SHA256SUMS",
                         "vendor/IZ2S-Platform/LICENSE", "packaging/IZ2S-Platform-SHA256SUMS",
                         "vendor/IZ2S-Platform/engines/izmysh/server/host.cjs",
                         "packaging/IZ2S-Platform-provenance.json", "packaging/runtime-homebrew.json",
                         "scripts/gui-ouncecake.cjs", "vendor/OunceCake/LICENSE", "vendor/OunceCake/engine/oz-code/native.bin",
                         "integrations/izdoom/prepare.cjs", "vendor/IZDOOM/IZDOOM-v0.17.1-IZ2S.izm",
                         "vendor/IZDOOM/IZDOOM-v0.17.1-source.tar.gz", "vendor/IZDOOM/SHA256SUMS",
                         "packaging/OunceCake-provenance.json", "packaging/OunceCake-SHA256SUMS",
                         "homebrew/manifest.json", "homebrew/fonts/DejaVuSans.ttf", "homebrew/bin/glslangValidator",
                         "scripts/install-driver.sh", "drivers/SHA256SUMS",
                         "drivers/usbgadget.kext/Contents/MacOS/usbgadget",
                         "vendor/ns2jb/run.cjs", "assets/bootstrap.bas", "source/LICENSE"] {
                guard manager.fileExists(atPath: root.appendingPathComponent(path).path) else {
                    throw RuntimeError.invalid("The embedded runtime is incomplete: \(path).")
                }
            }
            for path in executablePaths {
                guard manager.isExecutableFile(atPath: root.appendingPathComponent(path).path) else {
                    throw RuntimeError.invalid("The embedded helper is not executable: \(path).")
                }
            }
            let select = Process()
            select.executableURL = root.appendingPathComponent("node")
            select.arguments = [root.appendingPathComponent("scripts/prepare-host-profiles.cjs").path,
                                "--select", host.rawValue, root.path]
            select.currentDirectoryURL = root
            let output = Pipe()
            select.standardOutput = output; select.standardError = output
            try select.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            select.waitUntilExit()
            guard select.terminationStatus == 0 else {
                throw RuntimeError.invalid("Unable to prepare \(host.label): \(String(decoding: data, as: UTF8.self))")
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
