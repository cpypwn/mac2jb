import Foundation

enum PostBootstrapCommand: String, CaseIterable, Identifiable {
    case load, run, remove, start
    var id: String { rawValue }
    var label: String { rawValue.uppercased() }
    var title: String { self == .start ? "V=START" : label }
}

struct PostBootstrapCommandSelection: Equatable {
    let commands: [PostBootstrapCommand]
    let startCommand: String?
    let startPrefix: Bool
    static let standard = PostBootstrapCommandSelection(commands: [.load, .run, .remove])!

    init?(commands: [PostBootstrapCommand], startCommand: String? = nil, startPrefix: Bool = false,
          host: HostProfile = .kurumuz) {
        guard !commands.isEmpty, Set(commands).count == commands.count,
              commands == PostBootstrapCommand.allCases.filter({ commands.contains($0) }) else { return nil }
        self.commands = commands
        self.startPrefix = startPrefix
        guard !startPrefix || commands.contains(.start) else { return nil }
        if commands.contains(.start) {
            if startPrefix {
                guard startCommand?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false else { return nil }
                self.startCommand = nil
            } else {
                guard let manual = startCommand?.trimmingCharacters(in: .whitespacesAndNewlines),
                      Self.validStartCommand(manual, host: host) else { return nil }
                self.startCommand = manual
            }
        } else {
            self.startCommand = nil
        }
    }

    var arguments: [String] {
        ["--commands", commands.map(\.rawValue).joined(separator: ",")] +
        (startPrefix ? ["--start-prefix"] : startCommand.map { ["--start-command", $0] } ?? [])
    }

    static func validStartCommand(_ command: String, host: HostProfile = .kurumuz) -> Bool {
        guard command.hasPrefix("V=START("), command.hasSuffix(")") else { return false }
        let fields = command.dropFirst(8).dropLast().split(separator: ",", omittingEmptySubsequences: false)
        guard fields.count == host.startArgumentCount, fields[0] == String(host.startPort) else { return false }
        return fields.dropFirst().enumerated().allSatisfy { index, field in
            let maximum = index < 4 ? 255 : 281474976710655
            guard !field.isEmpty, field.count <= 15, field.utf8.allSatisfy({ (48...57).contains($0) }),
                  let value = Int(field), (0...maximum).contains(value) else { return false }
            return String(value) == field
        }
    }
}
