import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

@MainActor final class EldenRingSaveConvertModel: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var status = ""
    @Published private(set) var convertedSaveFolder: URL?
    @Published private(set) var details = ""

    func convert(runtimeRoot: URL?, pcSave: URL?, switchBackup: URL?, pcSlot: Int, switchSlot: Int) {
        guard !isRunning else { return }
        guard let pcSave, let switchBackup else {
            status = "Choose both save files before converting"
            return
        }
        guard pcSave.pathExtension.lowercased() == "sl2",
              FileManager.default.fileExists(atPath: pcSave.path) else {
            status = "Choose an existing PC .sl2 save"
            return
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: switchBackup.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            status = "Choose an existing Switch SaveKit backup folder"
            return
        }
        guard (0...9).contains(pcSlot), (0...9).contains(switchSlot) else {
            status = "Choose a character slot from 1 to 10"
            return
        }
        guard let runtimeRoot else {
            status = "Wait for the app runtime to finish preparing"
            return
        }
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent("scripts/convert-elden-ring-save.cjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path) else {
            status = "The Elden Ring conversion tool is missing from this app"
            return
        }

        let outputRoot: URL
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory,
                                                      in: .userDomainMask,
                                                      appropriateFor: nil, create: true)
            let conversions = support.appendingPathComponent("mac2jb/Conversions", isDirectory: true)
            try FileManager.default.createDirectory(at: conversions, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            outputRoot = conversions.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: outputRoot, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
        } catch {
            status = "Could not create a conversion folder: \(error.localizedDescription)"
            return
        }

        let task = Process()
        let stream = Pipe()
        task.executableURL = node
        task.currentDirectoryURL = runtimeRoot
        task.arguments = [script.path,
                          "--pc", pcSave.path,
                          "--switch", switchBackup.path,
                          "--output", outputRoot.path,
                          "--pc-slot", String(pcSlot),
                          "--switch-slot", String(switchSlot)]
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = stream
        task.standardError = stream
        do {
            try task.run()
        } catch {
            status = "Could not start conversion: \(error.localizedDescription)"
            return
        }
        isRunning = true
        status = "Converting character \(pcSlot + 1) for Switch slot \(switchSlot + 1)"
        details = ""
        convertedSaveFolder = nil
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let data = stream.fileHandleForReading.readDataToEndOfFile()
            task.waitUntilExit()
            let output = String(decoding: data, as: UTF8.self)
            Task { @MainActor [weak self] in
                self?.finish(exitCode: task.terminationStatus, output: output, outputRoot: outputRoot)
            }
        }
    }

    private func finish(exitCode: Int32, output: String, outputRoot: URL) {
        isRunning = false
        let lines = output.split(separator: "\n").map(String.init)
        let result = lines.reversed().compactMap { line -> [String: Any]? in
            guard let data = line.data(using: .utf8) else { return nil }
            return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        }.first
        let message = (result?["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let meaningfulMessage = message.flatMap { $0.isEmpty ? nil : $0 }
        if exitCode == 0, result?["status"] as? String == "complete",
           let path = result?["saveFolder"] as? String,
           FileManager.default.fileExists(atPath: path) {
            convertedSaveFolder = URL(fileURLWithPath: path, isDirectory: true)
            status = meaningfulMessage ?? "Converted save ready"
        } else {
            let error = lines.last(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
            status = meaningfulMessage ?? error ?? "Conversion failed with status \(exitCode)"
            convertedSaveFolder = nil
        }
        details = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if details.isEmpty { details = "Output folder: \(outputRoot.path)" }
    }
}

struct EldenRingSaveConvertView: View {
    let runtimeRoot: URL?

    @StateObject private var conversion = EldenRingSaveConvertModel()
    @State private var pcSave: URL?
    @State private var switchBackup: URL?
    @State private var pcSlot = 0
    @State private var switchSlot = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Elden Ring save conversion")
                .font(.system(size: 15, weight: .semibold))
            Text("Convert a PC character for a Switch 2 SaveKit backup.")
                .font(.system(size: 11))
                .foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button("Choose PC .sl2 save…") { choosePCSave() }
                    .disabled(conversion.isRunning)
                selectedPath(pcSave)
            }
            HStack(spacing: 10) {
                Button("Choose Switch backup folder…") { chooseSwitchBackup() }
                    .disabled(conversion.isRunning)
                selectedPath(switchBackup)
            }
            HStack(spacing: 18) {
                Picker("PC character", selection: $pcSlot) {
                    ForEach(0..<10) { slot in Text("Slot \(slot + 1)").tag(slot) }
                }
                Picker("Switch character", selection: $switchSlot) {
                    ForEach(0..<10) { slot in Text("Slot \(slot + 1)").tag(slot) }
                }
            }
            .pickerStyle(.menu)
            .disabled(conversion.isRunning)
            HStack(spacing: 10) {
                Button("Convert save") {
                    conversion.convert(runtimeRoot: runtimeRoot, pcSave: pcSave,
                                       switchBackup: switchBackup, pcSlot: pcSlot, switchSlot: switchSlot)
                }
                .disabled(conversion.isRunning || runtimeRoot == nil || pcSave == nil || switchBackup == nil)
                if let converted = conversion.convertedSaveFolder {
                    Button("Open converted save folder") { NSWorkspace.shared.open(converted) }
                }
            }
            if conversion.isRunning { ProgressView().progressViewStyle(.linear) }
            if !conversion.status.isEmpty {
                Text(conversion.status)
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !conversion.details.isEmpty {
                DisclosureGroup("Conversion details") {
                    Text(conversion.details)
                        .font(.system(size: 10, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
            }
        }
        .font(.system(size: 11))
    }

    private func selectedPath(_ url: URL?) -> some View {
        Text(url?.path ?? "Nothing selected")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(Mac2jbTheme.muted)
            .lineLimit(1).truncationMode(.middle)
            .textSelection(.enabled)
    }

    private func choosePCSave() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if let type = UTType(filenameExtension: "sl2") { panel.allowedContentTypes = [type] }
        if panel.runModal() == .OK { pcSave = panel.url }
    }

    private func chooseSwitchBackup() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK { switchBackup = panel.url }
    }
}
