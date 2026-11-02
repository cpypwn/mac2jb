import AppKit
import Combine
import Foundation
import SwiftUI

@MainActor final class NSPBoxModel: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var progress: Double?
    @Published private(set) var status = "Choose an extracted game snapshot"
    @Published private(set) var resultURL: URL?
    @Published private(set) var log = ""

    private var process: Process?
    private var cancelled = false
    private var reportedError = false

    func start(runtimeRoot: URL?, source: URL?, output: URL?, dlc: Bool,
               title: String, displayVersion: String, artwork: URL?, titleID: String,
               baseGame: URL?) {
        guard !isRunning else { return }
        guard let runtimeRoot, let source, let output else {
            status = "Choose a source folder and NSP destination"
            return
        }
        guard output.pathExtension.lowercased() == "nsp" else {
            status = "The destination must end in .nsp"
            return
        }
        guard !FileManager.default.fileExists(atPath: output.path) else {
            status = "This NSP already exists. Choose another destination"
            return
        }
        let python = runtimeRoot.appendingPathComponent("homebrew/python/bin/python3")
        let helper = runtimeRoot.appendingPathComponent("integrations/nsp-box/cli.py")
        guard FileManager.default.isExecutableFile(atPath: python.path),
              FileManager.default.fileExists(atPath: helper.path) else {
            status = "The included NSP-Box tools are unavailable"
            return
        }
        let task = Process()
        task.executableURL = python
        task.currentDirectoryURL = runtimeRoot
        var arguments = [helper.path, "--source", source.path, "--output", output.path]
        if dlc {
            arguments += ["--dlc"]
            if !titleID.isEmpty { arguments += ["--title-id", titleID] }
            if let baseGame { arguments += ["--base-game", baseGame.path] }
        } else {
            if !title.isEmpty { arguments += ["--title", title] }
            if !displayVersion.isEmpty { arguments += ["--display-version", displayVersion] }
            if let artwork { arguments += ["--artwork", artwork.path] }
        }
        task.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "PYTHONHOME")
        environment.removeValue(forKey: "PYTHONPATH")
        environment["PYTHONNOUSERSITE"] = "1"
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        task.environment = environment
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        do {
            try task.run()
        } catch {
            status = "Could not start NSP-Box: \(error.localizedDescription)"
            return
        }
        process = task
        cancelled = false
        reportedError = false
        resultURL = nil
        progress = nil
        log = ""
        status = "Building NSP"
        isRunning = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let handle = pipe.fileHandleForReading
            var pending = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                pending.append(chunk)
                while let newline = pending.firstIndex(of: 10) {
                    let line = String(decoding: pending[..<newline], as: UTF8.self)
                    pending.removeSubrange(...newline)
                    Task { @MainActor [weak self] in self?.consume(line) }
                }
            }
            if !pending.isEmpty {
                let line = String(decoding: pending, as: UTF8.self)
                Task { @MainActor [weak self] in self?.consume(line) }
            }
            task.waitUntilExit()
            Task { @MainActor [weak self] in self?.finish(status: task.terminationStatus) }
        }
    }

    func cancel() {
        guard isRunning, !cancelled, let process, process.isRunning else { return }
        cancelled = true
        status = "Stopping package build"
        process.terminate()
    }

    private func consume(_ line: String) {
        guard !line.isEmpty else { return }
        log += line + "\n"
        if log.count > 16_000 { log = String(log.suffix(12_000)) }
        guard let data = line.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = message["type"] as? String else { return }
        switch kind {
        case "progress":
            if let stage = message["stage"] as? String { status = stage }
            if let percent = message["percent"] as? Double { progress = max(0, min(1, percent / 100)) }
        case "result":
            if let report = message["report"] as? [String: Any],
               let path = report["output"] as? String {
                resultURL = URL(fileURLWithPath: path)
                status = "NSP ready and verified"
                progress = 1
            }
        case "error":
            reportedError = true
            status = message["message"] as? String ?? "NSP-Box failed"
        case "cancelled":
            status = "Package build canceled"
        default: break
        }
    }

    private func finish(status code: Int32) {
        isRunning = false
        process = nil
        if cancelled { status = "Package build canceled" }
        else if code != 0 && !reportedError { status = "NSP-Box exited with status \(code)" }
    }
}

struct NSPBoxToolsView: View {
    let runtimeRoot: URL?

    @StateObject private var model = NSPBoxModel()
    @State private var source: URL?
    @State private var output: URL?
    @State private var artwork: URL?
    @State private var baseGame: URL?
    @State private var dlc = false
    @State private var title = ""
    @State private var displayVersion = ""
    @State private var titleID = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("NSP-Box")
                .font(.system(size: 15, weight: .semibold))
            Text("Package an already-extracted ExeFS/RomFS game snapshot or DLC into a plaintext NSP for compatible emulators. The original dump stays untouched")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Picker("Content", selection: $dlc) {
                Text("Game").tag(false)
                Text("DLC").tag(true)
            }
            .pickerStyle(.segmented).frame(maxWidth: 230).disabled(model.isRunning)
            HStack(spacing: 10) {
                Button("Choose extracted folder…") { chooseSource() }.disabled(model.isRunning)
                Text(source?.path ?? "No folder selected")
                    .lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(Mac2jbTheme.muted)
            }
            if dlc {
                TextField("DLC title ID, if missing from folder name", text: $titleID)
                    .textFieldStyle(.roundedBorder).disabled(model.isRunning)
                HStack(spacing: 10) {
                    Button("Choose base game NSP (optional)…") { chooseBaseGame() }.disabled(model.isRunning)
                    Text(baseGame?.lastPathComponent ?? "")
                        .foregroundStyle(Mac2jbTheme.muted)
                }
            } else {
                HStack(spacing: 10) {
                    TextField("Game title (optional)", text: $title)
                    TextField("Display version (optional)", text: $displayVersion)
                }
                .textFieldStyle(.roundedBorder).disabled(model.isRunning)
                HStack(spacing: 10) {
                    Button("Choose artwork (optional)…") { chooseArtwork() }.disabled(model.isRunning)
                    Text(artwork?.lastPathComponent ?? "")
                        .foregroundStyle(Mac2jbTheme.muted)
                }
            }
            HStack(spacing: 10) {
                Button("Choose NSP destination…") { chooseOutput() }.disabled(model.isRunning)
                Text(output?.path ?? "No destination selected")
                    .lineLimit(1).truncationMode(.middle)
                    .foregroundStyle(Mac2jbTheme.muted)
            }
            HStack(spacing: 10) {
                Button("Build NSP") {
                    model.start(runtimeRoot: runtimeRoot, source: source, output: output,
                                dlc: dlc, title: title, displayVersion: displayVersion,
                                artwork: artwork, titleID: titleID, baseGame: baseGame)
                }
                .disabled(model.isRunning || runtimeRoot == nil || source == nil || output == nil)
                if model.isRunning { Button("Cancel") { model.cancel() } }
                if let result = model.resultURL {
                    Button("Show NSP in Finder") { NSWorkspace.shared.activateFileViewerSelecting([result]) }
                }
            }
            if let progress = model.progress { ProgressView(value: progress).tint(Mac2jbTheme.mint) }
            else if model.isRunning { ProgressView().progressViewStyle(.linear) }
            Text(model.status).font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if !model.log.isEmpty {
                DisclosureGroup("Packaging log") {
                    ScrollView {
                        Text(model.log).font(.system(size: 10, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }.frame(height: 120)
                }
            }
        }
        .font(.system(size: 11))
    }

    private func chooseSource() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        if panel.runModal() == .OK { source = panel.url }
    }

    private func chooseOutput() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.init(filenameExtension: "nsp")!]
        panel.nameFieldStringValue = "Game.nsp"
        if panel.runModal() == .OK { output = panel.url }
    }

    private func chooseArtwork() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        if panel.runModal() == .OK { artwork = panel.url }
    }

    private func chooseBaseGame() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.init(filenameExtension: "nsp")!]
        if panel.runModal() == .OK { baseGame = panel.url }
    }
}
