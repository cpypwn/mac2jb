import Combine
import Foundation

struct SaveReleaseInfo: Decodable {
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

    func page(for repository: String) -> URL? {
        guard !tag_name.isEmpty, tag_name.count <= 64,
              tag_name.unicodeScalars.allSatisfy({
                  CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
                      .contains($0)
              }),
              let repo = URLComponents(string: repository),
              repo.scheme == "https", repo.host == "github.com", repo.port == nil,
              repo.user == nil, repo.password == nil, repo.query == nil, repo.fragment == nil,
              repo.path.split(separator: "/").count == 2,
              let parts = URLComponents(string: html_url),
              parts.scheme == "https", parts.host == "github.com",
              parts.port == nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path == repo.path + "/releases/tag/\(tag_name)" else { return nil }
        return parts.url
    }
}

struct SaveReleaseSource {
    let name: String
    let repository: String
    let pinnedTag: String
    let expectedDigests: [String: String]

    var apiURL: URL? {
        guard let repo = URLComponents(string: repository),
              repo.scheme == "https", repo.host == "github.com",
              repo.path.split(separator: "/").count == 2 else { return nil }
        return URL(string: "https://api.github.com/repos\(repo.path)/releases/latest")
    }
}

@MainActor final class SaveGameUpdateChecker: ObservableObject {
    struct ReleasePage: Identifiable {
        let name: String
        let url: URL
        var id: String { name }
    }

    @Published private(set) var isChecking = false
    @Published private(set) var message = ""
    @Published private(set) var releasePages: [ReleasePage] = []

    private struct ArchiveAsset: Decodable {
        let url: String
        let sha256: String
    }
    private struct ArtemisManifest: Decodable {
        let repository: String
        let release: String
        let assets: [String: ArchiveAsset]
    }
    private struct EditorProManifest: Decodable {
        let repository: String
        let release: String
        let url: String
        let sha256: String
    }
    private struct LegacyEditorManifest: Decodable {
        struct Editor: Decodable {
            let repository: String
            let release: String
            let asset: String
            let sha256: String
        }
        let editor: Editor
    }
    private struct BalatroManifest: Decodable {
        struct Variants: Decodable {
            struct Variant: Decodable { let sha256: String }
            let upstream: Variant
        }
        let source: String
        let variants: Variants
    }
    private struct GravityManifest: Decodable {
        let repository: String
        let release: String
        let archive: ArchiveAsset
    }

    private static func decode<T: Decodable>(_ type: T.Type, at path: String, root: URL) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: root.appendingPathComponent(path)))
    }

    private static func validTag(_ tag: String) -> Bool {
        tag.range(of: "^[A-Za-z0-9._-]{1,64}$", options: .regularExpression) != nil
    }

    private static func digest(_ hash: String) -> Bool {
        hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private static func asset(_ record: ArchiveAsset) throws -> (String, String) {
        guard let url = URLComponents(string: record.url), url.scheme == "https",
              url.host == "github.com", url.query == nil, url.fragment == nil,
              let name = url.path.split(separator: "/").last.map(String.init),
              !name.isEmpty, digest(record.sha256) else { throw URLError(.badURL) }
        return (name, record.sha256)
    }

    static func loadSources(runtimeRoot: URL) throws -> [SaveReleaseSource] {
        let artemis = try decode(ArtemisManifest.self, at: "packaging/ArtemisLauncher-v2.json", root: runtimeRoot)
        let pro = try decode(EditorProManifest.self, at: "packaging/SeedsowEditorPro-v0.4.0.json", root: runtimeRoot)
        let legacy = try decode(LegacyEditorManifest.self, at: "vendor/ns2-savekit/provenance.json", root: runtimeRoot)
        let balatro = try decode(BalatroManifest.self, at: "integrations/balatro-rce/provenance.json", root: runtimeRoot)
        let gravity = try decode(GravityManifest.self, at: "packaging/GravCirc-v1.1.json", root: runtimeRoot)
        guard artemis.repository == "https://github.com/alula/switch-artemis-launcher",
              artemis.assets.count == 3,
              Set(artemis.assets.keys) == Set(["seedsow", "nora", "hamidashi"]),
              pro.repository == "https://github.com/purple442/seedsow-lua-editor-pro",
              legacy.editor.repository == "https://github.com/DialingSpoon527/seedsow-lua-editor",
              balatro.source.hasPrefix("https://github.com/Luminger/balatro-switch-rce/releases/tag/"),
              gravity.repository == "https://github.com/figurophobia/GravCirc-Switch-rce",
              validTag(artemis.release), validTag(pro.release),
              validTag(legacy.editor.release), validTag(gravity.release),
              digest(legacy.editor.sha256), digest(pro.sha256),
              digest(balatro.variants.upstream.sha256) else { throw URLError(.badURL) }
        let balatroTag = String(balatro.source.split(separator: "/").last ?? "")
        guard validTag(balatroTag),
              balatro.source == "https://github.com/Luminger/balatro-switch-rce/releases/tag/\(balatroTag)",
              !legacy.editor.asset.isEmpty,
              legacy.editor.asset == URL(fileURLWithPath: legacy.editor.asset).lastPathComponent else {
            throw URLError(.badURL)
        }
        var artemisDigests: [String: String] = [:]
        for record in artemis.assets.values {
            let (name, hash) = try asset(record)
            guard artemisDigests[name] == nil else { throw URLError(.badURL) }
            artemisDigests[name] = hash
        }
        let (proName, proHash) = try asset(ArchiveAsset(url: pro.url, sha256: pro.sha256))
        let (gravityName, gravityHash) = try asset(gravity.archive)
        return [
            SaveReleaseSource(name: "Artemis launcher", repository: artemis.repository,
                              pinnedTag: artemis.release, expectedDigests: artemisDigests),
            SaveReleaseSource(name: "Seedsow Lua Editor Pro", repository: pro.repository,
                              pinnedTag: pro.release, expectedDigests: [proName: proHash]),
            SaveReleaseSource(name: "Seedsow Lua Editor", repository: legacy.editor.repository,
                              pinnedTag: legacy.editor.release,
                              expectedDigests: [legacy.editor.asset: legacy.editor.sha256]),
            SaveReleaseSource(name: "Balatro RCE", repository: "https://github.com/Luminger/balatro-switch-rce",
                              pinnedTag: balatroTag, expectedDigests: [:]),
            SaveReleaseSource(name: "Gravity Circuit", repository: gravity.repository,
                              pinnedTag: gravity.release, expectedDigests: [gravityName: gravityHash])
        ]
    }

    private static func check(_ source: SaveReleaseSource) async -> (String, ReleasePage?) {
        guard let url = source.apiURL else { return ("\(source.name): invalid release address", nil) }
        do {
            var request = URLRequest(url: url)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("mac2jb", forHTTPHeaderField: "User-Agent")
            request.timeoutInterval = 15
            let (bytes, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.url?.host == "api.github.com", bytes.count <= 256 * 1024,
                  let release = try? JSONDecoder().decode(SaveReleaseInfo.self, from: bytes),
                  let page = release.page(for: source.repository) else {
                throw URLError(.badServerResponse)
            }
            let link = ReleasePage(name: source.name, url: page)
            if release.tag_name != source.pinnedTag {
                return ("\(source.name): latest \(release.tag_name); bundled \(source.pinnedTag)", link)
            }
            if source.expectedDigests.isEmpty {
                return ("\(source.name): \(source.pinnedTag) is the latest release (tag only)", link)
            }
            switch release.assetStatus(expected: source.expectedDigests) {
            case .matches:
                return ("\(source.name): \(source.pinnedTag) and bundled archives match upstream", link)
            case .changed:
                return ("\(source.name): upstream \(source.pinnedTag) archives changed or are missing", link)
            case .unavailable:
                return ("\(source.name): \(source.pinnedTag) is the latest release; asset digests unavailable", link)
            }
        } catch {
            return ("\(source.name): could not check upstream", nil)
        }
    }

    func check(runtimeRoot: URL?) {
        guard !isChecking else { return }
        releasePages = []
        guard let runtimeRoot,
              let sources = try? Self.loadSources(runtimeRoot: runtimeRoot) else {
            message = "The bundled save versions are unavailable in this app."
            return
        }
        isChecking = true
        message = "Checking save game releases…"
        Task {
            let tasks = sources.map { source in Task { await Self.check(source) } }
            var results: [String] = []
            var pages: [ReleasePage] = []
            for task in tasks {
                let (status, page) = await task.value
                results.append(status)
                if let page { pages.append(page) }
            }
            message = results.joined(separator: "\n")
            releasePages = pages
            isChecking = false
        }
    }
}
