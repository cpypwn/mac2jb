import Foundation
import AppKit

@main @MainActor struct UpdaterTests {
    static var passed = 0
    static let manager = FileManager.default
    static func expect(_ condition: @autoclosure () throws -> Bool, _ name: String) throws {
        guard try condition() else { throw UpdateFailure("FAIL: " + name) }
        passed += 1; print("PASS " + name)
    }
    static func rejects(_ name: String, _ action: () throws -> Void) throws {
        do { try action() } catch { passed += 1; print("PASS " + name); return }
        throw UpdateFailure("FAIL: " + name)
    }
    static func release(_ change: (inout [String: Any]) -> Void = { _ in }) throws -> UpdateRelease {
        let tag = "v1.2.3"
        var row: [String: Any] = ["tag_name": tag, "draft": false, "prerelease": false,
            "html_url": "https://github.com/cpypwn/mac2jb/releases/tag/\(tag)",
            "assets": ["mac2jb-\(tag)-macos-arm64.zip", "mac2jb-\(tag)-sha256sums"].map {
                ["name": $0, "size": 100, "digest": "sha256:" + String(repeating: "a", count: 64),
                 "browser_download_url": "https://github.com/cpypwn/mac2jb/releases/download/\(tag)/\($0)"] as [String: Any]
            }]
        change(&row)
        return try JSONDecoder().decode(UpdateRelease.self, from: JSONSerialization.data(withJSONObject: row))
    }
    static func app(_ url: URL, version: String, build: Int = 1, fixture: URL) throws {
        try manager.createDirectory(at: url.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        let metadata: [String: Any] = ["CFBundleIdentifier": UpdatePackage.bundleID, "CFBundleExecutable": "mac2jb",
                                      "CFBundleVersion": String(build), "CFBundleShortVersionString": version,
                                      "CFBundlePackageType": "APPL", "LSMinimumSystemVersion": "14.0"]
        try PropertyListSerialization.data(fromPropertyList: metadata, format: .xml, options: 0)
            .write(to: url.appendingPathComponent("Contents/Info.plist"))
        try manager.copyItem(at: fixture, to: url.appendingPathComponent("Contents/MacOS/mac2jb"))
        _ = try UpdatePackage.run("/usr/bin/codesign", ["--force", "--sign", "-", url.path])
    }
    static func plan(_ root: URL, fixture: URL, originalVersion: String = "1.0.0", version: String = "1.1.0",
                     originalBuild: Int = 1, build: Int = 1, advertisedBuild: Int? = nil,
                     minimumBuild: Int? = nil) throws -> UpdateInstallPlan {
        let directory = root.appendingPathComponent(UUID().uuidString)
        let destination = root.appendingPathComponent("installed-" + UUID().uuidString).appendingPathComponent("mac2jb.app")
        let candidate = directory.appendingPathComponent("unpacked/mac2jb.app")
        try app(destination, version: originalVersion, build: originalBuild, fixture: fixture)
        try app(candidate, version: version, build: build, fixture: fixture)
        return UpdateInstallPlan(directory: directory, destination: destination, version: version,
            build: advertisedBuild, minimumBuild: minimumBuild,
            originalSHA256: try UpdatePackage.sha256(destination.appendingPathComponent("Contents/MacOS/mac2jb")),
            updateSHA256: try UpdatePackage.sha256(candidate.appendingPathComponent("Contents/MacOS/mac2jb")), parentPID: getpid())
    }
    static func settle(_ updater: AppUpdater) async throws {
        for _ in 0..<500 {
            if !updater.isWorking { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw UpdateFailure("Fixture updater did not finish before its deadline.")
    }
    static func metadataTransport(_ root: URL, release: UpdateRelease) throws -> @Sendable (URL, Int64, Int64?) async throws -> URL {
        let data = try JSONEncoder().encode(release)
        return { url, _, _ in
            guard url.path.hasSuffix("/releases/latest") else { throw UpdateFailure("fixture download failure") }
            let file = root.appendingPathComponent(UUID().uuidString)
            try data.write(to: file, options: .withoutOverwriting)
            return file
        }
    }
    static func policyFixtures(_ root: URL, fixture: URL) async throws {
        let policyBody = "<!-- mac2jb-update: {\"build\":404,\"minimumBuild\":404} -->"
        let stable = try release { $0["body"] = policyBody }
        let candidate = try stable.validated()
        try expect(candidate.build == 404 && candidate.minimumBuild == 404, "strict release build policy parsed")
        try expect(candidate.isNewer(than: UpdateVersion("1.2.3"), build: 403), "same-version higher build is offered")
        try expect(!candidate.isNewer(than: UpdateVersion("1.2.3"), build: 404), "same build is not offered again")
        try expect(!candidate.isNewer(than: UpdateVersion("1.2.3"), build: 405), "same-version lower build cannot be offered")
        try expect(!candidate.isNewer(than: UpdateVersion("1.2.4"), build: 1), "higher build cannot downgrade version")
        try expect(try release().validated().build == nil, "legacy release without policy keeps version-only behavior")
        for json in ["{\"build\":404,\"minimumBuild\":405}", "{\"build\":0,\"minimumBuild\":0}",
                     "{\"build\":2147483648,\"minimumBuild\":404}", "{\"build\":404,\"minimumBuild\":-1}",
                     "{\"build\":\"404\",\"minimumBuild\":404}", "{\"build\":true,\"minimumBuild\":1}",
                     "{\"build\":404.0,\"minimumBuild\":404}", "{\"build\":4.04e2,\"minimumBuild\":404}",
                     "{\"build\":404,\"build\":405}", "{\"build\":404,\"minimumBuild\":404,\"force\":true}"] {
            try rejects("invalid policy \(json)") { _ = try release { $0["body"] = "<!-- mac2jb-update: \(json) -->" }.validated() }
        }
        try rejects("duplicate policy markers rejected") {
            _ = try release { $0["body"] = policyBody + policyBody }.validated()
        }
        try rejects("malformed policy marker rejected") { _ = try release { $0["body"] = "<!-- mac2jb-update: broken -->" }.validated() }
        try rejects("oversized policy-bearing body rejected") {
            _ = try release { $0["body"] = String(repeating: "x", count: 128 * 1024) + policyBody }.validated()
        }
        let requirement = try UpdateRequirement(stable)
        try expect(requirement.blocks(installedBuild: 403) && !requirement.blocks(installedBuild: 404), "required minimum applies only below supported build")
        let weaker = try release { $0["body"] = "<!-- mac2jb-update: {\"build\":405,\"minimumBuild\":403} -->" }
        try expect(requirement.incorporating(weaker).minimumBuild == 404, "new release cannot weaken cached required minimum")
        try expect(requirement.incorporating(release()).minimumBuild == 404, "missing marker cannot erase known requirement")
        try expect(UpdateRequirement.restored(requirement.encoded()).minimumBuild == 404, "validated policy survives cache round-trip")
        try rejects("foreign release cannot become cached requirement") {
            _ = try UpdateRequirement(release { $0["body"] = policyBody; $0["html_url"] = "https://github.com/other/repo/releases/tag/v1.2.3" })
        }

        let suite = "mac2jb-updater-fixture-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(false, forKey: "checkUpdatesAutomatically")
        defaults.set(Date(), forKey: "lastUpdateCheck")
        let transport = try metadataTransport(root, release: stable)
        let updater = AppUpdater(defaults: defaults, installedVersion: "1.2.3", installedBuild: 403,
                                 stagingParent: root.appendingPathComponent("fixture-staging"), updatesEnabled: true, transport: transport)
        updater.start(); try await settle(updater)
        try expect(updater.requiredUpdate && updater.blocksNewSession && updater.state == .available,
                   "launch checks required policy even with optional auto checks disabled")
        try expect(!updater.checksAutomatically, "critical check leaves optional update preference unchanged")
        updater.download(); try await settle(updater)
        try expect(updater.state == .failed && updater.blocksNewSession && updater.message.contains("fixture download failure"),
                   "download failure preserves required session block (\(updater.message))")
        updater.dismiss()
        try expect(updater.blocksNewSession && updater.state == .available, "dismiss cannot clear required update")

        let failingTransport: @Sendable (URL, Int64, Int64?) async throws -> URL = { _, _, _ in throw UpdateFailure("fixture offline") }
        let restored = AppUpdater(defaults: defaults, installedVersion: "1.2.3", installedBuild: 403,
                                  stagingParent: root.appendingPathComponent("fixture-staging"), updatesEnabled: true, transport: failingTransport)
        try expect(restored.blocksNewSession && restored.requiredUpdate, "known required policy blocks immediately after relaunch")
        restored.check(); try await settle(restored)
        try expect(restored.state == .failed && restored.blocksNewSession, "offline check cannot erase cached requirement")
        restored.dismiss(); try expect(restored.blocksNewSession, "dismissing offline error preserves block")
        let stale = AppUpdater(defaults: defaults, installedVersion: "1.2.3", installedBuild: 403,
                               stagingParent: root.appendingPathComponent("fixture-staging"), updatesEnabled: true, transport: try metadataTransport(root, release: weaker))
        stale.check(); try await settle(stale)
        try expect(stale.requiredUpdate && stale.blocksNewSession, "weaker fetched policy cannot unlock unsupported installed build")
        let supported = AppUpdater(defaults: defaults, installedVersion: "1.2.3", installedBuild: 404,
                                   stagingParent: root.appendingPathComponent("fixture-staging"), updatesEnabled: true, transport: transport)
        try expect(!supported.blocksNewSession && !supported.requiredUpdate, "installing supported build satisfies cached requirement")
        supported.check(); try await settle(supported)
        try expect(supported.state == .current && !supported.blocksNewSession,
                   "current advertised build remains usable after critical policy check")

        let freshSuite = "mac2jb-updater-fixture-" + UUID().uuidString
        let fresh = UserDefaults(suiteName: freshSuite)!
        defer { fresh.removePersistentDomain(forName: freshSuite) }
        fresh.set(false, forKey: "checkUpdatesAutomatically")
        let unknown = AppUpdater(defaults: fresh, installedVersion: "1.0.0", installedBuild: 1,
                                 stagingParent: root.appendingPathComponent("fixture-staging"), updatesEnabled: true, transport: failingTransport)
        unknown.start(); try await settle(unknown)
        try expect(!unknown.blocksNewSession && unknown.state == .idle, "network failure without known policy does not lock app")
        let optional = AppUpdater(defaults: fresh, installedVersion: "1.0.0", installedBuild: 1,
                                  stagingParent: root.appendingPathComponent("fixture-staging"), updatesEnabled: true, transport: try metadataTransport(root, release: release()))
        optional.start(); try await settle(optional)
        try expect(!optional.blocksNewSession && optional.state == .idle && optional.candidate == nil,
                   "required-policy check respects disabled optional update prompts")
        fresh.set(true, forKey: "checkUpdatesAutomatically")
        let lastOptionalCheck = Date()
        fresh.set(lastOptionalCheck, forKey: "lastUpdateCheck")
        let throttled = AppUpdater(defaults: fresh, installedVersion: "1.0.0", installedBuild: 1,
                                   stagingParent: root.appendingPathComponent("fixture-staging"), updatesEnabled: true,
                                   transport: try metadataTransport(root, release: release()))
        throttled.start(); try await settle(throttled)
        try expect(throttled.state == .idle && !throttled.blocksNewSession,
                   "critical launch fetch respects six-hour optional notification throttle")
        try expect(fresh.object(forKey: "lastUpdateCheck") as? Date == lastOptionalCheck,
                   "critical-only check does not postpone next optional check")

        let same = try plan(root, fixture: fixture, originalVersion: "1.2.3", version: "1.2.3", originalBuild: 403,
                            build: 404, advertisedBuild: 404, minimumBuild: 404)
        try UpdateInstaller.install(same)
        try expect(UpdatePackage.validateApp(same.destination, version: "1.2.3", build: 404) == 404,
                   "installer accepts independently validated higher build of same version")
        for build in [402, 403] {
            let equalOrOlder = try plan(root, fixture: fixture, originalVersion: "1.2.3", version: "1.2.3",
                                        originalBuild: 403, build: build, advertisedBuild: build)
            try rejects("installer refuses same-version build \(build) over403") { try UpdateInstaller.install(equalOrOlder) }
        }
        let mismatch = try plan(root, fixture: fixture, build: 404, advertisedBuild: 405)
        try rejects("downloaded bundle build must equal advertised policy build") { try UpdateInstaller.install(mismatch) }
        let belowMinimum = try plan(root, fixture: fixture, build: 403, advertisedBuild: 403, minimumBuild: 404)
        try rejects("installer independently enforces cached minimum") { try UpdateInstaller.install(belowMinimum) }

        // Exercise real download verification and canRestart guard with only
        // disposable, ad-hoc signed fixture apps and in-memory HTTP responses.
        let payload = root.appendingPathComponent("fixture-download/mac2jb.app")
        try app(payload, version: "1.2.3", build: 404, fixture: fixture)
        let zip = root.appendingPathComponent("fixture-update.zip")
        _ = try UpdatePackage.run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", payload.path, zip.path])
        let zipHash = try UpdatePackage.sha256(zip)
        let sums = root.appendingPathComponent("fixture-sums")
        try Data("\(zipHash)  mac2jb-v1.2.3-macos-arm64.zip\n".utf8).write(to: sums)
        let sumsHash = try UpdatePackage.sha256(sums)
        let zipData = try Data(contentsOf: zip), sumsData = try Data(contentsOf: sums)
        let downloadable = try release { row in
            row["body"] = policyBody
            var assets = row["assets"] as! [[String: Any]]
            assets[0]["size"] = zipData.count; assets[0]["digest"] = "sha256:" + zipHash
            assets[1]["size"] = sumsData.count; assets[1]["digest"] = "sha256:" + sumsHash
            row["assets"] = assets
        }
        let metadata = try JSONEncoder().encode(downloadable)
        let allFiles: @Sendable (URL, Int64, Int64?) async throws -> URL = { url, _, _ in
            let bytes = url.path.hasSuffix("/releases/latest") ? metadata : url.path.hasSuffix(".zip") ? zipData : sumsData
            let destination = root.appendingPathComponent(UUID().uuidString)
            try bytes.write(to: destination, options: .withoutOverwriting)
            return destination
        }
        let installed = root.appendingPathComponent("fixture-installed/mac2jb.app")
        try app(installed, version: "1.0.0", build: 1, fixture: fixture)
        let verified = AppUpdater(defaults: fresh, installedVersion: "1.0.0", installedBuild: 1, installedApp: installed,
                                  stagingParent: root.appendingPathComponent("fixture-staging"), updatesEnabled: true, transport: allFiles)
        verified.check(); try await settle(verified)
        verified.download(); try await settle(verified)
        try expect(verified.state == .ready && verified.blocksNewSession,
                   "real verified required update stays blocked until installed (\(verified.state): \(verified.message))")
        var interrupted = false
        verified.install(canRestart: false) { interrupted = true }
        try expect(!interrupted && verified.state == .ready && verified.blocksNewSession,
                   "active session restart guard never interrupts to install required update")
    }

    static func main() async throws {
        setbuf(stdout, nil)
        let root = manager.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("mac2jb-offline-updater-" + UUID().uuidString)
        try manager.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: root) }
        let fixture = URL(fileURLWithPath: CommandLine.arguments[1])
        try expect(UpdateVersion("0.3.10") > UpdateVersion("0.3.2"), "numeric version ordering")
        try expect(!(UpdateVersion("0.3.1") > UpdateVersion("0.3.2")), "older releases cannot trigger an update")
        for version in ["0.3", "0.3.2-beta", "01.2.3", "1.2.3.4", "../1.2.3"] {
            try rejects("invalid version \(version)") { _ = try UpdateVersion(version) }
        }
        try expect(try release().validated().version.text == "1.2.3", "stable release metadata accepted")
        try rejects("prerelease rejected") { _ = try release { $0["prerelease"] = true }.validated() }
        try rejects("draft rejected") { _ = try release { $0["draft"] = true }.validated() }
        try rejects("missing assets rejected") { _ = try release { $0["assets"] = [] }.validated() }
        try rejects("foreign repository rejected") {
            _ = try release { row in
                var assets = row["assets"] as! [[String: Any]]
                assets[0]["browser_download_url"] = "https://github.com/other/app/releases/download/v1.2.3/mac2jb-v1.2.3-macos-arm64.zip"
                row["assets"] = assets
            }.validated()
        }
        try rejects("oversized archive rejected") {
            _ = try release { row in
                var assets = row["assets"] as! [[String: Any]]
                assets[0]["size"] = UpdatePackage.maximumArchiveBytes + 1
                row["assets"] = assets
            }.validated()
        }
        try expect(try release { row in
            var assets = row["assets"] as! [[String: Any]]
            assets[0]["size"] = 350 * 1024 * 1024
            row["assets"] = assets
        }.validated().archive.size == 350 * 1024 * 1024, "published-size archive accepted")
        try rejects("missing digest rejected") { _ = try UpdateRelease.digest(nil) }
        let digest = String(repeating: "a", count: 64), filename = "mac2jb-v1.2.3-macos-arm64.zip"
        try expect(UpdatePackage.checksum(in: Data("\(digest)  \(filename)\n".utf8), filename: filename) == digest, "checksum entry parsed")
        try rejects("duplicate checksum rejected") {
            _ = try UpdatePackage.checksum(in: Data(String(repeating: "\(digest)  \(filename)\n", count: 2).utf8), filename: filename)
        }
        let setup = try plan(root, fixture: fixture)
        try UpdatePackage.validateApp(setup.candidate, version: setup.version)
        passed += 1; print("PASS real ad-hoc signed fixture validates")
        try rejects("wrong app version rejected") { try UpdatePackage.validateApp(setup.candidate, version: "9.9.9") }
        let archive = root.appendingPathComponent("good.zip")
        _ = try UpdatePackage.run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", setup.candidate.path, archive.path])
        try UpdatePackage.validateArchive(archive)
        passed += 1; print("PASS real single-app ZIP validates")
        let bad = root.appendingPathComponent("bad.zip")
        let bytes = try Data(contentsOf: archive)
        try bytes.prefix(40).write(to: bad)
        try rejects("truncated archive rejected") { try UpdatePackage.validateArchive(bad) }
        var traversal = bytes
        let from = Data("mac2jb.app/Contents/Info.plist".utf8)
        let to = Data("mac2jb.app/../other/Info.plist".utf8)
        precondition(from.count == to.count)
        while let range = traversal.range(of: from) { traversal.replaceSubrange(range, with: to) }
        try traversal.write(to: bad)
        try rejects("archive traversal rejected before extraction") { try UpdatePackage.validateArchive(bad) }
        let link = setup.candidate.appendingPathComponent("Contents/link")
        try manager.createSymbolicLink(at: link, withDestinationURL: fixture)
        _ = try UpdatePackage.run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--keepParent", setup.candidate.path, bad.path])
        try rejects("archive symlink rejected before extraction") { try UpdatePackage.validateArchive(bad) }
        try manager.removeItem(at: link)
        try UpdateInstaller.install(setup)
        try UpdatePackage.validateApp(setup.destination, version: "1.1.0")
        try UpdatePackage.validateApp(setup.backup, version: "1.0.0")
        passed += 1; print("PASS disposable app replaced with recoverable old-version backup")
        let rollback = try plan(root, fixture: fixture)
        try rejects("injected install failure triggers rollback") {
            try UpdateInstaller.install(rollback) { throw UpdateFailure("injected failure") }
        }
        try UpdatePackage.validateApp(rollback.destination, version: "1.0.0")
        try expect(!manager.fileExists(atPath: rollback.backup.path), "original restored after failed replacement")
        let changed = try plan(root, fixture: fixture)
        let binary = changed.candidate.appendingPathComponent("Contents/MacOS/mac2jb")
        let handle = try FileHandle(forWritingTo: binary); try handle.seekToEnd(); try handle.write(contentsOf: Data([1])); try handle.close()
        try rejects("tampered update cannot replace original") { try UpdateInstaller.install(changed) }
        try UpdatePackage.validateApp(changed.destination, version: "1.0.0")
        try expect(!manager.fileExists(atPath: changed.backup.path), "failed validation leaves original untouched")
        let downgrade = try plan(root, fixture: fixture)
        let older = UpdateInstallPlan(directory: downgrade.directory, destination: downgrade.destination,
            version: "0.9.0", originalSHA256: downgrade.originalSHA256, updateSHA256: downgrade.updateSHA256, parentPID: getpid())
        try rejects("installer independently refuses a downgrade") { try UpdateInstaller.install(older) }
        try UpdatePackage.validateApp(downgrade.destination, version: "1.0.0")
        let afterMove = try plan(root, fixture: fixture)
        try rejects("post-copy validation failure rolls back the original") {
            try UpdateInstaller.install(afterMove) {
                let incoming = afterMove.destination.deletingLastPathComponent()
                    .appendingPathComponent(".mac2jb-incoming-" + afterMove.directory.lastPathComponent + ".app")
                try Data("invalid plist".utf8).write(to: incoming.appendingPathComponent("Contents/Info.plist"))
            }
        }
        try UpdatePackage.validateApp(afterMove.destination, version: "1.0.0")
        try expect(manager.fileExists(atPath: afterMove.directory.appendingPathComponent("failed-update.app").path), "failed replacement retained for diagnosis after restoring original")
        let collision = try plan(root, fixture: fixture)
        try manager.createDirectory(at: collision.backup, withIntermediateDirectories: false)
        try rejects("an existing backup is never overwritten") { try UpdateInstaller.install(collision) }
        try UpdatePackage.validateApp(collision.destination, version: "1.0.0")
        let sleeper = Process()
        sleeper.executableURL = URL(fileURLWithPath: "/bin/sleep"); sleeper.arguments = ["2"]
        try sleeper.run()
        try rejects("helper wait has a deadline and does not stop the parent") {
            try UpdateInstaller.waitForExit(sleeper.processIdentifier, timeout: 0.01)
        }
        try expect(sleeper.isRunning, "timeout leaves the running parent alone")
        sleeper.terminate(); sleeper.waitUntilExit()
        try UpdateInstaller.waitForExit(sleeper.processIdentifier, timeout: 0.01)
        passed += 1; print("PASS helper proceeds only after parent exits")
        try await policyFixtures(root, fixture: fixture)
        print("\(passed) offline updater checks passed; no installed app, driver, or session changed.")
    }
}
