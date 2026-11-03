import Combine
import Foundation

struct ArtemisReleaseInfo: Decodable {
    struct Asset: Decodable {
        let name: String
        let digest: String?
    }

    enum AssetStatus: Equatable {
        case matches, changed, unavailable
    }

    let tag_name: String
    let html_url: String
    let assets: [Asset]?

    func assetStatus(expected: [String: String]) -> AssetStatus {
        guard let assets else { return .unavailable }
        var missingDigests = false
        for (name, hash) in expected {
            let found = assets.filter { $0.name == name }
            guard found.count == 1 else { return .changed }
            guard let digest = found[0].digest else { missingDigests = true; continue }
            if digest.lowercased() != "sha256:\(hash.lowercased())" { return .changed }
        }
        return missingDigests ? .unavailable : .matches
    }

    var page: URL? {
        guard !tag_name.isEmpty, tag_name.count <= 64,
              tag_name.unicodeScalars.allSatisfy({
                  CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
                      .contains($0)
              }),
              let parts = URLComponents(string: html_url),
              parts.scheme == "https", parts.host == "github.com",
              parts.port == nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path == "/alula/switch-artemis-launcher/releases/tag/\(tag_name)" else { return nil }
        return parts.url
    }
}

@MainActor final class ArtemisUpdateChecker: ObservableObject {
    @Published private(set) var isChecking = false
    @Published private(set) var message = ""
    @Published private(set) var releasePage: URL?

    private struct Manifest: Decodable {
        struct Asset: Decodable {
            let url: String
            let sha256: String
        }
        struct Assets: Decodable {
            let seedsow: Asset
            let nora: Asset
        }
        let repository: String
        let release: String
        let assets: Assets

        var expectedDigests: [String: String]? {
            let records = [assets.seedsow, assets.nora]
            var result: [String: String] = [:]
            for record in records {
                guard let name = URL(string: record.url)?.lastPathComponent,
                      !name.isEmpty, result[name] == nil,
                      record.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
                    return nil
                }
                result[name] = record.sha256
            }
            return result
        }
    }

    func check(runtimeRoot: URL?) {
        guard !isChecking else { return }
        releasePage = nil
        guard let runtimeRoot,
              let data = try? Data(contentsOf: runtimeRoot.appendingPathComponent("packaging/ArtemisLauncher-v1.json")),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data),
              manifest.repository == "https://github.com/alula/switch-artemis-launcher",
              manifest.release.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil,
              let expectedDigests = manifest.expectedDigests else {
            message = "The pinned launcher version is unavailable in this app."
            return
        }
        isChecking = true
        message = "Checking upstream releases…"
        releasePage = nil
        Task {
            defer { isChecking = false }
            do {
                let url = URL(string: "https://api.github.com/repos/alula/switch-artemis-launcher/releases/latest")!
                var request = URLRequest(url: url)
                request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
                request.setValue("mac2jb", forHTTPHeaderField: "User-Agent")
                request.timeoutInterval = 15
                let (bytes, response) = try await URLSession.shared.data(for: request)
                guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                      http.url?.host == "api.github.com", bytes.count <= 256 * 1024,
                      let release = try? JSONDecoder().decode(ArtemisReleaseInfo.self, from: bytes),
                      let page = release.page else { throw URLError(.badServerResponse) }
                releasePage = page
                if release.tag_name != manifest.release {
                    message = "Upstream lists \(release.tag_name). Installs remain pinned to verified \(manifest.release)."
                } else {
                    switch release.assetStatus(expected: expectedDigests) {
                    case .matches:
                        message = "Pinned \(manifest.release) and both save archives match upstream."
                    case .changed:
                        message = "Upstream \(manifest.release) save archives changed or are missing. Installs still require the pinned hashes."
                    case .unavailable:
                        message = "Pinned \(manifest.release) is the latest tag; upstream asset digests are unavailable. This check is tag-only."
                    }
                }
            } catch {
                message = "Could not check upstream releases."
            }
        }
    }
}
