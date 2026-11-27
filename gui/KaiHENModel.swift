import Foundation
import Combine

@MainActor final class KaiHENModel: ObservableObject {
    enum Phase: Equatable { case idle, preparing, running, installed, stopping, complete, failed }
    enum LaunchPath: Equatable { case civSwitch, ns2jb }
    struct TypingSettings {
        let driverAvailable: Bool
        let controller: String
        let delayMs: Int
        let enumerationTimeoutSeconds: Int
        let loadWaitMs: Int
        let runWaitMs: Int
        let removeWaitMs: Int
        let loadConfirmWaitMs: Int
        let keyHoldMs: Int
        let enterSettleMs: Int
        let pollInterval: Int
        let demo: Bool
        let preferredController: String?

        init(driverAvailable: Bool, controller: String, delayMs: Int,
             enumerationTimeoutSeconds: Int, loadWaitMs: Int, runWaitMs: Int,
             removeWaitMs: Int, loadConfirmWaitMs: Int, keyHoldMs: Int,
             enterSettleMs: Int, pollInterval: Int, demo: Bool,
             preferredController: String? = nil) {
            self.driverAvailable = driverAvailable
            self.controller = controller
            self.delayMs = delayMs
            self.enumerationTimeoutSeconds = enumerationTimeoutSeconds
            self.loadWaitMs = loadWaitMs
            self.runWaitMs = runWaitMs
            self.removeWaitMs = removeWaitMs
            self.loadConfirmWaitMs = loadConfirmWaitMs
            self.keyHoldMs = keyHoldMs
            self.enterSettleMs = enterSettleMs
            self.pollInterval = pollInterval
            self.demo = demo
            self.preferredController = preferredController
        }

        func arguments(startCommand: String) -> [String] {
            var result = ["hid", "kaihen-commands", controller, String(delayMs)]
            result += ["--enumeration-timeout", String(enumerationTimeoutSeconds)]
            result += ["--load-wait-ms", String(loadWaitMs), "--run-wait-ms", String(runWaitMs)]
            result += ["--remove-wait-ms", String(removeWaitMs)]
            result += ["--load-confirm-wait-ms", String(loadConfirmWaitMs)]
            result += ["--key-hold-ms", String(keyHoldMs), "--enter-settle-ms", String(enterSettleMs)]
            result += ["--poll-interval", String(pollInterval)]
            if demo { result.append("--demo") }
            if controller == "auto", let preferredController {
                result += ["--preferred-controller", preferredController]
            }
            result += ["--start-command", startCommand]
            return result
        }
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var launchPath: LaunchPath = .civSwitch
    @Published private(set) var status = ""
    @Published private(set) var log = ""
    @Published private(set) var progressStep = 0.0
    @Published private(set) var diagnosticLogURL: URL?
    @Published private(set) var startCommand: String?
    @Published private(set) var typingStatus = ""
    @Published private(set) var enumerationProgress: Double?
    @Published private(set) var enumerationRemainingMs: Double?

    var isRunning: Bool { [.preparing, .running, .installed, .stopping].contains(phase) }

    private var process: Process?
    private var typingProcess: Process?
    private var runtimeRoot: URL?
    private var typingSettings: TypingSettings?
    private var macAddress = ""
    private var typingCompleted = false
    private var attempt = UUID()
    private var stopRequested = false
    private var installed = false

    func start(consoleAddress: String, runtimeRoot: URL?) {
        guard CivSwitchFSModel.validIPv4(consoleAddress) else { return }
        launch(path: .civSwitch, address: consoleAddress, runtimeRoot: runtimeRoot,
               stageTimeoutMinutes: nil, typing: nil)
    }

    func startNs2jb(macAddress: String, runtimeRoot: URL?, stageTimeoutMinutes: Int,
                    typing: TypingSettings) {
        guard CivSwitchFSModel.validIPv4(macAddress), (1...60).contains(stageTimeoutMinutes) else { return }
        launch(path: .ns2jb, address: macAddress, runtimeRoot: runtimeRoot,
               stageTimeoutMinutes: stageTimeoutMinutes, typing: typing)
    }

    private func launch(path: LaunchPath, address: String, runtimeRoot: URL?,
                        stageTimeoutMinutes: Int?, typing: TypingSettings?) {
        guard !isRunning, let runtimeRoot else { return }
        launchPath = path
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent(path == .ns2jb
            ? "integrations/kaihen/ns2jb-launch.cjs" : "integrations/kaihen/launch.cjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path) else {
            status = "The kaiHEN launcher is missing from this app"
            phase = .failed
            return
        }
        diagnosticLogURL = Self.makeDiagnosticLog(path: path)
        let task = Process()
        let output = Pipe()
        task.executableURL = node
        task.arguments = [script.path, address, runtimeRoot.path] +
            (stageTimeoutMinutes.map { [String($0)] } ?? [])
        task.currentDirectoryURL = runtimeRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = output
        attempt = UUID()
        let current = attempt
        process = task
        self.runtimeRoot = runtimeRoot
        typingSettings = typing
        macAddress = address
        typingProcess = nil
        typingCompleted = false
        typingStatus = ""
        enumerationProgress = nil
        enumerationRemainingMs = nil
        stopRequested = false
        installed = false
        startCommand = nil
        log = ""
        progressStep = 0
        status = path == .ns2jb ? "Preparing kaiHEN for SmileBASIC" : "Preparing kaiHEN"
        phase = .preparing
        do { try task.run() }
        catch {
            process = nil
            status = "Could not start kaiHEN: \(error.localizedDescription)"
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
        enumerationProgress = nil
        enumerationRemainingMs = nil
        phase = .stopping
        status = "Stopping kaiHEN at the next safe checkpoint"
        if let typingProcess, typingProcess.isRunning { typingProcess.terminate() }
        if let process, process.isRunning { process.terminate() }
    }

    func dismiss() {
        guard phase == .complete || phase == .failed else { return }
        phase = .idle
    }

    private func receive(_ line: String, attempt current: UUID) {
        guard current == attempt else { return }
        writeDiagnostic(line)
        let prefix = launchPath == .ns2jb ? "MAC2JB_NS2JB_KAIHEN " : "MAC2JB_KAIHEN "
        guard line.hasPrefix(prefix), line.utf8.count <= 8192,
              let bytes = line.dropFirst(prefix.count).data(using: .utf8),
              let event = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let type = event["type"] as? String else {
            advanceProgress(from: line, step: nil)
            append(line)
            return
        }
        let message = event["message"] as? String
        if type == "log" {
            if let message {
                advanceProgress(from: message, step: nil)
                append(message)
            }
            return
        }
        if let message { status = message; append(message) }
        switch type {
        case "preparing", "downloading", "verified": phase = .preparing
        case "running", "host-ready":
            phase = .running
            if type == "host-ready", let command = event["startCommand"] as? String {
                guard PostBootstrapCommandSelection.validStartCommand(command, host: .kurumuz),
                      command.dropFirst(8).dropLast().split(separator: ",").dropFirst()
                        .joined(separator: ".") == macAddress else {
                    typingStatus = "The host START command is invalid. Enter commands manually after checking the host log."
                    append(typingStatus)
                    return
                }
                startCommand = command
                if launchPath == .ns2jb { startTyping(command, attempt: current) }
            }
        case "progress":
            phase = .running
            advanceProgress(from: message, step: event["step"] as? Int)
        case "installed":
            installed = true
            progressStep = 4
            phase = .installed
        case "failed":
            phase = .failed
        default: break
        }
    }

    private func advanceProgress(from message: String?, step: Int?) {
        let detected = step.flatMap { (1...4).contains($0) ? $0 : nil } ??
            message.flatMap(Self.stageNumber)
        guard let detected, !stopRequested else { return }
        progressStep = max(progressStep, Double(detected) - 0.5)
        phase = .running
        if let message { status = message.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    static func stageNumber(in message: String) -> Int? {
        guard let range = message.range(of: #"(?<![0-9])([1-4])/4(?=\s|$)"#,
                                        options: .regularExpression) else { return nil }
        return Int(message[range].prefix(1))
    }

    private func startTyping(_ command: String, attempt current: UUID) {
        guard current == attempt, typingProcess == nil, !stopRequested,
              let runtimeRoot, let typingSettings else { return }
        guard typingSettings.driverAvailable else {
            typingStatus = "The USB keyboard driver is unavailable. Enter LOAD, RUN, REMOVE and START manually."
            append(typingStatus)
            return
        }
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent("scripts/gui-host.cjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path) else {
            typingStatus = "The USB command sender is missing. Enter LOAD, RUN, REMOVE and START manually."
            append(typingStatus)
            return
        }
        let task = Process()
        let output = Pipe()
        task.executableURL = node
        task.arguments = [script.path] + typingSettings.arguments(startCommand: command)
        task.currentDirectoryURL = runtimeRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = output
        typingProcess = task
        typingStatus = "Connecting the USB keyboard to send LOAD, RUN, REMOVE and START"
        append(typingStatus)
        do { try task.run() }
        catch {
            typingProcess = nil
            typingStatus = "The USB command sender could not start. Enter the commands manually: \(error.localizedDescription)"
            append(typingStatus)
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
                    await self?.receiveTyping(line, attempt: current)
                }
                if pending.utf8.count > 32768 { pending = String(pending.suffix(4096)) }
            }
            if !pending.isEmpty { await self?.receiveTyping(pending, attempt: current) }
            task.waitUntilExit()
            await self?.typingFinished(code: task.terminationStatus, attempt: current)
        }
    }

    private func receiveTyping(_ line: String, attempt current: UUID) {
        guard current == attempt else { return }
        writeDiagnostic("HID \(line)")
        guard line.utf8.count <= 8192,
              let bytes = line.data(using: .utf8),
              let event = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let type = event["type"] as? String else {
            append(line)
            return
        }
        let message = event["message"] as? String
        switch type {
        case "controller":
            enumerationProgress = 0
            enumerationRemainingMs = nil
            if let message { typingStatus = message; append(message) }
        case "enumeration-progress":
            if let completed = (event["completed"] as? NSNumber)?.doubleValue,
               let total = (event["total"] as? NSNumber)?.doubleValue, total > 0 {
                enumerationProgress = min(1, max(0, completed / total))
            }
            enumerationRemainingMs = (event["remainingMs"] as? NSNumber)?.doubleValue
        case "typing", "command-start", "command-complete", "wait":
            enumerationProgress = nil
            enumerationRemainingMs = nil
            if let message { typingStatus = message; append(message) }
            else if type == "command-start", let label = event["label"] as? String {
                typingStatus = "Sending \(label)"
            }
        case "transfer-complete":
            guard event["kind"] as? String == "commands" else { return }
            enumerationProgress = nil
            enumerationRemainingMs = nil
            typingCompleted = true
            typingStatus = "Commands sent. Waiting for kaiHEN."
            append(typingStatus)
        case "failed", "cancelled":
            enumerationProgress = nil
            enumerationRemainingMs = nil
            let reason = message ?? "USB command transfer stopped."
            typingStatus = "\(reason) Check the Switch for partial input before entering commands manually."
            append(typingStatus)
        case "log":
            if let message { append(message) }
        default: break
        }
    }

    private func typingFinished(code: Int32, attempt current: UUID) {
        guard current == attempt else { return }
        typingProcess = nil
        enumerationProgress = nil
        enumerationRemainingMs = nil
        guard !stopRequested, process != nil, !typingCompleted else { return }
        if code == 0 {
            typingStatus = "The USB sender ended without confirming all four commands. Check the Switch before entering them manually."
        } else if !typingStatus.contains("Check the Switch") {
            typingStatus = "USB typing did not complete. Check the Switch for partial input before entering commands manually."
        }
        append(typingStatus)
    }

    private func finished(code: Int32, attempt current: UUID) {
        guard current == attempt else { return }
        process = nil
        if typingProcess?.isRunning == true { typingProcess?.terminate() }
        if stopRequested {
            phase = .idle
            status = "kaiHEN stopped"
        } else if code == 0 && installed {
            phase = .complete
            status = launchPath == .ns2jb
                ? "kaiHEN remains active until the Switch restarts"
                : "kaiHEN installed for this boot"
        } else {
            let hadFailure = phase == .failed
            phase = .failed
            if !hadFailure {
                status = "kaiHEN stopped before installation completed. See session details."
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

    private static func makeDiagnosticLog(path: LaunchPath) -> URL? {
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        let directory = support.appendingPathComponent("mac2jb/Sessions/\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let file = directory.appendingPathComponent(path == .ns2jb ? "ns2jb-kaihen.log" : "kaihen.log")
            guard FileManager.default.createFile(atPath: file.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]) else { return nil }
            return file
        } catch { return nil }
    }
}
