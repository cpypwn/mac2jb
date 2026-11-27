import Foundation

enum HostProfile: String, CaseIterable, Identifiable, Codable {
    case pepsipu, kurumuz
    case bermTheSequel = "BermTheSequel"

    static let availableHosts: [Self] = [.kurumuz, .pepsipu, .bermTheSequel]

    var id: String { rawValue }
    var label: String { rawValue }
    var supportsHeldRPC: Bool { self != .pepsipu }
    var supportsSaveKit: Bool { self == .kurumuz }
    var supportsNativeHBLauncher: Bool { self == .kurumuz }
    var supportsModloader: Bool { self == .kurumuz }
    var supportsDemo: Bool { self != .pepsipu }
    var startArgumentCount: Int { self == .pepsipu ? 9 : 5 }
    var startPort: Int { 39380 }
    var saveName: String { "NS2" }
    static let defaultHost: Self = .kurumuz
}
