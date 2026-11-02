import Foundation

private final class StubURLProtocol: URLProtocol {
    static var reply: (URLRequest) -> (Int, String) = { _ in (500, "unexpected request") }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (code, body) = Self.reply(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: code,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct ArtemisHTTPTests {
    @MainActor static func main() async throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ description: String) {
            precondition(condition(), description)
            checks += 1
        }

        let code = Data("print('hello world')".utf8)
        let eval = try ArtemisHTTPRoute.request(address: "192.168.1.42", route: .eval, body: code)
        check(eval.httpMethod == "POST", "eval method")
        check(eval.url?.absoluteString == "http://192.168.1.42:8080/eval", "eval url")
        check(eval.httpBody == code, "eval body")
        check(eval.value(forHTTPHeaderField: "Content-Length") == String(code.count), "body length")

        let save = try ArtemisHTTPRoute.request(address: "192.168.1.42", route: .save("save:/test/file.bin"), body: Data([1, 2]))
        check(save.httpMethod == "PUT", "save method")
        check(URLComponents(url: save.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value == "save:/test/file.bin", "save path query")
        check(save.httpBody == Data([1, 2]), "save body")
        let delete = try ArtemisHTTPRoute.request(address: "192.168.1.42", route: .delete("save:/test/file.bin"))
        check(delete.httpMethod == "DELETE", "delete method")
        check(delete.url?.path == "/delete", "delete url")

        check(ArtemisHTTPRoute.savePath("test.lua") == "save:/test.lua", "relative save path")
        check(ArtemisHTTPRoute.savePath("save:/core2.lua") == "save:/core2.lua", "upstream update file")
        check(ArtemisHTTPRoute.savePath("save:/core.lua") == nil, "protected file")
        check(ArtemisHTTPRoute.savePath("save:/a/../b") == nil, "path traversal")
        check(ArtemisHTTPRoute.savePath("save:/file name") == nil, "invalid characters")
        check(ArtemisHTTPRoute.savePath("/absolute") == nil, "absolute path")
        check((try? ArtemisHTTPRoute.request(address: "example.com", route: .status)) == nil, "numeric ip only")
        check((try? ArtemisHTTPRoute.request(address: "192.168.1.42", route: .eval,
                                             body: Data(repeating: 65, count: ArtemisHTTPRoute.bodyLimit + 1))) == nil,
              "upstream body cap")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let model = ArtemisHTTPModel(session: URLSession(configuration: configuration))
        model.address = "192.168.1.42"
        StubURLProtocol.reply = { request in
            precondition(request.url?.path == "/status", "status route")
            return (200, "nora2hax/seedsow HTTP server\nPOST /eval body=<lua>\n")
        }
        await model.checkConnection()
        check(model.message == "Artemis launcher HTTP server is ready", "status identity")

        model.luaSource = "error('bad')"
        StubURLProtocol.reply = { request in
            precondition(request.url?.path == "/eval", "eval route")
            return (200, "status: error\nresult: bad\n")
        }
        await model.eval()
        check(model.message == "Lua returned an error", "eval status despite HTTP 200")
        check(model.responseText.contains("result: bad"), "eval error output")

        let file = FileManager.default.temporaryDirectory.appendingPathComponent("mac2jb-artemis-http-\(UUID().uuidString).bin")
        try Data([0, 1, 255]).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        model.chooseFile(file)
        model.uploadPath = "save:/probe.bin"
        StubURLProtocol.reply = { request in
            precondition(request.httpMethod == "PUT" && request.url?.path == "/save", "upload route")
            return (200, "wrote 3 bytes to save:/probe.bin\n")
        }
        await model.upload()
        check(model.message == "File uploaded", "upload success")

        model.deletePath = "save:/probe.bin"
        StubURLProtocol.reply = { request in
            precondition(request.httpMethod == "DELETE" && request.url?.path == "/delete", "delete route")
            return (200, "deleted save:/probe.bin\n")
        }
        await model.delete()
        check(model.message == "File deleted", "delete success")
        print("Artemis HTTP request and response checks passed: \(checks)")
    }
}
