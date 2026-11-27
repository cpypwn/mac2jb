import Foundation

@main struct BundledUpdateTests {
    static func main() async throws {
        guard CommandLine.arguments.count == 2 else { fatalError("Expected repository root") }
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let sources = BundledUpdateService.loadSources(runtimeRoot: root)
        let ids = sources.map(\.id)
        precondition(ids.count == Set(ids).count)
        precondition(ids.count >= 9)
        for id in ["host-kurumuz", "host-pepsipu", "host-BermTheSequel", "kaihen", "civswitch", "savekit",
                   "ouncecake", "libusbd", "usb-gadget"] {
            precondition(ids.contains(id), "Missing bundled source \(id)")
        }
        precondition(ids.first == "kaihen")
        precondition(!ids.contains("host-astral"))
        for source in sources {
            precondition(source.pinned != "Unknown", "Missing bundled pin for \(source.id)")
            precondition(source.repository?.scheme == "https")
            precondition(["github.com", "gitlab.com"].contains(source.repository?.host ?? ""))
        }
        precondition(sources.first { $0.id == "host-kurumuz" }?.pinned ==
            "ae33da13542c616874ec23c56b7b6a660745c5e3")
        precondition(sources.first { $0.id == "kaihen" }?.pinned == "20261117.1")
        let lock = try String(contentsOf: root.appendingPathComponent("upstream.lock"), encoding: .utf8)
        for id in ["libusbd", "usb-gadget"] {
            precondition(lock.contains(sources.first { $0.id == id }!.pinned))
        }

        let kaihen = sources.first { $0.id == "kaihen" }!
        let current = await BundledUpdateService.inspect(kaihen) { url in
            precondition(url.absoluteString ==
                "https://api.github.com/repos/ouncebrew/kaihen/releases/latest")
            return Data(#"{"tag_name":"20261117.1"}"#.utf8)
        }
        precondition(current.status == .current && current.latest == "20261117.1")
        let release = #"{"tag_name":"20261118"}"#
        let changed = await BundledUpdateService.inspect(kaihen) { _ in
            Data(release.utf8)
        }
        precondition(changed.status == .changed && changed.latest == "20261118")
        let older = await BundledUpdateService.inspect(kaihen) { _ in
            Data(release.replacingOccurrences(of: "20261118", with: "20261116").utf8)
        }
        precondition(older.status == .changed && older.latest == "20261116")
        let malformed = await BundledUpdateService.inspect(kaihen) { _ in
            Data(#"{"tag_name":"../wrong"}"#.utf8)
        }
        precondition(malformed.status == .unknown && malformed.latest == "Unknown")

        let kurumuz = sources.first { $0.id == "host-kurumuz" }!
        var calls: [String] = []
        let gitlab = await BundledUpdateService.inspect(kurumuz) { url in
            calls.append(url.absoluteString)
            if url.absoluteString.hasSuffix("/repository/branches/main") {
                return Data(#"{"commit":{"id":"ae33da13542c616874ec23c56b7b6a660745c5e3"}}"#.utf8)
            }
            return Data(#"{"default_branch":"main"}"#.utf8)
        }
        precondition(gitlab.status == .current)
        precondition(calls.first == "https://gitlab.com/api/v4/projects/kurumuz%2Fns2jb")
        precondition(calls.count == 2)
        let civswitch = sources.first { $0.id == "civswitch" }!
        let githubCommit = await BundledUpdateService.inspect(civswitch) { url in
            if url.absoluteString.hasSuffix("/branches/main") {
                return Data(#"{"commit":{"sha":"1111111111111111111111111111111111111111"}}"#.utf8)
            }
            return Data(#"{"default_branch":"main"}"#.utf8)
        }
        precondition(githubCommit.status == .changed)
        precondition(githubCommit.statusText.contains("differs"))
        let unavailable = await BundledUpdateService.inspect(civswitch) { _ in
            throw URLError(.notConnectedToInternet)
        }
        precondition(unavailable.status == .unknown && unavailable.latest == "Unknown")
        let badSource = BundledUpdateSource(id: "bad", name: "Bad", repository: URL(string: "http://example.com"),
                                            pinned: "v1", kind: .release, note: "")
        let bad = await BundledUpdateService.inspect(badSource) { _ in fatalError("Should not fetch") }
        precondition(bad.status == .unknown && bad.sourceURL == nil)
        print("Bundled update catalog and offline GitHub/GitLab checks passed")
    }
}
