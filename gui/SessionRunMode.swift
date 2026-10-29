import Foundation

struct SessionPostRunAction: Equatable {
    let keepRPC: Bool
    let dumpFirmware: Bool
    var control: [String: Any] {
        ["action": "post-run", "keepRPC": keepRPC, "dumpFirmware": dumpFirmware]
    }
}

enum SessionRunMode: String, CaseIterable, Identifiable {
    case bootstrapOnly, heldRPC, systemCodeDump, exploitOnly, commandsOnly, hostOnly, hostOnlyHeld, existingRPC
    var id: String { rawValue }
    var number: Int { Self.allCases.firstIndex(of: self)! + 1 }
    var requiresHost: Bool { self != .bootstrapOnly && self != .commandsOnly }
    var requiresNetworkAddress: Bool { self != .bootstrapOnly && self != .commandsOnly && self != .existingRPC }
    var isHostOnly: Bool { self == .hostOnly || self == .hostOnlyHeld }
    var title: String {
        switch self {
        case .bootstrapOnly: return "Type bootstrap only"
        case .exploitOnly: return "NS2JB exploit only"
        case .heldRPC: return "Held RPC"
        case .systemCodeDump: return "System-code dump"
        case .commandsOnly: return "Post-bootstrap commands only"
        case .hostOnly: return "Host only"
        case .hostOnlyHeld: return "Host only · hold RPC"
        case .existingRPC: return "RPC already held"
        }
    }
    var caption: String {
        switch self {
        case .bootstrapOnly: return "Type bootstrap.bas into the editor, then save it as NS2."
        case .exploitOnly: return "Run the exploit and finish after verification."
        case .heldRPC: return "Run the exploit, hold RPC and launch MintBrew automatically."
        case .systemCodeDump: return "Run the exploit, save system code, then finish."
        case .commandsOnly: return "Type selected commands without starting a host."
        case .hostOnly: return "Start the host and enter the console commands yourself."
        case .hostOnlyHeld: return "Start the host, enter commands yourself, and hold the verified connection."
        case .existingRPC: return "Connect to an existing RPC session on this Mac and send homebrew."
        }
    }
    var icon: String {
        switch self {
        case .bootstrapOnly: return "keyboard"
        case .exploitOnly: return "bolt"
        case .heldRPC: return "cable.connector"
        case .systemCodeDump: return "externaldrive"
        case .commandsOnly: return "terminal"
        case .hostOnly, .hostOnlyHeld, .existingRPC: return "network"
        }
    }
    var startTitle: String {
        switch self {
        case .bootstrapOnly: return "Type bootstrap"
        case .exploitOnly: return "Start exploit"
        case .heldRPC: return "Start held RPC"
        case .systemCodeDump: return "Start system-code dump"
        case .commandsOnly: return "Type commands only"
        case .hostOnly, .hostOnlyHeld: return "Run host only"
        case .existingRPC: return "Connect to RPC"
        }
    }
    var postRunAction: SessionPostRunAction? {
        switch self {
        case .bootstrapOnly, .exploitOnly, .commandsOnly, .hostOnly, .existingRPC: return nil
        case .heldRPC, .hostOnlyHeld: return SessionPostRunAction(keepRPC: true, dumpFirmware: false)
        case .systemCodeDump: return SessionPostRunAction(keepRPC: false, dumpFirmware: true)
        }
    }
    func hostArguments(address: String) -> [String]? {
        guard requiresHost, self != .existingRPC else { return nil }
        return ["host", address] + (postRunAction == nil ? [] : ["--post-run-options"])
    }
}
