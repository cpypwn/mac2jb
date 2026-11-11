import Combine
import Foundation

@MainActor final class CivSwitchAppsModel: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var launcherRunning = false
    @Published private(set) var companionReady = false
    @Published private(set) var status = ""
    @Published private(set) var log = ""

    var isActive: Bool { busy || launcherRunning }

    private var actionProcess: Process?
    private var launcherProcess: Process?
    private var actionAttempt = UUID()
    private var launcherAttempt = UUID()
    private var actionName = ""
    private var currentAction = ""

    func connect(address: String, runtimeRoot: URL?) {
        guard !busy, !launcherRunning else { return }
        companionReady = false
        run("probe", script: "scripts/gui-civhomebrew.cjs", address: address, runtimeRoot: runtimeRoot)
    }

    func open(address: String, runtimeRoot: URL?) {
        guard !busy, !launcherRunning, let runtimeRoot else { return }
        guard Self.validIPv4(address) else { status = "Enter the Switch IPv4 address"; return }
        let script = runtimeRoot.appendingPathComponent("scripts/gui-civhomebrew.cjs")
        let node = runtimeRoot.appendingPathComponent("node")
        guard FileManager.default.fileExists(atPath: script.path),
              FileManager.default.isExecutableFile(atPath: node.path) else {
            status = "CivHomebrew is missing from this app"
            return
        }
        let task = Process()
        let stream = Pipe()
        task.executableURL = node
        task.arguments = [script.path, "launch", runtimeRoot.path, address]
        task.currentDirectoryURL = runtimeRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = stream
        task.standardError = stream
        let current = UUID()
        launcherAttempt = current
        launcherRunning = true
        companionReady = false
        status = "Opening CivHomebrew"
        append("Opening CivHomebrew")
        do { try task.run() }
        catch {
            launcherRunning = false
            status = "Could not open CivHomebrew: \(error.localizedDescription)"
            append(status)
            return
        }
        launcherProcess = task
        read(task, stream: stream, prefix: "MAC2JB_CIVHOMEBREW ") { [weak self] line, event in
            self?.receive(line, event: event, fromLaunch: true, attempt: current)
        } onFinish: { [weak self] code in
            guard let self, self.launcherAttempt == current else { return }
            self.launcherProcess = nil
            self.launcherRunning = false
            self.companionReady = false
            self.status = code == 0 ? "CivHomebrew closed" : "CivHomebrew stopped before completing"
            self.append(self.status)
        }
    }

    func installTrigger(address: String, runtimeRoot: URL?) {
        run("install", script: "scripts/gui-civhomebrew.cjs", address: address, runtimeRoot: runtimeRoot)
    }

    func restoreTrigger(address: String, runtimeRoot: URL?) {
        run("restore", script: "scripts/gui-civhomebrew.cjs", address: address, runtimeRoot: runtimeRoot)
    }

    func stop(address: String, runtimeRoot: URL?) {
        if launcherRunning && !companionReady {
            status = "Stopping CivHomebrew startup"
            launcherProcess?.terminate()
            return
        }
        run("shutdown", script: "scripts/gui-civhomebrew.cjs", address: address, runtimeRoot: runtimeRoot)
    }

    func installMoonlight(address: String, runtimeRoot: URL?) {
        run("install", script: "scripts/gui-civswitch-moonlight.cjs", address: address, runtimeRoot: runtimeRoot)
    }

    func launchMoonlight(address: String, runtimeRoot: URL?) {
        run("launch", script: "scripts/gui-civswitch-moonlight.cjs", address: address, runtimeRoot: runtimeRoot)
    }

    private func run(_ action: String, script name: String, address: String, runtimeRoot: URL?) {
        guard !busy, let runtimeRoot else { return }
        guard Self.validIPv4(address) else { status = "Enter the Switch IPv4 address"; return }
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent(name)
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path) else {
            status = "The CivSwitch app helper is missing from this build"
            return
        }
        let task = Process()
        let stream = Pipe()
        task.executableURL = node
        task.arguments = [script.path, action, runtimeRoot.path, address]
        task.currentDirectoryURL = runtimeRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = stream
        task.standardError = stream
        let current = UUID()
        actionAttempt = current
        actionName = name.contains("moonlight") ? "Moonlight" : "CivHomebrew"
        currentAction = action
        busy = true
        status = "\(actionName): \(action)"
        append(status)
        do { try task.run() }
        catch {
            busy = false
            status = "Could not start \(actionName): \(error.localizedDescription)"
            append(status)
            return
        }
        actionProcess = task
        let prefix = name.contains("moonlight") ? "MAC2JB_CIV_MOONLIGHT " : "MAC2JB_CIVHOMEBREW "
        read(task, stream: stream, prefix: prefix) { [weak self] line, event in
            self?.receive(line, event: event, fromLaunch: false, attempt: current)
        } onFinish: { [weak self] code in
            guard let self, self.actionAttempt == current else { return }
            self.actionProcess = nil
            self.busy = false
            if code != 0 && action == "probe" { self.companionReady = false }
            if code != 0 && self.status.hasSuffix(": \(action)") {
                self.status = "\(self.actionName) \(action) failed"
                self.append(self.status)
            } else if self.status.hasSuffix(": \(action)") {
                self.status = "\(self.actionName) \(action) complete"
            }
        }
    }

    private func read(_ task: Process, stream: Pipe, prefix: String,
                      onLine: @escaping @MainActor (String, [String: Any]?) -> Void,
                      onFinish: @escaping @MainActor (Int32) -> Void) {
        Task.detached(priority: .userInitiated) {
            var pending = ""
            while true {
                let data = stream.fileHandleForReading.availableData
                if data.isEmpty { break }
                pending += String(decoding: data, as: UTF8.self)
                while let end = pending.firstIndex(of: "\n") {
                    let line = String(pending[..<end])
                    pending = String(pending[pending.index(after: end)...])
                    let event: [String: Any]?
                    if line.hasPrefix(prefix), line.utf8.count <= 8192,
                       let data = line.dropFirst(prefix.count).data(using: .utf8) {
                        event = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                    } else { event = nil }
                    await onLine(line, event)
                }
                if pending.utf8.count > 32768 { pending = String(pending.suffix(4096)) }
            }
            if !pending.isEmpty { await onLine(pending, nil) }
            task.waitUntilExit()
            await onFinish(task.terminationStatus)
        }
    }

    private func receive(_ line: String, event: [String: Any]?, fromLaunch: Bool, attempt: UUID) {
        guard (fromLaunch ? launcherAttempt : actionAttempt) == attempt else { return }
        guard let event, let type = event["type"] as? String else { append(line); return }
        let message = event["message"] as? String
        switch type {
        case "ready", "probe-ready":
            companionReady = true
            status = "CivHomebrew ready"
        case "installed":
            if actionName == "Moonlight" { status = "Moonlight installed in CivHomebrew" }
            else { status = "CivHomebrew boot trigger installed"; companionReady = false }
        case "launched":
            status = "Moonlight is opening on your Switch"
        case "restored":
            status = "Original CivSwitch boot trigger restored"
            companionReady = false
        case "stopped":
            status = "CivHomebrew closed"
            companionReady = false
        case "error", "failed":
            if fromLaunch || currentAction == "probe" { companionReady = false }
            status = message ?? "CivHomebrew needs attention"
        default:
            if let message { status = message }
        }
        append(message.map { "\(type): \($0)" } ?? type)
    }

    private func append(_ line: String) {
        log = String((log + line + "\n").suffix(40_000))
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
