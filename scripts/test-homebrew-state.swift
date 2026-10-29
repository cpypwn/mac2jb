import Foundation

@main struct HomebrewStateTests {
    static func held() -> PostRunSessionState {
        var state = PostRunSessionState()
        precondition(!state.canLaunchHomebrew && !state.heldConfirmed)
        state.ready(); state.choose(keepRPC: true, dumpFirmware: false)
        precondition(!state.canLaunchHomebrew && !state.heldConfirmed)
        precondition(state.receive("rpc-held") && state.heldConfirmed && state.canLaunchHomebrew)
        return state
    }

    static func main() {
        var state = held()
        precondition(state.checkStatus() && !state.canLaunchHomebrew)
        precondition(!state.launchHomebrew())
        precondition(state.receive("rpc-status") && state.canLaunchHomebrew)
        precondition(state.launchHomebrew() && state.homebrewStage == .launching)
        precondition(!state.canLaunchHomebrew && !state.canFinish && !state.canCheckStatus)
        precondition(!state.launchHomebrew() && !state.checkStatus() && !state.finish())
        precondition(state.receive("homebrew-started"))
        precondition(state.receive("homebrew-running") && state.homebrewStage == .running)
        precondition(state.canFinish && !state.canCheckStatus && !state.canLaunchHomebrew)
        precondition(!state.receive("rpc-status-started"))
        precondition(state.finish() && state.stage == .finishing)
        precondition(state.receive("homebrew-stopped") && state.stage == .finishing)
        precondition(!state.receive("rpc-held") && !state.receive("homebrew-running"))
        precondition(state.receive("verified") && state.stage == .complete)
        precondition(!state.canLaunchHomebrew && !state.heldConfirmed)

        var failed = held()
        failed.launchHomebrew(); failed.receive("homebrew-started")
        precondition(failed.receive("homebrew-failed") && failed.homebrewStage == .failed)
        precondition(failed.canFinish && !failed.canCheckStatus && !failed.canLaunchHomebrew)
        precondition(!failed.heldConfirmed && !failed.launchHomebrew())
        precondition(failed.receive("homebrew-stopped") && failed.homebrewStage == .failed)
        precondition(failed.finish() && failed.receive("rpc-finishing") && failed.receive("verified"))

        var retry = held()
        precondition(retry.launchHomebrew() && retry.receive("homebrew-started"))
        precondition(retry.receive("homebrew-failed", retrySafe: true) && retry.homebrewStage == .idle)
        precondition(retry.heldConfirmed && retry.canLaunchHomebrew && retry.canCheckStatus)
        precondition(retry.launchHomebrew() && retry.homebrewStage == .launching)
        precondition(retry.receive("homebrew-failed") && !retry.canLaunchHomebrew)

        var ended = held()
        ended.launchHomebrew(); ended.receive("homebrew-running")
        precondition(ended.receive("homebrew-stopped") && ended.homebrewStage == .stopped)
        precondition(ended.canFinish && !ended.canLaunchHomebrew && !ended.canCheckStatus)
        ended.stop()
        precondition(!ended.canLaunchHomebrew && !ended.heldConfirmed)
        precondition(!ended.receive("homebrew-running") && !ended.receive("rpc-held"))

        var dump = PostRunSessionState()
        dump.ready(); dump.choose(keepRPC: false, dumpFirmware: true)
        precondition(!dump.canLaunchHomebrew && !dump.receive("rpc-held"))
        dump.receive("dump-started"); dump.receive("dump-complete")
        precondition(!dump.canLaunchHomebrew && !dump.homebrewAttempted)
        let fresh = held()
        precondition(fresh.canLaunchHomebrew && !fresh.homebrewAttempted)
        print("Homebrew state checks passed: confirmed ownership, one attempt, status/finish gates, failure cleanup, and fresh-session reset.")
    }
}
