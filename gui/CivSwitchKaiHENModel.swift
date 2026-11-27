import Foundation
import Combine

@MainActor final class CivSwitchKaiHENModel: ObservableObject {
    enum Operation: Equatable { case install, runOnce }
    enum Phase: Equatable { case idle, preparing, backup, transfer, running, stopping, complete, failed }

    @Published private(set) var operation: Operation = .install
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var status = ""
    @Published private(set) var log = ""
    @Published private(set) var errorMessage: String?
    @Published private(set) var progressStep = 0.0
    @Published private(set) var diagnosticLogURL: URL?

    var isRunning: Bool { process != nil }
    var lastError: String? { errorMessage }
    var activity: String { log }

    private var process: Process?
    private var attempt = UUID()
    private var stopRequested = false
    private var completed = false

    func startInstall(consoleAddress: String, runtimeRoot: URL?) {
        launch(.install, consoleAddress: consoleAddress, runtimeRoot: runtimeRoot)
    }

    func startRunOnce(consoleAddress: String, runtimeRoot: URL?) {
        launch(.runOnce, consoleAddress: consoleAddress, runtimeRoot: runtimeRoot)
    }

    private func launch(_ selectedOperation: Operation, consoleAddress: String?, runtimeRoot: URL?) {
        guard !isRunning else { return }
        diagnosticLogURL = nil
        guard consoleAddress.map(CivSwitchFSModel.validIPv4) == true else {
            fail("Enter a valid Switch IPv4 address")
            return
        }
        guard let runtimeRoot else {
            fail("The mac2jb runtime is unavailable")
            return
        }
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent("integrations/civswitchfs-kaihen/launch.cjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path) else {
            fail("The CivSwitchFS kaiHEN launcher is missing from this app")
            return
        }
        guard let diagnostic = Self.makeDiagnosticLog() else {
            fail("Could not create a private CivSwitchFS kaiHEN session log")
            return
        }

        let task = Process()
        let output = Pipe()
        task.executableURL = node
        switch selectedOperation {
        case .install: task.arguments = [script.path, "install", consoleAddress ?? "", runtimeRoot.path]
        case .runOnce: task.arguments = [script.path, "run-once", consoleAddress ?? "", runtimeRoot.path]
        }
        task.currentDirectoryURL = runtimeRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = output

        operation = selectedOperation
        phase = .preparing
        switch selectedOperation {
        case .install: status = "Preparing CivSwitchFS kaiHEN install"
        case .runOnce: status = "Preparing CivSwitchFS kaiHEN"
        }
        log = ""
        errorMessage = nil
        progressStep = 0
        diagnosticLogURL = diagnostic
        stopRequested = false
        completed = false
        attempt = UUID()
        let current = attempt
        process = task
        do { try task.run() }
        catch {
            process = nil
            fail("Could not start CivSwitchFS kaiHEN: \(error.localizedDescription)")
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
        guard let process, !stopRequested else { return }
        stopRequested = true
        phase = .stopping
        status = "Stopping CivSwitchFS kaiHEN"
        process.terminate()
    }

    func dismiss() {
        guard !isRunning, phase == .complete || phase == .failed else { return }
        phase = .idle
    }

    private func receive(_ line: String, attempt current: UUID) {
        guard current == attempt else { return }
        writeDiagnostic(line)
        let prefix = "MAC2JB_CIV_KAIHEN "
        guard line.hasPrefix(prefix), line.utf8.count <= 8192,
              let bytes = line.dropFirst(prefix.count).data(using: .utf8),
              let event = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let type = event["type"] as? String else {
            append(line)
            return
        }
        let message = event["message"] as? String
        if let message, type != "log" {
            status = message
        }
        if let message { append(message) }
        if let stage = event["phase"] as? String, !stopRequested {
            switch stage {
            case "preflight": phase = .preparing; progressStep = max(progressStep, 0.1)
            case "backup": phase = .backup; progressStep = max(progressStep, 0.3)
            case "transfer": phase = .transfer; progressStep = max(progressStep, 0.6)
            case "installed": phase = .running; progressStep = max(progressStep, 0.9)
            case "running": phase = .running; progressStep = max(progressStep, 0.12)
            case "fs-preparation": phase = .running; progressStep = max(progressStep, 0.25)
            case "canary": phase = .running; progressStep = max(progressStep, 0.45)
            case "memory-verified": phase = .running; progressStep = max(progressStep, 0.7)
            case "hen-starting": phase = .running; progressStep = max(progressStep, 0.9)
            default: break
            }
        }
        switch type {
        case "complete":
            completed = true
            progressStep = 1
        case "failed":
            errorMessage = message ?? "CivSwitchFS kaiHEN did not complete"
        default: break
        }
    }

    private func finished(code: Int32, attempt current: UUID) {
        guard current == attempt else { return }
        process = nil
        if stopRequested {
            phase = .idle
            status = "CivSwitchFS kaiHEN stopped"
        } else if code == 0 && completed && errorMessage == nil {
            phase = .complete
            if status.isEmpty {
                switch operation {
                case .install: status = "CivSwitchFS kaiHEN trigger installed"
                case .runOnce: status = "CivSwitchFS kaiHEN run sent"
                }
            }
        } else {
            let failure = errorMessage ?? "CivSwitchFS kaiHEN stopped before completion. See the session log."
            fail(failure)
        }
    }

    private func fail(_ message: String) {
        errorMessage = message
        status = message
        phase = .failed
        append(message)
        writeDiagnostic(message)
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
            let file = directory.appendingPathComponent("civswitchfs-kaihen.log")
            guard FileManager.default.createFile(atPath: file.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]) else { return nil }
            return file
        } catch { return nil }
    }
}
