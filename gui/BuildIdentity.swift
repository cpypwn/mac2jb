import Foundation

enum AppBuildIdentity {
    static var isTestBuild: Bool {
        Bundle.main.object(forInfoDictionaryKey: "MAC2JBTestBuild") as? Bool ?? false
    }

    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.6.0"
    }

    static var versionLabel: String {
        isTestBuild ? "v\(version) · test build" : "v\(version)"
    }

    static var diagnosticLabel: String {
        isTestBuild ? "mac2jb \(version) test build" : "mac2jb \(version)"
    }

    static let updatesDisabledMessage = "Updates are disabled for this local test build."
}
