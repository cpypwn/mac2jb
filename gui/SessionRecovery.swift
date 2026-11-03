import Foundation

enum SessionPhase: String {
    case preparing, ready, bootstrap, awaitingSave, savingBootstrap, hostStarting, commands
    case waitingForConsole, rpcAttaching, rpcHeld, rpcDetached, dumpingFirmware, installingSave, rpcFinishing
    case launchingHomebrew, homebrewRunning, homebrewStopped
    case keyboardConnecting, keyboardForwarding
    case verified, commandsSent, failed, cancelled
}

enum SessionRecovery {
    // Use the phase that stopped, before switching to failed/cancelled. The
    // mode picker describes the next run and cannot identify this failure.
    static func message(_ message: String, interruptedPhase: SessionPhase) -> String {
        let message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        switch interruptedPhase {
        case .bootstrap:
            guard message.range(of: "partial bootstrap", options: .caseInsensitive) == nil else { return message }
            return append("Clear any partial bootstrap before typing again.", to: message)
        case .savingBootstrap:
            guard message.range(of: "partial save command", options: .caseInsensitive) == nil else { return message }
            return append("Inspect Direct mode and clear any partial save command before trying again. Check whether NS2 was saved before resending the command.", to: message)
        case .keyboardConnecting, .keyboardForwarding:
            return append("Keyboard forwarding stopped. Reconnect the USB cable if a key repeats.", to: message)
        case .hostStarting, .commands, .commandsSent, .waitingForConsole:
            return addingRestart(to: message, liveSession: false)
        case .dumpingFirmware:
            let partialDump = #"(?i)\bpartial(?:\s+(?:system[- ]code|firmware))?\s+dump\b"#
            let recovery = message.range(of: partialDump, options: .regularExpression) == nil
                ? append("A partial system-code dump may remain; keep the logs and dump folder.", to: message)
                : message
            return addingRestart(to: recovery, liveSession: true)
        case .installingSave:
            return addingRestart(to: append("Keep the Seedsow save backup and check the install log before trying again.", to: message), liveSession: true)
        case .launchingHomebrew, .homebrewRunning:
            let recovery = message.range(of: "homebrew logs", options: .caseInsensitive) == nil
                ? append("Keep the homebrew logs; the app may have been interrupted.", to: message)
                : message
            return addingRestart(to: recovery, liveSession: true)
        case .rpcHeld, .rpcFinishing, .homebrewStopped:
            return addingRestart(to: message, liveSession: true)
        default:
            return message
        }
    }

    private static func addingRestart(to message: String, liveSession: Bool) -> String {
        let restart = #"(?i)\b(?:restart|reboot)\s+(?:(?:the|your)\s+)?(?:console|switch(?:\s+2)?)\b"#
        guard message.range(of: restart, options: .regularExpression) == nil else { return message }
        return append(liveSession
                      ? "Restart the console after the host has stopped, before another attempt."
                      : "Restart the console before another post-bootstrap attempt.", to: message)
    }

    private static func append(_ instruction: String, to message: String) -> String {
        message.isEmpty ? instruction : message + " " + instruction
    }
}
