import AppKit
import Combine
import CryptoKit
import Darwin
import Foundation

struct BrowserResearchProbe: Decodable, Identifiable {
    let id: String
    let title: String
    let description: String
}

@MainActor final class WebKitResearchModel: ObservableObject {
    enum SourceMode: String, CaseIterable, Identifiable {
        case bundled
        case upstream
        case localFolder

        var id: String { rawValue }
    }

    @Published var sourceMode: SourceMode = .bundled
    @Published var selectedProbeID = "runtime"
    @Published private(set) var probes: [BrowserResearchProbe] = []
    @Published private(set) var sourceURL: URL?
    @Published private(set) var storedURL: URL?
    @Published private(set) var upstreamStoredURL: URL?
    @Published private(set) var status = "Preparing included browser probes"
    @Published private(set) var readyURL: URL?
    @Published private(set) var reportURL: URL?
    @Published private(set) var isRunning = false

    private struct Catalog: Decodable {
        let version: Int
        let probes: [BrowserResearchProbe]
    }

    private struct UpstreamProvenance: Decodable {
        let revision: String
        let files: [String: String]
    }

    private enum ProbeError: LocalizedError {
        case unavailable
        case invalidBundle
        case modifiedCopy

        var errorDescription: String? {
            switch self {
            case .unavailable: return "Wait for the bundled tools to finish preparing"
            case .invalidBundle: return "The included browser probes are missing or invalid"
            case .modifiedCopy: return "The stored probe copy has changed; move it aside before trying again"
            }
        }
    }

    private let bundleFiles = ["manifest.json", "index.html", "style.css", "probes.js"]
    private var process: Process?
    private var output: Pipe?
    private var pendingOutput = ""
    private var stopping = false
    private var reportedFailure = false
    private var activeAddress = ""

    func loadCatalog(runtimeRoot: URL?) {
        guard !isRunning else { return }
        readyURL = nil
        guard let runtimeRoot else {
            status = "Preparing included browser probes"
            return
        }
        do {
            let source = runtimeRoot.appendingPathComponent("integrations/browser-probes", isDirectory: true)
            let data = try Data(contentsOf: source.appendingPathComponent("manifest.json"))
            guard data.count <= 32 * 1024 else { throw ProbeError.invalidBundle }
            let catalog = try JSONDecoder().decode(Catalog.self, from: data)
            let expected = Set(["runtime", "media", "network", "boundaries", "fonts", "webkit", "fontenv"])
            guard catalog.version == 1, catalog.probes.count == expected.count,
                  Set(catalog.probes.map(\.id)) == expected,
                  catalog.probes.allSatisfy({ !$0.title.isEmpty && $0.title.utf8.count <= 80 &&
                      !$0.description.isEmpty && $0.description.utf8.count <= 250 }) else {
                throw ProbeError.invalidBundle
            }
            let location = try stage(source: source)
            probes = catalog.probes
            storedURL = location
            if !probes.contains(where: { $0.id == selectedProbeID }) {
                selectedProbeID = probes[0].id
            }
            if sourceMode == .bundled { status = "Included browser probes are ready on this Mac" }
        } catch {
            probes = []
            storedURL = nil
            if sourceMode == .bundled { status = error.localizedDescription }
        }
        do {
            upstreamStoredURL = try stageUpstream(runtimeRoot: runtimeRoot)
            if sourceMode == .upstream { status = "Included upstream research is ready on this Mac" }
        } catch {
            upstreamStoredURL = nil
            if sourceMode == .upstream { status = error.localizedDescription }
        }
        if sourceMode == .upstream {
            reportURL = upstreamStoredURL?.appendingPathComponent("work/browser-probe/reports", isDirectory: true)
        } else if sourceMode == .localFolder {
            reportURL = nil
        }
    }

    func selectSource(_ url: URL) {
        guard !isRunning else { return }
        sourceURL = url.standardizedFileURL
        sourceMode = .localFolder
        readyURL = nil
        status = "Selected \(url.lastPathComponent). Start the local research page"
    }

    func start(runtimeRoot: URL?, address: String) {
        guard !isRunning, let runtimeRoot,
              NetworkSelection.isIPv4(address),
              NetworkSelection.localAddresses().contains(where: { $0.address == address }) else {
            status = "Choose a current Mac network address"
            return
        }
        let node = runtimeRoot.appendingPathComponent("node")
        let helper: URL
        let arguments: [String]
        let prefix: String
        if sourceMode == .bundled {
            if storedURL == nil { loadCatalog(runtimeRoot: runtimeRoot) }
            guard let storedURL, probes.contains(where: { $0.id == selectedProbeID }),
                  let reportURL else {
                status = "The included browser probes are unavailable"
                return
            }
            helper = runtimeRoot.appendingPathComponent("scripts/gui-bundled-browser-probes.cjs")
            arguments = [helper.path, "serve", "--address", address, "--probe", selectedProbeID,
                         "--reports", reportURL.path, "--source", storedURL.path]
            prefix = "MAC2JB_BROWSER "
        } else {
            let selected = sourceMode == .upstream ? upstreamStoredURL : sourceURL
            guard let selected else {
                status = sourceMode == .upstream
                    ? "The included upstream research is unavailable" : "Choose a local research folder"
                return
            }
            helper = runtimeRoot.appendingPathComponent("scripts/gui-webkit-research.cjs")
            arguments = [helper.path, "serve", "--folder", selected.path, "--address", address]
            prefix = "MAC2JB_WEBKIT "
        }
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: helper.path) else {
            status = "The browser research adapter is missing from this app"
            return
        }
        let task = Process()
        let pipe = Pipe()
        task.executableURL = node
        task.arguments = arguments
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = pipe
        task.standardError = pipe
        pendingOutput = ""
        readyURL = nil
        stopping = false
        reportedFailure = false
        activeAddress = address
        status = "Starting the local research page"
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor [weak self] in self?.consume(data, prefix: prefix) }
        }
        task.terminationHandler = { [weak self] finished in
            Task { @MainActor [weak self] in self?.finished(code: finished.terminationStatus) }
        }
        do {
            try task.run()
            output = pipe
            process = task
            isRunning = true
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            status = "Could not start the research page: \(error.localizedDescription)"
        }
    }

    func stop() {
        guard let process, process.isRunning else { return }
        stopping = true
        status = "Stopping the research page"
        process.terminate()
    }

    func stopForTermination() {
        output?.fileHandleForReading.readabilityHandler = nil
        if let process, process.isRunning { process.terminate() }
    }

    private func stage(source: URL) throws -> URL {
        let expected = try fingerprint(source)
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw ProbeError.unavailable
        }
        let base = support.appendingPathComponent("mac2jb/Browser Research", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let reports = base.appendingPathComponent("Reports", isDirectory: true)
        try FileManager.default.createDirectory(at: reports, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let destination = base.appendingPathComponent("Probes-v1-\(expected.prefix(12))", isDirectory: true)
        if FileManager.default.fileExists(atPath: destination.path) {
            guard try fingerprint(destination) == expected else { throw ProbeError.modifiedCopy }
        } else {
            let staging = base.appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            do {
                for name in bundleFiles {
                    try FileManager.default.copyItem(at: source.appendingPathComponent(name),
                                                     to: staging.appendingPathComponent(name))
                }
                try FileManager.default.moveItem(at: staging, to: destination)
            } catch {
                try? FileManager.default.removeItem(at: staging)
                throw error
            }
        }
        reportURL = reports
        return destination
    }

    private func stageUpstream(runtimeRoot: URL) throws -> URL {
        let manifestURL = runtimeRoot.appendingPathComponent("packaging/switch2-browser-research-provenance.json")
        let manifestData = try Data(contentsOf: manifestURL)
        guard manifestData.count < 16 * 1024,
              let provenance = try? JSONDecoder().decode(UpstreamProvenance.self, from: manifestData),
              provenance.revision == "07cd867af2f1dc8f7b6ce59d964c3827cc3997b3",
              provenance.files.count == 28,
              ["serve-switch2-browser-probe.py", "switch2-browser-probe.html",
               "switch2-probes-runtime.js", "switch2-probes-media.js",
               "switch2-probes-network.js", "switch2-probes-boundaries.js",
               "switch2-probes-fonts.js", "switch2-probes-webkit.js",
               "switch2-probes-fontenv.js", "probe-fixtures/probe-h264.mp4",
               "probe-fixtures/probe-vp8.webm", "probe-fixtures/probe-vp9.webm"]
                .allSatisfy({ provenance.files[$0] != nil }) else {
            throw ProbeError.invalidBundle
        }
        let source = runtimeRoot.appendingPathComponent("vendor/switch2-captive-portal-research", isDirectory: true)
        try Self.verifyUpstreamFiles(source, hashes: provenance.files)
        guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw ProbeError.unavailable
        }
        let base = support.appendingPathComponent("mac2jb/Browser Research", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let destination = base.appendingPathComponent("Upstream-\(provenance.revision.prefix(12))", isDirectory: true)
        if FileManager.default.fileExists(atPath: destination.path) {
            let info = try destination.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard info.isDirectory == true, info.isSymbolicLink != true else {
                throw ProbeError.modifiedCopy
            }
            do { try Self.verifyUpstreamFiles(destination, hashes: provenance.files, allowReports: true) }
            catch { throw ProbeError.modifiedCopy }
        } else {
            let staging = base.appendingPathComponent(".upstream-staging-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            do {
                for name in provenance.files.keys.sorted() {
                    let target = staging.appendingPathComponent(name)
                    try FileManager.default.createDirectory(at: target.deletingLastPathComponent(),
                                                            withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: source.appendingPathComponent(name), to: target)
                }
                try Self.verifyUpstreamFiles(staging, hashes: provenance.files)
                try FileManager.default.moveItem(at: staging, to: destination)
            } catch {
                try? FileManager.default.removeItem(at: staging)
                throw error
            }
        }
        return destination
    }

    static func verifyUpstreamFiles(_ folder: URL, hashes: [String: String],
                                    allowReports: Bool = false) throws {
        let rootInfo = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard rootInfo.isDirectory == true, rootInfo.isSymbolicLink != true else {
            throw ProbeError.invalidBundle
        }
        guard let resolved = realpath(folder.path, nil) else { throw ProbeError.invalidBundle }
        let canonicalFolder = URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
        free(resolved)
        for (name, expected) in hashes {
            let parts = name.split(separator: "/", omittingEmptySubsequences: false)
            guard !parts.isEmpty && parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
                  expected.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
                throw ProbeError.invalidBundle
            }
            var parent = canonicalFolder
            for part in parts.dropLast() {
                parent.appendPathComponent(String(part), isDirectory: true)
                let info = try parent.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard info.isDirectory == true, info.isSymbolicLink != true else {
                    throw ProbeError.invalidBundle
                }
            }
            let file = canonicalFolder.appendingPathComponent(name)
            let info = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard info.isRegularFile == true, info.isSymbolicLink != true,
                  let size = info.fileSize, size > 0, size <= 2 * 1024 * 1024 else {
                throw ProbeError.invalidBundle
            }
            let digest = SHA256.hash(data: try Data(contentsOf: file))
                .map { String(format: "%02x", $0) }.joined()
            guard digest == expected else { throw ProbeError.invalidBundle }
        }
        let sourceFiles = Set(hashes.keys)
        var sourceFolders = Set<String>()
        for name in sourceFiles {
            let parts = name.split(separator: "/")
            for count in 1..<parts.count {
                sourceFolders.insert(parts.prefix(count).joined(separator: "/"))
            }
        }
        let generatedFolders: Set<String> = ["work", "work/browser-probe", "work/browser-probe/reports"]
        guard let entries = FileManager.default.enumerator(at: canonicalFolder,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey]) else {
            throw ProbeError.invalidBundle
        }
        for case let entry as URL in entries {
            guard entry.path.hasPrefix(canonicalFolder.path + "/") else { throw ProbeError.invalidBundle }
            let relative = String(entry.path.dropFirst(canonicalFolder.path.count + 1))
            let info = try entry.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey,
                                                          .isSymbolicLinkKey, .fileSizeKey])
            guard info.isSymbolicLink != true else { throw ProbeError.invalidBundle }
            if info.isDirectory == true {
                guard sourceFolders.contains(relative) ||
                      allowReports && generatedFolders.contains(relative) else {
                    throw ProbeError.invalidBundle
                }
            } else if info.isRegularFile == true {
                if sourceFiles.contains(relative) { continue }
                guard allowReports, let size = info.fileSize, size <= 256 * 1024 else {
                    throw ProbeError.invalidBundle
                }
                let control = relative == "work/browser-probe/live-control.json" && size <= 8 * 1024
                let report = relative.hasPrefix("work/browser-probe/reports/") &&
                    relative.dropFirst("work/browser-probe/reports/".count)
                        .range(of: "^(report-[0-9]{8}T[0-9]{12}Z-[a-f0-9]{8}|live-[0-9]{8}T[0-9]{12}Z-[a-f0-9]{32})\\.json$",
                               options: .regularExpression) != nil
                guard control || report else { throw ProbeError.invalidBundle }
            } else {
                throw ProbeError.invalidBundle
            }
        }
    }

    private func fingerprint(_ folder: URL) throws -> String {
        var combined = Data()
        for name in bundleFiles {
            let file = folder.appendingPathComponent(name)
            let info = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard info.isRegularFile == true, info.isSymbolicLink != true,
                  let size = info.fileSize, size > 0, size <= 2 * 1024 * 1024 else {
                throw ProbeError.invalidBundle
            }
            combined.append(contentsOf: name.utf8)
            combined.append(0)
            combined.append(try Data(contentsOf: file))
        }
        return SHA256.hash(data: combined).map { String(format: "%02x", $0) }.joined()
    }

    private func consume(_ data: Data, prefix: String) {
        guard !data.isEmpty else { return }
        pendingOutput += String(decoding: data, as: UTF8.self)
        if pendingOutput.utf8.count > 32_768 {
            status = "The research server produced too much output"
            stop()
            return
        }
        while let newline = pendingOutput.firstIndex(of: "\n") {
            let line = String(pendingOutput[..<newline])
            pendingOutput.removeSubrange(...newline)
            guard line.hasPrefix(prefix),
                  let data = line.dropFirst(prefix.count).data(using: .utf8),
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = value["type"] as? String else { continue }
            switch type {
            case "ready":
                if let raw = value["url"] as? String, let url = URL(string: raw),
                   url.scheme == "http", url.host == activeAddress {
                    readyURL = url
                    status = "Research page ready at \(url.absoluteString)"
                }
                if let folder = value["reportFolder"] as? String { reportURL = URL(fileURLWithPath: folder) }
            case "failed":
                reportedFailure = true
                status = String((value["message"] as? String ?? "The research server failed").prefix(500))
            case "log":
                if readyURL == nil, let message = value["message"] as? String {
                    status = String(message.prefix(500))
                }
            default: break
            }
        }
    }

    private func finished(code: Int32) {
        output?.fileHandleForReading.readabilityHandler = nil
        output = nil
        process = nil
        isRunning = false
        if stopping { status = "Research page stopped" }
        else if code != 0 && !reportedFailure { status = "Research page exited with status \(code)" }
        stopping = false
        readyURL = nil
    }
}
