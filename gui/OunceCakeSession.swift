import Foundation

struct OunceCakeGame: Decodable, Equatable, Identifiable {
    let titleId: String
    let name: String
    let storages: [Int]
    var id: String { titleId }
    var storageDescription: String {
        storages.map { [2: "Game card", 4: "Internal storage", 5: "SD card"][$0] ?? "Unknown storage" }
            .joined(separator: ", ")
    }
}

struct OunceCakeEndpoint: Equatable {
    let host: String
    let port: Int
    var address: String { "http://\(host):\(port)/" }
}

// only the current verified host can supply a catalog and confirm its endpoint.
// capture the console address before opening the tool.
struct OunceCakeSession: Equatable {
    enum Stage { case idle, discovering, choosing, preparing, serving, stopped, failed, cleanupBlocked }
    private(set) var stage: Stage = .idle
    private(set) var consoleAddress = ""
    private(set) var games: [OunceCakeGame] = []
    private(set) var selectedTitleId: String?
    private(set) var endpoint: OunceCakeEndpoint?
    var hasStarted: Bool { stage != .idle }
    var selectedGame: OunceCakeGame? { games.first { $0.titleId == selectedTitleId } }

    static func validConsoleAddress(_ text: String) -> String? {
        let address = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = address.split(separator: ".", omittingEmptySubsequences: false)
        guard words.count == 4, words.allSatisfy({ word in
            !word.isEmpty && word.utf8.count <= 3 && word.utf8.allSatisfy { (48...57).contains($0) } &&
            Int(word).map { (0...255).contains($0) && String($0) == word } == true
        }) else { return nil }
        return address
    }

    @discardableResult mutating func begin(consoleAddress: String) -> Bool {
        guard stage == .idle, let address = Self.validConsoleAddress(consoleAddress) else { return false }
        self.consoleAddress = address
        stage = .discovering
        return true
    }

    @discardableResult mutating func receiveCatalog(_ incoming: [OunceCakeGame]) -> Bool {
        guard stage == .discovering, !incoming.isEmpty, incoming.count <= 1000 else { return false }
        var validated: [OunceCakeGame] = [], identifiers = Set<String>()
        for game in incoming {
            guard game.titleId.range(of: "^[0-9a-fA-F]{16}$", options: .regularExpression) != nil,
                  identifiers.insert(game.titleId.lowercased()).inserted,
                  !game.storages.isEmpty, game.storages.count <= 3,
                  Set(game.storages).count == game.storages.count,
                  game.storages.allSatisfy({ [2, 4, 5].contains($0) }), game.name.utf8.count <= 160 else { return false }
            let name = game.name.replacingOccurrences(of: "[\\x00-\\x1f\\x7f-\\x9f\\u2028-\\u202e\\u2066-\\u2069]",
                                                      with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            validated.append(OunceCakeGame(titleId: game.titleId.lowercased(), name: name.isEmpty ? "Unknown game" : name,
                                           storages: game.storages.sorted()))
        }
        games = validated
        stage = .choosing
        return true
    }

    @discardableResult mutating func select(titleId: String) -> Bool {
        guard stage == .choosing, games.contains(where: { $0.titleId == titleId }) else { return false }
        selectedTitleId = titleId
        stage = .preparing
        return true
    }

    @discardableResult mutating func receiveEndpoint(host: String?, port: Int?, httpURL: String?) -> Bool {
        guard stage == .preparing, let host, host == consoleAddress, port == 2121 else { return false }
        let endpoint = OunceCakeEndpoint(host: host, port: 2121)
        guard httpURL == endpoint.address else { return false }
        self.endpoint = endpoint
        stage = .serving
        return true
    }

    mutating func stop(failed: Bool = false, cleanupBlocked: Bool = false) {
        endpoint = nil
        if stage == .cleanupBlocked || cleanupBlocked { stage = .cleanupBlocked }
        else { stage = failed ? .failed : .stopped }
    }
}
