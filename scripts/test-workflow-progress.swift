import Foundation

private struct Failure: Error, CustomStringConvertible {
    let description: String
}

private func expect(_ progress: WorkflowProgress, _ expected: [WorkflowStepState], _ context: String) throws {
    let actual = (0..<3).map { progress.state(for: $0) }
    guard actual == expected else {
        throw Failure(description: "\(context): expected \(expected.map(\.rawValue)), got \(actual.map(\.rawValue))")
    }
}

@main private struct WorkflowProgressTests {
    static func main() {
        let tests: [(String, () throws -> Void)] = [
            ("ready and mode selection keep preparation active", {
                var progress = WorkflowProgress()
                try expect(progress, [.active, .pending, .pending], "initial")
                progress.selectMode(fullInstall: false)
                try expect(progress, [.active, .pending, .pending], "NS2-only selected, not started")
                progress.selectMode(fullInstall: true)
                try expect(progress, [.active, .pending, .pending], "full setup selected, not started")
            }),
            ("full bootstrap failure records step 2", {
                var progress = WorkflowProgress()
                progress.begin(fullInstall: true)
                try expect(progress, [.complete, .active, .pending], "bootstrap running")
                progress.fail()
                try expect(progress, [.active, .failed, .pending], "bootstrap failed")
            }),
            ("full bootstrap cancellation records step 2", {
                var progress = WorkflowProgress()
                progress.begin(fullInstall: true)
                progress.cancel()
                try expect(progress, [.active, .failed, .pending], "bootstrap cancelled")
            }),
            ("bootstrap delivery alone does not complete the save milestone", {
                var progress = WorkflowProgress()
                progress.begin(fullInstall: true)
                progress.bootstrapTransferred()
                try expect(progress, [.complete, .active, .pending], "awaiting save")
                progress.fail()
                try expect(progress, [.active, .failed, .pending], "failed while awaiting save")
            }),
            ("cancelling the save checkpoint still fails step 2", {
                var progress = WorkflowProgress()
                progress.begin(fullInstall: true)
                progress.bootstrapTransferred()
                progress.cancel()
                try expect(progress, [.active, .failed, .pending], "cancelled while awaiting save")
            }),
            ("saved bootstrap confirmation starts step 3 and survives failure", {
                var progress = WorkflowProgress()
                progress.begin(fullInstall: true)
                progress.bootstrapTransferred()
                progress.confirmSavedAndStartHost()
                try expect(progress, [.complete, .complete, .active], "host starting")
                progress.fail()
                try expect(progress, [.active, .complete, .failed], "host or commands failed")
            }),
            ("NS2-only run checks the skipped prerequisite steps", {
                var progress = WorkflowProgress()
                progress.selectMode(fullInstall: false)
                progress.begin(fullInstall: progress.selectedFullInstall)
                try expect(progress, [.complete, .complete, .active], "NS2-only running")
                progress.cancel()
                try expect(progress, [.active, .complete, .failed], "NS2-only cancelled")
            }),
            ("NS2-only failure retains the saved-bootstrap check", {
                var progress = WorkflowProgress()
                progress.begin(fullInstall: false)
                progress.fail()
                try expect(progress, [.active, .complete, .failed], "NS2-only failed")
            }),
            ("terminal worker cleanup cannot erase or move the failed marker", {
                var progress = WorkflowProgress()
                progress.begin(fullInstall: true)
                progress.fail()
                let failed = progress
                progress.cancel(); progress.fail(); progress.bootstrapTransferred()
                progress.confirmSavedAndStartHost(); progress.complete()
                guard progress == failed else { throw Failure(description: "late cleanup changed a terminal failure") }
                progress.begin(fullInstall: false)
                progress.cancel()
                let stopped = progress
                progress.fail(); progress.cancel(); progress.bootstrapTransferred(); progress.complete()
                guard progress == stopped else { throw Failure(description: "late cleanup changed a terminal cancellation") }
            }),
            ("mode changes retain failed history until a new run", {
                var progress = WorkflowProgress()
                progress.begin(fullInstall: true); progress.fail()
                progress.selectMode(fullInstall: false)
                try expect(progress, [.active, .failed, .pending], "mode changed after failure")
                progress.begin(fullInstall: progress.selectedFullInstall)
                try expect(progress, [.complete, .complete, .active], "new NS2-only run")
                progress.fail(); progress.selectMode(fullInstall: true)
                try expect(progress, [.active, .complete, .failed], "full mode selected after step 3 failed")
                progress.begin(fullInstall: progress.selectedFullInstall)
                try expect(progress, [.complete, .active, .pending], "new full run clears old failure and completion")
            }),
            ("only valid milestone sequences complete the workflow", {
                var progress = WorkflowProgress()
                progress.bootstrapTransferred(); progress.confirmSavedAndStartHost(); progress.complete()
                try expect(progress, [.active, .pending, .pending], "callbacks before begin")
                progress.begin(fullInstall: true)
                progress.confirmSavedAndStartHost(); progress.complete()
                try expect(progress, [.complete, .active, .pending], "confirmation before bootstrap delivery ignored")
                progress.bootstrapTransferred(); progress.confirmSavedAndStartHost()
                progress.bootstrapTransferred()
                try expect(progress, [.complete, .complete, .active], "late bootstrap callback cannot regress host stage")
                progress.complete()
                try expect(progress, [.complete, .complete, .complete], "full flow verified")
                progress.cancel(); progress.fail()
                try expect(progress, [.complete, .complete, .complete], "cleanup after verification")
                progress.begin(fullInstall: false); progress.complete()
                try expect(progress, [.complete, .complete, .complete], "NS2-only verified")
            }),
            ("preparation failure and cancellation are step 1 failures until retry", {
                var progress = WorkflowProgress()
                progress.cancel()
                try expect(progress, [.failed, .pending, .pending], "cancelled during preparation")
                progress.fail(); progress.confirmSavedAndStartHost()
                try expect(progress, [.failed, .pending, .pending], "late preparation callbacks")
                progress.begin(fullInstall: true)
                try expect(progress, [.complete, .active, .pending], "retry after preparation")
            })
        ]
        var failures = 0
        for (name, run) in tests {
            do { try run(); print("PASS \(name)") }
            catch { failures += 1; print("FAIL \(name): \(error)") }
        }
        print("\(tests.count - failures)/\(tests.count) workflow progress tests passed")
        if failures != 0 { exit(1) }
    }
}
