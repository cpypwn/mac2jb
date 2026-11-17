import Foundation
import zlib

private final class MemoryVault: StremioAccountVault {
    var value: String?
    var saved: [String] = []
    init(_ value: String? = nil) { self.value = value }
    func load() throws -> String? { value }
    func save(_ value: String) throws { self.value = value; saved.append(value) }
    func remove() throws { value = nil }
}

@main
struct StremioAccountFixtureTests {
    static var assertions = 0
    static func expect(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
        assertions += 1
        if try !value() { throw NSError(domain: "StremioAccountFixtures", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value) }
    static func progress(_ overrides: [String: Any] = [:]) throws -> StremioWatchProgress {
        var value: [String: Any] = ["sequence": 1, "playbackId": "fixture-playback", "itemId": "tt1", "videoId": "tt1",
            "type": "movie", "name": "Fixture", "position": 30, "duration": 100, "paused": false, "ended": false,
            "reason": "interval", "playedSeconds": 30, "resumePosition": 0]
        for (key, item) in overrides { value[key] = item }
        return try JSONDecoder().decode(StremioWatchProgress.self, from: json(value))
    }
    @MainActor
    static func wait(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !condition() {
            if ContinuousClock.now > deadline { throw NSError(domain: "Fixtures", code: 2, userInfo: [NSLocalizedDescriptionKey: "Fixture timed out"]) }
            try await Task.sleep(for: .milliseconds(5))
        }
    }
    static func inflate(_ field: String) throws -> [UInt8] {
        let packed = Data(base64Encoded: String(field.split(separator: ":").last!))!
        var bytes = [UInt8](repeating: 0, count: 512), size = uLongf(512)
        let status = packed.withUnsafeBytes { uncompress(&bytes, &size, $0.bindMemory(to: Bytef.self).baseAddress, uLong(packed.count)) }
        try expect(status == Z_OK, "watched field must use zlib framing")
        return Array(bytes.prefix(Int(size)))
    }
    @MainActor
    static func main() async throws {
        let oneAddon: [String: Any] = ["transportUrl": "https://example.org/configured/manifest.json", "manifest": ["id": "fixture"],
            "flags": ["official": false, "protected": false]]
        let collection = try json(["result": ["addons": [oneAddon], "lastModified": "2026-10-25T00:00:00Z"]])
        let record: [String: Any] = ["_id": "tt1", "name": "Fixture", "type": "movie", "removed": false, "temp": false,
            "_mtime": "2026-10-25T00:00:00Z", "unknown": ["keep": true],
            "state": ["timeWatched": 5000, "overallTimeWatched": 10000, "timeOffset": 5000, "duration": 100000,
                "video_id": "tt1", "timesWatched": 0, "flaggedWatched": 0, "unknownState": "keep"]]

        for invalid in ["https://link.stremio.com.evil.invalid/ABCD", "http://link.stremio.com/ABCD", "https://user@link.stremio.com/ABCD", "file:///tmp/account", "https://link.stremio.com:80/ABCD"] {
            do { _ = try StremioAccountCodec.browserURL(invalid); throw NSError(domain: "Fixtures", code: 3) }
            catch is StremioAccountError { assertions += 1 }
        }
        try expect(try StremioAccountCodec.browserURL("https://link.stremio.com/ABCD").host == "link.stremio.com", "official link accepted")
        let descriptors = (0..<35).map { ["transportUrl": "https://example.org/\($0)/manifest.json", "manifest": ["id": "id\($0)"]] }
        let selected = try StremioAccountCodec.addons(from: json(["result": ["addons": descriptors + [descriptors[0], ["transportUrl": "file:///private/token", "manifest": ["id": "bad"]]]]]))
        try expect(selected.urls.count == 32 && selected.total == 35 && selected.limited && selected.skipped == 1, "bounded account URLs deduplicate and report limits/skips")

        var requests: [URLRequest] = [], reads = 0, opened: [URL] = []
        let vault = MemoryVault()
        let account = StremioAccount(vault: vault, transport: { request in
            requests.append(request)
            switch request.url!.path {
            case "/api/v2/create": return try json(["result": ["code": "ABCD", "link": "https://link.stremio.com/ABCD", "qrcode": "unused"]])
            case "/api/v2/read":
                reads += 1
                return try reads == 1 ? json(["error": ["code": 1, "message": "Not approved"]]) : json(["result": ["authKey": "LINK_TOKEN"]])
            case "/api/loginWithToken": return try json(["result": ["authKey": "ACCOUNT_KEY", "user": ["email": "fixture@example.org"]]])
            case "/api/addonCollectionGet": return collection
            case "/api/datastoreGet": return try json(["result": [record]])
            default: throw StremioAccountError.response
            }
        }, openBrowser: { opened.append($0); return true }, pollNanoseconds: 1_000_000, restore: false)
        account.signIn()
        try await wait { account.libraryCount == 1 }
        try expect(account.signedIn && !account.signingIn && opened.count == 1, "browser sign-in finishes with account data")
        try expect(account.signInQRCodeURL == nil, "approved sign-in clears its QR code")
        try expect(vault.saved == ["ACCOUNT_KEY"], "only exchanged account key is stored")
        let exchange = requests.filter { $0.url!.path == "/api/loginWithToken" }
        try expect(exchange.count == 1 && exchange[0].httpMethod == "POST", "link token is exchanged exactly once")
        let body = try JSONSerialization.jsonObject(with: exchange[0].httpBody!) as! [String: String]
        try expect(body == ["type": "LoginWithToken", "token": "LINK_TOKEN"], "current official token exchange body")
        try expect(!account.status.contains("ACCOUNT_KEY") && !account.status.contains("LINK_TOKEN"), "status excludes authentication secrets")
        try expect(account.addonURLs == ["https://example.org/configured/manifest.json"], "account descriptor URLs loaded")
        let payload = account.libraryPayload()
        try expect(payload.count == 1 && payload[0]["unknown"] == nil && (payload[0]["state"] as? [String: Any])?["unknownState"] == nil, "helper library projection excludes unknown raw fields")
        account.signOut()
        try expect(!account.signedIn && vault.value == nil && account.libraryPayload().isEmpty && account.signInQRCodeURL == nil, "sign out removes only this Mac credential and clears profile and QR code")

        let ids = (1...16).map { "tt2934286:1:\($0)" }
        let marked = StremioAccountCodec.watched("tt2934286:1:5:5:eJyTZwAAAEAAIA==", videoIds: ids, selected: ids[5])!
        try expect(try inflate(marked) == [63, 0], "official anchor fixture preserves first five watched videos and marks sixth")
        let shifted = StremioAccountCodec.watched("tt2934286:1:5:5:eJyTZwAAAEAAIA==", videoIds: ["new:episode"] + ids, selected: "new:episode")!
        try expect(try inflate(shifted) == [63, 0, 0], "episode insertion reanchors old watched positions")
        try expect(StremioAccountCodec.watched("unknown:5:bad", videoIds: ids, selected: ids[5]) == nil, "unmapped/corrupt old watched state is preserved by caller")
        let seek = try StremioAccountCodec.merge(progress(["position": 95, "reason": "seek", "playedSeconds": 1]), into: record, now: "now", playedDelta: 1)
        try expect((seek["state"] as! [String: Any])["flaggedWatched"] as? Int == 0, "forward seek never marks watched")
        try expect((seek["unknown"] as? [String: Bool])?["keep"] == true && (seek["state"] as! [String: Any])["unknownState"] as? String == "keep", "raw cloud fields survive progress merge")
        let temporary = try StremioAccountCodec.merge(progress(), into: nil, now: "now")
        try expect(temporary["removed"] as? Bool == true && temporary["temp"] as? Bool == true, "new playback creates history, not a saved-library addition")

        var cloud = record, writes = 0
        let syncing = StremioAccount(vault: MemoryVault("ACCOUNT_KEY"), transport: { request in
            let parameters = try request.httpBody.map { try JSONSerialization.jsonObject(with: $0) as! [String: Any] } ?? [:]
            switch request.url!.path {
            case "/api/addonCollectionGet": return collection
            case "/api/datastoreGet": return try json(["result": [cloud]])
            case "/api/datastorePut":
                writes += 1
                cloud = (parameters["changes"] as! [[String: Any]])[0]
                if writes == 1 { throw StremioAccountError.server } // Applied, but its response was lost.
                return try json(["result": ["success": true]])
            default: throw StremioAccountError.response
            }
        }, openBrowser: { _ in false })
        try await wait { syncing.libraryCount == 1 }
        syncing.handleProgress(try progress())
        try await wait { syncing.watchProgressStatus.contains("not retried") }
        try expect(writes == 1, "uncertain progress write is not automatically replayed")
        syncing.handleProgress(try progress(["sequence": 2, "position": 40, "playedSeconds": 40]))
        try await wait { writes == 2 && syncing.watchProgressStatus == "Watch progress synced." }
        try expect((cloud["state"] as! [String: Any])["timeWatched"] as? Int == 45000, "later update does not double count an uncertain successful PUT")
        syncing.handleProgress(try progress(["sequence": 3, "position": 80, "playedSeconds": 80, "reason": "pause", "paused": true]))
        try await wait { writes == 3 }
        try expect((cloud["state"] as! [String: Any])["flaggedWatched"] as? Int == 1 && (cloud["state"] as! [String: Any])["timesWatched"] as? Int == 1, "actual play time marks watched once")
        syncing.handleProgress(try progress(["sequence": 4, "position": 100, "playedSeconds": 100, "reason": "finish", "ended": true]))
        try await wait { writes == 4 }
        try expect((cloud["state"] as! [String: Any])["timeOffset"] as? Int == 0 && (cloud["state"] as! [String: Any])["timesWatched"] as? Int == 1, "Finish syncs completion without incrementing watched twice")
        syncing.handleProgress(try progress(["sequence": 4, "reason": "finish", "playedSeconds": 100]))
        try await Task.sleep(for: .milliseconds(20))
        try expect(writes == 4, "duplicate progress sequence is ignored")
        syncing.signOut()

        var failedExchanges = 0
        let failed = StremioAccount(vault: MemoryVault(), transport: { request in
            if request.url!.path == "/api/v2/create" { return try json(["result": ["code": "ABCD", "link": "https://link.stremio.com/ABCD", "qrcode": "unused"]]) }
            if request.url!.path == "/api/v2/read" { return try json(["result": ["authKey": "LINK_SECRET"]]) }
            failedExchanges += 1
            return try json(["error": ["code": 400, "message": "Do not expose LINK_SECRET"]])
        }, openBrowser: { _ in true }, pollNanoseconds: 1_000_000, restore: false)
        failed.signIn()
        try await wait { !failed.signingIn }
        try expect(failedExchanges == 1 && !failed.signedIn && !failed.status.contains("LINK_SECRET") && failed.signInQRCodeURL == nil, "failed exchange is redacted and clears its QR code without retrying")

        var waitingForApproval = false, cancelledExchanges = 0, qrBrowserOpens: [URL] = []
        let cancelled = StremioAccount(vault: MemoryVault(), transport: { request in
            if request.url!.path == "/api/v2/create" { return try json(["result": ["code": "ABCD", "link": "https://link.stremio.com/ABCD", "qrcode": "unused"]]) }
            if request.url!.path == "/api/v2/read" {
                waitingForApproval = true
                try await Task.sleep(for: .seconds(10))
                return try json(["result": ["authKey": "NEVER_EXCHANGED"]])
            }
            cancelledExchanges += 1
            throw StremioAccountError.response
        }, openBrowser: { qrBrowserOpens.append($0); return true }, pollNanoseconds: 1_000_000, restore: false)
        cancelled.signInWithQRCode()
        try await wait { waitingForApproval }
        try expect(cancelled.signInQRCodeURL?.absoluteString == "https://link.stremio.com/ABCD" && qrBrowserOpens.isEmpty, "QR sign-in shows the validated link without opening a browser")
        cancelled.openSignInPage()
        try expect(qrBrowserOpens.map(\.absoluteString) == ["https://link.stremio.com/ABCD"] && cancelled.signInQRCodeURL != nil, "browser fallback opens the same active sign-in link")
        cancelled.cancelSignIn()
        try await Task.sleep(for: .milliseconds(20))
        try expect(!cancelled.signingIn && !cancelled.signedIn && cancelledExchanges == 0 && cancelled.signInQRCodeURL == nil, "closing/cancelling stops the pending request and clears its QR code before token exchange")
        waitingForApproval = false
        cancelled.signInWithQRCode()
        try await wait { waitingForApproval }
        cancelled.signOut()
        try expect(!cancelled.signingIn && cancelled.signInQRCodeURL == nil, "signing out during a pending sign-in clears its QR code")

        let expiring = StremioAccount(vault: MemoryVault(), transport: { request in
            if request.url!.path == "/api/v2/create" { return try json(["result": ["code": "ABCD", "link": "https://link.stremio.com/ABCD", "qrcode": "unused"]]) }
            try await Task.sleep(for: .seconds(10))
            throw StremioAccountError.response
        }, openBrowser: { _ in true }, pollNanoseconds: 1_000_000, localTimeout: .milliseconds(150), restore: false)
        expiring.signIn()
        try await wait { expiring.signInQRCodeURL != nil }
        try await wait { !expiring.signingIn }
        try expect(expiring.signInQRCodeURL == nil && expiring.status.contains("five minutes"), "expired sign-in clears its QR code")

        var largeLibrary: [[String: Any]] = []
        for index in 0..<600 {
            var item = record
            item["_id"] = "tt\(index)"
            item["authKey"] = "UNKNOWN_RAW_SECRET"
            largeLibrary.append(item)
        }
        let bounded = StremioAccount(vault: MemoryVault("ACCOUNT_KEY"), transport: { request in
            if request.url!.path == "/api/addonCollectionGet" { return collection }
            return try json(["result": largeLibrary])
        }, openBrowser: { _ in false })
        try await wait { bounded.libraryCount == 600 }
        let boundedPayload = bounded.libraryPayload()
        try expect(boundedPayload.count == 500 && bounded.status.contains("500 of 600"), "library browsing limit is visible while all raw records remain on the Mac")
        let projectedBytes = try json(boundedPayload)
        try expect(projectedBytes.count < 4 * 1024 * 1024 && !String(decoding: projectedBytes, as: UTF8.self).contains("UNKNOWN_RAW_SECRET"), "helper library stays bounded and does not include unknown cloud secrets")
        bounded.cancelSignIn()

        var series = record
        series["type"] = "series"
        series["state"] = ["video_id": "tt1:1:1", "timeWatched": 0, "overallTimeWatched": 0,
            "timeOffset": 0, "duration": 100000, "timesWatched": 0, "flaggedWatched": 0]
        var cloudRecords = ["tt1": series], orderedWrites: [[String: Any]] = []
        var blocked = false, releaseBlocked = false
        let ordering = StremioAccount(vault: MemoryVault("ACCOUNT_KEY"), transport: { request in
            let parameters = try request.httpBody.map { try JSONSerialization.jsonObject(with: $0) as! [String: Any] } ?? [:]
            switch request.url!.path {
            case "/api/addonCollectionGet": return collection
            case "/api/datastoreGet":
                if parameters["all"] as? Bool == true { return try json(["result": [series]]) }
                let id = (parameters["ids"] as! [String])[0]
                if id == "blocker" { blocked = true; while !releaseBlocked { try await Task.sleep(for: .milliseconds(2)) } }
                return try json(["result": cloudRecords[id].map { [$0] } ?? []])
            case "/api/datastorePut":
                let item = (parameters["changes"] as! [[String: Any]])[0]
                cloudRecords[item["_id"] as! String] = item
                orderedWrites.append(item)
                return try json(["result": ["success": true]])
            default: throw StremioAccountError.response
            }
        }, openBrowser: { _ in false })
        try await wait { ordering.libraryCount == 1 }
        ordering.handleProgress(try progress(["itemId": "blocker", "videoId": "blocker", "playbackId": "busy", "reason": "pause", "paused": true]))
        try await wait { blocked }
        ordering.handleProgress(try progress(["sequence": 10, "type": "series", "videoId": "tt1:1:1", "playbackId": "z-old", "reason": "stop", "position": 50, "playedSeconds": 50]))
        ordering.handleProgress(try progress(["sequence": 11, "type": "series", "videoId": "tt1:1:1", "playbackId": "z-old", "reason": "stop", "position": 55, "playedSeconds": 55]))
        // New helpers may restart their sequence counter. UUID lexical order
        // deliberately opposes the chronological receipt order here.
        ordering.handleProgress(try progress(["sequence": 1, "type": "series", "videoId": "tt1:1:2", "playbackId": "a-new", "position": 0, "playedSeconds": 0]))
        releaseBlocked = true
        try await wait { orderedWrites.count == 3 }
        let episodeWrites = orderedWrites.filter { $0["_id"] as? String == "tt1" }
        try expect(episodeWrites.map { ($0["state"] as! [String: Any])["video_id"] as! String } == ["tt1:1:1", "tt1:1:2"], "old stop is written before new start regardless of UUID or helper sequence order")
        try expect((episodeWrites[0]["state"] as! [String: Any])["timeOffset"] as? Int == 55000, "pending updates coalesce to the most recently received old-episode state")
        try expect((cloudRecords["tt1"]!["state"] as! [String: Any])["video_id"] as? String == "tt1:1:2", "final cloud resume pointer belongs to the newly started episode")
        ordering.cancelSignIn()

        var oldReadStarted = false, oldReadCancelled = false, oldPuts = 0
        let rotatingVault = MemoryVault("OLD_ACCOUNT_KEY")
        let rotating = StremioAccount(vault: rotatingVault, transport: { request in
            let parameters = try request.httpBody.map { try JSONSerialization.jsonObject(with: $0) as! [String: Any] } ?? [:]
            switch request.url!.path {
            case "/api/v2/create": return try json(["result": ["code": "ABCD", "link": "https://link.stremio.com/ABCD", "qrcode": "unused"]])
            case "/api/v2/read": return try json(["result": ["authKey": "NEW_LINK_TOKEN"]])
            case "/api/loginWithToken": return try json(["result": ["authKey": "NEW_ACCOUNT_KEY", "user": ["email": "new@example.org"]]])
            case "/api/addonCollectionGet": return collection
            case "/api/datastoreGet":
                if parameters["all"] as? Bool == false {
                    oldReadStarted = true
                    do { try await Task.sleep(for: .seconds(10)) } catch { oldReadCancelled = true; throw error }
                }
                var item = record
                if parameters["authKey"] as? String == "NEW_ACCOUNT_KEY" { item["_id"] = "new-account-item" }
                return try json(["result": [item]])
            case "/api/datastorePut": oldPuts += 1; return try json(["result": ["success": true]])
            default: throw StremioAccountError.response
            }
        }, openBrowser: { _ in true }, pollNanoseconds: 1_000_000)
        try await wait { rotating.libraryCount == 1 }
        rotating.handleProgress(try progress())
        try await wait { oldReadStarted }
        rotating.signIn()
        rotating.handleProgress(try progress(["sequence": 2, "reason": "finish"]))
        try await wait { rotatingVault.value == "NEW_ACCOUNT_KEY" && !rotating.signingIn }
        try expect(oldReadCancelled && oldPuts == 0, "account rotation cancels old cloud work and blocks stale progress during sign-in")
        try expect(rotating.libraryPayload().first?["_id"] as? String == "new-account-item", "new account profile replaces the old account library snapshot")
        rotating.cancelSignIn()
        print("Stremio account fixture assertions passed: \(assertions). No real account or Keychain was accessed.")
    }
}
