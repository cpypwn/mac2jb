import Foundation

@main struct SmileBASICEditionTests {
    static func main() throws {
        let sender = URL(fileURLWithPath: CommandLine.arguments[1])
        precondition(SmileBASICEdition.allCases == [.full, .demo])
        precondition(SmileBASICEdition(rawValue: "demo") == .demo)
        for edition in SmileBASICEdition.allCases {
        let saveCommand = edition == .demo ? "PRGEDIT 0:C$=\"\":FOR I=0 TO PRGSIZE(0)-1:C$=C$+PRGGET$() :NEXT:SAVEV \"TXT:NS2\",C$" : "SAVE \"NS2\""
        precondition(edition.saveCommands == [saveCommand])
        if edition == .demo {
            precondition(edition.saveCommands[0].contains("PRGGET$() :NEXT:"), "PRGGET$ must be a closed zero-argument function call")
        }
        precondition(edition.saveInstructions.contains("Press X"))
        precondition(edition.loadCommand.contains(edition == .demo ? "LOADV" : "LOAD"))
        precondition(edition.commandArguments == (edition == .demo ? ["--demo"] : []))
        precondition(edition.requiresLoadConfirmation)
        let task = Process(), output = Pipe()
        task.executableURL = sender
        task.arguments = ["--dry-run"] + edition.commandArguments
        task.standardOutput = output; task.standardError = output
        task.standardInput = FileHandle.nullDevice
        try task.run()
        let result = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        task.waitUntilExit()
        precondition(task.terminationStatus == 0, result)
        precondition(result.contains("1: \(edition.loadCommand) [Enter]"), result)
        precondition(result.contains("2: RUN [Enter]"), result)
        precondition(result.contains("3: REMOVE NSR,&H60000000,&H3FFFFFFF [Enter]"), result)
        precondition(result.contains("4: V=START("), result)
        let confirmation = edition == .demo ? "LOADV receives one additional Enter to accept its OK confirmation before RUN." : "LOAD receives one additional Enter to accept its YES confirmation before RUN."
        precondition(result.contains(confirmation), result)
        precondition(result.contains("LOADV") == (edition == .demo), result)
        }
        print("SmileBASIC full and demo SAVE/LOAD confirmation checks passed. No USB input sent.")
    }
}
