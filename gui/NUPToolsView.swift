import AppKit
import Combine
import SwiftUI

@MainActor final class NUPToolsModel: ObservableObject {
    @Published var dumpURL: URL?
    @Published var outputURL: URL?
    @Published var nupURL: URL?
    @Published private(set) var sourceReady = false
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

    func prepare(runtimeRoot: URL?) {
        run("prepare", runtimeRoot: runtimeRoot)
    }

    func pack(runtimeRoot: URL?) {
        guard let dumpURL, let outputURL else { return }
        run("pack", runtimeRoot: runtimeRoot, first: dumpURL, second: outputURL)
    }

    func inspect(_ action: String, runtimeRoot: URL?, destination: URL? = nil) {
        guard let nupURL else { return }
        run(action, runtimeRoot: runtimeRoot, first: nupURL, second: destination)
    }

    func cancel() {
        guard busy, let process, process.isRunning else { return }
        cancelled = true
        status = "Stopping NUP tool"
        process.terminate()
    }

    private func run(_ name: String, runtimeRoot: URL?, first: URL? = nil,
                     second: URL? = nil, quiet: Bool = false) {
        guard !busy, let runtimeRoot else {
            if !quiet { status = "Wait for the app runtime to finish preparing" }
            return
        }
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent("scripts/gui-nup.cjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path) else {
            status = "The NUP tool is missing from this app"
            return
        }
        let task = Process()
        let stream = Pipe()
        task.executableURL = node
        task.arguments = [script.path, name, runtimeRoot.path] + [first?.path, second?.path].compactMap { $0 }
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = stream
        task.standardError = stream
        action = name
        cancelled = false
        busy = true
        if !quiet {
            output = ""
            status = name == "prepare" ? "Getting pinned NUP source" :
                name == "pack" ? "Packing and verifying NUP" : "Running NUP \(name)"
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
            status = "Could not start NUP: \(error.localizedDescription)"
        }
    }

    private func consume(_ data: Data) {
        guard !data.isEmpty else { return }
        output += String(decoding: data, as: UTF8.self)
        if output.count > 64_000 { output = String(output.suffix(64_000)) }
    }

    private func finish(code: Int32) {
        defer { busy = false; process = nil; pipe = nil }
        if cancelled { status = "NUP operation stopped"; return }
        if code == 0 {
            if action == "prepare" || action == "status" { sourceReady = true }
            if action == "status" {
                status = "Pinned NUP source is ready"
            } else {
                status = action == "prepare" ? "Pinned NUP source is ready" : "NUP \(action) complete"
            }
        } else if action == "status" {
            sourceReady = false
            status = ""
        } else {
            status = "NUP \(action) failed"
        }
    }
}

struct NUPToolsView: View {
    let runtimeRoot: URL?
    @StateObject private var tool = NUPToolsModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("NUP").font(.system(size: 15, weight: .semibold))
            Text("Pack an extracted game dump into a compressed .nup file on this Mac, or inspect, verify and extract a NUP file. The tool runs locally and does not use RPC")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button("Get pinned NUP source") { tool.prepare(runtimeRoot: runtimeRoot) }
                    .disabled(tool.busy || runtimeRoot == nil || tool.sourceReady)
                Button("Open upstream source") {
                    if let url = URL(string: "https://github.com/a55uka/nup") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
            Divider()
            HStack(spacing: 10) {
                Button("Choose dump folder…") { chooseDirectory { tool.dumpURL = $0 } }
                selection(tool.dumpURL)
            }
            HStack(spacing: 10) {
                Button("Choose .nup destination…") { chooseOutput() }
                selection(tool.outputURL)
            }
            Button("Pack and verify NUP") { tool.pack(runtimeRoot: runtimeRoot) }
                .disabled(tool.busy || !tool.sourceReady || tool.dumpURL == nil || tool.outputURL == nil)
            Divider()
            HStack(spacing: 10) {
                Button("Choose .nup file…") { chooseNUP() }
                selection(tool.nupURL)
            }
            HStack(spacing: 10) {
                Button("Info") { tool.inspect("info", runtimeRoot: runtimeRoot) }
                Button("List files") { tool.inspect("list", runtimeRoot: runtimeRoot) }
                Button("Verify") { tool.inspect("verify", runtimeRoot: runtimeRoot) }
                Button("Extract…") { chooseExtraction() }
            }
            .disabled(tool.busy || !tool.sourceReady || tool.nupURL == nil)
            if tool.busy { Button("Stop NUP tool") { tool.cancel() } }
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

    private func chooseDirectory(_ selected: (URL) -> Void) {
        let picker = NSOpenPanel()
        picker.canChooseDirectories = true
        picker.canChooseFiles = false
        picker.allowsMultipleSelection = false
        if picker.runModal() == .OK, let url = picker.url { selected(url) }
    }

    private func chooseOutput() {
        let picker = NSSavePanel()
        picker.nameFieldStringValue = "game.nup"
        if picker.runModal() == .OK, let url = picker.url { tool.outputURL = url }
    }

    private func chooseNUP() {
        let picker = NSOpenPanel()
        picker.canChooseDirectories = false
        picker.canChooseFiles = true
        picker.allowsMultipleSelection = false
        if picker.runModal() == .OK, let url = picker.url { tool.nupURL = url }
    }

    private func chooseExtraction() {
        let picker = NSSavePanel()
        picker.nameFieldStringValue = "extracted-nup"
        if picker.runModal() == .OK, let url = picker.url {
            tool.inspect("extract", runtimeRoot: runtimeRoot, destination: url)
        }
    }
}
