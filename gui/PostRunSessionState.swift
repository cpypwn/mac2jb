import Foundation

// Verification with a live endpoint is a checkpoint. Completion still requires
// the host to restore its retained resources and verify final cleanup.
struct PostRunSessionState: Equatable {
    enum Stage { case inactive, awaitingChoice, held, dumping, finishing, complete, stopped, blocked }
    enum HomebrewStage { case idle, launching, selecting, running, stopped, failed }
    private(set) var stage: Stage = .inactive
    private(set) var homebrewStage: HomebrewStage = .idle
    private(set) var heldConfirmed = false
    private(set) var keepRPC = false
    private(set) var dumpRequested = false
    private(set) var dumpCompleted = false
    private(set) var statusInFlight = false
    private(set) var cleanupBlocked = false

    var isActive: Bool { [.awaitingChoice, .held, .dumping, .finishing].contains(stage) }
    var dumpInProgress: Bool { dumpRequested && !dumpCompleted }
    var canFinish: Bool { stage == .awaitingChoice || stage == .held && !dumpInProgress && !statusInFlight && homebrewStage != .launching }
    var canCheckStatus: Bool { stage == .held && !dumpInProgress && !statusInFlight && homebrewStage == .idle }
    var homebrewAttempted: Bool { homebrewStage != .idle }
    var canLaunchHomebrew: Bool { stage == .held && heldConfirmed && !dumpInProgress && !statusInFlight && !homebrewAttempted }
    var canDumpSystemCode: Bool {
        stage == .held && heldConfirmed && !dumpRequested && !statusInFlight && !cleanupBlocked &&
        [.idle, .running, .stopped].contains(homebrewStage)
    }

    @discardableResult mutating func ready() -> Bool {
        guard stage == .inactive else { return false }
        stage = .awaitingChoice
        return true
    }

    @discardableResult mutating func choose(keepRPC: Bool, dumpFirmware: Bool) -> Bool {
        guard stage == .awaitingChoice else { return false }
        self.keepRPC = keepRPC; dumpRequested = dumpFirmware
        stage = dumpFirmware ? .dumping : keepRPC ? .held : .finishing
        return true
    }

    @discardableResult mutating func finish() -> Bool {
        guard canFinish else { return false }
        heldConfirmed = false; statusInFlight = false; stage = .finishing
        return true
    }

    @discardableResult mutating func checkStatus() -> Bool {
        guard canCheckStatus else { return false }
        statusInFlight = true
        return true
    }

    @discardableResult mutating func requestDump() -> Bool {
        guard canDumpSystemCode else { return false }
        dumpRequested = true
        return true
    }

    mutating func cancelDumpRequest() {
        if stage == .held && dumpInProgress { dumpRequested = false }
    }

    @discardableResult mutating func launchHomebrew() -> Bool {
        guard canLaunchHomebrew else { return false }
        homebrewStage = .launching
        return true
    }

    var canSelectHomebrew: Bool { stage == .held && heldConfirmed && homebrewStage == .selecting && !cleanupBlocked }

    @discardableResult mutating func selectHomebrew() -> Bool {
        guard canSelectHomebrew else { return false }
        homebrewStage = .launching
        return true
    }

    @discardableResult mutating func receive(_ event: String, retrySafe: Bool = false) -> Bool {
        switch event {
        case "rpc-held":
            guard keepRPC, stage == .held else { return false }
            heldConfirmed = true
        case "dump-started":
            guard dumpRequested, [.held, .dumping].contains(stage) else { return false }
            stage = .dumping
        case "dump-complete":
            guard stage == .dumping else { return false }
            dumpCompleted = true; stage = keepRPC ? .held : .finishing
        case "rpc-finishing":
            guard isActive else { return false }
            heldConfirmed = false; statusInFlight = false; stage = .finishing
        case "rpc-status-started":
            guard stage == .held, homebrewStage == .idle else { return false }
            statusInFlight = true
        case "rpc-status":
            guard stage == .held, homebrewStage == .idle else { return false }
            statusInFlight = false
        case "homebrew-started":
            guard stage == .held, heldConfirmed, homebrewStage == .launching else { return false }
        case "homebrew-catalog":
            guard stage == .held, heldConfirmed, homebrewStage == .launching else { return false }
            homebrewStage = .selecting
        case "homebrew-running":
            guard stage == .held, homebrewStage == .launching else { return false }
            homebrewStage = .running
        case "homebrew-stopped", "homebrew-failed":
            guard [.held, .finishing].contains(stage), homebrewAttempted else { return false }
            if homebrewStage == .failed, event == "homebrew-stopped" { return true }
            if event == "homebrew-failed", retrySafe, stage == .held, heldConfirmed, !cleanupBlocked {
                homebrewStage = .idle
                return true
            }
            homebrewStage = event == "homebrew-stopped" ? .stopped : .failed
            if event == "homebrew-failed" { heldConfirmed = false }
        case "verified":
            guard isActive, !cleanupBlocked else { return false }
            heldConfirmed = false; statusInFlight = false; stage = .complete
        case "cleanup-blocked":
            guard homebrewAttempted else { return false }
            cleanupBlocked = true; heldConfirmed = false; statusInFlight = false
            homebrewStage = .failed; stage = .blocked
        default: return false
        }
        return true
    }

    mutating func stop() { heldConfirmed = false; statusInFlight = false; stage = .stopped }
}
