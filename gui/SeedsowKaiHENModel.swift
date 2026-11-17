import Foundation
import Combine

@MainActor final class SeedsowKaiHENModel: ObservableObject {
    enum Phase: Equatable { case idle, preparing, running, stopping, complete, failed }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var status = ""
    @Published private(set) var log = ""
    @Published private(set) var progressStep = 0.0
    @Published private(set) var diagnosticLogURL: URL?

    var isRunning: Bool { [.preparing, .running, .stopping].contains(phase) }

    private var process: Process?
    private var attempt = UUID()
    private var stopRequested = false
    private var installed = false

    func start(consoleAddress: String, runtimeRoot: URL?) {
        guard !isRunning else { return }
        guard CivSwitchFSModel.validIPv4(consoleAddress) else {
            status = "Enter a valid Switch IPv4 address"
            phase = .failed
            return
        }
        guard let runtimeRoot else {
            status = "The mac2jb runtime is unavailable"
            phase = .failed
            return
        }
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent("integrations/seedsow-kaihen/launch.cjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path) else {
            status = "The Seedsow kaiHEN launcher is missing from this app"
            phase = .failed
            return
        }

        diagnosticLogURL = Self.makeDiagnosticLog()
        let task = Process()
        let output = Pipe()
        task.executableURL = node
        task.arguments = [script.path, consoleAddress, runtimeRoot.path]
        task.currentDirectoryURL = runtimeRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = output
        process = task
        attempt = UUID()
        let current = attempt
        stopRequested = false
        installed = false
        progressStep = 0.1
        log = ""
        status = "Preparing Seedsow kaiHEN"
        phase = .preparing
        do { try task.run() }
        catch {
            process = nil
            status = "Could not start Seedsow kaiHEN: \(error.localizedDescription)"
            append(status)
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
        status = "Stopping Seedsow kaiHEN"
        if let process, process.isRunning { process.terminate() }
    }

    func dismiss() {
        guard phase == .complete || phase == .failed else { return }
        phase = .idle
    }

    private func receive(_ line: String, attempt current: UUID) {
        guard current == attempt else { return }
        writeDiagnostic(line)
        let prefix = "MAC2JB_SEEDSOW_KAIHEN "
        guard line.hasPrefix(prefix), line.utf8.count <= 8192,
              let bytes = line.dropFirst(prefix.count).data(using: .utf8),
              let event = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let type = event["type"] as? String else {
            append(line)
            return
        }
        let message = event["message"] as? String
        if type == "log" {
            if let message { append(message) }
            return
        }
        if let message { status = message; append(message) }
        switch type {
        case "preparing", "downloading", "verified":
            phase = .preparing
        case "running":
            phase = .running
        case "progress":
            phase = .running
            if let step = event["step"] as? Int, (1...4).contains(step) {
                progressStep = max(progressStep, Double(step) - 0.5)
            }
        case "installed":
            installed = true
            progressStep = 4
        case "stopping":
            phase = .stopping
        case "failed":
            phase = .failed
        default: break
        }
    }

    private func finished(code: Int32, attempt current: UUID) {
        guard current == attempt else { return }
        process = nil
        if stopRequested {
            phase = .idle
            status = "Seedsow kaiHEN stopped"
        } else if code == 0 && installed {
            phase = .complete
            status = "kaiHEN is running. Close Seedsow normally, then hold R while opening a native game."
        } else {
            let hadFailure = phase == .failed
            phase = .failed
            if !hadFailure {
                status = "Seedsow kaiHEN stopped before installation completed. See session details."
                append(status)
            }
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
        let directory = support.appendingPathComponent("mac2jb/Sessions/\(UUID().uuidString)",
                                                    isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let file = directory.appendingPathComponent("seedsow-kaihen.log")
            guard FileManager.default.createFile(atPath: file.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]) else { return nil }
            return file
        } catch { return nil }
    }
}
