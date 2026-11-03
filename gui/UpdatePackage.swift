import Foundation
import CryptoKit
import Darwin

struct UpdateFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct UpdateVersion: Comparable, Equatable {
    let components: [Int]
    let text: String
    init(_ text: String) throws {
        guard text.range(of: #"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"#, options: .regularExpression) != nil else {
            throw UpdateFailure("The release has an unsupported version number.")
        }
        let parts = text.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 3 else { throw UpdateFailure("The release version is invalid.") }
        self.components = parts; self.text = text
    }
    static func < (lhs: Self, rhs: Self) -> Bool { lhs.components.lexicographicallyPrecedes(rhs.components) }
}

struct UpdateAsset: Codable {
    let name: String
    let size: Int64
    let browser_download_url: URL
    let digest: String?
}

enum UpdateBuild {
    static let maximum = 2_147_483_647
    static func parse(_ text: String) throws -> Int {
        guard text.range(of: #"^[1-9][0-9]{0,9}$"#, options: .regularExpression) != nil,
              let value = Int(text), value <= maximum else {
            throw UpdateFailure("The app has an unsupported build number.")
        }
        return value
    }
}

struct UpdateBuildPolicy: Equatable {
    let build: Int
    let minimumBuild: Int

    static func parse(_ body: String?) throws -> Self? {
        guard let body, body.contains("mac2jb-update") else { return nil }
        guard body.utf8.count <= 128 * 1024,
              body.components(separatedBy: "mac2jb-update").count == 2 else {
            throw UpdateFailure("The release update policy is invalid.")
        }
        let pattern = #"<!-- mac2jb-update:\s*(\{[^\r\n]*\})\s*-->"#
        let expression = try NSRegularExpression(pattern: pattern)
        let range = NSRange(body.startIndex..., in: body)
        let matches = expression.matches(in: body, range: range)
        guard matches.count == 1, let jsonRange = Range(matches[0].range(at: 1), in: body),
              body[jsonRange].utf8.count <= 256,
              let data = String(body[jsonRange]).data(using: .utf8),
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["build", "minimumBuild"]) else {
            throw UpdateFailure("The release update policy is invalid.")
        }
        // Match the JSON text as well: booleans, strings, fractions, duplicate
        // fields and exponent notation must not become integer policy values.
        let fields = #"\{\s*"(?:build|minimumBuild)"\s*:\s*(?:0|[1-9][0-9]*)\s*,\s*"(?:build|minimumBuild)"\s*:\s*(?:0|[1-9][0-9]*)\s*\}"#
        guard String(body[jsonRange]).range(of: "^" + fields + "$", options: .regularExpression) != nil,
              let build = object["build"] as? Int, let minimum = object["minimumBuild"] as? Int,
              build > 0, build <= UpdateBuild.maximum, minimum >= 0, minimum <= build else {
            throw UpdateFailure("The release update policy is invalid.")
        }
        return Self(build: build, minimumBuild: minimum)
    }
}

struct UpdateRelease: Codable {
    let tag_name: String
    let draft: Bool
    let prerelease: Bool
    let html_url: URL
    let assets: [UpdateAsset]
    let body: String?

    func validated() throws -> UpdateCandidate {
        guard !draft, !prerelease, tag_name.hasPrefix("v") else { throw UpdateFailure("Only stable releases are supported.") }
        let version = try UpdateVersion(String(tag_name.dropFirst()))
        let appName = "mac2jb-\(tag_name)-macos-arm64.zip"
        let sumsName = "mac2jb-\(tag_name)-sha256sums"
        guard assets.filter({ $0.name == appName }).count == 1,
              assets.filter({ $0.name == sumsName }).count == 1,
              let archive = assets.first(where: { $0.name == appName }),
              let checksums = assets.first(where: { $0.name == sumsName }),
              archive.size > 0, archive.size <= UpdatePackage.maximumArchiveBytes,
              checksums.size > 0, checksums.size <= 16384 else {
            throw UpdateFailure("This release does not contain a supported Mac app and checksums.")
        }
        for asset in [archive, checksums] {
            let url = asset.browser_download_url
            guard url.scheme == "https", url.host == "github.com", url.user == nil, url.password == nil,
                  url.port == nil, url.query == nil, url.fragment == nil,
                  url.path == "/cpypwn/mac2jb/releases/download/\(tag_name)/\(asset.name)" else {
                throw UpdateFailure("The update download is outside the mac2jb repository.")
            }
            _ = try Self.digest(asset.digest)
        }
        guard html_url.absoluteString == "https://github.com/cpypwn/mac2jb/releases/tag/\(tag_name)" else {
            throw UpdateFailure("The release address is invalid.")
        }
        let policy = try UpdateBuildPolicy.parse(body)
        return UpdateCandidate(version: version, archive: archive, checksums: checksums, releaseURL: html_url,
                               build: policy?.build, minimumBuild: policy?.minimumBuild)
    }

    static func digest(_ value: String?) throws -> String {
        guard let value, value.range(of: #"^sha256:[a-f0-9]{64}$"#, options: .regularExpression) != nil else {
            throw UpdateFailure("GitHub did not provide a valid SHA-256 digest for this update.")
        }
        return String(value.dropFirst(7))
    }
}

struct UpdateCandidate {
    let version: UpdateVersion
    let archive: UpdateAsset
    let checksums: UpdateAsset
    let releaseURL: URL
    let build: Int?
    let minimumBuild: Int?

    func isNewer(than installed: UpdateVersion, build installedBuild: Int) -> Bool {
        version > installed || version == installed && (build.map { $0 > installedBuild } ?? false)
    }

    var displayVersion: String { version.text + (build.map { " (build \($0))" } ?? "") }
}

// Store the complete validated repository release, so a cached requirement
// cannot be restored without rechecking its origin, assets, digests and policy.
struct UpdateRequirement {
    let release: UpdateRelease
    let candidate: UpdateCandidate
    let minimumBuild: Int

    init(_ release: UpdateRelease) throws {
        let update = try release.validated()
        guard let minimum = update.minimumBuild, minimum > 0 else {
            throw UpdateFailure("The release does not declare a required update.")
        }
        self.release = release
        self.candidate = update
        self.minimumBuild = minimum
    }

    func incorporating(_ next: UpdateRelease) throws -> Self {
        let update = try next.validated()
        guard let minimum = update.minimumBuild, minimum > 0 else { return self }
        if minimum > minimumBuild || minimum == minimumBuild &&
            update.isNewer(than: candidate.version, build: candidate.build ?? 0) {
            return try Self(next)
        }
        return self
    }

    func blocks(installedBuild: Int) -> Bool { installedBuild < minimumBuild }

    func encoded() throws -> Data { try JSONEncoder().encode(release) }
    static func restored(_ data: Data) throws -> Self {
        guard data.count <= 1024 * 1024 else { throw UpdateFailure("The saved update policy is too large.") }
        return try Self(JSONDecoder().decode(UpdateRelease.self, from: data))
    }
}

enum UpdatePackage {
    static let bundleID = "io.github.cpypwn.mac2jb.demo"
    static let maximumArchiveBytes = 512 * 1024 * 1024

    static func sha256(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { hash.update(data: data) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func checksum(in data: Data, filename: String) throws -> String {
        guard data.count <= 16384, let text = String(data: data, encoding: .utf8) else {
            throw UpdateFailure("The update checksum file is invalid.")
        }
        var matches: [String] = []
        for line in text.split(whereSeparator: \.isNewline) {
            let fields = line.split(whereSeparator: \.isWhitespace)
            guard fields.count == 2 else { continue }
            if String(fields[1]).trimmingCharacters(in: CharacterSet(charactersIn: "*")) == filename {
                let value = String(fields[0])
                guard value.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil else {
                    throw UpdateFailure("The app checksum is invalid.")
                }
                matches.append(value)
            }
        }
        guard matches.count == 1 else { throw UpdateFailure("The app must have exactly one checksum entry.") }
        return matches[0]
    }

    // Inspect the ZIP directory and local headers before handing it to ditto.
    // Single-bundle ZIP32 archives are supported; links and special files are not.
    static func validateArchive(_ url: URL) throws {
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        func bad() -> UpdateFailure { UpdateFailure("The update archive has unsupported or unsafe contents.") }
        func u16(_ n: Int) throws -> Int {
            guard n >= 0, n + 2 <= data.count else { throw bad() }
            return Int(data[n]) | Int(data[n + 1]) << 8
        }
        func u32(_ n: Int) throws -> Int { try u16(n) | (u16(n + 2) << 16) }
        guard data.count >= 22, data.count <= maximumArchiveBytes else { throw bad() }
        var end: Int?
        for offset in stride(from: data.count - 22, through: max(0, data.count - 65557), by: -1) {
            if try u32(offset) == 0x06054b50, try offset + 22 + u16(offset + 20) == data.count { end = offset; break }
        }
        guard let end, try u16(end + 4) == 0, try u16(end + 6) == 0 else { throw bad() }
        let count = try u16(end + 10), centralSize = try u32(end + 12), centralStart = try u32(end + 16)
        guard count > 0, count <= 2048, try u16(end + 8) == count,
              centralStart + centralSize == end else { throw bad() }
        var at = centralStart, total = 0, names = Set<String>(), normalizedNames = Set<String>(), ranges: [Range<Int>] = []
        for _ in 0..<count {
            guard try u32(at) == 0x02014b50 else { throw bad() }
            let flags = try u16(at + 8), method = try u16(at + 10), packed = try u32(at + 20), unpacked = try u32(at + 24)
            let nameCount = try u16(at + 28), extra = try u16(at + 30), comment = try u16(at + 32)
            let local = try u32(at + 42), mode = try u32(at + 38) >> 16
            guard flags & 1 == 0, method == 0 || method == 8,
                  nameCount > 0, at + 46 + nameCount + extra + comment <= end,
                  try u16(at + 34) == 0 else { throw bad() }
            let nameBytes = data.subdata(in: at + 46..<at + 46 + nameCount)
            guard let name = String(data: nameBytes, encoding: .utf8), !name.contains("\0"),
                  !name.contains("\\"), !name.contains("\n"), !name.contains("\r"),
                  name == "mac2jb.app/" || name.hasPrefix("mac2jb.app/"),
                  name.split(separator: "/").allSatisfy({ $0 != "." && $0 != ".." }),
                  !name.contains("//"), names.insert(name).inserted else { throw bad() }
            let normalized = name.precomposedStringWithCanonicalMapping.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard normalizedNames.insert(normalized).inserted else { throw bad() }
            let type = mode & 0o170000
            guard mode & 0o6000 == 0, type == 0 || type == 0o100000 || type == 0o040000,
                  (type != 0o040000 || name.hasSuffix("/")) else { throw bad() }
            total += unpacked
            guard total <= 512 * 1024 * 1024, packed < 0xffffffff, unpacked < 0xffffffff,
                  local < centralStart, try u32(local) == 0x04034b50,
                  try u16(local + 6) == flags, try u16(local + 8) == method else { throw bad() }
            let localNameCount = try u16(local + 26), localExtra = try u16(local + 28)
            let payload = local + 30 + localNameCount + localExtra
            guard payload + packed <= centralStart,
                  data.subdata(in: local + 30..<local + 30 + localNameCount) == nameBytes else { throw bad() }
            let range = local..<payload + packed
            guard ranges.allSatisfy({ !$0.overlaps(range) }) else { throw bad() }
            ranges.append(range)
            at += 46 + nameCount + extra + comment
        }
        guard at == end, names.contains("mac2jb.app/Contents/Info.plist"),
              names.contains("mac2jb.app/Contents/MacOS/mac2jb") else { throw bad() }
    }

    @discardableResult static func run(_ executable: String, _ arguments: [String]) throws -> String {
        let task = Process(), output = Pipe()
        task.executableURL = URL(fileURLWithPath: executable); task.arguments = arguments
        task.standardOutput = output; task.standardError = output; task.standardInput = FileHandle.nullDevice
        try task.run()
        let bytes = output.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit()
        guard task.terminationStatus == 0 else {
            throw UpdateFailure("Update validation failed: " + String(decoding: bytes.prefix(1800), as: UTF8.self))
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    @discardableResult static func validateApp(_ app: URL, version: String, build: Int? = nil,
                                              minimumBuild: Int? = nil) throws -> Int {
        let manager = FileManager.default
        let metadata = try app.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard metadata.isDirectory == true, metadata.isSymbolicLink != true else { throw UpdateFailure("The update is not an app bundle.") }
        guard let walker = manager.enumerator(at: app, includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey]) else {
            throw UpdateFailure("The app could not be inspected.")
        }
        for case let file as URL in walker {
            let info = try file.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
            guard info.isSymbolicLink != true, info.isRegularFile == true || info.isDirectory == true else {
                throw UpdateFailure("The update contains an unsupported link or file.")
            }
        }
        let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")), format: nil) as? [String: Any]
        guard plist?["CFBundleIdentifier"] as? String == bundleID,
              plist?["CFBundleExecutable"] as? String == "mac2jb",
              plist?["CFBundleShortVersionString"] as? String == version,
              let minimum = plist?["LSMinimumSystemVersion"] as? String,
              minimum.range(of: #"^[0-9]+(\.[0-9]+){0,2}$"#, options: .regularExpression) != nil,
              minimum.compare(ProcessInfo.processInfo.operatingSystemVersionStringValue, options: .numeric) != .orderedDescending else {
            throw UpdateFailure("The downloaded app does not match this release or requires a newer macOS.")
        }
        guard let buildText = plist?["CFBundleVersion"] as? String else {
            throw UpdateFailure("The downloaded app has no build number.")
        }
        let actualBuild = try UpdateBuild.parse(buildText)
        guard build == nil || actualBuild == build, minimumBuild == nil || actualBuild >= minimumBuild! else {
            throw UpdateFailure("The downloaded app does not match the advertised or required build.")
        }
        let binary = app.appendingPathComponent("Contents/MacOS/mac2jb")
        guard manager.isExecutableFile(atPath: binary.path) else { throw UpdateFailure("The update executable is missing.") }
        let executable = try FileHandle(forReadingFrom: binary)
        defer { try? executable.close() }
        guard try executable.read(upToCount: 8) == Data([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]) else {
            throw UpdateFailure("The update executable is not a supported Apple Silicon build.")
        }
        _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        return actualBuild
    }
}

private extension ProcessInfo {
    var operatingSystemVersionStringValue: String {
        let v = operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }
}
