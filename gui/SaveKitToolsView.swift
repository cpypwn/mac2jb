import AppKit
import SwiftUI

struct SaveKitToolsView: View {
    @ObservedObject var model: SessionModel
    let experimentalTools: Bool
    @State private var titleID = ""
    @State private var accountID = ""
    @State private var scanAll = false
    @State private var space = ""
    @State private var type = ""
    @State private var rank = ""
    @State private var index = ""
    @State private var staticID = ""
    @State private var sourceFolder: URL?
    @State private var restoreFolder: URL?
    @State private var comparisonFolder: URL?
    @State private var deleteName = ""
    @State private var confirmWrite = false
    @State private var confirmRestore = false
    @State private var confirmDelete = false

    private static let knownTitleNames = [
        "010012900d38a000": "Nora Princess 2 (trial)",
        "01002eb00ce48000": "Nora Princess and Stray Cat Heart HD (trial)",
        "010042d022aea000": "Seedsow Lullaby (demo)",
        "0100ee5021c9e000": "Seedsow Lullaby (full)",
        "01005eb012fe2000": "Wagamama High Spec (trial)",
        "0100b4b00f9f6000": "SmileBASIC 4 (demo)",
        "04008e001f098000": "Nintendo Switch Sports Resort"
    ]

    private var validTitle: Bool { titleID.range(of: "^[a-fA-F0-9]{16}$", options: .regularExpression) != nil }
    private var validAccount: Bool { accountID.range(of: "^[a-fA-F0-9]{32}$", options: .regularExpression) != nil }
    private var canRead: Bool { model.canOpenAnotherSave && validTitle && validAccount && archiveValid }
    private var canModify: Bool {
        canRead && model.savekitWritableTitles.contains(titleID.lowercased())
    }
    private var canRestore: Bool {
        canRead && [1, 3].contains(archive?["type"] ?? 1) &&
            (archive?["rank"] ?? 0) == 0 && (archive?["index"] ?? 0) == 0 &&
            (archive?["staticId"] ?? 0) == 0
    }
    private var archiveFields: [(String, String, Int)] {
        [("space", space, 255), ("type", type, 7), ("rank", rank, 1),
         ("index", index, 65535), ("staticId", staticID, Int.max)]
    }
    private var archiveValid: Bool {
        archiveFields.allSatisfy { _, value, maximum in
            value.isEmpty || (value.allSatisfy(\.isNumber) && Int(value).map { $0 <= maximum } == true)
        }
    }
    private var archive: [String: Int]? {
        var result: [String: Int] = [:]
        for (key, value, _) in archiveFields where !value.isEmpty {
            guard let parsed = Int(value) else { return nil }
            result[key] = parsed
        }
        return result.isEmpty ? nil : result
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Save data actions").font(.system(size: 13, weight: .semibold))
            Text("Close the game whose save you want to inspect or back up.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            Text("Choose a title and account for each save action. Every write, restore or delete makes its own verified backup. Keep the game closed.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            HStack {
                Button("List console accounts") { send("accounts") }
                Button("List installed titles") { send("titles") }
                Button("List save archives") { send("inventory") }
            }.disabled(!model.canUseSaveKitTools)
            if !model.savekitArchives.isEmpty {
                DisclosureGroup("Save archives (\(model.savekitArchiveTotal))") {
                    VStack(alignment: .leading, spacing: 5) {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 5) {
                                ForEach(model.savekitArchives) { entry in
                                    Button {
                                        titleID = entry.titleId
                                        accountID = entry.uid
                                        space = String(entry.space)
                                        type = String(entry.type)
                                        rank = String(entry.rank)
                                        index = String(entry.index)
                                        staticID = "0"
                                    } label: {
                                        Text("\(titleLabel(entry.titleId)) · space \(entry.space), type \(entry.type), uid \(entry.uid.prefix(8))")
                                            .font(.system(size: 10, design: .monospaced))
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(entry.titleId == "0000000000000000")
                                }
                            }
                        }.frame(maxHeight: 240)
                        if model.savekitArchiveTotal > model.savekitArchives.count {
                            Text("Open the full report for the remaining archives")
                                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                        }
                        if model.savekitInventoryFolder != nil {
                            Button("Open full inventory report") { model.revealSaveKitInventory() }
                        }
                    }.padding(.top, 6)
                }.font(.system(size: 11))
            }
            HStack {
                TextField("32-digit account UID", text: $accountID)
                    .textFieldStyle(.roundedBorder)
                if !model.savekitAccounts.isEmpty {
                    Menu("Console accounts") {
                        ForEach(model.savekitAccounts, id: \.self) { uid in
                            Button(uid) { accountID = uid }
                        }
                    }
                }
            }
            if !model.savekitTitles.isEmpty {
                Picker("Detected games (\(model.savekitTitles.count))", selection: $titleID) {
                    if validTitle && !model.savekitTitles.contains(titleID.lowercased()) {
                        Text("Manual ID · \(titleID.lowercased())").tag(titleID)
                    }
                    ForEach(model.savekitTitles, id: \.self) { id in
                        Text(titleLabel(id)).tag(id)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            TextField("16-digit title ID", text: $titleID)
                .textFieldStyle(.roundedBorder)
            Text("Enter an ID manually if a title with a save is missing from the installed-game list.")
                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            DisclosureGroup("Archive filters") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Leave fields empty for the normal user account save. Filters narrow an all-archive scan.")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                    HStack {
                        archiveField("Space", value: $space)
                        archiveField("Type", value: $type)
                        archiveField("Rank", value: $rank)
                        archiveField("Index", value: $index)
                        archiveField("Static ID", value: $staticID)
                    }
                    Toggle("Scan all matching archives", isOn: $scanAll).toggleStyle(.checkbox)
                    Text("A full scan can take a long time and may interrupt the RPC session. Narrow it to a space or type when possible.")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                }.padding(.top, 6)
            }.font(.system(size: 11))
            HStack {
                Button("List save files") { send("inspect", archiveOptions: true) }.disabled(!canRead)
                Button("Back up save") { send("backup", archiveOptions: true) }.disabled(!canRead)
                Button("Read save timestamps") { send("filetime", archiveOptions: true) }.disabled(!canRead || scanAll)
            }
            if !model.savekitEntries.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(model.savekitEntries.prefix(20)) { entry in
                        Text("\(entry.path)  \(entry.size.map(String.init) ?? "folder")")
                            .font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                    }
                    if model.savekitEntries.count > 20 || model.savekitListingTruncated {
                        Text("More entries are in the Console log")
                            .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                    }
                }
            }
            if model.savekitBackupFolder != nil {
                Button("Open verified save export") { model.revealSaveKitBackup() }
            }
            if experimentalTools {
                Divider()
                DisclosureGroup("Write, restore and verify") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Writes are limited to the supported demo and research titles. The selected game must be closed. A fresh backup is made and verified before any change.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                        HStack {
                            Button("Choose local save folder…") { sourceFolder = chooseFolder() }
                            Text(sourceFolder?.lastPathComponent ?? "No folder chosen")
                                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                        }
                        Button("Back up and write save") { confirmWrite = true }
                            .disabled(!canModify || sourceFolder == nil)
                        HStack {
                            Button("Choose verified backup to restore…") { restoreFolder = chooseFolder() }
                            Text(restoreFolder?.lastPathComponent ?? "No backup chosen")
                                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                        }
                        Button("Back up and restore save") { confirmRestore = true }
                            .disabled(!canRestore || restoreFolder == nil)
                        Text("Restore accepts a verified mac2jb backup for an Account or Device archive at rank 0 and index 0. It replaces files in that backup and keeps any extra live files.")
                            .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                        HStack {
                            Button("Choose backup to compare…") { comparisonFolder = chooseFolder() }
                            Text(comparisonFolder?.lastPathComponent ?? "No backup chosen")
                                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                        }
                        Button("Verify live save against backup") {
                            if let comparisonFolder { send("verify", extra: ["expectedFolder": comparisonFolder.path]) }
                        }.disabled(!canRead || comparisonFolder == nil)
                    }.padding(.top, 6)
                }.font(.system(size: 11))
                DisclosureGroup("Delete one save file") {
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("File name at save root", text: $deleteName).textFieldStyle(.roundedBorder)
                        Button("Back up and delete file", role: .destructive) { confirmDelete = true }
                            .disabled(!canModify || deleteName.isEmpty)
                    }.padding(.top, 6)
                }.font(.system(size: 11))
            }
            if model.savekitBusy { ProgressView().controlSize(.small) }
            Text(model.savekitMessage).font(.system(size: 11))
                .foregroundStyle(Mac2jbTheme.muted).textSelection(.enabled)
            if (model.savekitChoiceStarted || model.savekitSaveOperationUsed) && !model.savekitChoiceFinished {
                Button("Done") { model.finishSaveKit() }
                    .buttonStyle(PrimaryActionStyle())
                    .disabled(!model.canFinishSaveKit)
                if model.savekitReturnBlocked {
                    Text("Finish this session and restart the console after a failed save operation.")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                }
            }
        }
        .font(.system(size: 11))
        .onChange(of: model.savekitTitles) { _, titles in
            if titleID.isEmpty { titleID = titles.first ?? "" }
        }
        .onChange(of: model.savekitAccounts) { _, accounts in
            if !accounts.contains(accountID.lowercased()) { accountID = accounts.first ?? "" }
        }
        .alert("Write save files to \(titleLabel(titleID))?", isPresented: $confirmWrite) {
            Button("Back up and replace matching files", role: .destructive) {
                if let sourceFolder {
                    send("write", extra: ["sourceFolder": sourceFolder.path, "allowReplace": true])
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Files from \(sourceFolder?.path ?? "the selected folder") will be written for account \(accountID). A verified backup is made first. Matching files will be replaced; other files are kept.")
        }
        .alert("Restore backup to \(titleLabel(titleID))?", isPresented: $confirmRestore) {
            Button("Back up current save and restore", role: .destructive) {
                if let restoreFolder {
                    send("restore", extra: ["sourceFolder": restoreFolder.path,
                                            "confirmRestore": true,
                                            "archive": archive ?? [:]])
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This replaces save files for account \(accountID). The current save is backed up and verified first.")
        }
        .alert("Delete \(deleteName)?", isPresented: $confirmDelete) {
            Button("Back up and delete", role: .destructive) {
                send("delete", extra: ["fileName": deleteName, "confirmDelete": true])
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes one file from the selected save after a fresh verified backup.")
        }
    }

    private func titleLabel(_ id: String) -> String {
        (model.savekitTitleNames[id] ?? Self.knownTitleNames[id]).map { "\($0) · \(id)" } ?? id
    }

    private func archiveField(_ label: String, value: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            TextField("Any", text: value).textFieldStyle(.roundedBorder)
                .frame(width: label == "Static ID" ? 90 : 60)
        }
    }
    private func chooseFolder() -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        return panel.runModal() == .OK ? panel.url : nil
    }
    private func send(_ action: String, extra: [String: Any] = [:], archiveOptions: Bool = false) {
        var request: [String: Any] = ["action": action]
        if !["titles", "accounts", "inventory"].contains(action) {
            request["titleId"] = titleID.lowercased()
            request["uid"] = accountID.lowercased()
        }
        if archiveOptions {
            if let archive { request["archive"] = archive }
            if action != "filetime" { request["all"] = scanAll }
        }
        extra.forEach { request[$0.key] = $0.value }
        model.runSaveKitTool(request)
    }
}
