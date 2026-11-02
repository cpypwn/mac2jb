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
              let id = value["id"] as? String else { return .cellenseres }
        return HostProfile(rawValue: id) ?? .cellenseres
    }

    enum RuntimeError: LocalizedError {
        case invalid(String)
        var errorDescription: String? {
            switch self { case .invalid(let message): return message }
        }
    }

    // Each launch has its own host files and pairing state. A prior session's
    // pairing command can never be consumed by a new GUI launch.
    static func prepare(sessionParent: URL? = nil, host: HostProfile = .cellenseres) throws -> BundledRuntime {
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
            let executablePaths = Set(["node", "mac2jb-send", "mac2jb-commands", "mac2jb-keyboard", "mac2jb-civswitch-hid",
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
            for path in ["node", "mac2jb-send", "mac2jb-commands", "mac2jb-keyboard", "mac2jb-civswitch-hid", "vendor/libusbd/libusbd.dylib",
                         "integrations/civswitch/payload.txt", "integrations/civswitch/provenance.json",
                         "integrations/civswitch/verify.cjs", "integrations/civswitch/probe.cjs",
                         "integrations/civswitch/send-hello.cjs", "integrations/civswitch/hello.js",
                         "scripts/gui-keyboard.cjs", "scripts/usb-controllers.cjs",
                         "scripts/gui-dnswitch.cjs", "scripts/gui-webkit-research.cjs",
                         "scripts/gui-bundled-browser-probes.cjs", "integrations/browser-probes/manifest.json",
                         "scripts/gui-nup.cjs", "packaging/NUP-source.json",
                         "integrations/nup-support/site-packages/zstandard/backend_c.cpython-313-darwin.so",
                         "integrations/nup-support/site-packages/zstandard-0.25.0.dist-info/licenses/LICENSE",
                         "integrations/browser-probes/index.html", "integrations/browser-probes/probes.js",
                         "integrations/browser-probes/style.css",
                         "scripts/check-webkit-research.cjs",
                         "packaging/switch2-browser-research-provenance.json",
                         "vendor/switch2-captive-portal-research/serve-switch2-browser-probe.py",
                         "vendor/switch2-captive-portal-research/switch2-browser-probe.html",
                         "vendor/switch2-captive-portal-research/switch2-probes-webkit.js",
                         "vendor/switch2-captive-portal-research/probe-fixtures/probe-h264.mp4",
                         "integrations/nsp-box/cli.py", "integrations/nsp-box/LICENSE.txt",
                         "integrations/nsp-box/provenance.json",
                         "integrations/nsp-box/src/engine.py", "integrations/nsp-box/src/container_format.py",
                         "integrations/nsp-box/src/verify_format.py", "integrations/nsp-box/src/artwork.py",
                         "integrations/nsp-box/src/compatibility.py", "integrations/nsp-box/src/dlc.py",
                         "scripts/dnswitch-launch.applescript",
                         "scripts/gui-host.cjs", "scripts/gui-session.cjs", "scripts/gui-dump.cjs",
                         "scripts/gui-savekit.cjs", "scripts/gui-savekit-tools.cjs", "scripts/prepare-seedsow-host.cjs",
                         "packaging/ArtemisLauncher-v1.json",
                         "packaging/ArtemisLauncher-bundles.json",
                         "integrations/artemis/seedsowhax-v1-mac2jb.zip",
                         "integrations/artemis/norahax-v1-mac2jb.zip",
                         "vendor/ns2-savekit/Seedsow-Lua-Editor-Save.zip",
                         "vendor/ns2-savekit/overlay/engine/shared/ipc.cjs",
                         "vendor/ns2-savekit/overlay/engine/switch2/ro/ncm.cjs",
                         "vendor/ns2-savekit/overlay/engine/switch2/app/mounted-save.cjs",
                         "vendor/ns2-savekit/tools/save-pull-root.cjs",
                         "vendor/ns2-savekit/tools/save-write-stage.cjs",
                         "vendor/ns2-savekit/tools/save-delete-root.cjs",
                         "vendor/ns2-savekit/tools/list-apps.cjs",
                         "vendor/ns2-savekit/tools/save-inventory.cjs",
                         "vendor/ns2-savekit/tools/save-restore.sh",
                         "vendor/ns2-savekit/tools/lib/save-tree.cjs",
                         "vendor/ns2-savekit/config/titles.json",
                         "vendor/ns2-savekit/research/catalog.json",
                         "vendor/ns2-savekit/research/current/README.md",
                         "integrations/seedsow-lua/cpypwn.lua",
                         "integrations/artemis/cpypwn-showcase.lua",
                         "scripts/gui-attach.cjs", "scripts/gui-discover-rpc.cjs", "scripts/rpc-attachment.cjs",
                         "scripts/homebrew-reentry.cjs",
                         "scripts/host-profiles.cjs", "scripts/prepare-host-profiles.cjs", "packaging/host-profiles.json",
                         "vendor/ns2jb-hosts/pepsipu/run.cjs", "vendor/ns2jb-hosts/kurumuz/run.cjs",
                         "vendor/ns2jb-hosts/cellenseres/run.cjs",
                         "scripts/gui-homebrew.cjs", "scripts/gui-stremio.cjs", "stremio/pipeline.cjs", "stremio/source-preferences.cjs", "stremio/app/app.json", "scripts/check-homebrew-runtime.cjs",
                         "scripts/gui-hblauncher.cjs", "vendor/HBLauncher/homebrew-launcher/launcher.cjs",
                         "scripts/gui-mintbrew.cjs", "scripts/prepare-mintbrew.cjs",
                         "scripts/gui-native-hblauncher.cjs",
                         "integrations/mintbrew-native/sd-roms.cjs",
                         "integrations/mintbrew-native/build-report.json",
                         "integrations/mintbrew-native/verify-native.cjs",
                         "integrations/mintbrew-native/upstream/host/start.cjs",
                         "integrations/mintbrew-native/upstream/sdk/abi.json",
                         "integrations/mintbrew-native/upstream/launcher/build/report.json",
                         "integrations/mintbrew-native/upstream/launcher/build/code.bin",
                         "integrations/mintbrew-native/upstream/launcher/build/data.bin",
                         "integrations/mintbrew-native/upstream/apps/hello-cpu/build/report.json",
                         "integrations/mintbrew-native/upstream/apps/hello-cpu/build/code.bin",
                         "integrations/mintbrew-native/upstream/apps/hello-cpu/build/data.bin",
                         "integrations/mintbrew-native/upstream/apps/gpu-triangle/build/report.json",
                         "integrations/mintbrew-native/upstream/apps/gpu-triangle/build/code.bin",
                         "integrations/mintbrew-native/upstream/apps/gpu-triangle/build/data.bin",
                         "integrations/mintbrew-native/upstream/apps/mintnes/manifest.json",
                         "integrations/mintbrew-native/upstream/apps/mintnes/build/report.json",
                         "integrations/mintbrew-native/upstream/apps/mintnes/build/code.bin",
                         "integrations/mintbrew-native/upstream/apps/mintnes/build/data.bin",
                         "integrations/mintbrew-native/upstream/apps/mintnes/assets/Diamond Chase.nes",
                         "vendor/MintBrew/manifest.json", "vendor/MintBrew/homebrew-launcher/launcher.cjs", "vendor/MintBrew/apps/hello-world/app.json",
                         "vendor/MintBrew/apps/froggy-road/app.json", "vendor/MintBrew/apps/cpu-gpu-probe/app.json",
                         "vendor/MintBrew/apps/chip8-test/app.json", "vendor/MintBrew/apps/ftpd-sb/app.json",
                         "vendor/MintBrew/apps/izdoom/app.json", "vendor/MintBrew/apps/stremio/app.json",
                         "vendor/MintBrew/apps/ouncecake/app.json", "vendor/MintBrew/apps/iz-exchange/app.json",
                         "integrations/mintbrew-stremio/adapter.cjs", "integrations/mintbrew-ouncecake/service.cjs",
                         "integrations/mintbrew-iz-exchange/service.cjs",
                         "packaging/ftpd-sb-v0.1.0-SHA256SUMS", "packaging/ftpd-sb-v0.1.0-release-SHA256SUMS",
                         "packaging/ftpd-sb-v0.1.0-provenance.json",
                         "vendor/HBLauncher/apps/ftpd-sb/app.json", "packaging/HBLauncher-v0.2.0-SHA256SUMS",
                         "scripts/gui-gpubrewlauncher.cjs", "vendor/GPUBrewLauncher/homebrew-launcher/launcher.cjs",
                         "vendor/GPUBrewLauncher/CREDITS", "packaging/GPUBrewLauncher-SHA256SUMS",
                         "vendor/IZ2S-Platform/LICENSE", "packaging/IZ2S-Platform-SHA256SUMS",
                         "vendor/IZ2S-Platform/engines/izmysh/server/host.cjs",
                         "packaging/IZ2S-Platform-provenance.json", "packaging/runtime-homebrew.json",
                         "scripts/gui-ouncecake.cjs", "vendor/OunceCake/LICENSE", "vendor/OunceCake/engine/oz-code/native.bin",
                         "vendor/OunceCake/engine/zip-download.cjs",
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
