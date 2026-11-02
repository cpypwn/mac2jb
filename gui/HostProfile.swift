import Foundation

enum HostProfile: String, CaseIterable, Identifiable, Codable {
    case pepsipu, kurumuz, cellenseres, izmysh
    case bermTheSequel = "BermTheSequel"

    var id: String { rawValue }
    var label: String {
        switch self {
        case .izmysh: return "IZMYSH"
        case .cellenseres: return "Cellenseres"
        default: return rawValue
        }
    }
    var supportsHeldRPC: Bool { self != .pepsipu && self != .izmysh }
    var supportsSaveKit: Bool { self == .kurumuz || self == .cellenseres }
    var supportsNativeHBLauncher: Bool { self == .kurumuz || self == .cellenseres }
    var supportsDemo: Bool { self != .pepsipu && self != .izmysh }
    var startArgumentCount: Int { self == .pepsipu || self == .izmysh ? 9 : 5 }
    var startPort: Int { self == .izmysh ? 39395 : 39380 }
    var saveName: String { self == .izmysh ? "NS2I" : "NS2" }
    static let preferenceKey = "developerHostProfile"
    static func saved(defaults: UserDefaults = .standard) -> Self {
        defaults.string(forKey: preferenceKey).flatMap(Self.init(rawValue:)) ?? .cellenseres
    }
}
