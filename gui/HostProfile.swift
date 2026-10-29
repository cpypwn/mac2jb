import Foundation

enum HostProfile: String, CaseIterable, Identifiable, Codable {
    case pepsipu, kurumuz, izmysh
    case bermTheSequel = "BermTheSequel"

    var id: String { rawValue }
    var label: String { self == .izmysh ? "IZMYSH" : rawValue }
    var supportsHeldRPC: Bool { self != .pepsipu && self != .izmysh }
    var supportsDemo: Bool { self != .pepsipu && self != .izmysh }
    var startArgumentCount: Int { self == .pepsipu || self == .izmysh ? 9 : 5 }
    var startPort: Int { self == .izmysh ? 39395 : 39380 }
    var saveName: String { self == .izmysh ? "NS2I" : "NS2" }
    static let preferenceKey = "developerHostProfile"
    static func saved(defaults: UserDefaults = .standard) -> Self {
        defaults.string(forKey: preferenceKey).flatMap(Self.init(rawValue:)) ?? .kurumuz
    }
}
