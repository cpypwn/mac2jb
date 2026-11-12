import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

@MainActor final class NXFormatToolsModel: ObservableObject {
    @Published var inputURL: URL?
    @Published var destinationURL: URL?
    @Published var archiveURL: URL?
    @Published private(set) var ready = false
    @Published private(set) var busy = false
    @Published private(set) var status = ""
    @Published private(set) var output = ""

    private var process: Process?
    private var pipe: Pipe?
    private var action = ""
    private var cancelled = false

    func refresh(runtimeRoot: URL?) {
        guard !busy, runtimeRoot != nil else { return }
        run("status", runtimeRoot: runtimeRoot, quiet: true)
    }

    func prepare(runtimeRoot: URL?) { run("prepare", runtimeRoot: runtimeRoot) }

    func pack(runtimeRoot: URL?) {
        guard let inputURL, let destinationURL else { return }
        run("pack", runtimeRoot: runtimeRoot, first: inputURL, second: destinationURL)
    }

    func inspect(_ name: String, runtimeRoot: URL?) {
        guard let archiveURL else { return }
        run(name, runtimeRoot: runtimeRoot, first: archiveURL)
    }

    func cancel() {
        guard busy, let process, process.isRunning else { return }
        cancelled = true
        status = "Stopping NXConvert"
        process.terminate()
    }

    private func run(_ name: String, runtimeRoot: URL?, first: URL? = nil,
                     second: URL? = nil, quiet: Bool = false) {
        guard !busy, let runtimeRoot else {
            if !quiet { status = "Wait for the app runtime to finish preparing" }
            return
        }
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent("scripts/gui-nxformat.cjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path) else {
            status = "NXFormat is missing from this app"
            return
        }
        let task = Process()
        let stream = Pipe()
        task.executableURL = node
        task.arguments = [script.path, name, runtimeRoot.path] + [first?.path, second?.path].compactMap { $0 }
        task.currentDirectoryURL = runtimeRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = stream
        task.standardError = stream
        action = name
        cancelled = false
        busy = true
        if !quiet {
            output = ""
            status = name == "prepare" ? "Getting NXConvert 1.0.3" :
                name == "pack" ? "Packing and verifying NX" : "Running NX \(name)"
        }
        stream.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor [weak self] in self?.consume(data) }
        }
        task.terminationHandler = { [weak self] finished in
            stream.fileHandleForReading.readabilityHandler = nil
            let last = stream.fileHandleForReading.readDataToEndOfFile()
            Task { @MainActor [weak self] in
                self?.consume(last)
                self?.finish(code: finished.terminationStatus)
            }
        }
        do {
            try task.run()
            process = task
            pipe = stream
        } catch {
            busy = false
            status = "Could not start NXFormat: \(error.localizedDescription)"
        }
    }

    private func consume(_ data: Data) {
        guard !data.isEmpty else { return }
        output += String(decoding: data, as: UTF8.self)
        if output.count > 64_000 { output = String(output.suffix(64_000)) }
    }

    private func finish(code: Int32) {
        defer { busy = false; process = nil; pipe = nil }
        if cancelled { status = "NXConvert stopped"; return }
        if code == 0 {
            if action == "prepare" || action == "status" { ready = true }
            status = action == "status" || action == "prepare" ?
                "NXConvert 1.0.3 is ready" : action == "pack" ? "NX archive verified" : "NX \(action) complete"
        } else if action == "status" {
            ready = false
            status = ""
        } else {
            status = "NX \(action) failed"
        }
    }
}

struct NXFormatToolsView: View {
    let runtimeRoot: URL?
    @StateObject private var tool = NXFormatToolsModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("NXFormat").font(.system(size: 15, weight: .semibold))
            Text("Convert an already decrypted dump or NUP into a verified .nx archive on this Mac")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            HStack(spacing: 10) {
                if !tool.ready {
                    Button("Get NXConvert 1.0.3") { tool.prepare(runtimeRoot: runtimeRoot) }
                        .disabled(tool.busy || runtimeRoot == nil)
                }
                Button("Open NXFormat source") {
                    if let url = URL(string: "https://github.com/fab918/nxformat") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
            Divider()
            HStack(spacing: 10) {
                Button("Choose dump folder or NUP…") { chooseInput() }
                selection(tool.inputURL)
            }
            HStack(spacing: 10) {
                Button("Choose .nx destination…") { chooseOutput() }
                selection(tool.destinationURL)
            }
            Button("Pack and verify NX") { tool.pack(runtimeRoot: runtimeRoot) }
                .disabled(tool.busy || !tool.ready || tool.inputURL == nil || tool.destinationURL == nil)
            Divider()
            HStack(spacing: 10) {
                Button("Choose .nx archive…") { chooseArchive() }
                selection(tool.archiveURL)
            }
            HStack(spacing: 10) {
                Button("Info") { tool.inspect("info", runtimeRoot: runtimeRoot) }
                Button("Contents") { tool.inspect("contents", runtimeRoot: runtimeRoot) }
                Button("Verify") { tool.inspect("verify", runtimeRoot: runtimeRoot) }
            }
            .disabled(tool.busy || !tool.ready || tool.archiveURL == nil)
            if tool.busy { Button("Stop NXConvert") { tool.cancel() } }
            if !tool.status.isEmpty {
                Text(tool.status).font(.system(size: 11, weight: .semibold))
            }
            if !tool.output.isEmpty {
                ScrollView {
                    Text(tool.output)
                        .font(.system(size: 10, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 120)
                .padding(10)
                .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .font(.system(size: 11))
        .onAppear { tool.refresh(runtimeRoot: runtimeRoot) }
        .onChange(of: runtimeRoot?.path) { _, _ in tool.refresh(runtimeRoot: runtimeRoot) }
    }

    private func selection(_ url: URL?) -> some View {
        Text(url?.path ?? "Nothing selected")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(Mac2jbTheme.muted)
            .lineLimit(1).truncationMode(.middle)
            .textSelection(.enabled)
    }

    private func chooseInput() {
        let picker = NSOpenPanel()
        picker.canChooseDirectories = true
        picker.canChooseFiles = true
        picker.allowsMultipleSelection = false
        if picker.runModal() == .OK { tool.inputURL = picker.url }
    }

    private func chooseOutput() {
        let picker = NSSavePanel()
        picker.nameFieldStringValue = "game.nx"
        if let archiveType = UTType(filenameExtension: "nx") {
            picker.allowedContentTypes = [archiveType]
        }
        if picker.runModal() == .OK { tool.destinationURL = picker.url }
    }

    private func chooseArchive() {
        let picker = NSOpenPanel()
        picker.canChooseDirectories = false
        picker.canChooseFiles = true
        picker.allowsMultipleSelection = false
        if let archiveType = UTType(filenameExtension: "nx") {
            picker.allowedContentTypes = [archiveType]
        }
        if picker.runModal() == .OK { tool.archiveURL = picker.url }
    }
}
