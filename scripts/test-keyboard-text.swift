import Foundation
import Darwin

@_cdecl("mac2jb_payload_bytes") func keyboardFixturePayloadBytes() -> UnsafePointer<UInt8>? { nil }
@_cdecl("mac2jb_payload_size") func keyboardFixturePayloadSize() -> UInt { 0 }
enum EmbeddedPayloadMetadata { static let sha256 = "unused-keyboard-fixture" }

@MainActor private final class KeyboardTextFixture {
    let root: URL
    let timingSuiteName = "mac2jb-test-timing-" + UUID().uuidString
    let model: SessionModel
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mac2jb-keyboard-text-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let script = #"""
        #!/bin/sh
        case "$1" in */scripts/gui-keyboard.cjs) ;; *) exit 88 ;; esac
        printf '%s\n' "$$" > fixture-pid
        emit_file() { if [ -f "$1" ]; then while IFS= read -r event; do printf '%s\n' "$event"; done < "$1"; fi; }
        gate() {
          n=0
          while [ ! -f "$1" ] && [ "$n" -lt 500 ]; do /bin/sleep 0.01; n=$((n+1)); done
          [ -f "$1" ] || exit 9
        }
        finish() {
          trap '' TERM
          emit_file late-events
          printf '%s\n' '{"type":"keyboard-stopped","message":"Fixture released keys."}'
          exit 0
        }
        trap finish TERM
        printf '%s\n' '{"type":"keyboard-ready","mode":"live"}'
        request=0
        while IFS= read -r control; do
          printf '%s\n' "$control" >> controls
          case "$control" in
            *'"text":'*)
              request=$((request+1))
              emit_file "pre-$request"
              : > "received-$request"
              gate "release-$request"
              emit_file "post-$request"
              if [ -f "fail-$request" ]; then
                printf '%s\n' '{"type":"failed","message":"Fixture keyboard transport failed."}'
                exit 1
              fi
              : > "finished-$request" ;;
          esac
        done
        finish
        """#
        let executable = root.appendingPathComponent("node")
        try Data(script.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        model = SessionModel(addressProvider: { [] }, runtime: BundledRuntime(root: root), timingDefaults: UserDefaults(suiteName: timingSuiteName)!, networkDefaults: UserDefaults(suiteName: timingSuiteName)!)
        model.phase = .ready; model.driverLoaded = true
    }
    func put(_ name: String, _ value: String = "") throws { try Data(value.utf8).write(to: root.appendingPathComponent(name)) }
    func events(_ name: String, _ events: [[String: Any]]) throws {
        let lines = try events.map { String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self) }.joined(separator: "\n")
        try put(name, lines + "\n")
    }
    func exists(_ name: String) -> Bool { FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path) }
    var controls: [[String: Any]] {
        ((try? String(contentsOf: root.appendingPathComponent("controls"), encoding: .utf8)) ?? "")
            .split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }
    func dispose() {
        UserDefaults(suiteName: timingSuiteName)?.removePersistentDomain(forName: timingSuiteName)
        if model.hasLiveWorkers, let value = try? String(contentsOf: root.appendingPathComponent("fixture-pid"), encoding: .utf8),
           let pid = Int32(value.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 1 { _ = kill(pid, SIGKILL) }
        if let log = model.diagnosticLogURL, log.deletingLastPathComponent().lastPathComponent.hasPrefix("mac2jb-gui-error-") {
            try? FileManager.default.removeItem(at: log.deletingLastPathComponent())
        }
        try? FileManager.default.removeItem(at: root)
    }
}

@MainActor enum KeyboardTextModelTests {
    private static var checks = 0
    private static func check(_ value: @autoclosure () -> Bool, _ message: String) { precondition(value(), message); checks += 1 }
    private static func until(_ message: String, _ predicate: @escaping @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !predicate() && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        check(predicate(), "Timed out: " + message)
    }
    static func run() async throws {
        let fixture = try KeyboardTextFixture(); defer { fixture.dispose() }
        let model = fixture.model
        check(model.keyboardTextAutoIndent, "SmileBASIC editor indentation adjustment is enabled by default")
        model.keyboardText = "before connection"
        model.sendKeyboardText()
        check(!model.canSendKeyboardText && fixture.controls.isEmpty, "disconnected input never reaches a helper")
        model.startKeyboardForwarding()
        try await until("keyboard ready") { model.keyboardActive }
        check(model.keyboardAcceptsPhysicalInput, "physical input starts enabled")
        for invalid in ["", "snowman ☃", "a\rb", "\u{0}", "\u{7f}", String(repeating: "x", count: 16 * 1024 + 1)] {
            model.keyboardText = invalid
            check(model.keyboardTextValidationMessage != nil && !model.canSendKeyboardText, "reject entire unsupported or oversized text before sending")
            model.sendKeyboardText()
        }
        check(fixture.controls.isEmpty, "invalid text sends no partial request")
        model.keyboardText = String(repeating: "x", count: 16 * 1024)
        check(model.canSendKeyboardText, "exact 16 KiB input is accepted")
        model.keyDelayMs = 0
        check(!model.canSendKeyboardText, "invalid pacing is rejected")
        model.keyDelayMs = 2001
        model.sendKeyboardText()
        check(fixture.controls.isEmpty, "invalid pacing sends nothing")
        model.keyDelayMs = 10

        let secret = "private token\r\nA\tB"
        let normalized = secret.replacingOccurrences(of: "\r\n", with: "\n")
        let total = normalized.utf8.count
        try fixture.events("pre-1", [
            ["type": "keyboard-text-completed", "sent": total, "total": total],
            ["type": "keyboard-text-started", "total": total + 1],
            ["type": "keyboard-text-progress", "sent": 4, "total": total],
            ["type": "keyboard-text-started", "total": total],
            ["type": "keyboard-text-progress", "sent": 2, "total": total],
            ["type": "keyboard-text-progress", "sent": 1, "total": total],
            ["type": "keyboard-text-progress", "sent": 2.5, "total": total],
            ["type": "keyboard-text-progress", "sent": 6, "total": total + 1],
            ["type": "keyboard-text-rejected", "message": "invalid late rejection"],
            ["type": "keyboard-text-completed", "sent": 2, "total": total]
        ])
        try fixture.events("post-1", [["type": "keyboard-text-completed", "sent": total, "total": total]])
        model.keyboardText = secret
        model.sendKeyboardText()
        check(model.keyboardTextSending && !model.keyboardAcceptsPhysicalInput && !model.canSendKeyboardText, "pending text blocks physical reports and duplicate sends immediately")
        model.sendKeyboardText(); model.sendKeyboardReport([0, 0, 4, 0, 0, 0, 0, 0])
        try await until("validated progress") { model.keyboardTextSent == 2 }
        check(model.keyboardText == secret && model.keyboardTextTotal == total && model.keyboardTextSending, "invalid/out-of-order events cannot clear the draft or corrupt progress")
        check(fixture.controls.count == 1, "no queued replay or physical interleaving")
        check(fixture.controls[0]["text"] as? String == normalized && fixture.controls[0]["delayMs"] as? Int == 10 &&
              fixture.controls[0]["editorAutoIndent"] as? Bool == true,
              "request normalizes CRLF, preserves tabs, selects editor indentation, and appends no Enter")
        check(Set(fixture.controls[0].keys) == Set(["text", "delayMs", "editorAutoIndent"]), "text uses only the documented control fields")
        try fixture.put("release-1")
        try await until("confirmed completion") { !model.keyboardTextSending }
        check(model.keyboardText.isEmpty && model.keyboardAcceptsPhysicalInput && model.keyboardTextStatus.contains("No extra Enter"), "only confirmed completion clears original text and restores physical capture")
        check(!model.log.contains("private token") && !model.usbLog.contains("private token"), "pasted text never enters diagnostic logs")

        try fixture.events("pre-2", [["type": "keyboard-text-started", "total": 3]])
        try fixture.events("post-2", [["type": "keyboard-text-completed", "sent": 3, "total": 3]])
        model.keyboardText = "old"; model.keyDelayMs = 27; model.keyboardTextAutoIndent = false; model.sendKeyboardText()
        try await until("second request") { fixture.exists("received-2") && model.keyboardTextStatus == "Sending text…" }
        model.keyboardText = "new draft"
        try fixture.put("release-2")
        try await until("second completion") { !model.keyboardTextSending }
        check(model.keyboardText == "new draft" && fixture.controls[1]["delayMs"] as? Int == 27 &&
              fixture.controls[1]["editorAutoIndent"] as? Bool == false,
              "completion preserves edits and allows literal input")

        try fixture.events("pre-3", [["type": "keyboard-text-rejected", "message": "Fixture text rejected."]])
        try fixture.put("release-3")
        model.keyboardText = "retryable"; model.sendKeyboardText()
        try await until("safe rejection") { !model.keyboardTextSending && fixture.exists("finished-3") }
        check(model.keyboardActive && model.keyboardText == "retryable" && model.canSendKeyboardText, "preflight rejection preserves text and the usable session")
        check(model.keyboardTextStatus == "Fixture text rejected." && !model.log.contains("Fixture text rejected."), "rejection is shown without entering logs")

        try fixture.events("pre-4", [["type": "keyboard-text-started", "total": 9], ["type": "keyboard-text-progress", "sent": 3, "total": 9]])
        try fixture.events("late-events", [["type": "keyboard-text-completed", "sent": 9, "total": 9]])
        model.sendKeyboardText()
        try await until("partial transfer") { model.keyboardTextSent == 3 }
        model.stopKeyboardForwarding()
        check(!model.keyboardTextSending && !model.keyboardActive && !model.canSendKeyboardText, "Stop immediately blocks text and physical input")
        try await until("stopped worker") { !model.hasLiveWorkers }
        check(model.phase == .ready && model.keyboardText == "retryable", "late completion after Stop cannot clear partly sent text")
        let controls = fixture.controls.count
        model.sendKeyboardText(); model.sendKeyboardReport([0, 0, 4, 0, 0, 0, 0, 0])
        check(fixture.controls.count == controls, "disconnected model sends no late controls")
        model.startKeyboardForwarding()
        try await until("reconnected") { model.keyboardActive }
        check(model.keyboardText == "retryable" && !model.keyboardTextSending && model.keyboardTextSent == 0 && model.keyboardTextTotal == 0, "reconnect keeps the draft and resets transfer state without replay")
        model.stopKeyboardForwarding()
        try await until("reconnected worker stopped") { !model.hasLiveWorkers }

        let failure = try KeyboardTextFixture(); defer { failure.dispose() }
        failure.model.startKeyboardForwarding()
        try await until("failure fixture ready") { failure.model.keyboardActive }
        try failure.events("pre-1", [["type": "keyboard-text-started", "total": 7], ["type": "keyboard-text-progress", "sent": 2, "total": 7]])
        try failure.put("fail-1"); try failure.put("release-1")
        failure.model.keyboardText = "partial"; failure.model.sendKeyboardText()
        try await until("transport failure drained") { failure.model.phase == .failed && !failure.model.hasLiveWorkers }
        check(failure.model.keyboardText == "partial" && !failure.model.keyboardTextSending && !failure.model.canSendKeyboardText, "transport failure preserves the draft without replay")
        print("Keyboard text model checks passed: \(checks). No real keyboard or USB input sent.")
    }
}
