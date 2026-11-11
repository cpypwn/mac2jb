import Combine
import Foundation

struct BundledUpdateResult: Identifiable {
    enum Status: String {
        case current
        case changed
        case unknown
    }

    let id: String
    let name: String
    let pinned: String
    let latest: String
    let status: Status
    let statusText: String
    let sourceURL: URL?
}

struct BundledUpdateSource {
    enum PinKind { case release, commit }

    let id: String
    let name: String
    let repository: URL?
    let pinned: String
    let kind: PinKind
    let note: String

    var sourceURL: URL? {
        guard let repository, repository.scheme == "https",
              ["github.com", "gitlab.com"].contains(repository.host ?? ""),
              repository.port == nil, repository.user == nil, repository.password == nil,
              repository.path.split(separator: "/").count == 2 else { return nil }
        return repository
    }
}

enum BundledUpdateService {
    typealias Fetch = (URL) async throws -> Data

    private struct Spec {
        let id: String
        let name: String
        let repository: String
        let file: String
        let keys: [String]
        let kind: BundledUpdateSource.PinKind
        var versionNeedsV = false
        var note = ""
    }

    private static let specs: [Spec] = [
        .init(id: "civswitch", name: "CivSwitch", repository: "https://github.com/Gezine/CivSwitch", file: "integrations/civswitch/provenance.json", keys: ["commit"], kind: .commit),
        .init(id: "civ-homebrew", name: "CivHomebrew", repository: "https://github.com/XITRIX/CivHomebrew", file: "packaging/CivHomebrew-source.json", keys: ["commit"], kind: .commit, note: "Downloaded when requested"),
        .init(id: "moonlight-civ", name: "Moonlight for CivSwitch", repository: "https://github.com/XITRIX/Moonlight-CivSwitch", file: "packaging/Moonlight-CivSwitch-source.json", keys: ["tag"], kind: .release, note: "Downloaded when requested"),
        .init(id: "savekit", name: "ns2-savekit", repository: "https://github.com/dougchansan/ns2-savekit", file: "vendor/ns2-savekit/provenance.json", keys: ["savekit", "revision"], kind: .commit),
        .init(id: "artemis", name: "Artemis launcher", repository: "https://github.com/alula/switch-artemis-launcher", file: "packaging/ArtemisLauncher-v2.json", keys: ["release"], kind: .release),
        .init(id: "artemis-full", name: "Seedsow full-game patch", repository: "https://github.com/soniciso1/switch-artemis-launcher", file: "packaging/ArtemisLauncher-seedsow-full.json", keys: ["revision"], kind: .commit),
        .init(id: "artemis-nora1", name: "Nora 1 Artemis variant", repository: "https://github.com/alula/switch-artemis-launcher", file: "packaging/ArtemisLauncher-nora1.json", keys: ["revision"], kind: .commit),
        .init(id: "seedsow-pro", name: "Seedsow Lua Editor Pro", repository: "https://github.com/purple442/seedsow-lua-editor-pro", file: "packaging/SeedsowEditorPro-v0.4.0.json", keys: ["release"], kind: .release),
        .init(id: "seedsow-editor", name: "Seedsow Lua Editor", repository: "https://github.com/DialingSpoon527/seedsow-lua-editor", file: "vendor/ns2-savekit/provenance.json", keys: ["editor", "release"], kind: .release),
        .init(id: "balatro", name: "Balatro RCE", repository: "https://github.com/Luminger/balatro-switch-rce", file: "integrations/balatro-rce/provenance.json", keys: ["source"], kind: .release),
        .init(id: "gravcirc", name: "Gravity Circuit RCE", repository: "https://github.com/figurophobia/GravCirc-Switch-rce", file: "packaging/GravCirc-v1.1.json", keys: ["release"], kind: .release),
        .init(id: "ouncecake", name: "OunceCake", repository: "https://github.com/Cellenseres/OunceCake", file: "packaging/OunceCake-provenance.json", keys: ["commit"], kind: .commit),
        .init(id: "modloader", name: "ns2jb-modloader", repository: "https://github.com/SebaaMG/ns2jb-modloader", file: "integrations/ns2jb-modloader/provenance.json", keys: ["commit"], kind: .commit),
        .init(id: "hb-native", name: "HBLauncher native runtime", repository: "https://github.com/ravensclawx/HBLauncher", file: "integrations/mintbrew-native/build-report.json", keys: ["upstreamCommit"], kind: .commit),
        .init(id: "gpubrew", name: "GPUBrewLauncher", repository: "https://github.com/NiftyNova/GPUBrewLauncher", file: "packaging/GPUBrewLauncher-provenance.json", keys: ["commit"], kind: .commit),
        .init(id: "ftpd", name: "ftpd-sb", repository: "https://github.com/ravensclawx/ftpd-sb", file: "packaging/ftpd-sb-v0.1.0-provenance.json", keys: ["tag"], kind: .release),
        .init(id: "nsp-box", name: "NSP-Box", repository: "https://github.com/smarkyie/NSP-Box", file: "integrations/nsp-box/provenance.json", keys: ["revision"], kind: .commit),
        .init(id: "nup", name: "nup", repository: "https://github.com/a55uka/nup", file: "packaging/NUP-source.json", keys: ["commit"], kind: .commit, note: "Downloaded when requested"),
        .init(id: "nxformat", name: "nxformat", repository: "https://github.com/fab918/nxformat", file: "packaging/NXFormat-source.json", keys: ["release"], kind: .release, note: "Downloaded when requested"),
        .init(id: "browser-research", name: "Switch 2 browser research", repository: "https://github.com/Jmesmykil/switch2-captive-portal-research", file: "packaging/switch2-browser-research-provenance.json", keys: ["revision"], kind: .commit)
    ]

    private static func string(at keys: [String], in file: URL) -> String? {
        guard let data = try? Data(contentsOf: file), data.count <= 1024 * 1024,
              let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
        var value: Any = object
        for key in keys {
            guard let next = (value as? [String: Any])?[key] else { return nil }
            value = next
        }
        return value as? String
    }

    private static func validPin(_ value: String, kind: BundledUpdateSource.PinKind) -> Bool {
        let pattern = kind == .commit ? "^[a-f0-9]{40}$" : "^[A-Za-z0-9._-]{1,64}$"
        return value.range(of: pattern, options: .regularExpression) != nil
    }

    private static func repository(_ text: String) -> URL? {
        guard let parts = URLComponents(string: text), parts.scheme == "https",
              ["github.com", "gitlab.com"].contains(parts.host ?? ""),
              parts.port == nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.split(separator: "/").count == 2,
              !parts.path.contains("%"), !parts.path.contains("..") else { return nil }
        return parts.url
    }

    private static func source(_ spec: Spec, root: URL) -> BundledUpdateSource {
        let file = root.appendingPathComponent(spec.file)
        var pin = string(at: spec.keys, in: file) ?? "Unknown"
        if spec.id == "balatro" { pin = String(pin.split(separator: "/").last ?? "") }
        if spec.versionNeedsV, pin != "Unknown", !pin.hasPrefix("v") { pin = "v" + pin }
        if !validPin(pin, kind: spec.kind) { pin = "Unknown" }
        return .init(id: spec.id, name: spec.name, repository: repository(spec.repository),
                     pinned: pin, kind: spec.kind, note: spec.note)
    }

    static func loadSources(runtimeRoot root: URL) -> [BundledUpdateSource] {
        struct Hosts: Decodable {
            struct Profile: Decodable {
                let id: String
                let label: String
                let revision: String
                let upstream: String
            }
            let profiles: [Profile]
        }
        let hostURL = root.appendingPathComponent("packaging/host-profiles.json")
        let hosts = (try? Data(contentsOf: hostURL)).flatMap { try? JSONDecoder().decode(Hosts.self, from: $0) }
        var sources: [BundledUpdateSource] = []
        for host in hosts?.profiles ?? [] {
            if host.id == "astral" { continue }
            sources.append(.init(id: "host-" + host.id, name: host.label + " host",
                                 repository: repository(host.upstream),
                                 pinned: validPin(host.revision, kind: .commit) ? host.revision : "Unknown",
                                 kind: .commit,
                                 note: host.id == "kurumuz" ? "Astral uses a locally modified Kurumuz base" : ""))
        }
        sources.append(contentsOf: specs.map { source($0, root: root) })
        sources.append(.init(id: "hb-gpu", name: "HBLauncher GPU runtime", repository: repository("https://github.com/ravensclawx/HBLauncher"),
                             pinned: "b40723be04baa51e5d1f121a1e2242c4167b6cbc", kind: .commit, note: ""))
        sources.append(.init(id: "libusbd", name: "libusbd", repository: repository("https://github.com/shinyquagsire23/libusbd"),
                             pinned: "4fe5521e424061b823c3f7aebaa754150f94a821", kind: .commit, note: ""))
        sources.append(.init(id: "usb-gadget", name: "macOS USB gadget driver", repository: repository("https://github.com/shinyquagsire23/macos_usb_gadget_poc"),
                             pinned: "c8349b449a2171c1b5b7c59b882728b130fc6b88", kind: .commit, note: ""))
        return sources
    }

    private static func pathSegment(_ value: String) -> String? {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn:
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"))
    }

    private static func apiBase(_ repository: URL) -> URL? {
        let path = repository.path.dropFirst()
        if repository.host == "github.com" { return URL(string: "https://api.github.com/repos/" + path) }
        if repository.host == "gitlab.com", let slug = pathSegment(String(path)) {
            return URL(string: "https://gitlab.com/api/v4/projects/" + slug)
        }
        return nil
    }

    private static func object(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw URLError(.cannotParseResponse)
        }
        return object
    }

    static func inspect(_ source: BundledUpdateSource, fetch: Fetch) async -> BundledUpdateResult {
        func result(_ status: BundledUpdateResult.Status, _ latest: String, _ text: String) -> BundledUpdateResult {
            .init(id: source.id, name: source.name, pinned: source.pinned, latest: latest,
                  status: status, statusText: text + (source.note.isEmpty ? "" : " · " + source.note),
                  sourceURL: source.sourceURL)
        }
        guard source.pinned != "Unknown", let repository = source.repository,
              let base = apiBase(repository) else {
            return result(.unknown, "Unknown", "Bundled version or source is unavailable")
        }
        do {
            if source.kind == .release {
                let suffix = repository.host == "github.com" ? "/releases/latest" : "/releases/permalink/latest"
                guard let releaseURL = URL(string: base.absoluteString + suffix) else {
                    return result(.unknown, "Unknown", "Invalid release address")
                }
                let info = try object(try await fetch(releaseURL))
                guard let tag = info["tag_name"] as? String,
                      validPin(tag, kind: .release) else {
                    return result(.unknown, "Unknown", "No verifiable latest release")
                }
                if tag == source.pinned { return result(.current, tag, "Bundled release matches upstream") }
                return result(.changed, tag, "Upstream release differs; review compatibility before updating")
            }
            let project = try object(try await fetch(base))
            guard let branch = project["default_branch"] as? String,
                  !branch.isEmpty, branch.count <= 100,
                  let encoded = pathSegment(branch) else {
                return result(.unknown, "Unknown", "Default branch is unavailable")
            }
            let branchURL: URL?
            if repository.host == "github.com" {
                branchURL = URL(string: base.absoluteString + "/branches/" + encoded)
            } else {
                branchURL = URL(string: base.absoluteString + "/repository/branches/" + encoded)
            }
            guard let branchURL else { return result(.unknown, "Unknown", "Invalid branch address") }
            let info = try object(try await fetch(branchURL))
            let commit = info["commit"] as? [String: Any]
            let hash = (repository.host == "github.com" ? commit?["sha"] : commit?["id"]) as? String
            guard let hash, validPin(hash, kind: .commit) else {
                return result(.unknown, "Unknown", "Upstream branch revision is unavailable")
            }
            if hash == source.pinned { return result(.current, String(hash.prefix(12)), "Bundled commit matches upstream branch") }
            return result(.changed, String(hash.prefix(12)), "Upstream branch differs; review the source before updating")
        } catch {
            return result(.unknown, "Unknown", "Could not check upstream")
        }
    }
}

@MainActor final class BundledUpdateChecker: ObservableObject {
    @Published private(set) var isChecking = false
    @Published private(set) var message = ""
    @Published private(set) var results: [BundledUpdateResult] = []
    private let responseCache = BundledUpdateResponseCache()

    func check(runtimeRoot: URL?) {
        guard !isChecking else { return }
        guard let runtimeRoot else { message = "Bundled component versions are unavailable"; return }
        let sources = BundledUpdateService.loadSources(runtimeRoot: runtimeRoot)
        guard !sources.isEmpty else { message = "No bundled components found"; return }
        isChecking = true
        results = []
        message = "Checking upstream sources…"
        Task {
            for offset in stride(from: 0, to: sources.count, by: 6) {
                let batch = sources[offset..<min(offset + 6, sources.count)]
                let tasks = batch.map { source in
                    Task {
                        await BundledUpdateService.inspect(source) { url in
                            try await responseCache.fetch(url)
                        }
                    }
                }
                for task in tasks {
                    results.append(await task.value)
                    message = "Checked \(results.count) of \(sources.count) bundled components"
                }
            }
            let changed = results.filter { $0.status == .changed }.count
            let unknown = results.filter { $0.status == .unknown }.count
            message = "\(changed) changed · \(unknown) could not be verified · \(sources.count) checked"
            isChecking = false
        }
    }
}

private actor BundledUpdateResponseCache {
    private var tasks: [URL: Task<Data, Error>] = [:]
    private var responses: [URL: (data: Data, checkedAt: Date)] = [:]

    func fetch(_ url: URL) async throws -> Data {
        if let response = responses[url], Date().timeIntervalSince(response.checkedAt) < 30 * 60 {
            return response.data
        }
        if let task = tasks[url] { return try await task.value }
        let task = Task { try await BoundedUpdateRequest.fetch(url) }
        tasks[url] = task
        do {
            let data = try await task.value
            responses[url] = (data, Date())
            tasks[url] = nil
            return data
        } catch {
            tasks[url] = nil
            throw error
        }
    }
}

private final class BoundedUpdateRequest: NSObject, URLSessionDataDelegate {
    private let limit = 256 * 1024
    private let expectedHost: String
    private var bytes = Data()
    private var failure: Error?
    private var continuation: CheckedContinuation<Data, Error>?
    private var session: URLSession?

    private init(host: String) { expectedHost = host }

    static func fetch(_ url: URL) async throws -> Data {
        guard url.scheme == "https", ["api.github.com", "gitlab.com"].contains(url.host ?? ""),
              url.user == nil, url.password == nil, url.port == nil else { throw URLError(.badURL) }
        let request = BoundedUpdateRequest(host: url.host!)
        return try await request.run(url)
    }

    private func run(_ url: URL) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 15
            config.timeoutIntervalForResource = 20
            config.httpMaximumConnectionsPerHost = 2
            let queue = OperationQueue()
            queue.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
            self.session = session
            var request = URLRequest(url: url)
            request.setValue("mac2jb", forHTTPHeaderField: "User-Agent")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            session.dataTask(with: request).resume()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 200, http.url?.scheme == "https",
              http.url?.host == expectedHost,
              response.expectedContentLength < 0 || response.expectedContentLength <= limit else {
            failure = URLError(.badServerResponse)
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard bytes.count + data.count <= limit else {
            failure = URLError(.dataLengthExceedsMaximum)
            dataTask.cancel()
            return
        }
        bytes.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let continuation else { return }
        self.continuation = nil
        self.session?.finishTasksAndInvalidate()
        self.session = nil
        if let failure { continuation.resume(throwing: failure) }
        else if let error { continuation.resume(throwing: error) }
        else { continuation.resume(returning: bytes) }
    }
}
