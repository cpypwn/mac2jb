import AppKit
import Combine
import Foundation

@MainActor final class CivSwitchControlCenterModel: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var ready = false
    @Published private(set) var staging = false
    @Published private(set) var payloadModeAvailable = false
    @Published private(set) var status = "Control Center is closed"
    @Published private(set) var log = ""
    @Published private(set) var backupFolder: URL?

    var isRunning: Bool { running || staging || payloadModeAvailable }

    private var hostProcess: Process?
    private var stageProcess: Process?
    private var runtimeRoot: URL?
    private var consoleAddress = ""
    private var hostAttempt = UUID()
    private var stageAttempt = UUID()
    private var stopping = false

    func start(address: String, runtimeRoot: URL?) {
        guard !isRunning, let runtimeRoot else { return }
        let python = runtimeRoot.appendingPathComponent("homebrew/python/bin/python3")
        let adapter = runtimeRoot.appendingPathComponent("integrations/civswitch-control-center/mac-host.py")
        guard FileManager.default.isExecutableFile(atPath: python.path),
              FileManager.default.fileExists(atPath: adapter.path) else {
            status = "The bundled Control Center host is unavailable"
            return
        }
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                      appropriateFor: nil, create: true)
            let backups = support.appendingPathComponent("mac2jb/CivSwitch/Backups", isDirectory: true)
            try FileManager.default.createDirectory(at: backups, withIntermediateDirectories: true)
            backupFolder = backups
            self.runtimeRoot = runtimeRoot
            consoleAddress = address
            hostAttempt = UUID()
            stopping = false
            running = true
            ready = false
            payloadModeAvailable = false
            log = ""
            status = "Opening Control Center"
            launch(python, arguments: [adapter.path, "launch", address, backups.path], stage: false,
                   attempt: hostAttempt)
        } catch {
            status = "Could not create the Control Center backup folder: \(error.localizedDescription)"
        }
    }

    func stagePayload(_ file: URL) {
        guard payloadModeAvailable, ready, !staging, let runtimeRoot,
              file.pathExtension.lowercased() == "js",
              FileManager.default.fileExists(atPath: file.path) else { return }
        let python = runtimeRoot.appendingPathComponent("homebrew/python/bin/python3")
        let sender = runtimeRoot.appendingPathComponent("vendor/CivSwitch-ControlCenter/tools/send_staged_payload.py")
        guard FileManager.default.isExecutableFile(atPath: python.path),
              FileManager.default.fileExists(atPath: sender.path) else {
            status = "The bundled Payload Mode sender is unavailable"
            return
        }
        stageAttempt = UUID()
        staging = true
        payloadModeAvailable = false
        status = "Sending JavaScript to Payload Mode"
        launch(python, arguments: [sender.path, consoleAddress, file.path], stage: true,
               attempt: stageAttempt)
    }

    func stop() {
        guard isRunning else { return }
        stopping = true
        status = "Closing Control Center connection"
        ready = false
        payloadModeAvailable = false
        if stageProcess?.isRunning == true { stageProcess?.terminate() }
        if hostProcess?.isRunning == true { hostProcess?.terminate() }
        if !running && !staging { stopping = false; status = "Control Center connection closed" }
    }

    func openBackups() {
        guard let backupFolder else { return }
        NSWorkspace.shared.open(backupFolder)
    }

    private func launch(_ executable: URL, arguments: [String], stage: Bool, attempt: UUID) {
        let task = Process()
        let output = Pipe()
        task.executableURL = executable
        task.arguments = arguments
        task.currentDirectoryURL = runtimeRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = output
        do { try task.run() }
        catch {
            if stage { staging = false } else { running = false; ready = false }
            status = "Control Center could not start: \(error.localizedDescription)"
            return
        }
        if stage { stageProcess = task } else { hostProcess = task }
        Task.detached(priority: .userInitiated) { [weak self] in
            var pending = ""
            while true {
                let data = output.fileHandleForReading.availableData
                if data.isEmpty { break }
                pending += String(decoding: data, as: UTF8.self)
                while let end = pending.firstIndex(of: "\n") {
                    let line = String(pending[..<end])
                    pending = String(pending[pending.index(after: end)...])
                    await self?.receive(line, stage: stage, attempt: attempt)
                }
                if pending.utf8.count > 32768 { pending = String(pending.suffix(4096)) }
            }
            if !pending.isEmpty { await self?.receive(pending, stage: stage, attempt: attempt) }
            task.waitUntilExit()
            await self?.finished(code: task.terminationStatus, stage: stage, attempt: attempt)
        }
    }

    private func receive(_ line: String, stage: Bool, attempt: UUID) {
        guard attempt == (stage ? stageAttempt : hostAttempt) else { return }
        log = String((log + line + "\n").suffix(50000))
        if stage {
            if line.contains("Transfer complete; press A") { status = "Payload staged — press A or B on the Switch" }
            if line.contains("PAYLOAD_STAGE|ERROR") { status = "Payload transfer failed" }
        } else if line.hasPrefix("CONTROL_CENTER_READY ") {
            ready = true
            status = "Control Center ready"
        }
    }

    private func finished(code: Int32, stage: Bool, attempt: UUID) {
        guard attempt == (stage ? stageAttempt : hostAttempt) else { return }
        if stage {
            stageProcess = nil
            staging = false
            if !running { ready = false; payloadModeAvailable = false }
            status = stopping ? "Control Center connection closed"
                : code == 0 ? "Payload session ended"
                : "Payload transfer stopped; check the activity log"
        } else {
            hostProcess = nil
            running = false
            if !stopping && code == 0 && ready && !staging {
                payloadModeAvailable = true
                status = "Control Center connection ended. If Payload Mode is open, choose JavaScript"
            } else {
                if !staging { ready = false }
                status = stopping ? "Control Center connection closed"
                    : code == 0 ? "Control Center closed"
                    : "Control Center stopped; check the activity log"
            }
        }
        if !isRunning { stopping = false }
    }
}
