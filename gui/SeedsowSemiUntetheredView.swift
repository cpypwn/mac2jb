import Combine
import Foundation
import SwiftUI

@MainActor final class SeedsowSemiUntetheredModel: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var status = ""
    @Published private(set) var activity = ""

    private var process: Process?
    private var attempt = UUID()

    func start(address: String, runtimeRoot: URL?) {
        guard !isRunning else { return }
        guard CivSwitchFSModel.validIPv4(address) else {
            status = "Enter a valid Switch IPv4 address"
            return
        }
        guard let runtimeRoot else {
            status = "The mac2jb runtime is unavailable"
            return
        }
        let node = runtimeRoot.appendingPathComponent("node")
        let script = runtimeRoot.appendingPathComponent("integrations/seedsow-semi-untethered/upload.cjs")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: script.path) else {
            status = "The Seedsow uploader is missing from this app"
            return
        }

        let task = Process()
        let output = Pipe()
        task.executableURL = node
        task.arguments = [script.path, "--host", address]
        task.currentDirectoryURL = runtimeRoot
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = output
        task.standardError = output
        process = task
        attempt = UUID()
        let current = attempt
        activity = ""
        status = "Uploading Seedsow scripts"
        isRunning = true
        do { try task.run() }
        catch {
            process = nil
            isRunning = false
            status = "Could not start uploader: \(error.localizedDescription)"
            return
        }

        Task.detached(priority: .userInitiated) { [weak self] in
            while true {
                let data = output.fileHandleForReading.availableData
                if data.isEmpty { break }
                await self?.append(String(decoding: data, as: UTF8.self), attempt: current)
            }
            task.waitUntilExit()
            await self?.finish(exitCode: task.terminationStatus, attempt: current)
        }
    }

    func stop() {
        guard let process, process.isRunning else { return }
        status = "Stopping Seedsow upload"
        process.terminate()
    }

    private func append(_ value: String, attempt current: UUID) {
        guard attempt == current else { return }
        activity = String((activity + value).suffix(12000))
    }

    private func finish(exitCode: Int32, attempt current: UUID) {
        guard attempt == current else { return }
        process = nil
        isRunning = false
        status = exitCode == 0
            ? "Scripts uploaded and save commit confirmed"
            : "Upload did not complete. Check activity before retrying"
    }
}

struct SeedsowSemiUntetheredView: View {
    @ObservedObject var model: SeedsowSemiUntetheredModel
    let runtimeRoot: URL?
    let canStart: Bool
    @Binding var address: String
    @State private var confirmUpload = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Button("Semi-untethered · experimental") { confirmUpload = true }
                    .buttonStyle(.bordered)
                    .disabled(!canStart || model.isRunning ||
                              !CivSwitchFSModel.validIPv4(address) || runtimeRoot == nil)
                if model.isRunning {
                    Button("Stop upload") { model.stop() }
                }
            }
            if !model.status.isEmpty {
                Text(model.status)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Mac2jbTheme.muted)
            }
            if !model.activity.isEmpty {
                DisclosureGroup("Upload activity") {
                    ScrollView {
                        Text(model.activity)
                            .font(.system(size: 10, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 180)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .confirmationDialog("Modify the Seedsow save?", isPresented: $confirmUpload,
                            titleVisibility: .visible) {
            Button("Upload scripts", role: .destructive) {
                model.start(address: address, runtimeRoot: runtimeRoot)
            }
        } message: {
            Text("The uploader writes and replaces Lua files in the current Seedsow save. Back up the save before continuing.")
        }
    }
}
