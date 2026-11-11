import Foundation
@_cdecl("mac2jb_payload_bytes") func testPayloadBytes() -> UnsafePointer<UInt8>? { nil }
@_cdecl("mac2jb_payload_size") func testPayloadSize() -> UInt { 0 }
enum EmbeddedPayloadMetadata { static let sha256 = "unused-fixture" }
@main @MainActor struct TypingPreferenceTests {
    static func main() {
        let name = "mac2jb-timing-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        var checks = 0
        func check(_ condition: Bool, _ message: String) { precondition(condition, message); checks += 1 }
        check(HostProfile.defaultHost == .kurumuz, "Kurumuz is the startup host")
        let legacyHostKey = "developerHostProfile"
        let previousHost = UserDefaults.standard.object(forKey: legacyHostKey)
        defer {
            if let previousHost { UserDefaults.standard.set(previousHost, forKey: legacyHostKey) }
            else { UserDefaults.standard.removeObject(forKey: legacyHostKey) }
        }
        for oldHost in ["astral", "cellenseres"] {
            UserDefaults.standard.set(oldHost, forKey: legacyHostKey)
            let fresh = SessionModel(addressProvider: { [] }, timingDefaults: defaults, networkDefaults: defaults)
            check(fresh.selectedHost == .kurumuz && fresh.activeHost == .kurumuz,
                  "a previously selected \(oldHost) host does not override the next launch")
        }
        let model = SessionModel(addressProvider: { [] }, timingDefaults: defaults, networkDefaults: defaults)
        check(model.keyDelayMs == 10 && model.keyHoldMs == 0 && model.enterSettleMs == 0 && model.pollInterval == 10, "stock transport defaults")
        model.useExperimentalTypingTiming()
        model.enumerationTimeoutSeconds = 12; model.loadConfirmWaitMs = 500
        model.loadWaitMs = 1500; model.runWaitMs = 250; model.removeWaitMs = 350
        let reopened = SessionModel(addressProvider: { [] }, timingDefaults: defaults, networkDefaults: defaults)
        check(reopened.keyDelayMs == 5 && reopened.keyHoldMs == 10 && reopened.enterSettleMs == 100 && reopened.pollInterval == 6, "transport profile survives relaunch")
        check(reopened.enumerationTimeoutSeconds == 12 && reopened.loadConfirmWaitMs == 500 && reopened.loadWaitMs == 1500 && reopened.runWaitMs == 250 && reopened.removeWaitMs == 350, "all existing timing fields survive relaunch")
        reopened.useStockTiming()
        let stock = SessionModel(addressProvider: { [] }, timingDefaults: defaults, networkDefaults: defaults)
        check(stock.keyDelayMs == 10 && stock.keyHoldMs == 0 && stock.enterSettleMs == 0 && stock.pollInterval == 10, "stock profile persisted")
        check(stock.enumerationTimeoutSeconds == 4 && stock.loadConfirmWaitMs == 0 && stock.loadWaitMs == 1000 && stock.runWaitMs == 0 && stock.removeWaitMs == 0, "stock command defaults restored")
        defaults.set(["keyDelayMs": 0, "keyHoldMs": -1, "enterSettleMs": 2001, "pollInterval": 17, "enumerationTimeoutSeconds": 121, "loadWaitMs": 1.5, "runWaitMs": "500"], forKey: "usbTimingSettings")
        let invalid = SessionModel(addressProvider: { [] }, timingDefaults: defaults, networkDefaults: defaults)
        check(invalid.keyDelayMs == 10 && invalid.keyHoldMs == 0 && invalid.enterSettleMs == 0 && invalid.pollInterval == 10, "corrupt transport preferences fail back to stock")
        check(invalid.enumerationTimeoutSeconds == 4 && invalid.loadWaitMs == 1000 && invalid.runWaitMs == 0, "corrupt command preferences are rejected")
        check(!model.hasLiveWorkers && !reopened.hasLiveWorkers && !stock.hasLiveWorkers, "preference changes never start workers")
        check(HostProfile.allCases.count == 5 && HostProfile(rawValue: "astral") != nil, "all five host profiles remain available")
        check(HostProfile.kurumuz.supportsModloader && HostProfile.cellenseres.supportsModloader &&
              !HostProfile.astral.supportsModloader && !HostProfile.bermTheSequel.supportsModloader &&
              !HostProfile.pepsipu.supportsModloader,
              "Modloader is offered only on supported hosts")
        print("Typing preference checks passed: \(checks). No runtime, USB or RPC started.")
    }
}
