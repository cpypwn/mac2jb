import Foundation
import Combine

@MainActor final class ArtemisFSModel: ObservableObject {
    enum Phase { case idle, checking, held, stopping, failed }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var status = ""
    @Published private(set) var log = ""
    @Published private(set) var progressStep = 0
    @Published private(set) var runPath: String?
    @Published private(set) var diagnosticLogURL: URL?
    @Published private(set) var failureLogURL: URL?

    var isRunning: Bool { phase == .checking || phase == .held || phase == .stopping }
    var isHeld: Bool { phase == .held && runPath != nil }

    private var process: Process?
    private var attempt = UUID()
    private var failure: String?
    private var stopRequested = false
    private var stoppedConfirmed = false

    func start(consoleAddress: String, macAddress: String, runtimeRoot: URL?) {
        guard !isRunning, let runtimeRoot,
              Self.validIPv4(consoleAddress), Self.validIPv4(macAddress) else { return }
        diagnosticLogURL = Self.makeDiagnosticLog()
        failureLogURL = nil
        guard let sessionRoot = diagnosticLogURL?.deletingLastPathComponent() else {
            status = "Could not create a private Artemis filesystem session folder"
            phase = .failed
            return
        }
        let script = runtimeRoot.appendingPathComponent("integrations/artemis-fs/fs-host.cjs")
        let node = runtimeRoot.appendingPathComponent("node")
        guard FileManager.default.fileExists(atPath: script.path),
              FileManager.default.isExecutableFile(atPath: node.path) else {
            status = "The Artemis filesystem host is missing from this app"
            writeDiagnostic(status)
            phase = .failed
            return
        }
        let task = Process()
        let output = Pipe()
        task.executableURL = node
        task.arguments = [script.path, consoleAddress, macAddress, sessionRoot.path]
        task.currentDirectoryURL = sessionRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = output
        attempt = UUID()
        let current = attempt
        process = task
        failure = nil
        stopRequested = false
        stoppedConfirmed = false
        log = ""
        runPath = nil
        progressStep = 0
        phase = .checking
        status = "Connecting to Seedsow Lullaby"
        do { try task.run() }
        catch {
            process = nil
            status = "Could not start the Artemis filesystem host: \(error.localizedDescription)"
            writeDiagnostic(status)
            phase = .failed
            return
        }
        Task.detached(priority: .userInitiated) { [weak self] in
            var pending = ""
            while true {
                let bytes = output.fileHandleForReading.availableData
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
        guard isRunning, !stopRequested else { return }
        stopRequested = true
        phase = .stopping
        status = "Stopping the Artemis filesystem host"
        process?.terminate()
    }

    private func receive(_ line: String, attempt current: UUID) {
        guard current == attempt else { return }
        writeDiagnostic(line)
        let prefix = "MAC2JB_ARTEMIS_FS "
        guard line.hasPrefix(prefix), line.utf8.count <= 8192,
              let bytes = line.dropFirst(prefix.count).data(using: .utf8),
              let event = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let type = event["type"] as? String else {
            append(line)
            return
        }
        let message = event["message"] as? String
        switch type {
        case "preparing": status = message ?? status
        case "probe-ready": status = message ?? "Artemis HTTP profile verified"
        case "progress":
            status = message ?? status
            if let step = event["step"] as? Int, (1...4).contains(step) {
                progressStep = max(progressStep, step - 1)
            } else if let message, message.count >= 3,
                      message.dropFirst().hasPrefix("/4"),
                      let step = Int(message.prefix(1)), (1...4).contains(step) {
                progressStep = max(progressStep, step - 1)
            }
        case "held-ready":
            if let path = event["runPath"] as? String, path.hasPrefix("/"), !stopRequested {
                runPath = path
                progressStep = 4
                phase = .held
                status = "Filesystem access verified · RPC held"
            }
        case "failed":
            failure = message ?? "The Artemis HTTP profile could not be verified"
            status = failure ?? status
            if let path = event["logPath"] as? String, path.hasPrefix("/") {
                failureLogURL = URL(fileURLWithPath: path)
            }
        case "stopped":
            stoppedConfirmed = true
            status = message ?? "Artemis filesystem host stopped"
        default: break
        }
        if let message { append(message) }
    }

    private func finished(code: Int32, attempt current: UUID) {
        guard current == attempt else { return }
        let cleanStop = stopRequested && stoppedConfirmed && code == 0
        process = nil
        runPath = nil
        if cleanStop {
            phase = .idle
            status = "Artemis filesystem host stopped"
        } else {
            status = failure ?? (code == 0
                ? "The Artemis filesystem host ended without a verified held RPC session"
                : "The Artemis filesystem host stopped unexpectedly")
            writeDiagnostic(status)
            phase = .failed
        }
    }

    private func append(_ line: String) {
        log = String((log + line + "\n").suffix(50000))
    }

    private func writeDiagnostic(_ line: String) {
        guard let diagnosticLogURL,
              let handle = try? FileHandle(forWritingTo: diagnosticLogURL) else { return }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: Data((line + "\n").utf8))
        } catch { }
    }

    private static func makeDiagnosticLog() -> URL? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory,
                                                     in: .userDomainMask).first else { return nil }
        let directory = support.appendingPathComponent("mac2jb/Sessions/\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let file = directory.appendingPathComponent("artemis-fs-check.log")
            guard FileManager.default.createFile(atPath: file.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]) else { return nil }
            return file
        } catch { return nil }
    }

    static func validIPv4(_ text: String) -> Bool {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { part in
            !part.isEmpty && part.count <= 3 && part.utf8.allSatisfy { (48...57).contains($0) } &&
            Int(part).map { (0...255).contains($0) && String($0) == String(part) } == true
        }
    }
}
