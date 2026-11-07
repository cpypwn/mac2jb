import Foundation

// This fixture never prepares an embedded runtime or starts driver/USB/RPC work.
@_cdecl("mac2jb_payload_bytes") func testPayloadBytes() -> UnsafePointer<UInt8>? { nil }
@_cdecl("mac2jb_payload_size") func testPayloadSize() -> UInt { 0 }
enum EmbeddedPayloadMetadata { static let sha256 = "unused-fixture" }

@main @MainActor struct NetworkSelectionTests {
    static func main() async throws {
        var checks = 0
        func check(_ condition: Bool, _ message: String) {
            precondition(condition, message); checks += 1
        }
        let old = NetworkAddress(address: "192.168.1.25", interface: "en0")
        let current = NetworkAddress(address: "192.168.1.119", interface: "en0")
        let other = NetworkAddress(address: "10.0.0.2", interface: "en1")
        let kept = NetworkSelection.refresh(selected: old.address, previous: [old], available: [other, old])
        check(!kept.changed && kept.selected == old.address, "preserve a still-current user selection")
        let replaced = NetworkSelection.refresh(selected: old.address, previous: [old], available: [other, current])
        check(replaced.changed && replaced.selected == current.address, "DHCP change prefers the user's same interface")
        let empty = NetworkSelection.refresh(selected: old.address, previous: [old], available: [])
        check(empty.changed && empty.selected.isEmpty, "disconnect clears unavailable address")
        check(NetworkSelection.refresh(selected: "", previous: [], available: [current]).selected == current.address,
              "initial picker receives actual addresses")
        check(!NetworkSelection.safePreflightFailure(retrySafe: false, hostStarting: true, hostReady: false,
              hasHIDWorker: false, hasHIDEvidence: false, postRunActive: false), "unsafe backend failure cannot become idle recovery")
        for flags in [(false, false, false, false, false), (true, true, false, false, false),
                      (true, false, true, false, false), (true, false, false, true, false),
                      (true, false, false, false, true)] {
            check(!NetworkSelection.safePreflightFailure(retrySafe: true, hostStarting: flags.0, hostReady: flags.1,
                  hasHIDWorker: flags.2, hasHIDEvidence: flags.3, postRunActive: flags.4), "deny safe recovery after any connection/input evidence")
        }

        let suiteName = "mac2jb-network-tests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        var live = [current], reads = 0
        let model = SessionModel(addressProvider: { reads += 1; return live }, networkDefaults: defaults)
        check(model.runMode == .heldRPC && model.activeRunMode == .heldRPC && !model.fullInstall,
              "actual model defaults to Held RPC")
        check(!model.workflowProgress.selectedFullInstall, "sidebar mode agrees with Held RPC default")
        model.phase = .ready; model.addresses = [old]; model.selectedAddress = old.address
        model.start()
        check(reads == 1 && model.selectedAddress == current.address && model.addresses == [current],
              "actual Start refreshes addresses instead of trusting its cached list")
        check(model.phase == .ready && model.error == nil && !model.hasLiveWorkers && model.activeAddress.isEmpty,
              "changed-address Start launches no host/HID and does not become an exploit failure")
        check(model.networkNotice?.contains("Review the current address") == true &&
              model.networkNotice?.localizedCaseInsensitiveContains("restart the console") == false,
              "changed-address notice asks for review without false console cleanup advice")
        model.start()
        check(reads == 2 && !model.hasLiveWorkers, "every subsequent host Start reads the provider again")

        model.phase = .rpcHeld; live = [other]
        model.refreshNetworkAddressesIfIdle()
        check(reads == 2 && model.selectedAddress == current.address, "idle monitor cannot mutate an active held session")
        check(!model.handleNetworkUnavailable("not safe", retrySafe: true), "bind recovery cannot override held RPC")
        model.phase = .ready; model.refreshNetworkAddressesIfIdle()
        check(reads == 3 && model.selectedAddress.isEmpty, "disconnected selected interface blocks instead of switching to another interface")
        check(defaults.string(forKey: "preferredNetworkInterface") == "en0", "disconnect retains the interface lock")
        let relaunched = SessionModel(addressProvider: { [other] }, networkDefaults: defaults)
        relaunched.phase = .ready
        relaunched.refreshNetworkAddressesIfIdle()
        check(relaunched.selectedAddress.isEmpty, "relaunch with saved Ethernet absent does not choose Wi-Fi")
        model.start()
        check(!model.hasLiveWorkers && model.selectedAddress.isEmpty, "Start refuses disconnected locked interface")
        live = [other, current]
        model.refreshNetworkAddressesIfIdle()
        check(model.selectedAddress == current.address, "reconnected locked interface is restored")
        let restored = SessionModel(addressProvider: { [other, current] }, networkDefaults: defaults)
        restored.phase = .ready; restored.refreshNetworkAddressesIfIdle()
        check(restored.selectedAddress == current.address, "selection survives app relaunch despite Wi-Fi sorting first")
        restored.selectedAddress = other.address
        check(defaults.string(forKey: "preferredNetworkInterface") == "en1", "explicit user selection can change the lock")
        defaults.removePersistentDomain(forName: suiteName)
        model.phase = .hostStarting
        check(model.handleNetworkUnavailable("The selected Mac address changed. Review its network address.", retrySafe: true),
              "provably pre-input bind failure returns to configuration")
        check(model.phase == .ready && model.error == nil && !model.hasLiveWorkers && model.networkNotice?.contains("Mac address changed") == true,
              "safe bind event preserves its actionable network notice")
        check(model.workflowProgress.state(for: 0) == .active && model.workflowProgress.state(for: 2) == .pending,
              "safe bind failure does not mark the exploit failed")

        model.selectRunMode(.bootstrapOnly)
        let beforeBootstrap = reads
        model.start()
        check(reads == beforeBootstrap && !model.hasLiveWorkers, "bootstrap-only does not require a network address")
        check(Array(SessionRunMode.allCases.prefix(4)) == [.bootstrapOnly, .heldRPC, .systemCodeDump, .exploitOnly] &&
              SessionRunMode.allCases[4] == .commandsOnly, "primary mode order and developer commands-only position are unchanged")

        // Exercise the real Process/output/exit callbacks with an inert fake
        // host. It cannot run the app's JavaScript or a USB/RPC helper.
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("mac2jb-network-model-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false,
                                                 attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: folder) }
        let fakeHost = """
        #!/bin/sh
        count=0
        while [ ! -f release-network-error ] && [ "$count" -lt 500 ]; do
          /bin/sleep 0.01
          count=$((count + 1))
        done
        printf '%s\\n' '{"type":"network-unavailable","retrySafe":true,"message":"This Mac address changed. Review its current network address."}'
        exit 1
        """
        let executable = folder.appendingPathComponent("node")
        try Data(fakeHost.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        var liveHostAddresses = [current]
        let hostModel = SessionModel(addressProvider: { liveHostAddresses }, runtime: BundledRuntime(root: folder), networkDefaults: defaults)
        hostModel.phase = .ready; hostModel.driverLoaded = true
        hostModel.addresses = [current]; hostModel.selectedAddress = current.address
        hostModel.start()
        check(hostModel.phase == .hostStarting && hostModel.hasLiveWorkers && hostModel.activeAddress == current.address,
              "host start captures its actual address")
        liveHostAddresses = [other]
        hostModel.refreshNetworkAddressesIfIdle()
        check(hostModel.selectedAddress == current.address && hostModel.activeAddress == current.address,
              "live host address is never replaced by idle refresh")
        try Data().write(to: folder.appendingPathComponent("release-network-error"))
        let deadline = Date().addingTimeInterval(3)
        while hostModel.hasLiveWorkers && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        check(!hostModel.hasLiveWorkers && hostModel.phase == .ready && hostModel.error == nil,
              "real safe event plus nonzero worker exit does not become a generic exploit failure")
        check(hostModel.selectedAddress.isEmpty && hostModel.activeAddress == current.address,
              "safe recovery blocks the missing interface without rewriting attempt history")
        check(hostModel.networkNotice?.contains("Mac address changed") == true &&
              !hostModel.detail.localizedCaseInsensitiveContains("restart the console") && hostModel.diagnosticLogURL == nil,
              "safe bind failure has network guidance and no fallback crash/cleanup log")
        print("Network selection and actual model preflight checks passed: \(checks). No app, driver, USB or RPC operations run.")
    }
}
