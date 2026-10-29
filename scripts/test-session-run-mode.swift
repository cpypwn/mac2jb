import Foundation

@main struct SessionRunModeTests {
    static func main() throws {
        let address = "192.0.2.1"
        precondition(SessionRunMode.allCases == [.bootstrapOnly, .heldRPC, .systemCodeDump, .exploitOnly, .commandsOnly, .hostOnly, .hostOnlyHeld, .existingRPC])
        precondition(SessionRunMode.allCases.map(\.number) == [1, 2, 3, 4, 5, 6, 7, 8])
        precondition(SessionRunMode.heldRPC.caption.contains("launch MintBrew automatically"))

        var bootstrap = WorkflowProgress()
        bootstrap.begin(fullInstall: true)
        bootstrap.bootstrapOnlySaved()
        precondition(bootstrap.state(for: 1) == .active && bootstrap.state(for: 2) == .pending)
        bootstrap.bootstrapTransferred()
        precondition(bootstrap.state(for: 1) == .active)
        bootstrap.bootstrapOnlySaved()
        precondition(bootstrap.state(for: 0) == .complete && bootstrap.state(for: 1) == .complete)
        precondition(bootstrap.state(for: 2) == .pending)
        bootstrap.confirmSavedAndStartHost(); bootstrap.complete()
        precondition(bootstrap.state(for: 2) == .pending)
        precondition(!SessionRunMode.bootstrapOnly.requiresHost)
        precondition(SessionRunMode.bootstrapOnly.hostArguments(address: "") == nil)
        precondition(SessionRunMode.bootstrapOnly.postRunAction == nil)
        precondition(!SessionRunMode.commandsOnly.requiresHost && !SessionRunMode.commandsOnly.requiresNetworkAddress)
        precondition(SessionRunMode.commandsOnly.hostArguments(address: address) == nil && SessionRunMode.commandsOnly.postRunAction == nil)
        precondition(!SessionRunMode.existingRPC.requiresNetworkAddress && !SessionRunMode.existingRPC.isHostOnly)
        precondition(SessionRunMode.existingRPC.hostArguments(address: address) == nil && SessionRunMode.existingRPC.postRunAction == nil)
        for mode in [SessionRunMode.hostOnly, .hostOnlyHeld] {
            precondition(mode.isHostOnly && mode.requiresHost && mode.requiresNetworkAddress)
            precondition(mode.hostArguments(address: address) == ["host", address] + (mode == .hostOnlyHeld ? ["--post-run-options"] : []))
            precondition(mode.postRunAction?.keepRPC == (mode == .hostOnlyHeld ? true : nil))
            precondition(mode.postRunAction?.dumpFirmware != true)
        }
        var commands = WorkflowProgress()
        commands.begin(fullInstall: false); commands.commandsOnlySent(); commands.complete()
        precondition(commands.state(for: 2) == .pending)

        for mode in [SessionRunMode.exploitOnly, .heldRPC, .systemCodeDump] {
            precondition(mode.requiresHost)
            var workflow = WorkflowProgress()
            workflow.begin(fullInstall: false)
            precondition(workflow.state(for: 1) == .complete && workflow.state(for: 2) == .active)
            var postRun = PostRunSessionState()
            if mode == .exploitOnly {
                precondition(mode.hostArguments(address: address) == ["host", address])
                precondition(mode.postRunAction == nil && !postRun.isActive)
            } else {
                precondition(mode.hostArguments(address: address) == ["host", address, "--post-run-options"])
                let action = mode.postRunAction!
                let control = try JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: action.control)) as! [String: Any]
                precondition(control["action"] as? String == "post-run")
                precondition(control["keepRPC"] as? Bool == (mode == .heldRPC))
                precondition(control["dumpFirmware"] as? Bool == (mode == .systemCodeDump))
                precondition(postRun.ready())
                precondition(postRun.choose(keepRPC: action.keepRPC, dumpFirmware: action.dumpFirmware))
                if mode == .heldRPC {
                    precondition(postRun.stage == .held && postRun.receive("rpc-held"))
                    precondition(postRun.checkStatus() && !postRun.canFinish)
                    precondition(postRun.receive("rpc-status") && postRun.canFinish)
                    precondition(postRun.finish())
                } else {
                    precondition(postRun.stage == .dumping && !postRun.canFinish)
                    precondition(postRun.receive("dump-started"))
                    precondition(postRun.receive("dump-complete") && postRun.dumpCompleted)
                    precondition(postRun.stage == .finishing && !postRun.keepRPC)
                }
                precondition(postRun.receive("rpc-finishing"))
                precondition(workflow.state(for: 2) == .active)
                precondition(postRun.receive("verified") && !postRun.isActive)
            }
            precondition(workflow.state(for: 2) == .active)
            workflow.complete()
            precondition(workflow.state(for: 2) == .complete)
        }

        // Returning from a saved bootstrap starts a fresh run milestone; it
        // cannot carry an old completion through a failed exploit attempt.
        bootstrap.begin(fullInstall: false)
        precondition(bootstrap.state(for: 2) == .active)
        bootstrap.fail()
        precondition(bootstrap.state(for: 2) == .failed)
        print("Four primary modes and developer command, host-only and existing-RPC modes passed with independent verification gates.")
    }
}
