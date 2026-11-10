import Foundation

@main @MainActor struct SaveGameUpdateTests {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { throw NSError(domain: "test", code: 1) }
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let sources = try SaveGameUpdateChecker.loadSources(runtimeRoot: root)
        precondition(sources.map(\.name) == [
            "Artemis launcher", "Seedsow Lua Editor Pro", "Seedsow Lua Editor",
            "Balatro RCE", "Gravity Circuit"
        ])
        let artemis = sources[0]
        precondition(artemis.pinnedTag == "v2")
        precondition(Set(artemis.expectedDigests.keys) == Set([
            "seedsow_save.zip", "nora2_save.zip", "hamidashi_save.zip"
        ]))
        precondition(sources[3].expectedDigests.isEmpty)
        for source in sources {
            precondition(source.apiURL?.host == "api.github.com")
            precondition(!source.pinnedTag.isEmpty)
        }

        let valid = SaveReleaseInfo(tag_name: "v2",
            html_url: "https://github.com/alula/switch-artemis-launcher/releases/tag/v2", assets: nil)
        precondition(valid.page(for: artemis.repository)?.absoluteString == valid.html_url)
        precondition(valid.assetStatus(expected: artemis.expectedDigests) == .unavailable)
        let matching = SaveReleaseInfo(tag_name: "v2", html_url: valid.html_url,
            assets: artemis.expectedDigests.map { .init(name: $0.key, digest: "sha256:\($0.value)") })
        precondition(matching.assetStatus(expected: artemis.expectedDigests) == .matches)
        let changed = SaveReleaseInfo(tag_name: "v2", html_url: valid.html_url,
            assets: artemis.expectedDigests.map { name, hash in
                .init(name: name, digest: "sha256:\(name == "seedsow_save.zip" ? String(repeating: "0", count: 64) : hash)")
            })
        precondition(changed.assetStatus(expected: artemis.expectedDigests) == .changed)
        let missing = SaveReleaseInfo(tag_name: "v2", html_url: valid.html_url,
            assets: artemis.expectedDigests.map { name, hash in
                .init(name: name, digest: name == "seedsow_save.zip" ? nil : "sha256:\(hash)")
            })
        precondition(missing.assetStatus(expected: artemis.expectedDigests) == .unavailable)
        for url in [
            "http://github.com/alula/switch-artemis-launcher/releases/tag/v2",
            "https://example.com/alula/switch-artemis-launcher/releases/tag/v2",
            "https://github.com/alula/other/releases/tag/v2",
            "https://github.com/alula/switch-artemis-launcher/releases/tag/v2?redirect=1"
        ] {
            precondition(SaveReleaseInfo(tag_name: "v2", html_url: url, assets: nil)
                .page(for: artemis.repository) == nil)
        }
        precondition(SaveReleaseInfo(tag_name: "../v2", html_url: valid.html_url, assets: nil)
            .page(for: artemis.repository) == nil)
        print("All pinned save game update sources and release URL checks passed")
    }
}
