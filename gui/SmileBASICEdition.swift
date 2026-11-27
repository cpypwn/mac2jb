import Foundation

// Demo SAVE collects every program line before writing TXT:NS2.
enum SmileBASICEdition: String, CaseIterable {
    case full, demo
    var saveCommands: [String] {
        saveCommands(for: "NS2")
    }
    var loadCommand: String {
        loadCommand(for: "NS2")
    }
    func saveCommands(for name: String) -> [String] {
        self == .demo ? ["PRGEDIT 0:C$=\"\":FOR I=0 TO PRGSIZE(0)-1:C$=C$+PRGGET$() :NEXT:SAVEV \"TXT:\(name)\",C$"] : ["SAVE \"\(name)\""]
    }
    func loadCommand(for name: String) -> String {
        self == .demo ? "PRGEDIT 0:LOADV \"TXT:\(name)\" OUT C$:PRGSET C$" : "LOAD \"TXT:\(name)\""
    }
    var commandArguments: [String] { self == .demo ? ["--demo"] : [] }
    var requiresLoadConfirmation: Bool { true }
    var saveInstructions: String {
        "The bootstrap has finished typing. Press X on the Switch controller to return to Direct mode. Confirm that the command prompt is empty, then choose Type save command. Overwrite the existing NS2 file if prompted."
    }
    var savedConfirmation: String { "NS2 is saved in slot 0 and I have entered Direct mode" }
    func saveInstructions(for name: String) -> String {
        saveInstructions.replacingOccurrences(of: "NS2", with: name)
    }
    func savedConfirmation(for name: String) -> String {
        savedConfirmation.replacingOccurrences(of: "NS2", with: name)
    }
}
