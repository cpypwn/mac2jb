import AppKit
import Foundation
import SwiftUI

struct SaveKitResearchItem: Identifiable {
    let category: String
    let name: String
    let path: String
    let execution: String
    let requiresRun: Bool
    let requirements: String
    let sourceURL: URL

    var id: String { path }

}

struct SaveKitResearchCatalog {
    let revision: String
    let groups: [(name: String, items: [SaveKitResearchItem])]

    private struct Source: Decodable {
        let revision: String
        let tools: [SourceItem]
    }

    private struct SourceItem: Decodable {
        let category: String
        let name: String
        let path: String
        let execution: String
        let requiresRun: Bool
        let requirements: String
    }

    static func load(runtimeRoot: URL) throws -> SaveKitResearchCatalog {
        let runtime = runtimeRoot.resolvingSymlinksInPath()
        let base = runtimeRoot.appendingPathComponent("vendor/ns2-savekit/research", isDirectory: true)
            .resolvingSymlinksInPath()
        guard base.path.hasPrefix(runtime.path + "/") else { throw CatalogError.invalid }
        let file = base.appendingPathComponent("catalog.json")
        let data = try Data(contentsOf: file)
        guard data.count <= 256 * 1024 else { throw CatalogError.invalid }
        let source = try JSONDecoder().decode(Source.self, from: data)
        guard source.revision.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil,
              !source.tools.isEmpty, source.tools.count <= 128 else { throw CatalogError.invalid }
        let manager = FileManager.default
        var groups: [(name: String, items: [SaveKitResearchItem])] = []
        var seen = Set<String>()
        for item in source.tools {
            guard valid(item.category, limit: 80), valid(item.name, limit: 120),
                  valid(item.requirements, limit: 250), valid(item.path, limit: 250),
                  ["node", "python3", "shell", "source"].contains(item.execution),
                  !item.path.hasPrefix("/"), !item.path.contains("\\"),
                  !item.path.components(separatedBy: "/").contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  seen.insert(item.path).inserted else { throw CatalogError.invalid }
            let url = base.appendingPathComponent(item.path).resolvingSymlinksInPath()
            guard url.path.hasPrefix(base.path + "/"),
                  let attributes = try? manager.attributesOfItem(atPath: url.path),
                  attributes[.type] as? FileAttributeType == .typeRegular else {
                throw CatalogError.invalid
            }
            let resolved = SaveKitResearchItem(category: item.category, name: item.name,
                path: item.path, execution: item.execution, requiresRun: item.requiresRun,
                requirements: item.requirements, sourceURL: url)
            if let index = groups.firstIndex(where: { $0.name == item.category }) {
                groups[index].items.append(resolved)
            } else {
                groups.append((item.category, [resolved]))
            }
        }
        return SaveKitResearchCatalog(revision: source.revision, groups: groups)
    }

    private static func valid(_ text: String, limit: Int) -> Bool {
        !text.isEmpty && text.utf8.count <= limit &&
            !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
    }

    private enum CatalogError: Error { case invalid }
}

struct SaveKitResearchView: View {
    let runtimeRoot: URL?
    @State private var catalog: SaveKitResearchCatalog?
    @State private var loadFailed = false

    var body: some View {
        DisclosureGroup("SaveKit research sources") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Browse the bundled upstream research. Commands here only check source syntax; this panel never runs research or hardware tools.")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                if let catalog {
                    ForEach(catalog.groups, id: \.name) { group in
                        DisclosureGroup("\(group.name) · \(group.items.count)") {
                            VStack(alignment: .leading, spacing: 12) {
                                ForEach(group.items) { item in sourceRow(item) }
                            }.padding(.top, 8)
                        }
                        .font(.system(size: 11, weight: .semibold))
                    }
                    Text("Upstream revision \(catalog.revision.prefix(12))")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Mac2jbTheme.muted)
                } else {
                    Text(loadFailed ? "The bundled research catalog is unavailable." : "Preparing research catalog…")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                }
            }.padding(.top, 10)
        }
        .font(.system(size: 12, weight: .semibold))
        .onAppear(perform: load)
        .onChange(of: runtimeRoot?.path) { _, _ in load() }
    }

    private func sourceRow(_ item: SaveKitResearchItem) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(item.name).font(.system(size: 11, weight: .semibold))
                if item.requiresRun {
                    Text("held RPC required").font(.system(size: 9)).foregroundStyle(Mac2jbTheme.muted)
                }
                Spacer(minLength: 0)
            }
            Text(item.requirements).font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button("Show in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([item.sourceURL])
                }
                Button("Copy path") { copy(item.sourceURL.path) }
                if let command = syntaxCheck(for: item) {
                    Button("Copy syntax check") { copy(command) }
                        .help("Copies a syntax check without running the research tool")
                }
            }
            .font(.system(size: 10))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func syntaxCheck(for item: SaveKitResearchItem) -> String? {
        let path = shellQuote(item.sourceURL.path)
        switch item.execution {
        case "node" where item.path.hasSuffix(".cjs"): return "node --check \(path)"
        case "shell" where item.path.hasSuffix(".sh") || item.path.hasSuffix(".command"):
            return "bash -n \(path)"
        default: return nil
        }
    }

    private func shellQuote(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    private func load() {
        guard let runtimeRoot else { catalog = nil; loadFailed = false; return }
        do { catalog = try SaveKitResearchCatalog.load(runtimeRoot: runtimeRoot); loadFailed = false }
        catch { catalog = nil; loadFailed = true }
    }
}
