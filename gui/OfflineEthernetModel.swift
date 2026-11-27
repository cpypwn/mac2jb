import Foundation
import Combine

@MainActor final class OfflineEthernetModel: ObservableObject {
    struct Adapter: Identifiable {
        let interface: String
        let label: String
        let active: Bool
        var id: String { interface }
    }

    @Published private(set) var adapters: [Adapter] = []
    @Published private(set) var isRefreshingAdapters = false
    @Published private(set) var adapterCheckError = ""
    @Published var selectedInterface = ""
    @Published private(set) var phase = "idle"
    @Published private(set) var message = "Choose the Mac Ethernet connection"
    @Published private(set) var active = false
    @Published private(set) var needsRestore = false
    @Published private(set) var switchSeen = false
    @Published private(set) var lastSwitchRequest = ""
    @Published private(set) var logPath = ""
    @Published private(set) var actionError = ""

    private let stateDirectory = "/Library/Application Support/mac2jb/offline-ethernet"
    private var runtimeRoot: URL?
    private var pollTask: Task<Void, Never>?
    private var adapterRefreshGeneration = 0
    private var startInFlight = false
    private var stopAfterStart = false
    private var stopInFlight = false
    private var restoreInFlight = false

    var adapterIssue: String? {
        if isRefreshingAdapters { return nil }
        if !adapterCheckError.isEmpty { return adapterCheckError }
        if adapters.isEmpty { return "No Ethernet adapter detected. Connect one to this Mac and refresh." }
        guard let selected = adapters.first(where: { $0.interface == selectedInterface }) else {
            return "Choose a Mac Ethernet connection."
        }
        if !selected.active {
            return "No active Ethernet link on \(selected.interface). Check the adapter, cable, and Switch dock, then refresh."
        }
        return nil
    }

    var canStart: Bool {
        !active && !startInFlight && !stopInFlight && !restoreInFlight &&
        phase != "starting" && !isRefreshingAdapters && adapterIssue == nil
    }
    var canStop: Bool {
        !stopAfterStart && !stopInFlight && !restoreInFlight &&
        (active || startInFlight || phase == "starting")
    }
    var canRestore: Bool { !startInFlight && !stopInFlight && !restoreInFlight && (needsRestore || active) }

    func open(runtimeRoot: URL?) {
        self.runtimeRoot = runtimeRoot
        refreshAdapters()
        startPolling()
    }

    func close() {
        pollTask?.cancel()
        pollTask = nil
        adapterRefreshGeneration += 1
        isRefreshingAdapters = false
    }

    func refreshAdapters() {
        adapterRefreshGeneration += 1
        let generation = adapterRefreshGeneration
        guard let tool = toolURL() else {
            isRefreshingAdapters = false
            adapterCheckError = "Wait for the bundled tools to finish preparing"
            return
        }
        isRefreshingAdapters = true
        adapterCheckError = ""
        Task {
            let result = await Self.runProcess(executable: tool.node.path, arguments: [tool.helper.path, "list"])
            guard generation == adapterRefreshGeneration else { return }
            isRefreshingAdapters = false
            guard result.code == 0,
                  let data = result.output.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let entries = json["adapters"] as? [[String: Any]] else {
                adapterCheckError = "Could not list Ethernet adapters: \(Self.short(result.output))"
                return
            }
            let values = entries.compactMap { entry -> Adapter? in
                guard let name = entry["interface"] as? String,
                      name.range(of: #"^en[0-9]+$"#, options: .regularExpression) != nil else { return nil }
                return Adapter(interface: name,
                               label: entry["label"] as? String ?? name,
                               active: entry["active"] as? Bool ?? false)
            }
            adapters = values
            if !values.contains(where: { $0.interface == selectedInterface }) {
                selectedInterface = values.first(where: { $0.active })?.interface ?? values.first?.interface ?? ""
            }
        }
    }

    func start() { perform("start") }
    func stop() {
        if startInFlight {
            stopAfterStart = true
            actionError = ""
            message = "Stop requested; waiting for startup to finish"
            return
        }
        perform("stop")
    }
    func restore() { perform("restore") }

    private func perform(_ action: String, force: Bool = false) {
        guard let tool = toolURL() else {
            message = "The Offline Ethernet tools are missing from this app"
            return
        }
        let script = runtimeRoot!.appendingPathComponent("scripts/offline-ethernet-launch.applescript")
        guard FileManager.default.fileExists(atPath: script.path) else {
            message = "The Offline Ethernet administrator launcher is missing"
            return
        }
        if action == "start" {
            guard canStart else { return }
            startInFlight = true
            stopAfterStart = false
            phase = "starting"
            message = "Starting DNS and HTTP on \(selectedInterface)"
        } else if action == "stop" {
            guard force || canStop else { return }
            stopInFlight = true
            message = "Stopping the connection-check service"
        } else {
            guard canRestore else { return }
            restoreInFlight = true
            message = "Restoring the Mac Ethernet address"
        }
        let interface = selectedInterface
        actionError = ""
        let arguments = [script.path, action, tool.node.path, tool.helper.path, stateDirectory, interface]
        Task {
            let result = await Self.runProcess(executable: "/usr/bin/osascript", arguments: arguments)
            if action == "start" && stopAfterStart {
                startInFlight = false
                stopAfterStart = false
                perform("stop", force: true)
                return
            }
            if result.code != 0 {
                actionError = action == "start" ? Self.short(result.output) :
                    "\(action.capitalized) failed (exit \(result.code)): \(Self.short(result.output))"
            }
            await refreshStatus()
            if action == "start" {
                startInFlight = false
                if result.code != 0 && phase == "starting" { phase = "failed" }
            } else if action == "stop" {
                stopInFlight = false
                if phase == "starting" { phase = "stopped" }
            } else {
                restoreInFlight = false
            }
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { break }
                await self.refreshStatus()
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
        }
    }

    private func refreshStatus() async {
        guard let tool = toolURL() else { return }
        let result = await Self.runProcess(executable: tool.node.path,
                                           arguments: [tool.helper.path, "status", "--state-dir", stateDirectory])
        guard result.code == 0,
              let data = result.output.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            if phase != "starting" && !stopAfterStart {
                message = "Could not read Offline Ethernet status: \(Self.short(result.output))"
            }
            return
        }
        let reported = json["phase"] as? String ?? "idle"
        if phase == "starting" && reported == "idle" { return }
        phase = reported
        active = json["active"] as? Bool ?? false
        needsRestore = json["needsRestore"] as? Bool ?? false
        switchSeen = json["switchSeen"] as? Bool ?? false
        lastSwitchRequest = json["lastSwitchRequest"] as? String ?? ""
        logPath = json["logPath"] as? String ?? ""
        if !stopAfterStart { message = json["message"] as? String ?? reported.capitalized }
        if let interface = json["interface"] as? String, !interface.isEmpty { selectedInterface = interface }
    }

    private func toolURL() -> (node: URL, helper: URL)? {
        guard let runtimeRoot else { return nil }
        let node = runtimeRoot.appendingPathComponent("node")
        let helper = runtimeRoot.appendingPathComponent("scripts/gui-offline-ethernet.cjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: helper.path) else { return nil }
        return (node, helper)
    }

    private nonisolated static func runProcess(executable: String, arguments: [String]) async -> (code: Int32, output: String) {
        await Task.detached(priority: .utility) {
            let process = Process()
            let pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = pipe
            process.standardError = pipe
            do {
                try process.run()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                return (process.terminationStatus, String(decoding: data.prefix(65536), as: UTF8.self))
            } catch {
                return (-1, error.localizedDescription)
            }
        }.value
    }

    private nonisolated static func short(_ output: String) -> String {
        let value = output.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "No details available" : String(value.suffix(400))
    }
}
