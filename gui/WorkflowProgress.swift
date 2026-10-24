import Foundation

enum WorkflowStepState: String, Equatable {
    case pending, active, complete, failed
}

// Sidebar progress records workflow milestones, not just the most recent UI
// phase. In particular, a sent bootstrap is not complete until the user has
// confirmed saving it, and cleanup callbacks cannot erase a failure marker.
struct WorkflowProgress: Equatable {
    private enum Stage: Int { case prepare, bootstrap, run }

    private var states: [WorkflowStepState] = [.active, .pending, .pending]
    private var activeStage: Stage = .prepare
    private var awaitingSave = false
    private var terminal = false
    private(set) var selectedFullInstall = true

    func state(for index: Int) -> WorkflowStepState {
        guard states.indices.contains(index) else { return .pending }
        return states[index]
    }

    // A mode picker changes the next run, while the previous run's failure
    // remains visible until the user explicitly starts again.
    mutating func selectMode(fullInstall: Bool) {
        selectedFullInstall = fullInstall
    }

    mutating func begin(fullInstall: Bool) {
        selectedFullInstall = fullInstall
        terminal = false
        awaitingSave = false
        activeStage = fullInstall ? .bootstrap : .run
        states = fullInstall ? [.complete, .active, .pending] : [.complete, .complete, .active]
    }

    mutating func bootstrapTransferred() {
        guard !terminal, activeStage == .bootstrap else { return }
        awaitingSave = true
        // Step 2 remains active through the save/Direct-mode checkpoint.
    }

    mutating func confirmSavedAndStartHost() {
        guard !terminal, activeStage == .bootstrap, awaitingSave else { return }
        awaitingSave = false
        activeStage = .run
        states = [.complete, .complete, .active]
    }

    mutating func complete() {
        guard !terminal, activeStage == .run else { return }
        terminal = true
        states = [.complete, .complete, .complete]
    }

    mutating func fail() { stop() }
    mutating func cancel() { stop() }

    private mutating func stop() {
        guard !terminal else { return }
        terminal = true
        awaitingSave = false
        // Returning to preparation makes the first step unchecked and active.
        // Preserve only milestones actually completed before this failure.
        states = [.active, activeStage == .run ? .complete : .pending, .pending]
        states[activeStage.rawValue] = .failed
    }
}
