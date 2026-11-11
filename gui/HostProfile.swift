import Foundation

enum HostProfile: String, CaseIterable, Identifiable, Codable {
    case pepsipu, kurumuz, cellenseres, astral
    case bermTheSequel = "BermTheSequel"

    var id: String { rawValue }
    var label: String {
        switch self {
        case .astral: return "Astral (custom)"
        case .cellenseres: return "Cellenseres"
        default: return rawValue
        }
    }
    var supportsHeldRPC: Bool { self != .pepsipu }
    var supportsSaveKit: Bool { self == .kurumuz || self == .cellenseres || self == .astral }
    var supportsNativeHBLauncher: Bool { self == .kurumuz || self == .cellenseres || self == .astral }
    var supportsModloader: Bool { self == .kurumuz || self == .cellenseres }
    var supportsDemo: Bool { self != .pepsipu }
    var startArgumentCount: Int { self == .pepsipu ? 9 : 5 }
    var startPort: Int { 39380 }
    var saveName: String { "NS2" }
    static let defaultHost: Self = .kurumuz
}
