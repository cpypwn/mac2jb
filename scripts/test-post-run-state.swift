import Foundation

@main struct PostRunStateTests {
    static func main() {
        for keepRPC in [false, true] {
            for dumpFirmware in [false, true] {
                var state = PostRunSessionState()
                var workflow = WorkflowProgress()
                workflow.begin(fullInstall: false)
                precondition(!state.isActive && !state.canFinish && !state.canCheckStatus)
                precondition(!state.choose(keepRPC: keepRPC, dumpFirmware: dumpFirmware))
                precondition(state.ready() && state.stage == .awaitingChoice && state.isActive)
                precondition(!state.ready() && state.canFinish && !state.canCheckStatus)
                precondition(workflow.state(for: 2) == .active)
                precondition(state.choose(keepRPC: keepRPC, dumpFirmware: dumpFirmware))
                precondition(!state.choose(keepRPC: !keepRPC, dumpFirmware: !dumpFirmware))
                if dumpFirmware {
                    precondition(state.stage == .dumping && !state.canFinish && !state.canCheckStatus)
                    precondition(!state.finish() && !state.checkStatus())
                    precondition(!state.receive("rpc-held"))
                    precondition(state.receive("dump-started"))
                    precondition(!state.dumpCompleted)
                    precondition(state.receive("dump-complete") && state.dumpCompleted)
                    precondition(!state.receive("dump-complete"))
                }
                if keepRPC {
                    precondition(state.stage == .held && state.canFinish && state.canCheckStatus)
                    precondition(state.receive("rpc-held"))
                    precondition(state.checkStatus() && state.statusInFlight)
                    precondition(!state.canFinish && !state.canCheckStatus)
                    precondition(!state.checkStatus() && !state.finish())
                    precondition(state.receive("rpc-status-started"))
                    precondition(state.receive("rpc-status") && !state.statusInFlight)
                    precondition(state.finish())
                }
                precondition(state.stage == .finishing && state.isActive)
                precondition(!state.canFinish && !state.canCheckStatus)
                precondition(!state.receive("rpc-held") && !state.receive("rpc-status"))
                precondition(workflow.state(for: 2) == .active)
                precondition(state.receive("rpc-finishing"))
                precondition(state.receive("verified") && state.stage == .complete && !state.isActive)
                workflow.complete()
                precondition(workflow.state(for: 2) == .complete)
                precondition(!state.ready() && !state.receive("rpc-finishing"))
            }
        }
        var declined = PostRunSessionState()
        precondition(declined.ready() && declined.finish() && declined.stage == .finishing)
        var heldDump = PostRunSessionState()
        precondition(heldDump.ready() && heldDump.choose(keepRPC: true, dumpFirmware: false))
        precondition(heldDump.receive("rpc-held") && heldDump.canDumpSystemCode)
        precondition(heldDump.requestDump() && heldDump.dumpInProgress)
        precondition(!heldDump.canFinish && !heldDump.canCheckStatus && !heldDump.canLaunchHomebrew)
        heldDump.cancelDumpRequest()
        precondition(heldDump.canDumpSystemCode && heldDump.launchHomebrew())
        precondition(heldDump.receive("homebrew-started") && heldDump.receive("homebrew-running"))
        precondition(heldDump.canDumpSystemCode && heldDump.requestDump())
        precondition(!heldDump.requestDump())
        precondition(heldDump.receive("homebrew-stopped"))
        precondition(heldDump.receive("dump-started") && heldDump.stage == .dumping)
        precondition(heldDump.receive("dump-complete") && heldDump.stage == .held && heldDump.dumpCompleted)
        precondition(!heldDump.canDumpSystemCode && heldDump.canFinish)
        precondition(heldDump.finish())
        for stage in 0..<4 {
            var state = PostRunSessionState()
            state.ready()
            if stage > 0 { state.choose(keepRPC: true, dumpFirmware: stage == 2) }
            if stage == 3 { state.finish() }
            state.stop()
            precondition(state.stage == .stopped && !state.isActive && !state.canFinish)
            precondition(!state.ready() && !state.receive("rpc-held") && !state.receive("verified"))
        }
        let fresh = PostRunSessionState()
        precondition(!fresh.keepRPC && !fresh.dumpRequested && !fresh.dumpCompleted && !fresh.statusInFlight)
        print("Post-run state checks passed: four choices, dump/hold/status/finish, cancellation, and final-only completion.")
    }
}
