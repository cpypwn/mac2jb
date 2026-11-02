import Foundation

@main
struct WebKitStagingTest {
    @MainActor static func main() throws {
        guard CommandLine.arguments.count == 3 else { fatalError("missing source and provenance") }
        let source = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let record = URL(fileURLWithPath: CommandLine.arguments[2])
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: record)) as? [String: Any]
        guard let hashes = object?["files"] as? [String: String] else { fatalError("missing hashes") }
        try WebKitResearchModel.verifyUpstreamFiles(source, hashes: hashes)

        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("mac2jb-webkit-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try FileManager.default.copyItem(at: source, to: folder)
        try WebKitResearchModel.verifyUpstreamFiles(folder, hashes: hashes, allowReports: true)

        let extra = folder.appendingPathComponent("unexpected.js")
        try Data("alert(1)".utf8).write(to: extra)
        try expectRejection("extra source file") {
            try WebKitResearchModel.verifyUpstreamFiles(folder, hashes: hashes, allowReports: true)
        }
        try FileManager.default.removeItem(at: extra)

        let reports = folder.appendingPathComponent("work/browser-probe/reports", isDirectory: true)
        try FileManager.default.createDirectory(at: reports, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: reports.appendingPathComponent("report-20261101T220000000000Z-1234abcd.json"))
        try WebKitResearchModel.verifyUpstreamFiles(folder, hashes: hashes, allowReports: true)

        try Data("bad".utf8).write(to: reports.appendingPathComponent("run.py"))
        try expectRejection("unexpected report script") {
            try WebKitResearchModel.verifyUpstreamFiles(folder, hashes: hashes, allowReports: true)
        }
        print("Pinned WebKit staging rejects extra files and accepts bounded reports")
    }

    @MainActor private static func expectRejection(_ label: String, _ body: () throws -> Void) throws {
        do { try body() }
        catch { return }
        throw NSError(domain: "WebKitStagingTest", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Accepted \(label)"])
    }
}
