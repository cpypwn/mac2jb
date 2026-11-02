import Foundation
import Combine

@MainActor final class DNSwitchModel: ObservableObject {
    enum Phase: Equatable { case idle, starting, ready, stopping, stopFailed, stopped, failed }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var status = "Ready to start the local DNS page"
    @Published private(set) var detail = "Switch 2 captive portal behavior has not been verified"
    @Published private(set) var activeAddress = ""
    @Published private(set) var addresses: [NetworkAddress] = []
    @Published var selectedAddress = ""

    var isActive: Bool { phase == .starting || phase == .ready || phase == .stopping || phase == .stopFailed }
    var canStart: Bool { !isActive }
    var canStop: Bool { phase == .ready || phase == .stopFailed }

    private let hostname = "ctest.p01.ctest.srv.nintendo.net"
    private var runtimeRoot: URL?
    private var stateURL: URL?
    private var tokenURL: URL?
    private var launchProcess: Process?
    private var pollTask: Task<Void, Never>?
    private var attempt = UUID()

    init() { refreshAddresses() }

    func refreshAddresses() {
        let available = NetworkSelection.localAddresses()
        let selected = NetworkSelection.refresh(selected: selectedAddress, previous: addresses, available: available)
        addresses = selected.addresses
        if !isActive { selectedAddress = selected.selected }
    }

    func start(destinationURL: String, runtimeRoot: URL?) {
        guard canStart else { return }
        refreshAddresses()
        let address = selectedAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard NetworkSelection.isIPv4(address),
              NetworkSelection.localAddresses().contains(where: { $0.address == address }) else {
            fail("Choose a current Mac network address before starting DNSwitch")
            return
        }
        let destination = destinationURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if !destination.isEmpty {
            guard let components = URLComponents(string: destination),
                  let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
                  let host = components.host, !host.isEmpty,
                  components.user == nil, components.password == nil else {
                fail("Enter a complete http or https destination URL, or leave it blank for the local page")
                return
            }
        }
        guard let runtimeRoot else {
            fail("Wait for the bundled tools to finish preparing")
            return
        }
        let node = runtimeRoot.appendingPathComponent("node")
        let helper = runtimeRoot.appendingPathComponent("scripts/gui-dnswitch.cjs")
        let script = runtimeRoot.appendingPathComponent("scripts/dnswitch-launch.applescript")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: helper.path),
              FileManager.default.fileExists(atPath: script.path) else {
            fail("The DNSwitch tools are missing from this app")
            return
        }

        let state = runtimeRoot.appendingPathComponent("dnswitch-state.json")
        let token = runtimeRoot.appendingPathComponent("dnswitch-token")
        do {
            let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max) }
            let hex = bytes.map { String(format: "%02x", $0) }.joined()
            try Data(hex.utf8).write(to: token, options: .atomic)
            try Data("{\"phase\":\"starting\"}".utf8).write(to: state, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: token.path)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: state.path)
        } catch {
            fail("Could not prepare the private DNSwitch control files: \(error.localizedDescription)")
            return
        }

        attempt = UUID()
        let current = attempt
        self.runtimeRoot = runtimeRoot
        stateURL = state
        tokenURL = token
        activeAddress = address
        phase = .starting
        status = "Starting the local DNS page"
        detail = "macOS will ask for administrator access to use DNS port 53 and HTTP port 80"

        let task = Process()
        let output = Pipe()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = [script.path, node.path, helper.path, address, hostname, destination, state.path, token.path]
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = output
        do {
            try task.run()
        } catch {
            fail("Could not open the DNSwitch administrator prompt: \(error.localizedDescription)")
            return
        }
        launchProcess = task
        beginPolling(attempt: current)
        Task.detached(priority: .utility) { [weak self] in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            let message = String(decoding: data.prefix(2048), as: UTF8.self)
            await self?.launchFinished(code: task.terminationStatus, output: message, attempt: current)
        }
    }

    func stop() {
        guard canStop, let runtimeRoot, let stateURL, let tokenURL else { return }
        phase = .stopping
        status = "Stopping DNSwitch"
        detail = "Closing the local DNS and HTTP listeners"
        let current = attempt
        let task = Process()
        let output = Pipe()
        task.executableURL = runtimeRoot.appendingPathComponent("node")
        task.arguments = [runtimeRoot.appendingPathComponent("scripts/gui-dnswitch.cjs").path,
                          "stop", "--state", stateURL.path, "--token-file", tokenURL.path]
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = output
        do {
            try task.run()
        } catch {
            fail("Could not stop DNSwitch: \(error.localizedDescription)")
            return
        }
        Task.detached(priority: .utility) { [weak self] in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            await self?.stopFinished(code: task.terminationStatus,
                                     output: String(decoding: data.prefix(2048), as: UTF8.self), attempt: current)
        }
    }

    func stopForTermination() {
        pollTask?.cancel()
        if phase == .starting { launchProcess?.terminate() }
        guard phase == .starting || phase == .ready || phase == .stopping || phase == .stopFailed,
              let runtimeRoot, let stateURL, let tokenURL else { return }
        let task = Process()
        task.executableURL = runtimeRoot.appendingPathComponent("node")
        task.arguments = [runtimeRoot.appendingPathComponent("scripts/gui-dnswitch.cjs").path,
                          "stop", "--state", stateURL.path, "--token-file", tokenURL.path]
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
        if task.isRunning { task.waitUntilExit() }
    }

    private func beginPolling(attempt current: UUID) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, current == self.attempt, self.isActive else { break }
                self.readState()
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
    }

    private func readState() {
        guard let stateURL, let data = try? Data(contentsOf: stateURL), data.count <= 8192,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let state = value["phase"] as? String else { return }
        let message = (value["message"] as? String).map { String($0.prefix(500)) }
        switch state {
        case "ready":
            if phase == .starting {
                phase = .ready
                status = "DNSwitch is running"
                detail = "Set the Switch’s primary DNS to \(activeAddress), then run its connection test"
            }
        case "failed":
            fail(message ?? "The local DNS or HTTP listener could not start")
        case "stopped":
            phase = .stopped
            status = "DNSwitch stopped"
            detail = "Restore your previous DNS settings on the Switch"
            pollTask?.cancel()
            removeToken()
        default: break
        }
    }

    private func launchFinished(code: Int32, output: String, attempt current: UUID) {
        guard current == attempt else { return }
        launchProcess = nil
        readState()
        guard phase == .starting else { return }
        if code != 0 {
            let reason = output.trimmingCharacters(in: .whitespacesAndNewlines)
            fail(reason.isEmpty ? "DNSwitch administrator access was canceled or failed" :
                 "DNSwitch could not start: \(String(reason.prefix(500)))")
            return
        }
        detail = "Waiting for the local DNS and HTTP listeners"
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            guard let self, self.attempt == current, self.phase == .starting else { return }
            self.readState()
            if self.phase == .starting { self.fail("The DNSwitch service did not report that it was ready") }
        }
    }

    private func stopFinished(code: Int32, output: String, attempt current: UUID) {
        guard current == attempt else { return }
        readState()
        guard phase == .stopping else { return }
        if code == 0 {
            detail = "Waiting for the DNS and HTTP listeners to close"
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                guard let self, self.attempt == current, self.phase == .stopping else { return }
                self.readState()
                if self.phase == .stopping {
                    self.phase = .stopFailed
                    self.status = "DNSwitch may still be running"
                    self.detail = "Stop was acknowledged but listener shutdown was not confirmed. Try Stop again"
                }
            }
        } else {
            let reason = output.trimmingCharacters(in: .whitespacesAndNewlines)
            phase = .stopFailed
            status = "DNSwitch may still be running"
            detail = reason.isEmpty ? "Stop was not confirmed. Try Stop again" :
                "Stop failed: \(String(reason.prefix(500))). Try Stop again"
        }
    }

    private func removeToken() {
        if let tokenURL { try? FileManager.default.removeItem(at: tokenURL) }
        tokenURL = nil
    }

    private func fail(_ message: String) {
        phase = .failed
        status = "DNSwitch needs attention"
        detail = message
        pollTask?.cancel()
    }
}
