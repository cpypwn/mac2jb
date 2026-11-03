import AppKit
import Foundation
import Combine

private final class UpdateDownloadGuard: NSObject, URLSessionDownloadDelegate {
    let limit: Int64
    let progress: @Sendable (Double) -> Void
    init(limit: Int64, progress: @escaping @Sendable (Double) -> Void = { _ in }) {
        self.limit = limit; self.progress = progress
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten > limit || totalBytesExpectedToWrite > limit { downloadTask.cancel(); return }
        if totalBytesExpectedToWrite > 0 { progress(min(1, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(Self.allowed(request.url) ? request : nil)
    }
    static func allowed(_ url: URL?) -> Bool {
        guard let url, url.scheme == "https", url.user == nil, url.password == nil, url.port == nil,
              let host = url.host else { return false }
        return ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].contains(host)
    }
}

@MainActor final class AppUpdater: ObservableObject {
    enum State: Equatable { case idle, checking, available, downloading, ready, installing, current, failed }
    @Published private(set) var state: State = .idle
    @Published private(set) var message = ""
    @Published private(set) var progress: Double = 0
    @Published private(set) var candidate: UpdateCandidate?
    @Published private(set) var diagnosticURL: URL?
    @Published private(set) var requiredUpdate = false
    @Published var checksAutomatically: Bool {
        didSet { defaults.set(checksAutomatically, forKey: "checkUpdatesAutomatically") }
    }
    static let requirementCacheKey = "validatedRequiredUpdateRelease-v1"
    private let defaults: UserDefaults
    private let installedVersion: String?
    private let installedBuild: Int?
    private let installedApp: URL?
    private let stagingParent: URL?
    private let updatesEnabled: Bool
    private let transport: (@Sendable (URL, Int64, Int64?) async throws -> URL)?
    private var requirement: UpdateRequirement?
    private var plan: UpdateInstallPlan?
    private var task: Task<Void, Never>?
    private var periodicCheck: Task<Void, Never>?
    private var started = false

    init(defaults: UserDefaults = .standard, installedVersion: String? = nil, installedBuild: Int? = nil,
         installedApp: URL? = nil, stagingParent: URL? = nil,
         updatesEnabled: Bool = !AppBuildIdentity.isTestBuild,
         transport: (@Sendable (URL, Int64, Int64?) async throws -> URL)? = nil) {
        self.defaults = defaults; self.installedVersion = installedVersion; self.installedBuild = installedBuild
        self.installedApp = installedApp
        self.stagingParent = stagingParent
        self.updatesEnabled = updatesEnabled; self.transport = transport
        self.checksAutomatically = updatesEnabled &&
            (defaults.object(forKey: "checkUpdatesAutomatically") as? Bool ?? true)
        if updatesEnabled, let data = defaults.data(forKey: Self.requirementCacheKey),
           let cached = try? UpdateRequirement.restored(data) {
            requirement = cached
            requiredUpdate = cached.blocks(installedBuild: currentBuild)
            if requiredUpdate {
                candidate = cached.candidate.isNewer(than: (try? UpdateVersion(currentVersion)) ?? cached.candidate.version,
                                                     build: currentBuild) ? cached.candidate : nil
                state = candidate == nil ? .failed : .available
                message = requiredMessage
            }
        }
    }

    var blocksNewSession: Bool { requiredUpdate || state == .installing }
    var isWorking: Bool { [.checking, .downloading, .installing].contains(state) }
    var currentVersion: String { installedVersion ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0" }
    var currentBuild: Int {
        installedBuild ?? (try? UpdateBuild.parse(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "")) ?? 0
    }
    private var requiredMessage: String {
        "An update is required before starting a new session. Finish any current session first, then update mac2jb." +
        (candidate.map { " Required release: \($0.displayVersion)." } ?? " Check for updates to continue.")
    }

    func start() {
        guard !started else { return }; started = true
        guard updatesEnabled else { return }
        // Required policy is checked even if optional automatic updates are off.
        check(manual: false, policyCheck: true)
        periodicCheck = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(24 * 60 * 60))
                guard !Task.isCancelled, let self else { return }
                self.check(manual: false, policyCheck: true)
            }
        }
    }

    func check(manual: Bool = true, policyCheck: Bool = false) {
        guard updatesAllowed(manual: manual) else { return }
        guard !isWorking, state != .ready else { return }
        let last = defaults.object(forKey: "lastUpdateCheck") as? Date
        let optionalDue = last.map { Date().timeIntervalSince($0) >= 6 * 60 * 60 } ?? true
        if !manual, !policyCheck, !optionalDue { return }
        let offerOptional = manual || checksAutomatically && optionalDue
        state = .checking; message = requiredUpdate ? requiredMessage : "Checking for updates…"
        task = Task {
            do {
                let url = URL(string: "https://api.github.com/repos/cpypwn/mac2jb/releases/latest")!
                let file = try await fetchFile(url, limit: 1024 * 1024)
                defer { try? FileManager.default.removeItem(at: file) }
                let release = try JSONDecoder().decode(UpdateRelease.self, from: Data(contentsOf: file))
                let update = try release.validated()
                if let known = requirement {
                    requirement = try known.incorporating(release)
                } else if let minimum = update.minimumBuild, minimum > 0 {
                    requirement = try UpdateRequirement(release)
                }
                if let requirement {
                    defaults.set(try requirement.encoded(), forKey: Self.requirementCacheKey)
                }
                requiredUpdate = requirement?.blocks(installedBuild: currentBuild) ?? false
                if offerOptional { defaults.set(Date(), forKey: "lastUpdateCheck") }
                let installed = try UpdateVersion(currentVersion)
                if requiredUpdate {
                    let choices = [update, requirement?.candidate].compactMap { $0 }.filter {
                        $0.isNewer(than: installed, build: currentBuild) && ($0.build ?? 0) >= (requirement?.minimumBuild ?? 0)
                    }
                    candidate = choices.max {
                        $0.version == $1.version ? ($0.build ?? 0) < ($1.build ?? 0) : $0.version < $1.version
                    }
                    state = candidate == nil ? .failed : .available
                    message = requiredMessage
                } else if update.isNewer(than: installed, build: currentBuild), offerOptional {
                    candidate = update; state = .available
                    message = "mac2jb \(update.displayVersion) is available."
                } else {
                    candidate = nil; state = manual ? .current : .idle
                    message = "You’re up to date — mac2jb \(currentVersion)."
                }
            } catch {
                if manual || requiredUpdate {
                    state = .failed; message = (requiredUpdate ? requiredMessage + " " : "") +
                        "Could not check for updates: \(error.localizedDescription)"
                    if diagnosticURL == nil, let folder = try? Self.makeStagingDirectory(parent: stagingParent) {
                        diagnosticURL = folder.appendingPathComponent("update.log")
                    }
                    log(message)
                }
                else { state = .idle; message = "" }
            }
        }
    }

    func download() {
        guard updatesAllowed(manual: true) else { return }
        guard state == .available || state == .failed, let candidate else { return }
        plan = nil; diagnosticURL = nil
        state = .downloading; progress = 0; message = "Downloading mac2jb \(candidate.displayVersion)…"
        task = Task {
            do {
                let root = try Self.makeStagingDirectory(parent: stagingParent)
                diagnosticURL = root.appendingPathComponent("update.log")
                log("Downloading stable release \(candidate.version.text) from cpypwn/mac2jb.")
                let sums = try await fetchFile(candidate.checksums.browser_download_url, limit: 16384,
                                                expected: candidate.checksums.size)
                defer { try? FileManager.default.removeItem(at: sums) }
                guard try UpdatePackage.sha256(sums) == UpdateRelease.digest(candidate.checksums.digest) else {
                    throw UpdateFailure("The checksum-file digest does not match GitHub’s release metadata.")
                }
                let expected = try UpdatePackage.checksum(in: Data(contentsOf: sums), filename: candidate.archive.name)
                guard try expected == UpdateRelease.digest(candidate.archive.digest) else {
                    throw UpdateFailure("The published app checksums disagree. Please try again later.")
                }
                let temporary = try await fetchFile(candidate.archive.browser_download_url, limit: Int64(UpdatePackage.maximumArchiveBytes),
                                                      expected: candidate.archive.size) { [weak self] fraction in
                    Task { @MainActor in self?.progress = fraction }
                }
                let archive = root.appendingPathComponent("update.zip")
                try FileManager.default.moveItem(at: temporary, to: archive)
                message = "Verifying the downloaded app…"
                let version = candidate.version.text
                let minimumBuild = requirement?.minimumBuild
                let staged = try await Task.detached(priority: .userInitiated) {
                    guard try UpdatePackage.sha256(archive) == expected else {
                        throw UpdateFailure("The update checksum did not match. The installed app was left unchanged.")
                    }
                    try UpdatePackage.validateArchive(archive)
                    let folder = root.appendingPathComponent("unpacked", isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false,
                                                             attributes: [.posixPermissions: 0o700])
                    _ = try UpdatePackage.run("/usr/bin/ditto", ["-x", "-k", archive.path, folder.path])
                    let app = folder.appendingPathComponent("mac2jb.app", isDirectory: true)
                    let build = try UpdatePackage.validateApp(app, version: version, build: candidate.build,
                                                             minimumBuild: minimumBuild)
                    return (app, build)
                }.value
                let (app, build) = staged
                let destination = (installedApp ?? Bundle.main.bundleURL).resolvingSymlinksInPath()
                plan = UpdateInstallPlan(directory: root, destination: destination, version: version, build: build,
                    minimumBuild: minimumBuild,
                    originalSHA256: try UpdatePackage.sha256(destination.appendingPathComponent("Contents/MacOS/mac2jb")),
                    updateSHA256: try UpdatePackage.sha256(app.appendingPathComponent("Contents/MacOS/mac2jb")), parentPID: getpid())
                state = .ready; progress = 1
                message = "mac2jb \(version) is verified and ready to install."
                log("Download, SHA-256, archive, bundle version, architecture, and code integrity checks passed.")
            } catch {
                state = .failed; message = (requiredUpdate ? requiredMessage + " " : "") + "Update failed: \(error.localizedDescription)"
                log(message)
            }
        }
    }

    func install(canRestart: Bool, willInstall: () -> Void) {
        guard updatesAllowed(manual: true) else { return }
        guard state == .ready, let plan else { return }
        guard canRestart else { message = "Finish or stop the current session and wait for its workers before updating."; return }
        do {
            let parent = plan.destination.deletingLastPathComponent()
            guard FileManager.default.isWritableFile(atPath: parent.path), !plan.destination.path.contains("/AppTranslocation/") else {
                throw UpdateFailure("Move mac2jb to a writable folder, such as your Applications folder, then reopen it to update.")
            }
            let helper = plan.directory.appendingPathComponent("mac2jb-update-helper")
            guard let executable = Bundle.main.executableURL else { throw UpdateFailure("The running app cannot be located.") }
            try FileManager.default.copyItem(at: executable, to: helper)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
            let planURL = plan.directory.appendingPathComponent("install-plan.json")
            try JSONEncoder().encode(plan).write(to: planURL, options: .withoutOverwriting)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: planURL.path)
            let process = Process()
            process.executableURL = helper; process.arguments = ["--finish-update", planURL.path]
            process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            state = .installing
            log("Restarting to update. The installer preserves a sibling backup of the previous app.")
            willInstall()
            NSApp.terminate(nil)
        } catch {
            state = .failed; message = "Could not install the update: \(error.localizedDescription)"
            log(message)
        }
    }

    func dismiss() {
        guard !isWorking else { return }
        if requiredUpdate {
            state = candidate == nil ? .failed : .available
            message = requiredMessage
            return
        }
        if state == .failed || state == .current { state = .idle; message = "" }
    }

    private func updatesAllowed(manual: Bool) -> Bool {
        guard !updatesEnabled else { return true }
        if manual {
            candidate = nil; state = .current
            message = AppBuildIdentity.updatesDisabledMessage
        }
        return false
    }

    private func fetchFile(_ url: URL, limit: Int64, expected: Int64? = nil,
                           progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> URL {
        if let transport { return try await transport(url, limit, expected) }
        return try await Self.fetch(url, limit: limit, expected: expected, progress: progress)
    }

    func revealLog() { if let diagnosticURL { NSWorkspace.shared.activateFileViewerSelecting([diagnosticURL]) } }

    var hasDownloadedApp: Bool { plan != nil }
    func revealDownloadedApp() {
        if let plan { NSWorkspace.shared.activateFileViewerSelecting([plan.candidate]) }
    }

    private func log(_ message: String) {
        guard let diagnosticURL else { return }
        if let handle = try? FileHandle(forWritingTo: diagnosticURL) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data((ISO8601DateFormatter().string(from: Date()) + " " + message + "\n").utf8))
        }
    }

    private static func makeStagingDirectory(parent customParent: URL? = nil) throws -> URL {
        let manager = FileManager.default
        let parent: URL
        if let customParent { parent = customParent }
        else {
            let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            parent = support.appendingPathComponent("mac2jb/Updates", isDirectory: true)
        }
        try manager.createDirectory(at: parent, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let resolved = parent.resolvingSymlinksInPath()
        var info = stat()
        guard lstat(parent.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), parent.path == resolved.path else {
            throw UpdateFailure("The update folder is not a regular directory owned by this user.")
        }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path)
        let root = parent.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let log = root.appendingPathComponent("update.log")
        guard manager.createFile(atPath: log.path, contents: Data(), attributes: [.posixPermissions: 0o600]) else {
            throw UpdateFailure("The private updater log could not be created.")
        }
        return root
    }

    nonisolated static func fetch(_ url: URL, limit: Int64, expected: Int64? = nil,
                                          progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> URL {
        guard UpdateDownloadGuard.allowed(url) else { throw UpdateFailure("The update URL is not trusted.") }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30; configuration.timeoutIntervalForResource = 300
        configuration.httpShouldSetCookies = false; configuration.urlCache = nil
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.setValue("mac2jb-updater", forHTTPHeaderField: "User-Agent")
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (file, response) = try await session.download(for: request, delegate: UpdateDownloadGuard(limit: limit, progress: progress))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, UpdateDownloadGuard.allowed(http.url) else {
            try? FileManager.default.removeItem(at: file)
            throw UpdateFailure("GitHub could not provide the update (it may be temporarily rate-limited).")
        }
        let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.int64Value ?? -1
        guard size > 0, size <= limit, expected == nil || expected == size else {
            try? FileManager.default.removeItem(at: file)
            throw UpdateFailure("The update download was incomplete or exceeded its size limit.")
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return file
    }
}
