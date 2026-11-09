import Foundation
import Combine

@MainActor final class CivSwitchModel: ObservableObject {
    enum Phase { case idle, typing, verifying, installingTrigger, sendingDemo, sendingPayload, stopping, verified, failed, cancelled }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var status = "Ready for CivSwitch"
    @Published private(set) var detail = "Prepare the Civilization VII chat screen before starting"
    @Published private(set) var progress: Double?
    @Published private(set) var log = ""
    @Published private(set) var diagnosticLogURL: URL?

    var isRunning: Bool { phase == .typing || phase == .verifying || phase == .installingTrigger || phase == .sendingDemo || phase == .sendingPayload || phase == .stopping }
    var canStart: Bool { !isRunning && phase != .verified && !transferCompleted && !needsReset }
    var canAttach: Bool { !isRunning }
    var canCancel: Bool { phase == .typing || phase == .verifying || phase == .sendingDemo || phase == .sendingPayload }
    var canRetryProbe: Bool { transferCompleted && !isRunning && phase != .verified }
    var canReset: Bool { !isRunning && phase != .idle }
    var canShowDemo: Bool { phase == .verified && probeConfirmed }
    var canSendPayload: Bool { phase == .verified && probeConfirmed }
    var canInstallTrigger: Bool { probeConfirmed && !triggerInstalled && !isRunning }
    @Published private(set) var triggerInstalled = false
    @Published private(set) var backupFolder: URL?

    private var process: Process?
    private var attempt = UUID()
    private var runtimeRoot: URL?
    private var consoleAddress = ""
    private var transferCompleted = false
    private var probeConfirmed = false
    private var demoConfirmed = false
    private var payloadConfirmed = false
    private var reportedFailure: String?
    private var needsReset = false
    private var diagnosticLog: FileHandle?

    func start(consoleAddress: String, runtimeRoot: URL?, controller: String = "auto",
               enumerationTimeoutSeconds: Int = 4) {
        guard canStart else { return }
        let address = consoleAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.validIPv4(address) else { fail("Enter the Switch IPv4 address before starting CivSwitch"); return }
        guard let runtimeRoot else { fail("Wait for the bundled runtime to finish preparing"); return }
        guard controller == "auto" || Self.validController(controller) else {
            fail("Choose an available USB controller"); return
        }
        guard (1...120).contains(enumerationTimeoutSeconds) else {
            fail("Choose a USB enumeration timeout from 1 to 120 seconds"); return
        }
        let helper = runtimeRoot.appendingPathComponent("mac2jb-civswitch-hid")
        let payload = runtimeRoot.appendingPathComponent("integrations/civswitch/payload.txt")
        guard FileManager.default.isExecutableFile(atPath: helper.path),
              FileManager.default.fileExists(atPath: payload.path) else {
            fail("The CivSwitch USB helper or payload is missing from this app"); return
        }
        attempt = UUID(); self.runtimeRoot = runtimeRoot; self.consoleAddress = address
        transferCompleted = false; probeConfirmed = false; demoConfirmed = false; payloadConfirmed = false
        triggerInstalled = false; backupFolder = nil; reportedFailure = nil; needsReset = false
        progress = 0; log = ""
        append("Starting CivSwitch transfer")
        phase = .typing
        status = "Connecting CivSwitch USB controller"
        detail = "Keep Civilization VII chat open and the USB cable connected during the 87-line transfer"
        launch(helper, arguments: ["--payload", payload.path, "--controller", controller,
             "--enumeration-timeout-seconds", String(enumerationTimeoutSeconds)], stage: .typing)
    }

    func cancel() {
        guard canCancel else { return }
        let wasTyping = phase == .typing
        phase = .stopping
        status = "Stopping CivSwitch"
        detail = wasTyping ? "Waiting for the USB helper to release both controller and keyboard reports"
                           : "Stopping the connection to the CivSwitch loader"
        process?.terminate()
    }

    func retryProbe() {
        guard canRetryProbe, let runtimeRoot else { return }
        attempt = UUID()
        reportedFailure = nil; probeConfirmed = false
        phase = .verifying
        status = "Checking CivSwitch loader"
        detail = "The 87-line payload will not be typed again"
        launch(runtimeRoot.appendingPathComponent("node"), arguments: [
            runtimeRoot.appendingPathComponent("integrations/civswitch/probe.cjs").path,
            consoleAddress
        ], stage: .verifying)
    }

    func attachExisting(consoleAddress: String, runtimeRoot: URL?) {
        guard canAttach else { return }
        let address = consoleAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.validIPv4(address) else { fail("Enter the Switch IPv4 address before connecting"); return }
        guard let runtimeRoot else { fail("Wait for the bundled runtime to finish preparing"); return }
        attempt = UUID(); self.runtimeRoot = runtimeRoot; self.consoleAddress = address
        transferCompleted = false; probeConfirmed = false; demoConfirmed = false; payloadConfirmed = false
        triggerInstalled = false; backupFolder = nil; reportedFailure = nil; needsReset = false
        phase = .verifying
        status = "Connecting to open CivSwitch loader"
        detail = "Checking the Remote JS Loader on port 9026"
        progress = nil
        append("Connecting to open CivSwitch loader")
        launch(runtimeRoot.appendingPathComponent("node"), arguments: [
            runtimeRoot.appendingPathComponent("integrations/civswitch/probe.cjs").path,
            address, "--once"
        ], stage: .verifying)
    }

    func installTrigger() {
        guard canInstallTrigger, let runtimeRoot else { return }
        attempt = UUID()
        reportedFailure = nil
        phase = .installingTrigger
        status = "Installing CivSwitch boot trigger"
        detail = "Backing up Civilization VII single-player saves before writing the persistent trigger"
        progress = nil
        append("Installing CivSwitch boot trigger")
        let backups = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("mac2jb/CivSwitch/Backups", isDirectory: true)
        launch(runtimeRoot.appendingPathComponent("node"), arguments: [
            runtimeRoot.appendingPathComponent("integrations/civswitch/install-persistent.cjs").path,
            consoleAddress, backups.path
        ], stage: .installingTrigger)
    }

    func sendPayload(_ file: URL) {
        guard canSendPayload, let runtimeRoot else { return }
        attempt = UUID()
        reportedFailure = nil; payloadConfirmed = false
        phase = .sendingPayload
        status = "Sending CivSwitch JavaScript"
        detail = "Sending \(file.lastPathComponent) to the open Remote JS Loader"
        progress = nil
        launch(runtimeRoot.appendingPathComponent("node"), arguments: [
            runtimeRoot.appendingPathComponent("integrations/civswitch/send-payload.cjs").path,
            consoleAddress, file.path
        ], stage: .sendingPayload)
    }

    func showDemo() {
        guard canShowDemo, let runtimeRoot else { return }
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent("integrations/civswitch/send-hello.cjs")
        let display = runtimeRoot.appendingPathComponent("integrations/civswitch/hello.js")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path),
              FileManager.default.fileExists(atPath: display.path) else {
            actionProblem("The CivSwitch demo is missing from this app")
            return
        }
        attempt = UUID()
        reportedFailure = nil; demoConfirmed = false
        phase = .sendingDemo
        status = "Sending cpypwn demo"
        detail = "Keep Civilization VII open while the Mac sends the display to the verified loader"
        launch(node, arguments: [script.path, consoleAddress], stage: .sendingDemo)
    }

    func reset() {
        guard !isRunning else { return }
        attempt = UUID()
        transferCompleted = false; probeConfirmed = false; demoConfirmed = false; payloadConfirmed = false
        triggerInstalled = false; backupFolder = nil; reportedFailure = nil; needsReset = false
        runtimeRoot = nil; consoleAddress = ""
        phase = .idle
        status = "Ready for CivSwitch"
        detail = "Prepare the Civilization VII chat screen before starting"
        progress = nil; log = ""
    }

    private func launch(_ executable: URL, arguments: [String], stage: Phase) {
        let task = Process()
        let output = Pipe()
        task.executableURL = executable
        task.arguments = arguments
        task.currentDirectoryURL = runtimeRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = output
        let current = attempt
        do { try task.run() }
        catch {
            let message = "CivSwitch could not start: \(error.localizedDescription)"
            if stage == .sendingDemo || stage == .sendingPayload || stage == .installingTrigger {
                actionProblem(message)
            } else { fail(message) }
            return
        }
        process = task
        Task.detached(priority: .userInitiated) { [weak self] in
            var pending = ""
            while true {
                let data = output.fileHandleForReading.availableData
                if data.isEmpty { break }
                pending += String(decoding: data, as: UTF8.self)
                while let end = pending.firstIndex(of: "\n") {
                    let line = String(pending[..<end]); pending = String(pending[pending.index(after: end)...])
                    await self?.receive(line, attempt: current)
                }
                if pending.utf8.count > 32768 {
                    pending = String(pending.suffix(4096))
                }
            }
            if !pending.isEmpty { await self?.receive(pending, attempt: current) }
            task.waitUntilExit()
            await self?.finished(stage: stage, code: task.terminationStatus, attempt: current)
        }
    }

    private func receive(_ line: String, attempt current: UUID) {
        guard current == attempt else { return }
        let prefix = "MAC2JB_CIVSWITCH "
        guard line.hasPrefix(prefix), line.utf8.count <= 4096,
              let data = line.dropFirst(prefix.count).data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = value["type"] as? String else {
            append(line); return
        }
        let message = value["message"] as? String
        switch type {
        case "ready":
            status = "Typing CivSwitch chat payload"
            detail = "Keep the chat screen open until all 87 lines finish"
        case "line-start", "line-complete":
            if let completed = value["completed"] as? Int, let total = value["total"] as? Int,
               total == 87, (0...total).contains(completed) {
                progress = Double(completed) / Double(total)
                status = "Typing CivSwitch · \(completed)/\(total) lines"
            }
        case "complete":
            transferCompleted = true
            progress = 1
            status = "CivSwitch payload typed"
            detail = "Waiting for the Remote JS Loader to answer on the Switch network address"
        case "probe-wait":
            status = "Checking CivSwitch loader"
            detail = message ?? "Waiting for TCP port 9026"
        case "loader-ready":
            probeConfirmed = true
            detail = message ?? "CivSwitch loader responded"
        case "install-backup-progress", "install-started":
            if let backup = (value["backup"] ?? value["path"]) as? String {
                backupFolder = URL(fileURLWithPath: backup)
            }
            detail = message ?? detail
        case "install-complete":
            triggerInstalled = true
            if let backup = value["backup"] as? String { backupFolder = URL(fileURLWithPath: backup) }
            detail = message ?? "The persistent CivSwitch trigger is installed"
        case "demo-sending":
            status = "Sending cpypwn demo"
            detail = message ?? "Sending display to the verified loader"
        case "demo-ready":
            demoConfirmed = true
            detail = message ?? "The cpypwn display is running on the Switch"
        case "payload-sending":
            detail = message ?? detail
        case "payload-ready":
            payloadConfirmed = true
            detail = message ?? "The CivSwitch loader ran the JavaScript"
        case "failed":
            reportedFailure = message ?? "CivSwitch stopped before verification"
        default: break
        }
        append(message.map { type + ": " + $0 } ?? type)
    }

    private func finished(stage: Phase, code: Int32, attempt current: UUID) {
        guard current == attempt else { return }
        process = nil
        if phase == .stopping {
            if stage == .sendingDemo || stage == .sendingPayload {
                phase = .verified
                status = "CivSwitch loader ready"
                detail = "The demo transfer stopped. You can send it again"
                progress = 1
                return
            }
            phase = .cancelled
            needsReset = stage == .typing
            status = "CivSwitch stopped"
            detail = stage == .typing
                ? "The chat payload may be partial. Return to the game menu, then reset this transfer before retrying"
                : "The typed payload remains on the Switch. You can check the loader again"
            progress = nil
            return
        }
        if stage == .sendingDemo || stage == .sendingPayload {
            let confirmed = stage == .sendingDemo ? demoConfirmed : payloadConfirmed
            if code == 0 && reportedFailure == nil && confirmed {
                phase = .verified
                status = stage == .sendingDemo ? "cpypwn demo on Switch" : "JavaScript sent to CivSwitch"
                detail = stage == .sendingDemo
                    ? "The CivSwitch loader confirmed the display. You can send it again while the game remains open"
                    : "The CivSwitch loader confirmed execution. You can send another file while the connection remains open"
                progress = 1
            } else {
                actionProblem(reportedFailure ?? (stage == .sendingDemo
                    ? "The CivSwitch loader did not confirm the cpypwn display"
                    : "The CivSwitch loader did not confirm JavaScript execution"))
            }
            return
        }
        if stage == .installingTrigger {
            if code == 0 && reportedFailure == nil && triggerInstalled {
                phase = .verified
                status = "CivSwitch boot trigger installed"
                detail = "The Civilization VII save trigger is ready. Reboot the game and choose Load Game to open the loader again"
                progress = 1
            } else {
                actionProblem(reportedFailure ?? "The CivSwitch boot trigger was not verified. The loader remains open")
            }
            return
        }
        if code != 0 || reportedFailure != nil {
            fail(reportedFailure ?? (stage == .typing ? "CivSwitch USB transfer stopped. Check the chat screen before retrying" :
                  "The CivSwitch loader did not verify on port 9026"))
            if stage == .verifying && transferCompleted {
                detail += ". Use Check loader again to retry without retyping"
            }
            return
        }
        if stage == .typing {
            guard transferCompleted, let runtimeRoot else {
                fail("The CivSwitch helper exited without confirming all payload lines"); return
            }
            phase = .verifying
            status = "Checking CivSwitch loader"
            detail = "The Mac is sending a harmless challenge to the Switch on port 9026"
            let node = runtimeRoot.appendingPathComponent("node")
            let script = runtimeRoot.appendingPathComponent("integrations/civswitch/probe.cjs")
            launch(node, arguments: [script.path, consoleAddress], stage: .verifying)
        } else if probeConfirmed {
            phase = .verified
            status = "CivSwitch loader ready"
            detail = "The Remote JS Loader answered the Mac on port 9026. Keep the game and Mac on the same network"
            progress = 1
        } else {
            fail("The CivSwitch loader did not confirm the challenge response")
        }
    }

    private func append(_ line: String) {
        log = String((log + line + "\n").suffix(50000))
        if diagnosticLog == nil { openDiagnosticLog() }
        let entry = "[\(Date().formatted(.iso8601))] \(line)\n"
        if let bytes = entry.data(using: .utf8) {
            try? diagnosticLog?.write(contentsOf: bytes)
        }
    }

    private func openDiagnosticLog() {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("mac2jb/CivSwitch/Logs", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            let file = folder.appendingPathComponent("activity.log")
            let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
            if let size = attributes?[.size] as? NSNumber, size.intValue > 1_000_000 {
                let previous = folder.appendingPathComponent("activity.previous.log")
                try? FileManager.default.removeItem(at: previous)
                try FileManager.default.moveItem(at: file, to: previous)
            }
            let descriptor = open(file.path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, S_IRUSR | S_IWUSR)
            guard descriptor >= 0 else { return }
            diagnosticLog = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            diagnosticLogURL = file
        } catch {
            diagnosticLogURL = nil
        }
    }

    private func fail(_ message: String) {
        if phase == .typing { needsReset = true }
        process = nil
        phase = .failed
        status = "CivSwitch needs attention"
        detail = message
        progress = nil
        append(message)
    }

    private func actionProblem(_ message: String) {
        process = nil
        phase = .verified
        status = "CivSwitch loader ready"
        detail = message
        progress = 1
        append(message)
    }

    private static func validController(_ value: String) -> Bool {
        guard value.hasPrefix("usb-drd"), let number = Int(value.dropFirst(7)) else { return false }
        return (0...15).contains(number) && value == "usb-drd\(number)"
    }

    private static func validIPv4(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { part in
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let octet = Int(part), (0...255).contains(octet),
                  String(octet) == part else { return false }
            return true
        }
    }
}
