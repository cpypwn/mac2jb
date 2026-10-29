import AppKit
import Combine
import Foundation
import Security
import zlib

// Account requests follow Stremio's public stremio-core Link and API types.
// The link token is exchanged once; only the resulting account key is saved.
enum StremioAccountError: Error, Equatable {
    case response, server, browser, storage, expired
}

struct StremioWatchProgress: Codable {
    let sequence: Int
    let itemId: String
    let videoId: String
    let type: String
    let name: String
    let poster: String?
    // Native playback reports seconds. Stremio's cloud state uses milliseconds.
    let position: Double
    let duration: Double
    let paused: Bool
    let ended: Bool
    let season: Int?
    let episode: Int?
    let playbackId: String?
    let reason: String?
    let playedSeconds: Double?
    let resumePosition: Double?
    let videoIds: [String]?
}

enum StremioAccountCodec {
    struct RemoteError: Decodable { let code: UInt64; let message: String }
    struct Envelope<Value: Decodable>: Decodable {
        let result: Value?
        let error: RemoteError?
    }
    struct Link: Decodable { let code: String; let link: String; let qrcode: String }
    struct LinkKey: Decodable { let authKey: String? }
    struct User: Decodable { let email: String?; let name: String? }
    struct Authentication: Decodable { let authKey: String; let user: User }
    struct Manifest: Decodable { let id: String }
    struct Flags: Decodable { let official: Bool?; let protected: Bool? }
    struct Addon: Decodable { let transportUrl: String; let manifest: Manifest; let flags: Flags? }
    struct Collection: Decodable { let addons: [Addon]; let lastModified: String? }
    struct Selection {
        let urls: [String]
        let total: Int
        let skipped: Int
        let limited: Bool
    }
    static func value<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoded = try JSONDecoder().decode(Envelope<T>.self, from: data)
        guard decoded.error == nil, let result = decoded.result else { throw StremioAccountError.server }
        return result
    }
    static func validKey(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 4096 && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
    }
    static func browserURL(_ text: String) throws -> URL {
        guard text.utf8.count <= 4096, let parts = URLComponents(string: text),
              parts.scheme?.lowercased() == "https", let host = parts.host?.lowercased(),
              ["link.stremio.com", "www.stremio.com", "stremio.com"].contains(host),
              parts.user == nil, parts.password == nil, parts.port == nil || parts.port == 443,
              !text.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
              let url = parts.url else { throw StremioAccountError.response }
        return url
    }
    static func manifestURL(_ text: String) -> String? {
        guard text.utf8.count <= 4096,
              !text.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }),
              let parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased(),
              ["https", "http"].contains(scheme), let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.port == nil || (1...65535).contains(parts.port!),
              parts.path.hasSuffix("/manifest.json"), let url = parts.url else { return nil }
        return url.absoluteString
    }
    static func addons(from data: Data) throws -> Selection {
        let collection = try value(Collection.self, from: data)
        guard collection.addons.count <= 2048 else { throw StremioAccountError.response }
        var seen = Set<String>(), all: [String] = [], skipped = 0
        for addon in collection.addons {
            guard !addon.manifest.id.isEmpty, let url = manifestURL(addon.transportUrl) else { skipped += 1; continue }
            if seen.insert(url).inserted { all.append(url) }
        }
        return Selection(urls: Array(all.prefix(32)), total: all.count, skipped: skipped, limited: all.count > 32)
    }
    static func library(from data: Data) throws -> [[String: Any]] {
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              envelope["error"] == nil || envelope["error"] is NSNull,
              let records = envelope["result"] as? [[String: Any]], records.count <= 50_000
        else { throw StremioAccountError.response }
        return records
    }
    static func validProgress(_ update: StremioWatchProgress) -> Bool {
        let identifiers = [update.itemId, update.videoId, update.type]
        return update.sequence >= 0 && identifiers.allSatisfy { !$0.isEmpty && $0.utf8.count <= 512 &&
            !$0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) } &&
            update.name.utf8.count <= 1024 && update.position.isFinite && update.duration.isFinite &&
            (0...1_440_000).contains(update.position) && (0...1_440_000).contains(update.duration) &&
            (update.playbackId?.utf8.count ?? 0) <= 256 &&
            (update.playedSeconds == nil || update.playedSeconds!.isFinite && (0...1_440_000).contains(update.playedSeconds!)) &&
            (update.videoIds?.count ?? 0) <= 2000
    }
    static func watched(_ old: String?, videoIds: [String], selected: String) -> String? {
        guard !videoIds.isEmpty, videoIds.count <= 2000, Set(videoIds).count == videoIds.count,
              videoIds.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 512 }),
              let selectedIndex = videoIds.firstIndex(of: selected) else { return nil }
        var bits = [UInt8](repeating: 0, count: (videoIds.count + 7) / 8)
        if let old, !old.isEmpty {
            guard old.utf8.count <= 8192, let lastColon = old.lastIndex(of: ":") else { return nil }
            let before = old[..<lastColon]
            guard let middleColon = before.lastIndex(of: ":"),
                  let anchorLength = Int(before[before.index(after: middleColon)...]), (1...2000).contains(anchorLength),
                  let anchorIndex = videoIds.firstIndex(of: String(before[..<middleColon])),
                  let packed = Data(base64Encoded: String(old[old.index(after: lastColon)...])), packed.count <= 2048 else { return nil }
            var unpacked = [UInt8](repeating: 0, count: 512), size = uLongf(512)
            let result = packed.withUnsafeBytes { raw in
                uncompress(&unpacked, &size, raw.bindMemory(to: Bytef.self).baseAddress, uLong(packed.count))
            }
            guard result == Z_OK, size > 0 else { return nil }
            let offset = anchorLength - anchorIndex - 1
            for index in videoIds.indices {
                let previous = index + offset
                if previous >= 0 && previous < videoIds.count && previous / 8 < Int(size),
                   unpacked[previous / 8] & (1 << (previous % 8)) != 0 {
                    bits[index / 8] |= 1 << (index % 8)
                }
            }
        }
        bits[selectedIndex / 8] |= 1 << (selectedIndex % 8)
        guard let last = videoIds.indices.last(where: { bits[$0 / 8] & (1 << ($0 % 8)) != 0 }) else { return nil }
        var size = compressBound(uLong(bits.count)), packed = [UInt8](repeating: 0, count: Int(size))
        guard compress2(&packed, &size, &bits, uLong(bits.count), 6) == Z_OK else { return nil }
        return videoIds[last] + ":" + String(last + 1) + ":" + Data(packed.prefix(Int(size))).base64EncodedString()
    }
    static func merge(_ update: StremioWatchProgress, into existing: [String: Any]?, now: String,
                      playedDelta: Double = 0, minimumTimeWatched: Double? = nil,
                      minimumOverallTimeWatched: Double? = nil) throws -> [String: Any] {
        guard validProgress(update), existing == nil || existing?["_id"] as? String == update.itemId,
              existing == nil || existing?["type"] as? String == update.type else { throw StremioAccountError.response }
        // New playback history stays temporary; playing a title does not add it
        // to the user's saved library or restore a deliberately removed item.
        var record = existing ?? ["_id": update.itemId, "name": update.name, "type": update.type,
            "posterShape": "poster", "removed": true, "temp": true, "_ctime": now,
            "state": ["timeWatched": 0, "timeOffset": 0, "overallTimeWatched": 0,
                "timesWatched": 0, "flaggedWatched": 0, "duration": 0]]
        var state = record["state"] as? [String: Any] ?? [:]
        let previousVideo = state["video_id"] as? String
        if previousVideo != update.videoId {
            state["timeWatched"] = 0
            state["flaggedWatched"] = 0
        }
        func nonnegative(_ name: String) -> Double {
            let number = (state[name] as? NSNumber)?.doubleValue ?? 0
            return number.isFinite && number >= 0 ? min(number, 9_000_000_000_000) : 0
        }
        let delta = playedDelta.isFinite ? max(0, min(playedDelta, 1_440_000)) * 1000 : 0
        state["timeWatched"] = Int64(max(nonnegative("timeWatched"), minimumTimeWatched ?? (nonnegative("timeWatched") + delta)))
        state["overallTimeWatched"] = Int64(max(nonnegative("overallTimeWatched"), minimumOverallTimeWatched ?? (nonnegative("overallTimeWatched") + delta)))
        state["timeOffset"] = Int64((update.position * 1000).rounded())
        if update.duration > 0 { state["duration"] = Int64((update.duration * 1000).rounded()) }
        state["video_id"] = update.videoId
        state["lastWatched"] = now
        // Seeking near the end is not evidence of having watched the video.
        // Match Core's >70% actual-play-time threshold and retain opaque or
        // unmapped old episode fields instead of replacing them with blanks.
        let duration = nonnegative("duration")
        let live = update.type == "tv" || (record["behaviorHints"] as? [String: Any])?["isLive"] as? Bool == true
        if !live, duration > 0, nonnegative("flaggedWatched") == 0,
           nonnegative("timeWatched") > duration * 0.7 {
            state["flaggedWatched"] = 1
            state["timesWatched"] = Int64(nonnegative("timesWatched") + 1)
            if let ids = update.videoIds, let marked = watched(state["watched"] as? String, videoIds: ids, selected: update.videoId) {
                state["watched"] = marked
            }
        }
        if update.ended || (["stop", "finish"].contains(update.reason ?? "") && duration > 0 && update.position * 1000 > duration * 0.9) {
            state["timeOffset"] = 0
        }
        record["state"] = state
        record["_mtime"] = now
        if existing == nil, let poster = update.poster, poster.utf8.count <= 4096,
           let url = URL(string: poster), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            record["poster"] = poster
        }
        return record
    }
}

protocol StremioAccountVault {
    func load() throws -> String?
    func save(_ value: String) throws
    func remove() throws
}

private struct StremioMacKeychain: StremioAccountVault {
    private let service = "io.github.cpypwn.mac2jb.stremio"
    private let account = "mac2jb-stremio-account"
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }
    func load() throws -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = result as? Data,
              let value = String(data: bytes, encoding: .utf8), StremioAccountCodec.validKey(value)
        else { throw StremioAccountError.storage }
        return value
    }
    func save(_ value: String) throws {
        guard StremioAccountCodec.validKey(value) else { throw StremioAccountError.storage }
        let data = Data(value.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw StremioAccountError.storage }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "mac2jb Stremio account"
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw StremioAccountError.storage }
    }
    func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StremioAccountError.storage }
    }
}

// No cookies, disk cache, credential store or automatic HTTP redirects. In
// particular an account-key POST cannot follow a redirect to another host.
private final class StremioAccountHTTP: NSObject, URLSessionTaskDelegate {
    private var session: URLSession!
    override init() {
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 30
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }
    func request(_ request: URLRequest) async throws -> Data {
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode),
              response.expectedContentLength <= 8 * 1024 * 1024 else { throw StremioAccountError.server }
        var data = Data()
        for try await byte in bytes {
            if data.count >= 8 * 1024 * 1024 { throw StremioAccountError.response }
            data.append(byte)
        }
        try Task.checkCancellation()
        return data
    }
    func invalidate() { session.invalidateAndCancel() }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class StremioAccount: ObservableObject {
    @Published private(set) var signedIn = false
    @Published private(set) var signingIn = false
    @Published private(set) var status = "Sign in to use your Stremio add-ons, or continue without an account."
    @Published private(set) var addonURLs: [String] = []
    @Published private(set) var displayName: String?
    @Published private(set) var libraryCount = 0
    @Published private(set) var watchProgressStatus = ""

    typealias Transport = (URLRequest) async throws -> Data
    private let transport: Transport
    private let vault: StremioAccountVault
    private let openBrowser: (URL) -> Bool
    private let pollNanoseconds: UInt64
    private let localTimeout: Duration
    private let invalidateTransport: () -> Void
    private var key: String?
    private var operation: Task<Void, Never>?
    private var deadlineTask: Task<Void, Never>?
    private var progressTask: Task<Void, Never>?
    private var progressStatusTask: Task<Void, Never>?
    private var progressStatusGeneration = UUID()
    private var library: [String: [String: Any]] = [:]
    private var pendingProgress: [String: StremioWatchProgress] = [:]
    private var pendingProgressOrder: [String: UInt64] = [:]
    private var progressReceipt: UInt64 = 0
    private var seenSequence: [String: Int] = [:]
    private var lastProgressWrite: [String: Date] = [:]
    private var lastPlayedSeconds: [String: Double] = [:]
    private var watchBaselines: [String: (time: Double, overall: Double)] = [:]
    private var progressGeneration = UUID()
    private var generation = UUID()

    convenience init() {
        let network = StremioAccountHTTP()
        self.init(vault: StremioMacKeychain(), transport: { try await network.request($0) },
                  openBrowser: { NSWorkspace.shared.open($0) }, invalidateTransport: { network.invalidate() })
    }
    // Dependency injection is used by fixture tests; no tests need a real account.
    init(vault: StremioAccountVault, transport: @escaping Transport, openBrowser: @escaping (URL) -> Bool,
         pollNanoseconds: UInt64 = 5_000_000_000, localTimeout: Duration = .seconds(300),
         invalidateTransport: @escaping () -> Void = {}, restore: Bool = true) {
        self.vault = vault
        self.transport = transport
        self.openBrowser = openBrowser
        self.pollNanoseconds = pollNanoseconds
        self.localTimeout = localTimeout
        self.invalidateTransport = invalidateTransport
        if restore {
            do {
                key = try vault.load()
                if key != nil { signedIn = true; refresh() }
            } catch { status = "Your saved Stremio sign-in could not be opened. Unlock your Mac keychain and try again." }
        }
    }
    deinit { operation?.cancel(); deadlineTask?.cancel(); progressTask?.cancel(); progressStatusTask?.cancel(); invalidateTransport() }

    private func setProgressStatus(_ message: String, clearAfter delay: Duration? = nil) {
        progressStatusTask?.cancel()
        progressStatusTask = nil
        progressStatusGeneration = UUID()
        let id = progressStatusGeneration
        watchProgressStatus = message
        guard let delay else { return }
        progressStatusTask = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            guard let self, self.progressStatusGeneration == id else { return }
            self.watchProgressStatus = ""
            self.progressStatusTask = nil
        }
    }

    private func cancelCloudWork(clearHistory: Bool = false) {
        progressTask?.cancel()
        progressTask = nil
        progressStatusTask?.cancel()
        progressStatusTask = nil
        progressStatusGeneration = UUID()
        watchProgressStatus = ""
        progressGeneration = UUID()
        pendingProgress = [:]
        pendingProgressOrder = [:]
        if clearHistory {
            seenSequence = [:]
            lastProgressWrite = [:]
            lastPlayedSeconds = [:]
            watchBaselines = [:]
        }
    }
    private func begin(cancelCloud: Bool = false) -> UUID {
        operation?.cancel()
        deadlineTask?.cancel()
        deadlineTask = nil
        if cancelCloud { cancelCloudWork() }
        generation = UUID()
        return generation
    }
    private func ensureCurrent(_ id: UUID) throws {
        try Task.checkCancellation()
        guard generation == id else { throw CancellationError() }
    }
    private func request(_ url: URL, body: [String: Any]? = nil) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return try await transport(request)
    }
    private func accountRequest(_ method: String, body: [String: Any]) async throws -> Data {
        try await request(URL(string: "https://api.strem.io/api/" + method)!, body: body)
    }
    private func fetchAddons(_ key: String, generation id: UUID) async throws {
        let data = try await accountRequest("addonCollectionGet", body: ["type": "AddonCollectionGet", "authKey": key, "update": true])
        let selection = try StremioAccountCodec.addons(from: data)
        try ensureCurrent(id)
        addonURLs = selection.urls
        if selection.limited {
            status = "Signed in. Using the first 32 of \(selection.total) compatible account add-ons."
        } else if selection.urls.isEmpty {
            status = "Signed in. No compatible account add-ons were found; the built-in source is available."
        } else {
            status = "Signed in. \(selection.urls.count) account add-on\(selection.urls.count == 1 ? "" : "s") ready."
        }
        if selection.skipped > 0 { status += " \(selection.skipped) unsupported add-on URL\(selection.skipped == 1 ? " was" : "s were") skipped." }
    }
    private func updateLibraryCount() {
        libraryCount = library.values.filter { ($0["removed"] as? Bool) == false && ($0["temp"] as? Bool) != true }.count
    }
    private func fetchLibrary(_ key: String, generation id: UUID) async throws {
        let data = try await accountRequest("datastoreGet", body: ["authKey": key,
            "collection": "libraryItem", "ids": [], "all": true])
        let records = try StremioAccountCodec.library(from: data)
        try ensureCurrent(id)
        var next: [String: [String: Any]] = [:]
        for record in records {
            if let itemId = record["_id"] as? String, !itemId.isEmpty, itemId.utf8.count <= 512 { next[itemId] = record }
        }
        library = next
        updateLibraryCount()
        let available = libraryPayload().count
        status += available < library.count ? " Library loaded; this session can browse \(available) of \(library.count) records." : " Library ready."
    }
    func libraryPayload() -> [[String: Any]] {
        // Keep the complete raw record on the Mac for cloud merges. The helper
        // receives only bounded browsing/resume fields, without unknown values.
        let stateNames = ["timeOffset", "duration", "video_id", "timesWatched", "watched", "season", "episode", "timeWatched", "overallTimeWatched"]
        let ordered = library.values.sorted { ($0["_mtime"] as? String ?? "") > ($1["_mtime"] as? String ?? "") }
        var result: [[String: Any]] = [], bytes = 2
        for record in ordered {
            guard result.count < 500 else { break }
            var item: [String: Any] = [:]
            for field in ["_id", "name", "type", "poster", "removed", "temp", "_mtime", "_ctime"] {
                if let text = record[field] as? String, text.utf8.count <= 4096 { item[field] = text }
                else if let flag = record[field] as? Bool, ["removed", "temp"].contains(field) { item[field] = flag }
            }
            guard item["_id"] is String, item["type"] is String else { continue }
            var state: [String: Any] = [:]
            for field in stateNames {
                let value = (record["state"] as? [String: Any])?[field]
                if let text = value as? String, text.utf8.count <= 8192 { state[field] = text }
                else if let number = value as? NSNumber, number.doubleValue.isFinite { state[field] = number }
            }
            item["state"] = state
            guard let data = try? JSONSerialization.data(withJSONObject: item), bytes + data.count + 1 <= 3 * 1024 * 1024 else { continue }
            result.append(item)
            bytes += data.count + 1
        }
        return result
    }
    func signIn() {
        guard !signingIn else { return }
        let id = begin(cancelCloud: true)
        signingIn = true
        status = "Opening Stremio sign-in in your browser…"
        operation = Task { [weak self] in
            guard let self else { return }
            defer { if generation == id { deadlineTask?.cancel(); deadlineTask = nil } }
            do {
                let link = try StremioAccountCodec.value(StremioAccountCodec.Link.self,
                    from: await request(URL(string: "https://link.stremio.com/api/v2/create?type=Create")!))
                guard !link.code.isEmpty, link.code.utf8.count <= 256,
                      !link.code.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 })
                else { throw StremioAccountError.response }
                let browser = try StremioAccountCodec.browserURL(link.link)
                try ensureCurrent(id)
                guard openBrowser(browser) else { throw StremioAccountError.browser }
                status = "Complete sign-in on Stremio’s website. Waiting for approval…"
                let timeout = localTimeout
                deadlineTask = Task { [weak self] in
                    do { try await Task.sleep(for: timeout) } catch { return }
                    guard let self, generation == id else { return }
                    operation?.cancel()
                    generation = UUID()
                    signingIn = false
                    status = "This Mac stopped waiting after five minutes. Start sign-in again for a new code."
                }
                let deadline = ContinuousClock.now.advanced(by: localTimeout)
                var linkToken: String?
                while ContinuousClock.now < deadline {
                    try await Task.sleep(nanoseconds: pollNanoseconds)
                    try ensureCurrent(id)
                    var url = URLComponents(string: "https://link.stremio.com/api/v2/read")!
                    url.queryItems = [URLQueryItem(name: "type", value: "Read"), URLQueryItem(name: "code", value: link.code)]
                    let bytes = try await request(url.url!)
                    let reply = try JSONDecoder().decode(StremioAccountCodec.Envelope<StremioAccountCodec.LinkKey>.self, from: bytes)
                    if reply.error == nil, let token = reply.result?.authKey {
                        guard StremioAccountCodec.validKey(token) else { throw StremioAccountError.response }
                        linkToken = token
                        break
                    }
                }
                try ensureCurrent(id)
                guard let linkToken else { throw StremioAccountError.expired }
                status = "Finishing Stremio sign-in…"
                // The link API's authKey field is a link token, not the key to
                // persist. This exchange is deliberately attempted only once.
                let authentication = try StremioAccountCodec.value(StremioAccountCodec.Authentication.self,
                    from: await accountRequest("loginWithToken", body: ["type": "LoginWithToken", "token": linkToken]))
                try ensureCurrent(id)
                guard StremioAccountCodec.validKey(authentication.authKey) else { throw StremioAccountError.response }
                try vault.save(authentication.authKey)
                cancelCloudWork(clearHistory: true)
                key = authentication.authKey
                library = [:]
                libraryCount = 0
                addonURLs = []
                watchProgressStatus = ""
                signedIn = true
                displayName = authentication.user.name ?? authentication.user.email
                try await fetchAddons(authentication.authKey, generation: id)
                try await fetchLibrary(authentication.authKey, generation: id)
                signingIn = false
            } catch {
                guard generation == id else { return }
                signingIn = false
                if error is CancellationError { return }
                if (error as? StremioAccountError) == .expired {
                    status = "This Mac stopped waiting after five minutes. Start sign-in again for a new code."
                } else if (error as? StremioAccountError) == .storage {
                    status = "Your Stremio sign-in could not be saved. Unlock your Mac keychain and try again."
                } else if signedIn {
                    status = "Signed in, but account add-ons or library could not be refreshed. Try Refresh."
                } else {
                    status = "Stremio sign-in could not be completed. Try again, or continue without an account."
                }
            }
        }
    }
    func refresh() {
        guard let key, !signingIn else { return }
        let id = begin()
        status = "Refreshing your Stremio add-ons…"
        operation = Task { [weak self] in
            guard let self else { return }
            do { try await fetchAddons(key, generation: id); try await fetchLibrary(key, generation: id) }
            catch {
                guard generation == id, !(error is CancellationError) else { return }
                status = "Your Stremio account could not be refreshed. Try again, or sign out and sign in again."
            }
        }
    }
    func cancelSignIn() {
        _ = begin(cancelCloud: true)
        signingIn = false
        status = signedIn ? "Signed in. Sign-in request cancelled." : "Sign-in cancelled. You can continue without an account."
    }
    func signOut() {
        _ = begin(cancelCloud: true)
        signingIn = false
        do { try vault.remove() }
        catch { status = "The saved sign-in could not be removed. Unlock your Mac keychain and try again."; return }
        key = nil
        cancelCloudWork(clearHistory: true)
        library = [:]
        libraryCount = 0
        watchProgressStatus = ""
        signedIn = false
        displayName = nil
        addonURLs = []
        status = "Signed out on this Mac. You can continue without an account."
    }
    func handleProgress(_ update: StremioWatchProgress) {
        guard signedIn, !signingIn, key != nil, StremioAccountCodec.validProgress(update) else { return }
        let identity = (update.playbackId ?? "legacy") + "|" + update.itemId + "|" + update.videoId
        guard update.sequence > (seenSequence[identity] ?? -1) else { return }
        seenSequence[identity] = update.sequence
        let urgent = update.ended || update.paused || ["pause", "seek", "stop", "finish", "ended", "completion"].contains(update.reason ?? "")
        if !urgent, let last = lastProgressWrite[identity], Date().timeIntervalSince(last) < 30 { return }
        if pendingProgress.count >= 32 && pendingProgress[identity] == nil { return }
        pendingProgress[identity] = update
        progressReceipt += 1
        pendingProgressOrder[identity] = progressReceipt
        setProgressStatus("Syncing watch progress…")
        guard progressTask == nil else { return }
        let progressID = UUID()
        progressGeneration = progressID
        progressTask = Task { [weak self] in
            guard let self else { return }
            defer { if progressGeneration == progressID { progressTask = nil } }
            while !pendingProgress.isEmpty, !Task.isCancelled {
                // Each coalesced update keeps its most recent receipt order.
                // UUID lexical order can put an old episode's stop after the
                // next episode's start and replace the new resume pointer.
                guard let identity = pendingProgressOrder.min(by: { $0.value < $1.value })?.key,
                      let update = pendingProgress.removeValue(forKey: identity), let credential = key, signedIn else { break }
                pendingProgressOrder.removeValue(forKey: identity)
                do {
                    // Read the current cloud record before each write, so a
                    // resume update preserves fields changed by another device.
                    let data = try await accountRequest("datastoreGet", body: ["authKey": credential,
                        "collection": "libraryItem", "ids": [update.itemId], "all": false])
                    let records = try StremioAccountCodec.library(from: data)
                    try Task.checkCancellation()
                    guard key == credential, signedIn, progressGeneration == progressID else { break }
                    let existing = records.first { $0["_id"] as? String == update.itemId }
                    let formatter = ISO8601DateFormatter()
                    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                    let observed = update.playedSeconds ?? (lastPlayedSeconds[identity] ?? 0)
                    let playedDelta = max(0, observed - (lastPlayedSeconds[identity] ?? 0))
                    if watchBaselines[identity] == nil {
                        let state = existing?["state"] as? [String: Any] ?? [:]
                        let sameVideo = state["video_id"] as? String == update.videoId
                        let time = sameVideo ? (state["timeWatched"] as? NSNumber)?.doubleValue ?? 0 : 0
                        let overall = (state["overallTimeWatched"] as? NSNumber)?.doubleValue ?? 0
                        watchBaselines[identity] = (max(0, min(time.isFinite ? time : 0, 9_000_000_000_000)),
                            max(0, min(overall.isFinite ? overall : 0, 9_000_000_000_000)))
                    }
                    let baseline = watchBaselines[identity]!
                    // Floors derived from one playback's baseline make a later
                    // update idempotent even if a previous PUT reached Stremio
                    // but its response was lost. Never add the same play twice.
                    let merged = try StremioAccountCodec.merge(update, into: existing, now: formatter.string(from: Date()),
                        playedDelta: playedDelta, minimumTimeWatched: baseline.time + observed * 1000,
                        minimumOverallTimeWatched: baseline.overall + observed * 1000)
                    let reply = try await accountRequest("datastorePut", body: ["authKey": credential,
                        "collection": "libraryItem", "changes": [merged]])
                    struct Success: Decodable { let success: Bool }
                    let success = try StremioAccountCodec.value(Success.self, from: reply)
                    guard success.success else { throw StremioAccountError.server }
                    try Task.checkCancellation()
                    guard key == credential, signedIn, progressGeneration == progressID else { break }
                    library[update.itemId] = merged
                    updateLibraryCount()
                    lastProgressWrite[identity] = Date()
                    lastPlayedSeconds[identity] = observed
                    if pendingProgress.isEmpty {
                        setProgressStatus("Watch progress synced.", clearAfter: .seconds(4))
                    } else {
                        setProgressStatus("Syncing watch progress…")
                    }
                } catch {
                    if Task.isCancelled { break }
                    setProgressStatus("Watch progress could not be synced. This update was not retried.", clearAfter: .seconds(8))
                }
            }
        }
    }
}
