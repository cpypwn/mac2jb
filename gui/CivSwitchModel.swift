import Foundation
import Combine

@MainActor final class CivSwitchModel: ObservableObject {
    enum Phase { case idle, typing, verifying, sendingDemo, stopping, verified, failed, cancelled }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var status = "Ready for CivSwitch"
    @Published private(set) var detail = "Prepare the Civilization VII chat screen before starting"
    @Published private(set) var progress: Double?
    @Published private(set) var log = ""

    var isRunning: Bool { phase == .typing || phase == .verifying || phase == .sendingDemo || phase == .stopping }
    var canStart: Bool { !isRunning && !transferCompleted && !needsReset }
    var canRetryProbe: Bool { transferCompleted && !isRunning && phase != .verified }
    var canReset: Bool { !isRunning && (needsReset || transferCompleted) }
    var canShowDemo: Bool { phase == .verified && probeConfirmed }

    private var process: Process?
    private var attempt = UUID()
    private var runtimeRoot: URL?
    private var consoleAddress = ""
    private var transferCompleted = false
    private var probeConfirmed = false
    private var demoConfirmed = false
    private var reportedFailure: String?
    private var needsReset = false

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
        transferCompleted = false; probeConfirmed = false; demoConfirmed = false; reportedFailure = nil; needsReset = false
        progress = 0; log = ""
        phase = .typing
        status = "Connecting CivSwitch USB controller"
        detail = "Keep Civilization VII chat open and the USB cable connected during the 87-line transfer"
        launch(helper, arguments: ["--payload", payload.path, "--controller", controller,
             "--enumeration-timeout-seconds", String(enumerationTimeoutSeconds)], stage: .typing)
    }

    func cancel() {
        guard phase == .typing || phase == .verifying || phase == .sendingDemo else { return }
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

    func showDemo() {
        guard canShowDemo, let runtimeRoot else { return }
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent("integrations/civswitch/send-hello.cjs")
        let display = runtimeRoot.appendingPathComponent("integrations/civswitch/hello.js")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path),
              FileManager.default.fileExists(atPath: display.path) else {
            demoProblem("The CivSwitch demo is missing from this app")
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
        transferCompleted = false; probeConfirmed = false; demoConfirmed = false; reportedFailure = nil; needsReset = false
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
            if stage == .sendingDemo { demoProblem(message) } else { fail(message) }
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
        case "demo-sending":
            status = "Sending cpypwn demo"
            detail = message ?? "Sending display to the verified loader"
        case "demo-ready":
            demoConfirmed = true
            detail = message ?? "The cpypwn display is running on the Switch"
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
            if stage == .sendingDemo {
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
        if stage == .sendingDemo {
            if code == 0 && reportedFailure == nil && demoConfirmed {
                phase = .verified
                status = "cpypwn demo on Switch"
                detail = "The CivSwitch loader confirmed the display. You can send it again while the game remains open"
                progress = 1
            } else {
                demoProblem(reportedFailure ?? "The CivSwitch loader did not confirm the cpypwn display")
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

    private func demoProblem(_ message: String) {
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
