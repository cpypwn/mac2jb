import Combine
import Foundation

@MainActor final class CivStremioModel: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var running = false
    @Published private(set) var installed = false
    @Published private(set) var status = ""
    @Published private(set) var log = ""

    var accountProgressHandler: ((StremioWatchProgress) -> Void)?
    var canStop: Bool { process?.isRunning == true }

    private var process: Process?
    private var attempt = UUID()
    private var stopRequested = false
    private var hadError = false

    func installAndBridge(address: String, runtimeRoot: URL?, addonURLs: [String],
                          libraryItems: [[String: Any]], quality: StremioQuality) {
        bridge(address: address, runtimeRoot: runtimeRoot, addonURLs: addonURLs,
               libraryItems: libraryItems, quality: quality, install: true)
    }

    func ensureBridge(address: String, runtimeRoot: URL?, addonURLs: [String],
                      libraryItems: [[String: Any]], quality: StremioQuality) {
        bridge(address: address, runtimeRoot: runtimeRoot, addonURLs: addonURLs,
               libraryItems: libraryItems, quality: quality, install: false)
    }

    private func bridge(address: String, runtimeRoot: URL?, addonURLs: [String],
                        libraryItems: [[String: Any]], quality: StremioQuality, install: Bool) {
        guard !busy, !running, let runtimeRoot else { return }
        guard Self.validIPv4(address) else { status = "Enter the Switch IPv4 address"; return }
        installed = FileManager.default.fileExists(atPath: FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/mac2jb/civ-stremio-install-state.json").path)
        guard addonURLs.count <= 32, libraryItems.count <= 500,
              let config = try? JSONSerialization.data(withJSONObject: [
                "addonUrls": addonURLs, "libraryItems": libraryItems,
                "quality": quality.rawValue
              ]), config.count <= 2 * 1024 * 1024 else {
            status = "Stremio account data is too large for this session"
            return
        }
        run(arguments: ["serve", runtimeRoot.path, address,
                        install ? "--install" : "--if-installed", "--config-stdin"],
            runtimeRoot: runtimeRoot, input: config,
            initialStatus: install ? "Installing Stremio" : "Checking Stremio")
    }

    private func run(arguments: [String], runtimeRoot: URL, input: Data?, initialStatus: String) {
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent("integrations/civ-stremio/run.cjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path) else {
            status = "The CivHomebrew Stremio helper is missing from this app"
            return
        }
        let task = Process()
        let stream = Pipe()
        let inputPipe = input == nil ? nil : Pipe()
        task.executableURL = node
        task.arguments = [script.path] + arguments
        task.currentDirectoryURL = runtimeRoot
        if let inputPipe { task.standardInput = inputPipe }
        else { task.standardInput = FileHandle.nullDevice }
        task.standardOutput = stream
        task.standardError = stream
        let current = UUID()
        attempt = current
        stopRequested = false
        hadError = false
        log = ""
        busy = true
        status = initialStatus
        append(status)
        do { try task.run() }
        catch {
            busy = false
            status = "Could not start Stremio: \(error.localizedDescription)"
            append(status)
            return
        }
        process = task
        if let inputPipe, let input {
            Task.detached(priority: .userInitiated) {
                try? inputPipe.fileHandleForWriting.write(contentsOf: input)
                try? inputPipe.fileHandleForWriting.close()
            }
        }
        Task.detached(priority: .userInitiated) { [weak self] in
            var pending = ""
            while true {
                let bytes = stream.fileHandleForReading.availableData
                if bytes.isEmpty { break }
                pending += String(decoding: bytes, as: UTF8.self)
                while let end = pending.firstIndex(of: "\n") {
                    let line = String(pending[..<end])
                    pending = String(pending[pending.index(after: end)...])
                    await self?.receive(line, attempt: current)
                }
                if pending.utf8.count > 32768 { pending = String(pending.suffix(4096)) }
            }
            if !pending.isEmpty { await self?.receive(pending, attempt: current) }
            task.waitUntilExit()
            await self?.finished(code: task.terminationStatus, attempt: current)
        }
    }

    func stop() {
        guard let process, process.isRunning else { return }
        stopRequested = true
        busy = true
        status = "Stopping Stremio"
        append(status)
        process.terminate()
    }

    private func receive(_ line: String, attempt current: UUID) {
        guard attempt == current else { return }
        let prefix = "MAC2JB_CIV_STREMIO "
        guard line.hasPrefix(prefix), line.utf8.count <= 8192,
              let data = line.dropFirst(prefix.count).data(using: .utf8),
              let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = event["type"] as? String else {
            append(line)
            return
        }
        let message = event["message"] as? String
        switch type {
        case "ready", "bridge-ready":
            busy = false
            running = true
            installed = true
            hadError = false
            status = message ?? "Stremio will start from CivHomebrew"
        case "watching":
            busy = false
            running = true
            hadError = false
            status = message ?? "Waiting for Stremio in CivHomebrew"
        case "bridge-closed":
            running = true
            status = message ?? "Stremio closed on the Switch"
        case "installed":
            installed = true
            status = message ?? "Stremio installed in CivHomebrew"
        case "absent":
            installed = false
            status = ""
        case "status", "activity":
            if let message { status = message }
        case "error":
            hadError = true
            status = message ?? "Stremio needs attention"
        case "stopped":
            status = message ?? "Stremio stopped"
        case "account-progress":
            if let value = event["watchProgress"],
               let bytes = try? JSONSerialization.data(withJSONObject: value),
               let update = try? JSONDecoder().decode(StremioWatchProgress.self, from: bytes) {
                accountProgressHandler?(update)
            }
        default:
            break
        }
        append(message.map { "\(type): \($0)" } ?? type)
    }

    private func finished(code: Int32, attempt current: UUID) {
        guard attempt == current else { return }
        process = nil
        busy = false
        running = false
        if stopRequested {
            status = "Stremio stopped"
        } else if code != 0 && !hadError {
            status = "Stremio stopped before completing"
        } else if status == "Checking Stremio" || status == "Installing Stremio" {
            status = "Stremio stopped"
        }
        append(status)
    }

    private func append(_ line: String) {
        log = String((log + line + "\n").suffix(20_000))
    }

    private static func validIPv4(_ address: String) -> Bool {
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { part in
            guard !part.isEmpty, part.count <= 3, let number = Int(part),
                  (0...255).contains(number), String(number) == part else { return false }
            return true
        }
    }
}
