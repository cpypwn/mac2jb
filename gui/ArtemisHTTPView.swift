import AppKit
import Combine
import Foundation
import SwiftUI

enum ArtemisHTTPRoute {
    case status
    case eval
    case save(String)
    case delete(String)

    static let bodyLimit = 0x7000

    static func recognizedStatus(_ text: String) -> Bool {
        if text.hasPrefix("nora2hax/seedsow HTTP server\n") { return true }
        let games = ["seedsow", "nora", "nora2", "hamidashi"]
        return games.contains { text.hasPrefix("n2h HTTP server (\($0))\n") }
    }

    private static let protectedFiles: Set<String> = [
        "core.lua", "inject.iet", "inject.lua", "http.lua", "proggy.ttf",
        "save9999.dat", "saveg.dat", "system.dat"
    ]

    static func savePath(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 200 else { return nil }
        let name = trimmed.hasPrefix("save:/") ? String(trimmed.dropFirst(6)) : trimmed
        guard !name.isEmpty, !name.hasPrefix("/"), !name.contains(".."),
              !protectedFiles.contains(name),
              name.unicodeScalars.allSatisfy({
                  CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-/")
                      .contains($0)
              }) else { return nil }
        return "save:/\(name)"
    }

    static func request(address: String, route: ArtemisHTTPRoute, body: Data = Data()) throws -> URLRequest {
        guard NetworkSelection.isIPv4(address) else { throw ArtemisHTTPError.invalidAddress }
        guard body.count <= bodyLimit else { throw ArtemisHTTPError.bodyTooLarge }
        var components = URLComponents()
        components.scheme = "http"
        components.host = address
        components.port = 8080
        let method: String
        switch route {
        case .status:
            method = "GET"
            components.path = "/status"
        case .eval:
            method = "POST"
            components.path = "/eval"
        case .save(let path):
            guard let path = savePath(path) else { throw ArtemisHTTPError.invalidPath }
            method = "PUT"
            components.path = "/save"
            components.queryItems = [URLQueryItem(name: "path", value: path)]
        case .delete(let path):
            guard let path = savePath(path) else { throw ArtemisHTTPError.invalidPath }
            method = "DELETE"
            components.path = "/delete"
            components.queryItems = [URLQueryItem(name: "path", value: path)]
        }
        guard let url = components.url else { throw ArtemisHTTPError.invalidAddress }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = method
        request.setValue("close", forHTTPHeaderField: "Connection")
        if method == "POST" || method == "PUT" {
            request.httpBody = body
            request.setValue(String(body.count), forHTTPHeaderField: "Content-Length")
            request.setValue(method == "POST" ? "text/plain; charset=utf-8" : "application/octet-stream",
                             forHTTPHeaderField: "Content-Type")
        }
        return request
    }
}

enum ArtemisHTTPError: LocalizedError {
    case invalidAddress
    case invalidPath
    case bodyTooLarge
    case missingLua
    case missingFile
    case invalidServerResponse

    var errorDescription: String? {
        switch self {
        case .invalidAddress: return "Enter the Switch IPv4 address"
        case .invalidPath: return "Use a path under save:/ with letters, numbers, /, _, - or .; launcher files are protected"
        case .bodyTooLarge: return "The launcher accepts at most 28,672 bytes per request"
        case .missingLua: return "Enter Lua code to run"
        case .missingFile: return "Choose a file to upload"
        case .invalidServerResponse: return "The response did not come from the Artemis launcher HTTP server"
        }
    }
}

private final class ArtemisHTTPNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor final class ArtemisHTTPModel: ObservableObject {
    @Published var address = ""
    @Published var luaSource = ""
    @Published var uploadPath = "save:/file.bin"
    @Published var deletePath = ""
    @Published private(set) var fileURL: URL?
    @Published private(set) var isBusy = false
    @Published private(set) var message = ""
    @Published private(set) var responseText = ""

    private let session: URLSession

    init(session: URLSession? = nil) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.waitsForConnectivity = false
        self.session = session ?? URLSession(configuration: configuration,
                                             delegate: ArtemisHTTPNoRedirect(), delegateQueue: nil)
    }

    var hasValidAddress: Bool { NetworkSelection.isIPv4(address) }
    var canEval: Bool { !isBusy && hasValidAddress && !luaSource.isEmpty }
    var canUpload: Bool { !isBusy && hasValidAddress && fileURL != nil && ArtemisHTTPRoute.savePath(uploadPath) != nil }
    var canDelete: Bool { !isBusy && hasValidAddress && ArtemisHTTPRoute.savePath(deletePath) != nil }

    func chooseFile(_ url: URL) {
        fileURL = url
        let name = "save:/\(url.lastPathComponent)"
        if ArtemisHTTPRoute.savePath(name) != nil { uploadPath = name }
        message = "Selected \(url.lastPathComponent)"
        responseText = ""
    }

    func checkConnection() async {
        await perform(.status, body: Data(), success: "Artemis launcher HTTP server is ready")
    }

    func eval() async {
        guard !luaSource.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            message = ArtemisHTTPError.missingLua.localizedDescription
            return
        }
        await perform(.eval, body: Data(luaSource.utf8), success: "Lua ran")
    }

    func upload() async {
        guard let fileURL else {
            message = ArtemisHTTPError.missingFile.localizedDescription
            return
        }
        do {
            let size = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard size.isRegularFile == true else { throw ArtemisHTTPError.missingFile }
            guard let fileSize = size.fileSize, fileSize <= ArtemisHTTPRoute.bodyLimit else {
                throw ArtemisHTTPError.bodyTooLarge
            }
            let bytes = try Data(contentsOf: fileURL)
            await perform(.save(uploadPath), body: bytes, success: "File uploaded")
        } catch {
            message = error.localizedDescription
            responseText = ""
        }
    }

    func delete() async {
        await perform(.delete(deletePath), body: Data(), success: "File deleted")
    }

    private func perform(_ route: ArtemisHTTPRoute, body: Data, success: String) async {
        guard !isBusy else { return }
        do {
            let request = try ArtemisHTTPRoute.request(address: address, route: route, body: body)
            isBusy = true
            message = "Contacting Artemis launcher…"
            responseText = ""
            defer { isBusy = false }
            let (bytes, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ArtemisHTTPError.invalidServerResponse }
            let text = String(decoding: bytes.prefix(64 * 1024), as: UTF8.self)
            responseText = text + (bytes.count > 64 * 1024 ? "\n…response truncated" : "")
            guard http.statusCode == 200 else {
                message = "HTTP \(http.statusCode) from Artemis launcher"
                return
            }
            switch route {
            case .status:
                guard ArtemisHTTPRoute.recognizedStatus(text) else {
                    throw ArtemisHTTPError.invalidServerResponse
                }
            case .eval:
                guard text.hasPrefix("status: ok\n") else {
                    message = "Lua returned an error"
                    return
                }
            case .save, .delete:
                break
            }
            message = success
        } catch {
            message = error.localizedDescription
            responseText = ""
        }
    }
}

struct ArtemisHTTPView: View {
    @StateObject private var model = ArtemisHTTPModel()
    @State private var confirmDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Artemis launcher HTTP")
                .font(.system(size: 15, weight: .semibold))
            Text("Load the launcher save on your Switch and press Y to open its HTTP server. Keep the Mac and Switch on the same network. These tools work without an ns2jb RPC session.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                TextField("Switch IPv4 address", text: $model.address)
                    .textFieldStyle(.roundedBorder).frame(maxWidth: 200)
                    .disabled(model.isBusy)
                Button(model.isBusy ? "Working…" : "Check connection") {
                    Task { await model.checkConnection() }
                }.disabled(model.isBusy || !model.hasValidAddress)
            }
            DisclosureGroup("Run Lua") {
                VStack(alignment: .leading, spacing: 8) {
                    TextEditor(text: $model.luaSource)
                        .font(.system(size: 11, design: .monospaced))
                        .frame(height: 90)
                        .scrollContentBackground(.hidden)
                        .background(Color.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 8))
                    Button("Run on Switch") { Task { await model.eval() } }
                        .disabled(!model.canEval)
                }.padding(.top, 8)
            }
            DisclosureGroup("Upload save file") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        Button("Choose file…") {
                            let panel = NSOpenPanel()
                            panel.canChooseFiles = true
                            panel.canChooseDirectories = false
                            panel.allowsMultipleSelection = false
                            if panel.runModal() == .OK, let url = panel.url { model.chooseFile(url) }
                        }.disabled(model.isBusy)
                        if let fileURL = model.fileURL {
                            Text(fileURL.lastPathComponent).font(.system(size: 11)).lineLimit(1)
                        }
                    }
                    TextField("save:/file.bin", text: $model.uploadPath)
                        .textFieldStyle(.roundedBorder).disabled(model.isBusy)
                    Button("Upload to save") { Task { await model.upload() } }
                        .disabled(!model.canUpload)
                    Text("The launcher accepts files up to 28,672 bytes. Its core files are protected; use the upstream update mechanism for those.")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                }.padding(.top, 8)
            }
            DisclosureGroup("Delete save file") {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("save:/file.bin", text: $model.deletePath)
                        .textFieldStyle(.roundedBorder).disabled(model.isBusy)
                    Button("Delete file…") { confirmDelete = true }
                        .disabled(!model.canDelete)
                }.padding(.top, 8)
            }
            if !model.message.isEmpty {
                Text(model.message).font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Mac2jbTheme.muted)
            }
            if !model.responseText.isEmpty {
                Text(model.responseText).font(.system(size: 10, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color.black.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .confirmationDialog("Delete \(model.deletePath) from the launcher save?",
                            isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete file", role: .destructive) { Task { await model.delete() } }
        }
    }
}
