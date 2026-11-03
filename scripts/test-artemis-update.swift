import Foundation

@main struct ArtemisUpdateTests {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { throw NSError(domain: "test", code: 1) }
        let manifest = try JSONSerialization.jsonObject(
            with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as? [String: Any]
        guard manifest?["repository"] as? String == "https://github.com/alula/switch-artemis-launcher",
              manifest?["release"] as? String == "v1" else {
            throw NSError(domain: "test", code: 2)
        }
        guard let assets = manifest?["assets"] as? [String: [String: String]],
              let seedsowHash = assets["seedsow"]?["sha256"],
              let noraHash = assets["nora"]?["sha256"] else {
            throw NSError(domain: "test", code: 3)
        }
        let expected = ["seedsow_save.zip": seedsowHash, "nora2_save.zip": noraHash]
        let valid = try JSONDecoder().decode(ArtemisReleaseInfo.self,
            from: Data(#"{"tag_name":"v1","html_url":"https://github.com/alula/switch-artemis-launcher/releases/tag/v1"}"#.utf8))
        precondition(valid.page?.absoluteString == "https://github.com/alula/switch-artemis-launcher/releases/tag/v1")
        precondition(valid.assetStatus(expected: expected) == .unavailable)
        let matching = ArtemisReleaseInfo(tag_name: "v1", html_url: valid.html_url, assets: [
            .init(name: "seedsow_save.zip", digest: "sha256:\(seedsowHash)"),
            .init(name: "nora2_save.zip", digest: "sha256:\(noraHash)")
        ])
        precondition(matching.assetStatus(expected: expected) == .matches)
        let changed = ArtemisReleaseInfo(tag_name: "v1", html_url: valid.html_url, assets: [
            .init(name: "seedsow_save.zip", digest: "sha256:\(String(repeating: "0", count: 64))"),
            .init(name: "nora2_save.zip", digest: "sha256:\(noraHash)")
        ])
        precondition(changed.assetStatus(expected: expected) == .changed)
        let missing = ArtemisReleaseInfo(tag_name: "v1", html_url: valid.html_url, assets: [
            .init(name: "seedsow_save.zip", digest: nil),
            .init(name: "nora2_save.zip", digest: "sha256:\(noraHash)")
        ])
        precondition(missing.assetStatus(expected: expected) == .unavailable)
        for url in [
            "http://github.com/alula/switch-artemis-launcher/releases/tag/v2",
            "https://example.com/alula/switch-artemis-launcher/releases/tag/v2",
            "https://github.com/alula/other/releases/tag/v2",
            "https://github.com/alula/switch-artemis-launcher/releases/tag/v2?redirect=1"
        ] {
            let row = ArtemisReleaseInfo(tag_name: "v2", html_url: url, assets: nil)
            precondition(row.page == nil)
        }
        let unsafe = ArtemisReleaseInfo(tag_name: "../v2", html_url:
            "https://github.com/alula/switch-artemis-launcher/releases/tag/../v2", assets: nil)
        precondition(unsafe.page == nil)
        print("Artemis update release URL and pinned manifest checks passed")
    }
}
