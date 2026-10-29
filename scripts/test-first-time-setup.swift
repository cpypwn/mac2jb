import Foundation
import Combine
import Darwin

// Compile the real model, but never prepare an embedded runtime, query the
// driver, instantiate an account, or launch any USB/RPC/native executable.
@_cdecl("mac2jb_payload_bytes") func testPayloadBytes() -> UnsafePointer<UInt8>? { nil }
@_cdecl("mac2jb_payload_size") func testPayloadSize() -> UInt { 0 }
enum EmbeddedPayloadMetadata { static let sha256 = "unused-fixture" }

@MainActor final class SetupFixture {
    let root: URL
    let model: SessionModel

    init(edition: SmileBASICEdition, addressProvider: @escaping () -> [NetworkAddress] = { [] }) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mac2jb-setup-model-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
        let worker = #"""
        #!/bin/sh
        case "$2" in hid) purpose="$3" ;; *) purpose="$2" ;; esac
        printf '%s\n' "$purpose" >> invocations
        printf '%s\n' "$*" >> arguments
        printf '%s\n' "$$" > "pid-$purpose"
        emit() {
          json="$1"
          case "$json" in
            *'"type":"typing"'*|*'"type":"keyboard-ready"'*)
              if [ -f "proof-controller-$purpose" ]; then
                IFS= read -r proven < "proof-controller-$purpose"
                json="${json%?},\"controller\":\"$proven\"}"
              fi ;;
          esac
          printf '%s\n' "$json"
        }
        emit_events() {
          if [ -f "$1" ]; then
            while IFS= read -r event; do emit "$event"; done < "$1"
          fi
        }
        gate() {
          n=0
          while [ ! -f "$1" ] && [ "$n" -lt 500 ]; do
            /bin/sleep 0.01
            n=$((n + 1))
          done
          [ -f "$1" ] || exit 9
        }
        finish_live() {
          trap '' TERM
          while IFS= read -r report; do printf '%s\n' "$report" >> reports; done
          if [ -f late-ready-live ]; then emit '{"type":"keyboard-ready"}'; fi
          emit '{"type":"keyboard-stopped","message":"Fixture keys released and worker stopped."}'
          if [ -f hold-exit-live ]; then gate exit-live; fi
          code=0
          if [ -f exit-code-live ]; then read -r code < exit-code-live; fi
          exit "$code"
        }
        emit_events "pre-events-$purpose"
        : > "pre-events-sent-$purpose"
        if [ "$purpose" = host ]; then
          trap 'emit_events late-events-host; exit 143' TERM
          mkdir held-fixture
          if [ -f command-flow-host ]; then
            gate release-command-host-ready
            emit '{"type":"host-ready","startCommand":"V=START(39380,192,0,2,42)"}'
            gate release-overlap-host-stage
            emit '{"type":"host-stage","stage":"connected","message":"Fixture exploit active while RUN is sent"}'
            emit '{"type":"command-start","kind":"commands","step":1,"completed":0,"total":4,"label":"LOAD"}'
            emit '{"type":"typing","kind":"commands","total":4}'
            gate release-command-host-final
            emit '{"type":"verified"}'
            exit 0
          fi
          if [ -f manual-host-fixture ]; then
            gate release-host-ready
            IFS= read -r ready < manual-host-ready
            emit "$ready"
            if [ -f host-stage-fixture ]; then
              emit '{"type":"log","message":"Connected. Checking the application; 1/4 native work"}'
              emit '{"type":"host-stage","stage":"pipeline","total":99,"completed":1}'
              emit '{"type":"host-stage","stage":"waiting","message":"Fixture host waiting"}'
              : > host-stage-waiting
              gate release-host-connected
              emit '{"type":"host-stage","stage":"connected","message":"Fixture host connected"}'
              gate release-host-waiting
              emit '{"type":"host-stage","stage":"waiting","message":"Fixture host waiting again"}'
              gate release-host-pipeline
              emit '{"type":"host-stage","stage":"pipeline","completed":1,"total":4,"message":"Fixture actual pipeline"}'
            fi
            gate release-console-result
            if [ -f unproven-host ]; then exit 0; fi
            if [ -f failed-host ]; then emit '{"type":"failed","message":"Inert host failed."}'; exit 1; fi
            if [ ! -f manual-host-held ]; then emit '{"type":"verified"}'; exit 0; fi
          fi
          printf '{"type":"post-run-ready","path":"%s/held-fixture","rpcCommand":"inert-fixture-rpc"}\n' "$PWD"
          while IFS= read -r control; do
            printf '%s\n' "$control" >> controls
            case "$control" in
              *'"action":"post-run"'*)
                : > held-choice-received
                gate release-rpc-held
                printf '{"type":"rpc-held","path":"%s/held-fixture","rpcCommand":"inert-fixture-rpc"}\n' "$PWD" ;;
              *'"action":"list-izlauncher-modules"'*)
                emit '{"type":"izlauncher-catalog","modules":[]}' ;;
              *'"action":"launch-mintbrew"'*|*'"action":"launch-izlauncher"'*)
                emit '{"type":"homebrew-started"}'
                gate release-gpu-running
                emit '{"type":"homebrew-running","message":"Inert GPU launcher ready."}' ;;
              *'"action":"dump-system-code"'*)
                emit '{"type":"homebrew-stopped"}'
                mkdir -p dump-fixture
                printf '{"type":"dump-started","path":"%s/dump-fixture"}\n' "$PWD"
                printf '{"type":"dump-complete","path":"%s/dump-fixture"}\n' "$PWD"
                printf '{"type":"rpc-held","path":"%s/held-fixture","rpcCommand":"inert-fixture-rpc"}\n' "$PWD" ;;
              *'"action":"finish"'*)
                emit '{"type":"homebrew-stopped"}'
                emit '{"type":"rpc-finishing"}'
                emit '{"type":"verified"}'
                exit 0 ;;
              *) emit '{"type":"action-rejected"}' ;;
            esac
          done
          exit 1
        fi
        if [ "$purpose" = live ]; then
          trap finish_live TERM
          : > live-awaiting
          gate release-live
          emit '{"type":"keyboard-ready","message":"Inert keyboard fixture ready."}'
          if [ -f unproven-live ]; then exit 0; fi
          if [ -f failed-live ]; then emit '{"type":"failed","message":"Fixture keyboard failed."}'; exit 1; fi
          while IFS= read -r report; do printf '%s\n' "$report" >> reports; done
          finish_live
        fi
        trap 'emit_events "late-events-$purpose"; exit 143' TERM
        : > "waiting-$purpose"
        gate "release-$purpose"
        if [ -f "safe-failed-$purpose" ]; then
          emit '{"type":"failed","retrySafe":true,"message":"Fixture conclusively failed before USB enumeration."}'
          emit_events "after-safe-events-$purpose"
          if [ -f "hold-exit-$purpose" ]; then gate "exit-$purpose"; fi
          exit 1
        fi
        if [ -f "unproven-$purpose" ]; then exit 0; fi
        if [ -f "failed-$purpose" ]; then
          emit '{"type":"failed","message":"Fixture typing interrupted before completion."}'
          exit 1
        fi
        case "$purpose" in
          bootstrap)
            emit '{"type":"typing","kind":"bootstrap","total":229,"durationMs":600000}'
            emit '{"type":"line-start","kind":"bootstrap","line":229,"completed":228,"total":229,"remainingMs":2500}'
            emit '{"type":"line-complete","kind":"bootstrap","line":229,"completed":229,"total":229,"remainingMs":0}'
            emit '{"type":"transfer-complete","kind":"bootstrap","total":229}' ;;
          save-bootstrap)
            if [ -f custom-save-events ]; then
              emit_events custom-save-events
            else
              emit '{"type":"typing","kind":"save-bootstrap","completed":0,"total":1}'
              emit '{"type":"command-start","kind":"save-bootstrap","step":1,"completed":0,"total":1,"label":"SAVE"}'
              : > save-command-started
              if [ -f hold-save-completion ]; then gate release-save-completion; fi
              emit '{"type":"command-complete","kind":"save-bootstrap","step":1,"completed":1,"total":1,"label":"SAVE"}'
              emit '{"type":"transfer-complete","kind":"save-bootstrap","completed":1,"total":1}'
            fi
            : > save-events-sent ;;
          commands)
            emit '{"type":"typing","kind":"commands","total":4}'
            step=0
            for label in LOAD RUN REMOVE START; do
              step=$((step + 1)); completed=$((step - 1))
              gate "release-command-start-$step"
              printf '{"type":"command-start","kind":"commands","step":%s,"completed":%s,"total":4,"label":"%s"}\n' "$step" "$completed" "$label"
              gate "release-command-complete-$step"
              printf '{"type":"command-complete","kind":"commands","step":%s,"completed":%s,"total":4,"label":"%s"}\n' "$step" "$step" "$label"
              if [ "$step" = 1 ]; then
                gate release-load-confirmation
                emit '{"type":"wait","kind":"commands","completed":1,"total":4,"label":"LOAD","remainingMs":1000}'
                gate release-command-wait-1
              fi
            done
            gate release-command-transfer
            emit '{"type":"transfer-complete","kind":"commands"}'
            emit '{"type":"command-start","kind":"commands","step":1,"completed":0,"total":4,"label":"LOAD"}' ;;
          commands-only)
            selected=load,run,remove
            prefix=no
            previous=
            for value in "$@"; do
              if [ "$previous" = --commands ]; then selected="$value"; fi
              if [ "$value" = --start-prefix ]; then prefix=yes; fi
              previous="$value"
            done
            oldIFS="$IFS"; IFS=,
            total=0
            for name in $selected; do total=$((total + 1)); done
            emit "{\"type\":\"typing\",\"kind\":\"commands-only\",\"total\":$total}"
            emit '{"type":"verified","message":"Fixture must not grant host verification."}'
            if [ -f wrong-progress-commands-only ]; then
              emit '{"type":"command-complete","kind":"commands-only","step":4,"completed":4,"total":4,"label":"START"}'
              : > wrong-progress-sent
              gate release-good-progress
            fi
            step=0
            for name in $selected; do
              step=$((step + 1)); completed=$((step - 1))
              case "$name" in load) label=LOAD ;; run) label=RUN ;; remove) label=REMOVE ;; start) label=START ;; esac
              printf '{"type":"command-start","kind":"commands-only","step":%s,"completed":%s,"total":%s,"label":"%s"}\n' "$step" "$completed" "$total" "$label"
              if [ "$name" = start ] && [ "$prefix" = yes ]; then
                if [ ! -f missing-prefix-proof ]; then
                  printf '{"type":"command-prefix-complete","kind":"commands-only","step":%s,"completed":%s,"total":%s,"label":"START","startPending":true}\n' "$step" "$completed" "$total"
                fi
              else
                printf '{"type":"command-complete","kind":"commands-only","step":%s,"completed":%s,"total":%s,"label":"%s"}\n' "$step" "$step" "$total" "$label"
              fi
            done
            IFS="$oldIFS"
            if [ -f hold-transfer-commands-only ]; then gate release-command-transfer; fi
            if [ -f wrong-kind-commands-only ]; then
              emit '{"type":"transfer-complete","kind":"commands"}'
            elif [ "$prefix" = yes ]; then
              if [ -f missing-prefix-transfer ]; then
                printf '{"type":"transfer-complete","kind":"commands-only","total":%s,"completed":%s}\n' "$total" "$((total - 1))"
              else
                printf '{"type":"transfer-complete","kind":"commands-only","startPending":true,"total":%s,"completed":%s}\n' "$total" "$((total - 1))"
              fi
            else
              printf '{"type":"transfer-complete","kind":"commands-only","total":%s,"completed":%s}\n' "$total" "$total"
            fi ;;
          *) emit '{"type":"failed","message":"Unexpected fixture invocation."}'; exit 7 ;;
        esac
        if [ -f "hold-exit-$purpose" ]; then gate "exit-$purpose"; fi
        code=0
        if [ -f "exit-code-$purpose" ]; then read -r code < "exit-code-$purpose"; fi
        exit "$code"
        """#
        let executable = root.appendingPathComponent("node")
        try Data(worker.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        model = SessionModel(addressProvider: addressProvider, runtime: BundledRuntime(root: root), edition: edition)
        model.phase = .ready; model.driverLoaded = true
    }

    func put(_ file: String, _ value: String = "") throws { try Data(value.utf8).write(to: root.appendingPathComponent(file)) }
    var invocations: [String] { (try? String(contentsOf: root.appendingPathComponent("invocations"), encoding: .utf8))?.split(separator: "\n").map(String.init) ?? [] }
    var reports: [[String: Any]] {
        ((try? String(contentsOf: root.appendingPathComponent("reports"), encoding: .utf8)) ?? "")
            .split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String:Any] }
    }
    func dispose() {
        if let log = model.diagnosticLogURL, log.deletingLastPathComponent() != root,
           log.deletingLastPathComponent().lastPathComponent.hasPrefix("mac2jb-gui-error-") {
            try? FileManager.default.removeItem(at: log.deletingLastPathComponent())
        }
        try? FileManager.default.removeItem(at: root)
    }
}

@main @MainActor struct FirstTimeSetupTests {
    static var checks = 0
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        precondition(condition(), message); checks += 1
    }
    static func until(_ message: String, diagnostic: @MainActor () -> String = { "" }, _ predicate: @escaping @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !predicate() && Date() < deadline { try await Task.sleep(nanoseconds: 10_000_000) }
        let succeeded = predicate()
        check(succeeded, "Timed out: " + message + (succeeded ? "" : diagnostic()))
    }
    static func bootstrap(_ f: SetupFixture) async throws {
        f.model.selectRunMode(.bootstrapOnly); f.model.start()
        check(f.model.phase == .bootstrap && f.model.hasLiveWorkers, "bootstrap starts only the inert typing worker")
        try f.put("release-bootstrap")
        try await until("bootstrap completion and worker drain") { f.model.phase == .awaitingSave && !f.model.hasLiveWorkers }
    }
    static func bootstrapSaveFixtures() async throws {
        let saveEvents = [
            #"{"type":"typing","kind":"save-bootstrap","completed":0,"total":1}"#,
            #"{"type":"command-start","kind":"save-bootstrap","step":1,"completed":0,"total":1,"label":"SAVE"}"#,
            #"{"type":"command-complete","kind":"save-bootstrap","step":1,"completed":1,"total":1,"label":"SAVE"}"#,
            #"{"type":"transfer-complete","kind":"save-bootstrap","completed":1,"total":1}"#
        ]
        let completeSave = saveEvents.joined(separator: "\n") + "\n"
        for edition in SmileBASICEdition.allCases {
            var addressReads = 0
            let save = try SetupFixture(edition: edition, addressProvider: { addressReads += 1; return [] })
            defer { save.dispose() }
            try save.put("proof-controller-bootstrap", "usb-drd3\n")
            try await bootstrap(save)
            save.model.selectedEdition = edition == .full ? .demo : .full
            check(save.model.activeEdition == edition && save.model.canTypeBootstrapSave && !save.model.bootstrapSaveCommandSent,
                  "\(edition) reaches SAVE with the attempt's frozen edition and no claimed command delivery")
            save.model.typeBootstrapSave(directModeConfirmed: false)
            check(save.invocations == ["bootstrap"] && save.model.phase == .awaitingSave,
                  "SAVE cannot type until the user confirms an empty Direct-mode prompt")
            try save.put("hold-save-completion"); try save.put("hold-exit-save-bootstrap")
            try save.put("pre-events-save-bootstrap", #"{"type":"verified"}"# + "\n" +
                         #"{"type":"transfer-complete","kind":"commands-only","completed":1,"total":1}"# + "\n")
            save.model.typeBootstrapSave(directModeConfirmed: true)
            check(save.model.phase == .savingBootstrap && save.model.isBusy && save.model.hasLiveWorkers &&
                  !save.model.canTypeBootstrapSave && !save.model.canStartKeyboard && !save.model.canRestartForUpdate,
                  "SAVE owns the busy worker and blocks duplicate typing, keyboard and update restarts")
            save.model.typeBootstrapSave(directModeConfirmed: true); save.model.finishBootstrapOnly()
            save.model.start(); save.model.startCommandsOnly(); save.model.startKeyboardForwarding()
            save.model.selectRunMode(.heldRPC)
            check(save.model.phase == .savingBootstrap && save.model.activeRunMode == .bootstrapOnly &&
                  save.model.runMode == .bootstrapOnly && !save.model.bootstrapSaveCommandSent,
                  "ordinary start, confirmation and mode actions cannot interrupt active SAVE")
            try save.put("release-save-bootstrap")
            try await until("\(edition) SAVE began without completion") {
                FileManager.default.fileExists(atPath: save.root.appendingPathComponent("save-command-started").path)
            }
            check(!save.model.bootstrapSaveCommandSent && save.model.phase == .savingBootstrap,
                  "SAVE typing and command-start are not proof that the command was delivered")
            try save.put("release-save-completion")
            try await until("\(edition) SAVE proof emitted before worker exit") {
                FileManager.default.fileExists(atPath: save.root.appendingPathComponent("save-events-sent").path)
            }
            try await Task.sleep(nanoseconds: 30_000_000)
            save.model.finishBootstrapOnly(); save.model.typeBootstrapSave(directModeConfirmed: true)
            check(save.model.phase == .savingBootstrap && save.model.hasLiveWorkers && save.model.isBusy &&
                  !save.model.bootstrapSaveCommandSent && !save.model.canTypeBootstrapSave,
                  "complete SAVE events cannot unlock confirmation or retyping while the adapter is draining")
            try save.put("exit-save-bootstrap")
            try await until("\(edition) SAVE successful worker exit") { !save.model.hasLiveWorkers }
            check(save.model.phase == .awaitingSave && save.model.bootstrapSaveCommandSent &&
                  !save.model.canTypeBootstrapSave && !save.model.canLaunchHomebrew &&
                  save.model.workflowProgress.state(for: 1) != .complete,
                  "successful SAVE delivery returns to a separate manual saved-program confirmation")
            let args = try String(contentsOf: save.root.appendingPathComponent("arguments"), encoding: .utf8)
                .split(separator: "\n").last.map(String.init) ?? ""
            check(args.contains("hid save-bootstrap auto 10") && args.contains("--preferred-controller usb-drd3") &&
                  args.contains("--load-wait-ms 1000") && args.contains("--run-wait-ms 0") &&
                  args.contains("--remove-wait-ms 0") && args.contains("--load-confirm-wait-ms 0") &&
                  args.contains("--demo") == (edition == .demo) &&
                  !args.contains("--commands") && !args.contains("--start-command") &&
                  !args.contains("--save-name") && !args.contains("--load-name") && !args.contains("--start-port"),
                  "\(edition) SAVE uses the frozen edition, 10 ms timing and proven USB controller; host flags come from the adapter")
            save.model.typeBootstrapSave(directModeConfirmed: true)
            check(save.invocations == ["bootstrap", "save-bootstrap"] && addressReads == 0 && save.model.activeAddress.isEmpty,
                  "SAVE sends once and never discovers a host address or launches an ns2jb host")
            save.model.finishBootstrapOnly()
            check(save.model.phase == .ready && save.model.workflowProgress.state(for: 1) == .complete &&
                  save.model.workflowProgress.state(for: 2) == .pending,
                  "only explicit saved-program confirmation completes setup without claiming an exploit")
            save.model.skipBootstrapTyping()
            check(!save.model.bootstrapSaveCommandSent && save.model.canTypeBootstrapSave,
                  "a separately requested new setup attempt resets the previous SAVE delivery proof")
            save.model.finishBootstrapOnly()
        }

        let guarded = try SetupFixture(edition: .full)
        defer { guarded.dispose() }
        guarded.model.skipBootstrapTyping()
        func rejectsSave(_ label: String) {
            check(!guarded.model.canTypeBootstrapSave, label + " disables SAVE")
            guarded.model.typeBootstrapSave(directModeConfirmed: true)
            check(guarded.model.phase == .awaitingSave && guarded.invocations.isEmpty, label + " launches nothing")
        }
        guarded.model.driverLoaded = false; rejectsSave("missing driver"); guarded.model.driverLoaded = true
        guarded.model.driverSetupRunning = true; rejectsSave("driver installation"); guarded.model.driverSetupRunning = false
        guarded.model.keyDelayMs = 0; rejectsSave("invalid key timing"); guarded.model.keyDelayMs = 10
        guarded.model.enumerationTimeoutSeconds = 0; rejectsSave("invalid enumeration timeout"); guarded.model.enumerationTimeoutSeconds = 4
        guarded.model.loadWaitMs = -1; rejectsSave("invalid command timing"); guarded.model.loadWaitMs = 1000
        for phase in [SessionPhase.ready, .bootstrap, .savingBootstrap, .commands, .failed, .cancelled, .verified] {
            guarded.model.phase = phase; guarded.model.typeBootstrapSave(directModeConfirmed: true)
            check(!guarded.model.canTypeBootstrapSave && guarded.model.phase == phase && guarded.invocations.isEmpty,
                  "SAVE is unavailable outside its awaiting-save checkpoint: \(phase)")
        }
        let wrongMode = try SetupFixture(edition: .full)
        defer { wrongMode.dispose() }
        wrongMode.model.phase = .awaitingSave; wrongMode.model.typeBootstrapSave(directModeConfirmed: true)
        check(!wrongMode.model.canTypeBootstrapSave && wrongMode.invocations.isEmpty,
              "awaitingSave alone cannot type SAVE outside a bootstrap-only attempt")
        let noRuntime = SessionModel(addressProvider: { [] }, edition: .full)
        noRuntime.phase = .awaitingSave; noRuntime.driverLoaded = true
        noRuntime.typeBootstrapSave(directModeConfirmed: true)
        check(!noRuntime.canTypeBootstrapSave && !noRuntime.hasLiveWorkers, "SAVE needs a prepared runtime")
        let manual = try SetupFixture(edition: .demo)
        defer { manual.dispose() }
        manual.model.driverLoaded = false; manual.model.keyDelayMs = 0; manual.model.skipBootstrapTyping()
        manual.model.typeBootstrapSave(directModeConfirmed: true); manual.model.finishBootstrapOnly()
        check(manual.model.phase == .ready && manual.invocations.isEmpty && !manual.model.bootstrapSaveCommandSent,
              "the skipped-bootstrap manual SAVE path still works without a driver or typing timings")

        let invalidProofs: [(String, String)] = [
            ("no events", ""),
            ("transfer alone", saveEvents[3] + "\n"),
            ("missing typing", saveEvents.dropFirst().joined(separator: "\n") + "\n"),
            ("missing command completion", [saveEvents[0], saveEvents[1], saveEvents[3]].joined(separator: "\n") + "\n"),
            ("out-of-order completion", [saveEvents[0], saveEvents[2], saveEvents[1], saveEvents[3]].joined(separator: "\n") + "\n"),
            ("wrong purpose", completeSave.replacingOccurrences(of: "save-bootstrap", with: "commands-only")),
            ("wrong command label", completeSave.replacingOccurrences(of: "SAVE", with: "LOAD")),
            ("wrong count", completeSave.replacingOccurrences(of: #""total":1"#, with: #""total":2"#)),
            ("nonzero exit", completeSave)
        ]
        for (name, events) in invalidProofs {
            var addressReads = 0
            let rejected = try SetupFixture(edition: .full, addressProvider: { addressReads += 1; return [] })
            defer { rejected.dispose() }
            rejected.model.skipBootstrapTyping()
            try rejected.put("custom-save-events", events)
            if name == "nonzero exit" { try rejected.put("exit-code-save-bootstrap", "1\n") }
            rejected.model.typeBootstrapSave(directModeConfirmed: true); try rejected.put("release-save-bootstrap")
            try await until("rejected SAVE proof drained: \(name)") { !rejected.model.hasLiveWorkers }
            check(rejected.model.phase == .failed && !rejected.model.bootstrapSaveCommandSent &&
                  !rejected.model.canTypeBootstrapSave && !rejected.model.canSkipBootstrapTyping,
                  "\(name) cannot claim a saved command or offer an automatic retry")
            rejected.model.typeBootstrapSave(directModeConfirmed: true); rejected.model.finishBootstrapOnly()
            check(rejected.model.phase == .failed && rejected.invocations == ["save-bootstrap"] && addressReads == 0,
                  "\(name) remains failed without another SAVE or host lookup")
        }

        let cancelledSave = try SetupFixture(edition: .full)
        defer { cancelledSave.dispose() }
        cancelledSave.model.skipBootstrapTyping()
        try cancelledSave.put("hold-save-completion"); try cancelledSave.put("late-events-save-bootstrap", completeSave)
        cancelledSave.model.typeBootstrapSave(directModeConfirmed: true); try cancelledSave.put("release-save-bootstrap")
        try await until("partially typed SAVE before cancellation") {
            FileManager.default.fileExists(atPath: cancelledSave.root.appendingPathComponent("save-command-started").path)
        }
        cancelledSave.model.cancel()
        try await until("cancelled SAVE with late proof drained") { !cancelledSave.model.hasLiveWorkers }
        cancelledSave.model.typeBootstrapSave(directModeConfirmed: true); cancelledSave.model.finishBootstrapOnly()
        check(cancelledSave.model.phase == .cancelled && !cancelledSave.model.bootstrapSaveCommandSent &&
              !cancelledSave.model.canTypeBootstrapSave && cancelledSave.invocations == ["save-bootstrap"],
              "late SAVE proof after cancellation cannot finish setup or trigger a retry")
    }
    static func main() async throws {
        let oldEditionPreference = UserDefaults.standard.object(forKey: "smileBASICDemo")
        UserDefaults.standard.set(true, forKey: "smileBASICDemo")
        defer {
            if let oldEditionPreference { UserDefaults.standard.set(oldEditionPreference, forKey: "smileBASICDemo") }
            else { UserDefaults.standard.removeObject(forKey: "smileBASICDemo") }
        }
        let oldQualityPreference = UserDefaults.standard.object(forKey: StremioQuality.preferenceKey)
        UserDefaults.standard.removeObject(forKey: StremioQuality.preferenceKey)
        defer {
            if let oldQualityPreference { UserDefaults.standard.set(oldQualityPreference, forKey: StremioQuality.preferenceKey) }
            else { UserDefaults.standard.removeObject(forKey: StremioQuality.preferenceKey) }
        }
        let persisted = SessionModel(addressProvider: { [] })
        check(persisted.selectedEdition == .full && persisted.activeEdition == .full, "an old saved preference does not silently select the demo")
        check(persisted.loadWaitMs == 1000 && persisted.runWaitMs == 0 && persisted.removeWaitMs == 0 && persisted.loadConfirmWaitMs == 0,
              "only the post-confirmation LOAD wait defaults to one second")
        check(persisted.keyDelayMs == 10, "default keystroke delay is 10 ms")
        check(persisted.stremioQuality == .p720, "a new installation starts at 720p")
        for quality in StremioQuality.allCases {
            persisted.stremioQuality = quality
            let reopened = SessionModel(addressProvider: { [] })
            check(reopened.stremioQuality == quality, "each valid Stremio quality survives reopening the model")
        }
        for unavailableQuality in ["1080p", "invalid-quality"] {
            UserDefaults.standard.set(unavailableQuality, forKey: StremioQuality.preferenceKey)
            check(SessionModel(addressProvider: { [] }).stremioQuality == .p720, "an unavailable saved quality falls back to 720p")
        }
        let full = try SetupFixture(edition: .full)
        defer { full.dispose() }
        try await bootstrap(full)
        check(full.model.activeEdition == .full, "full edition keeps the normal save checkpoint")
        full.model.finishBootstrapOnly()
        check(full.model.phase == .ready && full.invocations == ["bootstrap"], "full SAVE workflow needs only the bootstrap sender")
        try await bootstrapSaveFixtures()
        let failed = try SetupFixture(edition: .full)
        defer { failed.dispose() }
        try failed.put("failed-bootstrap")
        failed.model.selectRunMode(.bootstrapOnly); failed.model.start()
        try failed.put("release-bootstrap")
        try await until("failed bootstrap worker") { !failed.model.hasLiveWorkers }
        check(failed.model.phase == .failed, "bootstrap failure never marks the program saved")
        failed.model.finishBootstrapOnly()
        check(failed.model.phase == .failed, "save confirmation cannot erase a failed bootstrap")

        let unproven = try SetupFixture(edition: .full)
        defer { unproven.dispose() }
        try unproven.put("unproven-bootstrap"); unproven.model.selectRunMode(.bootstrapOnly); unproven.model.start()
        try unproven.put("release-bootstrap")
        try await until("unproven bootstrap exit") { !unproven.model.hasLiveWorkers }
        check(unproven.model.phase == .failed && unproven.model.error?.contains("without confirming completion") == true,
              "exit zero without a bootstrap completion event fails closed")

        let cancelled = try SetupFixture(edition: .full)
        defer { cancelled.dispose() }
        cancelled.model.selectRunMode(.bootstrapOnly); cancelled.model.start()
        try await until("cancel fixture worker started") { cancelled.invocations.contains("bootstrap") }
        cancelled.model.cancel()
        try await until("cancelled bootstrap exit") { !cancelled.model.hasLiveWorkers }
        cancelled.model.finishBootstrapOnly()
        check(cancelled.model.phase == .cancelled, "cancellation during bootstrap typing cannot become a saved setup")

        for code in [0, 130] {
            let keyboard = try SetupFixture(edition: .full)
            defer { keyboard.dispose() }
            try keyboard.put("release-live"); try keyboard.put("exit-code-live", "\(code)\n")
            check(keyboard.model.canStartKeyboard, "keyboard can begin only from idle with a runtime and loaded driver")
            keyboard.model.startKeyboardForwarding()
            check(keyboard.model.keyboardIsLoading && !keyboard.model.keyboardActive && keyboard.model.keyboardStatus == "Loading…" &&
                  !keyboard.model.detail.contains("Click the typing area"), "a new live keyboard shows loading instead of a premature typing prompt")
            try await until("keyboard ready") { keyboard.model.keyboardActive }
            keyboard.model.selectRunMode(.bootstrapOnly); keyboard.model.start(); keyboard.model.startKeyboardForwarding()
            check(keyboard.model.phase == .keyboardForwarding && !keyboard.model.canStartKeyboard && keyboard.model.runMode == .heldRPC,
                  "live keyboard blocks new workflows and duplicate keyboard launch")
            keyboard.model.sendKeyboardReport([0,0,4,0,0,0,0])
            keyboard.model.sendKeyboardReport([0,1,4,0,0,0,0,0])
            keyboard.model.sendKeyboardReport([0,0,4,0,0,0,0,0])
            try await until("one validated keyboard report") { keyboard.reports.count == 1 }
            check((keyboard.reports.first?["report"] as? [Int]) == [0,0,4,0,0,0,0,0], "only complete reports with a zero reserved byte reach the fake stdin")
            keyboard.model.sendKeyboardReport(Array(repeating: 0, count: 8))
            try await until("explicit release report") { keyboard.reports.count == 2 }
            check((keyboard.reports.last?["report"] as? [Int]) == Array(repeating: 0, count: 8), "the model forwards all-key release reports")
            keyboard.model.stopKeyboardForwarding(); keyboard.model.stopKeyboardForwarding()
            try await until("positive keyboard stop and process exit") { !keyboard.model.hasLiveWorkers }
            check(keyboard.model.phase == .ready && !keyboard.model.keyboardActive && keyboard.model.error == nil,
                  "positive keyboard-stopped proof permits expected exit \(code) without a generic failure")
            check(keyboard.invocations == ["live"] && keyboard.model.canStartKeyboard,
                  "keyboard stops without launching another worker and can be used again")
        }

        let unexpectedKeyboard = try SetupFixture(edition: .full)
        defer { unexpectedKeyboard.dispose() }
        try unexpectedKeyboard.put("release-live"); try unexpectedKeyboard.put("unproven-live")
        unexpectedKeyboard.model.startKeyboardForwarding()
        try await until("keyboard unproven zero exit") { !unexpectedKeyboard.model.hasLiveWorkers }
        check(unexpectedKeyboard.model.phase == .failed && unexpectedKeyboard.model.error?.contains("without confirming completion") == true,
              "live keyboard exit zero without stopped proof is a failure")

        let connecting = try SetupFixture(edition: .full)
        defer { connecting.dispose() }
        try connecting.put("late-ready-live")
        var phases: [SessionPhase] = []
        let observed = connecting.model.$phase.sink { phases.append($0) }
        connecting.model.startKeyboardForwarding()
        try await until("connecting keyboard worker trap installed") { FileManager.default.fileExists(atPath: connecting.root.appendingPathComponent("live-awaiting").path) }
        connecting.model.stopKeyboardForwarding()
        try await until("stop while connecting") { !connecting.model.hasLiveWorkers }
        check(connecting.model.phase == .ready && !phases.contains(.keyboardForwarding), "late ready after Stop cannot re-enable forwarding")
        withExtendedLifetime(observed) {}

        let address = NetworkAddress(address: "192.0.2.42", interface: "en12")
        let changed = NetworkAddress(address: "192.0.2.43", interface: "en12")
        var available = [address], commandAddressReads = 0
        let commands = try SetupFixture(edition: .full, addressProvider: { commandAddressReads += 1; return available })
        defer { commands.dispose() }
        var subsetStatuses: [String] = []
        let subsetStatusObservation = commands.model.$status.sink { subsetStatuses.append($0) }
        check(commands.model.canStartCommandsOnly() && commands.model.selectedAddress.isEmpty,
              "the default first three commands need no selected address or network")
        check(commands.model.canStartCommandsOnly(commands: [.start], startPrefix: true),
              "an unfinished START prefix can target a different machine without a Mac IP")
        commands.model.driverLoaded = false
        check(!commands.model.canStartCommandsOnly(), "command typing still requires the loaded USB driver")
        commands.model.driverLoaded = true; commands.model.keyDelayMs = 0
        check(!commands.model.canStartCommandsOnly(), "command typing still validates USB timings")
        commands.model.keyDelayMs = 10
        for invalid in [[], [.run, .load], [.run, .run]] as [[PostBootstrapCommand]] {
            check(!commands.model.canStartCommandsOnly(commands: invalid), "empty, repeated or reordered commands are rejected")
            commands.model.startCommandsOnly(commands: invalid)
        }
        check(!commands.model.canStartCommandsOnly(commands: [.start]) &&
              !commands.model.canStartCommandsOnly(commands: [.load], startPrefix: true) &&
              !commands.model.canStartCommandsOnly(commands: [.start], startCommand: "V=START(39380,1,2,3,4)", startPrefix: true),
              "START needs either an explicit manual command or exclusive prefix intent")
        check(commands.invocations.isEmpty && !commands.model.hasLiveWorkers, "invalid selections launch nothing")
        for invalid in ["V=START(39381,1,2,3,4)", "V=START(39380,256,2,3,4)",
                        "V=START(39380,01,2,3,4)", "V=START(39380,1,2,3,4,0,0,0,0)",
                        "V=START(39380,1,2,3,4):PRINT 1", "V=START(39380,"] {
            check(PostBootstrapCommandSelection(commands: [.start], startCommand: invalid) == nil,
                  "manual START rejects malformed or noncanonical host input")
        }
        try commands.put("hold-exit-commands-only"); try commands.put("wrong-progress-commands-only")
        var selected: [PostBootstrapCommand] = [.load, .remove]
        commands.model.startCommandsOnly(commands: selected)
        selected = [.run]
        check(commands.model.phase == .commands && commands.model.activeRunMode == .commandsOnly && commands.model.activeAddress.isEmpty &&
              commands.model.activeCommandSelection?.commands == [.load, .remove] && commands.model.activeCommandCount == 2,
              "the selected subset and count are frozen independently of UI changes and network selection")
        commands.model.startCommandsOnly(); commands.model.startKeyboardForwarding(); commands.model.start()
        check(!commands.model.canStartKeyboard && !commands.model.canStartCommandsOnly() && commands.model.phase == .commands,
              "commands-only blocks concurrent host, keyboard and duplicate sender attempts")
        available = [changed]; commands.model.refreshNetworkAddressesIfIdle()
        check(commandAddressReads == 0 && commands.model.activeAddress.isEmpty,
              "command typing never reads or captures the Mac's network inventory")
        try commands.put("release-commands-only")
        try await until("invalid progress fixture emitted") { FileManager.default.fileExists(atPath: commands.root.appendingPathComponent("wrong-progress-sent").path) }
        try await Task.sleep(nanoseconds: 30_000_000)
        check(commands.model.progressLabel == "0 of 2 commands sent", "a mismatched four-command progress event cannot overwrite the frozen subset count")
        try commands.put("release-good-progress")
        try await until("commands sent before adapter exit") { commands.model.phase == .commandsSent }
        check(commands.model.hasLiveWorkers && commands.model.isBusy && !commands.model.canReturnToStart && !commands.model.canRestartForUpdate,
              "completion cannot permit another run or update before the sender exits")
        check(commands.model.postRun.stage == .inactive && !commands.model.postRun.heldConfirmed && !commands.model.canLaunchHomebrew,
              "keyboard delivery and a spurious HID verified event never grant held RPC or homebrew")
        check(commands.model.progressLabel == "2 commands sent · host not verified", "terminal delivery reports the selected count")
        try commands.put("exit-commands-only")
        try await until("commands-only sender exit") { !commands.model.hasLiveWorkers }
        check(commands.model.phase == .commandsSent && commands.model.canReturnToStart && !commands.model.isBusy && commands.model.canStartKeyboard,
              "ordinary subset completion permits an explicit manual keyboard continuation but never auto-connects")
        check(commands.model.status == "Commands sent — check your Switch" &&
              commands.model.detail.contains("No ns2jb host was started") && commands.model.detail.contains("not been verified"),
              "the terminal result explicitly distinguishes delivery from host verification")
        check(commands.model.workflowProgress.state(for: 2) == .pending && commands.invocations == ["commands-only"],
              "a non-prefix subset never starts a host or automatically starts the live keyboard")
        check(subsetStatuses.contains("Preparing LOAD…") && subsetStatuses.contains("Sending LOAD…") &&
              subsetStatuses.contains("LOAD sent") && subsetStatuses.contains("Sending REMOVE…") &&
              !subsetStatuses.contains("Sending RUN…") && !subsetStatuses.contains("Sending START…"),
              "selected-command status uses only the actual selected command labels")
        withExtendedLifetime(subsetStatusObservation) {}
        let arguments = try String(contentsOf: commands.root.appendingPathComponent("arguments"), encoding: .utf8)
        check(arguments.contains("hid commands-only auto 10") && arguments.contains("--commands load,remove") &&
              arguments.contains("--load-confirm-wait-ms 0") && arguments.contains("--load-wait-ms 1000") &&
              !arguments.contains("--start-command") && !arguments.contains("192.0.2") &&
              !arguments.contains("--save-name") && !arguments.contains("--load-name") && !arguments.contains("--start-port"),
              "only the frozen CSV, edition and timings reach the adapter; host names and port come from its selected profile")
        commands.model.returnToStart()
        check(commands.model.phase == .ready, "commands-only can return to the normal start screen after drain")

        let manual = try SetupFixture(edition: .full)
        defer { manual.dispose() }
        manual.model.startCommandsOnly(commands: [.start], startCommand: "  V=START(39380,198,51,100,7)\n")
        try manual.put("release-commands-only")
        try await until("manual remote START submitted") { !manual.model.hasLiveWorkers }
        let manualArguments = try String(contentsOf: manual.root.appendingPathComponent("arguments"), encoding: .utf8)
        check(manual.model.phase == .commandsSent && manual.model.activeCommandCount == 1 && manual.model.activeAddress.isEmpty &&
              manualArguments.contains("--commands start --start-command V=START(39380,198,51,100,7)") && manual.invocations == ["commands-only"],
              "a full manual START preserves the remote host exactly and does not auto-connect the keyboard")

        for invalidCompletion in ["unproven-commands-only", "wrong-kind-commands-only"] {
            let rejected = try SetupFixture(edition: .full, addressProvider: { [address] })
            defer { rejected.dispose() }
            rejected.model.addresses = [address]; rejected.model.selectedAddress = address.address
            try rejected.put(invalidCompletion); rejected.model.startCommandsOnly(); try rejected.put("release-commands-only")
            try await until("invalid commands-only completion rejected") { !rejected.model.hasLiveWorkers }
            check(rejected.model.phase == .failed && rejected.model.error?.contains("without confirming completion") == true &&
                  !rejected.model.canLaunchHomebrew, "missing or mismatched command completion fails without claiming a verified result")
        }

        let badCommandExit = try SetupFixture(edition: .full, addressProvider: { [address] })
        defer { badCommandExit.dispose() }
        badCommandExit.model.addresses = [address]; badCommandExit.model.selectedAddress = address.address
        try badCommandExit.put("exit-code-commands-only", "1\n")
        badCommandExit.model.startCommandsOnly(); try badCommandExit.put("release-commands-only")
        try await until("nonzero commands-only exit") { !badCommandExit.model.hasLiveWorkers }
        check(badCommandExit.model.phase == .failed && !badCommandExit.model.canReturnToStart,
              "a failing sender after its positive event cannot leave a success screen")

        var prefixAddressReads = 0
        let prefix = try SetupFixture(edition: .full, addressProvider: { prefixAddressReads += 1; return [] })
        defer { prefix.dispose() }
        var prefixStatuses: [String] = []
        let prefixStatusObservation = prefix.model.$status.sink { prefixStatuses.append($0) }
        try prefix.put("hold-exit-commands-only")
        try prefix.put("pre-events-live", "{\"type\":\"controller\",\"controller\":\"usb-drd3\",\"message\":\"Fixture controller attempt must not replace loading\"}\n")
        try prefix.put("proof-controller-commands-only", "usb-drd3\n"); try prefix.put("proof-controller-live", "usb-drd3\n")
        prefix.model.startCommandsOnly(commands: [.run, .start], startPrefix: true)
        try prefix.put("release-commands-only")
        try await until("prefix proof before sender exit") { prefix.model.phase == .commandsSent }
        check(prefix.model.hasLiveWorkers && prefix.invocations == ["commands-only"] && !prefix.model.canStartKeyboard,
              "even valid prefix proof cannot start the live keyboard before the old sender exits")
        check(prefix.model.keyboardIsLoading && !prefix.model.keyboardActive && prefix.model.keyboardStatus == "Loading…" &&
              prefix.model.status == "Loading…" && !prefix.model.detail.contains("Enter your host"),
              "the proven-prefix sender-drain gap remains loading without a typing prompt or Connect state")
        check(prefix.model.activeCommandSelection?.startPrefix == true && prefix.model.activeCommandCount == 2 &&
              prefix.model.progressLabel.contains("START is unfinished") && prefix.model.progress == 0.5,
              "START prefix is not counted as a submitted command or Enter")
        prefix.model.startCommandsOnly(commands: [.remove])
        check(prefix.model.activeCommandSelection?.commands == [.run, .start], "the handoff intent cannot be replaced by another selection while draining")
        try prefix.put("exit-commands-only")
        try await until("prefix keyboard created but not ready") {
            prefix.model.phase == .keyboardConnecting && FileManager.default.fileExists(atPath: prefix.root.appendingPathComponent("live-awaiting").path)
        }
        try await Task.sleep(nanoseconds: 30_000_000)
        prefix.model.sendKeyboardReport([0,0,4,0,0,0,0,0])
        check(prefix.model.keyboardIsLoading && !prefix.model.keyboardActive && prefix.model.keyboardStatus == "Loading…" &&
              prefix.model.status == "Loading…" && !prefix.model.detail.contains("Click the typing area") && prefix.reports.isEmpty,
              "the connecting interval stays loading and rejects key input even after controller-attempt messages")
        try prefix.put("release-live")
        try await until("proven prefix automatic keyboard handoff") { prefix.model.keyboardActive }
        check(!prefix.model.keyboardIsLoading, "only positive keyboard readiness ends loading")
        check(prefix.invocations == ["commands-only", "live"] && prefixAddressReads == 0 && prefix.model.activeAddress.isEmpty,
              "successful prefix typing automatically starts only live keyboard, with no Mac address lookup or host")
        check(prefix.model.keyboardStatus == "Click the typing area. Enter the host IP as four comma-separated numbers, add ), then press Enter." &&
              prefix.model.detail == prefix.model.keyboardStatus && !prefix.model.canLaunchHomebrew,
              "the keyboard retains remote-host completion guidance without claiming execution proof")
        let prefixArguments = try String(contentsOf: prefix.root.appendingPathComponent("arguments"), encoding: .utf8)
        check(prefixArguments.contains("--commands run,start --start-prefix") && !prefixArguments.contains("--start-command") &&
              !prefixArguments.contains("--start-address"), "prefix mode never sends a synthesized full START or local IP")
        check(prefixArguments.contains("live auto 4 --preferred-controller usb-drd3") && prefix.model.lastSuccessfulController == "usb-drd3",
              "the proven command controller is reused for automatic live keyboard handoff")
        check(prefixStatuses.contains("Preparing RUN…") && prefixStatuses.contains("Sending RUN…") &&
              prefixStatuses.contains("Sending START prefix…") && !prefixStatuses.contains("Sending START…"),
              "the unfinished START prefix is distinguished from a submitted START command")
        withExtendedLifetime(prefixStatusObservation) {}
        prefix.model.stopKeyboardForwarding()
        try await until("prefix keyboard clean stop") { !prefix.model.hasLiveWorkers }
        check(prefix.model.phase == .ready && prefix.model.error == nil,
              "stopping the continuation releases the keyboard without pretending START was verified")

        for failure in ["missing-prefix-proof", "missing-prefix-transfer", "nonzero", "cancel"] {
            let denied = try SetupFixture(edition: .full)
            defer { denied.dispose() }
            if failure == "nonzero" { try denied.put("exit-code-commands-only", "1\n") }
            else if failure == "cancel" { try denied.put("hold-exit-commands-only") }
            else { try denied.put(failure) }
            denied.model.startCommandsOnly(commands: [.start], startPrefix: true)
            try denied.put("release-commands-only")
            if failure == "cancel" {
                try await until("prefix ready to cancel before exit") { denied.model.phase == .commandsSent }
                denied.model.stopKeyboardForwarding()
            }
            try await until("rejected prefix handoff") { !denied.model.hasLiveWorkers }
            check(denied.invocations == ["commands-only"] && !denied.model.keyboardActive &&
                  !denied.model.keyboardIsLoading && denied.model.phase == (failure == "cancel" ? .cancelled : .failed),
                  "\(failure) cannot trigger a keyboard handoff or retry")
        }

        let gpu = try SetupFixture(edition: .full, addressProvider: { [address] })
        defer { gpu.dispose() }
        let addonURLs = ["https://example.invalid/manifest.json"]
        let libraryItems: [[String: Any]] = [["id": "fixture-library"]]
        gpu.model.mintBrewAccountProvider = { (addonURLs, libraryItems) }
        gpu.model.addresses = [address]; gpu.model.selectedAddress = address.address
        try gpu.put("pre-events-host", "{\"type\":\"typing\",\"kind\":\"bootstrap\",\"controller\":\"usb-drd3\"}\n{\"type\":\"typing\",\"kind\":\"bootstrap\",\"controller\":\"usb-drd3\"}\n")
        gpu.model.launchMintBrew()
        check(!gpu.model.postRun.homebrewAttempted && !gpu.model.hasLiveWorkers,
              "MintBrew cannot create a host or consume an attempt from the start screen")
        gpu.model.start()
        try await until("held choice received by inert host") { FileManager.default.fileExists(atPath: gpu.root.appendingPathComponent("held-choice-received").path) }
        check(!gpu.model.postRun.homebrewAttempted && !gpu.model.postRun.heldConfirmed,
              "the held choice cannot launch MintBrew without positive rpc-held proof")
        check(gpu.model.lastSuccessfulController == nil, "host events never teach the USB controller preference")
        try gpu.put("release-rpc-held")
        try await until("automatic MintBrew launch") {
            gpu.model.postRun.homebrewAttempted && gpu.model.phase == .launchingHomebrew
        }
        check(gpu.model.homebrewTitle == "MintBrew" && !gpu.model.canLaunchHomebrew &&
              gpu.model.detail.contains("safely disconnect") && gpu.model.detail.contains("same network") &&
              gpu.model.detail.contains("SmileBASIC and mac2jb open"),
              "the verified GUI jailbreak starts MintBrew with post-RPC USB guidance")
        gpu.model.launchMintBrew(); gpu.model.launchIZlauncher(); gpu.model.checkRPCStatus(); gpu.model.startKeyboardForwarding()
        check(!gpu.model.postRun.canFinish && !gpu.model.canLaunchHomebrew && !gpu.model.canStartKeyboard,
              "MintBrew startup blocks other apps, status, keyboard and premature Finish")
        try gpu.put("release-gpu-running")
        try await until("MintBrew running", diagnostic: { " phase=\(gpu.model.phase) status=\(gpu.model.status) detail=\(gpu.model.detail) log=\(gpu.model.log.suffix(500))" }) { gpu.model.phase == .homebrewRunning }
        check(gpu.model.postRun.canFinish && gpu.model.postRun.homebrewStage == .running && gpu.model.canDumpSystemCode,
              "a running MintBrew exposes the existing Finish control and an in-session system-code dump")
        gpu.model.dumpSystemCode()
        try await until("MintBrew held-session system-code dump") {
            gpu.model.postRun.dumpCompleted && gpu.model.postRun.stage == .held
        }
        check(gpu.model.dumpFolder != nil && !gpu.model.canDumpSystemCode,
              "the held-session dump exposes its folder and cannot repeat in this session")
        gpu.model.finishPostRun()
        try await until("MintBrew original-session final cleanup") { gpu.model.phase == .verified && !gpu.model.hasLiveWorkers }
        let controls = try String(contentsOf: gpu.root.appendingPathComponent("controls"), encoding: .utf8)
            .split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String:Any] }
        check(controls.compactMap { $0["action"] as? String } == ["post-run", "launch-mintbrew", "dump-system-code", "finish"] &&
              gpu.invocations == ["host"],
              "automatic MintBrew and its dump use the same original held host")
        let launchControl = controls.first { $0["action"] as? String == "launch-mintbrew" }
        check((launchControl?["addonUrls"] as? [String]) == addonURLs &&
              (launchControl?["libraryItems"] as? [[String: String]])?.first?["id"] == "fixture-library",
              "automatic MintBrew receives the current Stremio account configuration")

        for (keepRPC, launcher) in [(false, "mint"), (true, "mint"), (true, "iz")] {
            let host = try SetupFixture(edition: .full, addressProvider: { [address] })
            defer { host.dispose() }
            host.model.addresses = [address]; host.model.selectedAddress = address.address
            host.model.driverLoaded = false; host.model.keyDelayMs = -99; host.model.enumerationTimeoutSeconds = 0
            host.model.loadConfirmWaitMs = -1; host.model.loadWaitMs = -1; host.model.runWaitMs = -1; host.model.removeWaitMs = -1
            host.model.driverSetupRunning = true
            check(!host.model.canStartHostOnly, "host-only cannot overlap driver installation")
            host.model.driverSetupRunning = false
            check(host.model.canStartHostOnly && !host.model.canStartKeyboard,
                  "host-only is available without a loaded USB driver or valid typing timings")
            try host.put("manual-host-fixture")
            if keepRPC { try host.put("manual-host-held") }
            try host.put("manual-host-ready", "{\"type\":\"host-ready\",\"startCommand\":\"V=START(39380,192,0,2,42)\"}\n")
            host.model.startHostOnly(keepRPC: keepRPC)
            check(host.model.phase == .hostStarting && host.model.activeRunMode == (keepRPC ? .hostOnlyHeld : .hostOnly),
                  "host-only freezes its hold choice before launching")
            host.model.startHostOnly(keepRPC: !keepRPC); host.model.startCommandsOnly(); host.model.startKeyboardForwarding()
            try host.put("release-host-ready")
            try await until("host-ready without HID") { host.model.phase == .waitingForConsole }
            check(host.model.activeAddress == address.address && host.model.hostStartCommand == "V=START(39380,192,0,2,42)" &&
                  host.invocations == ["host"] && !host.model.canRestartForUpdate,
                  "host-ready exposes only the captured pairing command and never launches HID")
            check(host.model.activeSessionSupportsHomebrew == keepRPC && !host.model.canLaunchHomebrew && !host.model.postRun.heldConfirmed,
                  "host readiness alone never grants homebrew or held proof")
            host.model.start(); host.model.launchMintBrew(); host.model.launchIZlauncher()
            try host.put("release-console-result")
            if keepRPC {
                try await until("manual host held choice") { FileManager.default.fileExists(atPath: host.root.appendingPathComponent("held-choice-received").path) }
                check(!host.model.canLaunchHomebrew, "post-run choice alone is not positive retained-endpoint proof")
                try host.put("release-rpc-held")
                try await until("host-only positive held proof") { host.model.canLaunchHomebrew }
                check(host.model.phase == .rpcHeld && !host.model.postRun.homebrewAttempted,
                      "host-only held RPC keeps app selection manual")
                if launcher == "iz" { host.model.launchIZlauncher() } else { host.model.launchMintBrew() }
                check(host.model.homebrewTitle == (launcher == "iz" ? "IZlauncher" : "MintBrew"),
                      "host-only launches the selected independent launcher")
                try host.put("release-gpu-running")
                try await until("homebrew on manually connected host") { host.model.phase == .homebrewRunning }
                host.model.finishPostRun()
            }
            try await until("host-only final cleanup") { host.model.phase == .verified && !host.model.hasLiveWorkers }
            check(host.invocations == ["host"] && host.model.activeRunMode.isHostOnly && host.model.canReturnToStart,
                  "both host-only variants finish through the original host without a USB or bootstrap worker")
            let args = try String(contentsOf: host.root.appendingPathComponent("arguments"), encoding: .utf8)
            check(args.contains("host 192.0.2.42") && args.contains("--post-run-options") == keepRPC && !args.contains("--load-wait-ms"),
                  "host-only sends only the address and optional held flag, never invalid USB timings")
        }

        let assistedHost = try SetupFixture(edition: .full, addressProvider: { [address] })
        defer { assistedHost.dispose() }
        assistedHost.model.addresses = [address]; assistedHost.model.selectedAddress = address.address
        try assistedHost.put("manual-host-fixture")
        try assistedHost.put("manual-host-ready", "{\"type\":\"host-ready\",\"startCommand\":\"V=START(39380,192,0,2,42)\"}\n")
        assistedHost.model.startHostOnly(keepRPC: false)
        try assistedHost.put("release-host-ready")
        try await until("host-only sender becomes available") { assistedHost.model.canSendHostOnlyCommands }
        check(assistedHost.model.canStartKeyboard && assistedHost.model.hostStartCommand == "V=START(39380,192,0,2,42)" &&
              assistedHost.invocations == ["host"],
              "host-only offers live keyboard and the exact current pairing command without starting HID")
        assistedHost.model.sendHostOnlyCommands()
        check(assistedHost.model.phase == .commands && !assistedHost.model.canSendHostOnlyCommands,
              "explicit host-only button starts the existing four-command HID sender alongside the host")
        try await until("host-only command worker starts") { assistedHost.invocations == ["host", "commands"] }
        try assistedHost.put("release-commands")
        for step in 1...4 {
            try assistedHost.put("release-command-start-\(step)")
            try assistedHost.put("release-command-complete-\(step)")
        }
        try assistedHost.put("release-load-confirmation")
        try assistedHost.put("release-command-wait-1")
        try assistedHost.put("release-command-transfer")
        try await until("host-only command sender finishes", diagnostic: {
            " phase=\(assistedHost.model.phase) status=\(assistedHost.model.status) detail=\(assistedHost.model.detail) invocations=\(assistedHost.invocations) log=\(assistedHost.model.log.suffix(400))"
        }) {
            assistedHost.model.phase == .waitingForConsole && assistedHost.invocations == ["host", "commands"]
        }
        check(!assistedHost.model.canSendHostOnlyCommands && !assistedHost.model.canStartKeyboard,
              "completed host-only command transfer cannot be sent twice or overlap live keyboard")
        try assistedHost.put("release-console-result")
        try await until("assisted host-only verification") { assistedHost.model.phase == .verified && !assistedHost.model.hasLiveWorkers }
        let assistedArguments = try String(contentsOf: assistedHost.root.appendingPathComponent("arguments"), encoding: .utf8)
        check(assistedArguments.contains("hid commands auto 10") && !assistedArguments.contains("--start-prefix") &&
              !assistedArguments.contains("--start-command"),
              "host-only button uses the host's published pairing instead of inventing a START address")

        let keyboardHost = try SetupFixture(edition: .full, addressProvider: { [address] })
        defer { keyboardHost.dispose() }
        keyboardHost.model.addresses = [address]; keyboardHost.model.selectedAddress = address.address
        try keyboardHost.put("manual-host-fixture")
        try keyboardHost.put("host-stage-fixture")
        try keyboardHost.put("manual-host-ready", "{\"type\":\"host-ready\",\"startCommand\":\"V=START(39380,192,0,2,42)\"}\n")
        keyboardHost.model.startHostOnly(keepRPC: false)
        try keyboardHost.put("release-host-ready")
        try await until("host-only live keyboard can connect") { keyboardHost.model.canStartKeyboard }
        keyboardHost.model.startKeyboardForwarding()
        check(keyboardHost.model.phase == .waitingForConsole && keyboardHost.model.hasLiveWorkers &&
              !keyboardHost.model.canSendHostOnlyCommands,
              "live keyboard preserves the waiting host and prevents a second automatic command sequence")
        try keyboardHost.put("release-live")
        try await until("host-only live keyboard is active") { keyboardHost.model.keyboardActive }
        check(keyboardHost.model.phase == .waitingForConsole && keyboardHost.invocations == ["host", "live"],
              "live keyboard is usable while the original host keeps listening")
        try keyboardHost.put("release-host-connected")
        try await until("host connection releases only live keyboard") {
            keyboardHost.model.hostIsExploiting && !keyboardHost.model.keyboardActive &&
            keyboardHost.model.phase == .waitingForConsole
        }
        check(keyboardHost.model.hasLiveWorkers && keyboardHost.model.error == nil,
              "host connection keeps its worker while the keyboard releases")
        try keyboardHost.put("release-host-waiting")
        try keyboardHost.put("release-host-pipeline")
        try keyboardHost.put("release-console-result")
        try await until("host verifies after live keyboard release") {
            keyboardHost.model.phase == .verified && !keyboardHost.model.hasLiveWorkers
        }

        let demo = try SetupFixture(edition: .demo, addressProvider: { [address] })
        defer { demo.dispose() }
        demo.model.addresses = [address]; demo.model.selectedAddress = address.address
        demo.model.start()
        try await until("demo held choice") { FileManager.default.fileExists(atPath: demo.root.appendingPathComponent("held-choice-received").path) }
        try demo.put("release-rpc-held")
        try await until("demo MintBrew launch") { demo.model.postRun.homebrewAttempted }
        check(demo.model.activeEdition == .demo && demo.model.activeHost == .kurumuz &&
              demo.model.homebrewTitle == "MintBrew" && demo.model.phase == .launchingHomebrew,
              "the verified kurumuz demo flow automatically launches MintBrew")
        try demo.put("release-gpu-running")
        try await until("demo MintBrew running", diagnostic: { " phase=\(demo.model.phase) status=\(demo.model.status) detail=\(demo.model.detail) log=\(demo.model.log.suffix(500))" }) { demo.model.phase == .homebrewRunning }
        demo.model.finishPostRun()
        try await until("demo MintBrew session finishes") { demo.model.phase == .verified && !demo.model.hasLiveWorkers }
        let demoControls = try String(contentsOf: demo.root.appendingPathComponent("controls"), encoding: .utf8)
            .split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String:Any] }
        check(demoControls.compactMap { $0["action"] as? String } == ["post-run", "launch-mintbrew", "finish"] && demo.invocations == ["host"],
              "automatic demo MintBrew reuses the original kurumuz host")

        let unprovenHost = try SetupFixture(edition: .full, addressProvider: { [address] })
        defer { unprovenHost.dispose() }
        unprovenHost.model.addresses = [address]; unprovenHost.model.selectedAddress = address.address
        unprovenHost.model.driverLoaded = false
        try unprovenHost.put("manual-host-fixture"); try unprovenHost.put("unproven-host")
        try unprovenHost.put("manual-host-ready", "{\"type\":\"host-ready\",\"startCommand\":\"V=START(39380,192,0,2,99)\"}\n")
        unprovenHost.model.startHostOnly(keepRPC: false); try unprovenHost.put("release-host-ready")
        try await until("unproven host ready") { unprovenHost.model.phase == .waitingForConsole }
        check(unprovenHost.model.hostStartCommand.isEmpty, "a mismatched START address is not displayed as this host's pairing command")
        try unprovenHost.put("release-console-result")
        try await until("unproven host exit") { !unprovenHost.model.hasLiveWorkers }
        check(unprovenHost.model.phase == .failed && unprovenHost.model.error?.contains("without final cleanup verification") == true &&
              unprovenHost.invocations == ["host"] && !unprovenHost.model.canLaunchHomebrew,
              "a zero host exit without verification fails once without HID or auto retry")

        let staleHost = try SetupFixture(edition: .full, addressProvider: { [changed] })
        defer { staleHost.dispose() }
        staleHost.model.addresses = [address]; staleHost.model.selectedAddress = address.address; staleHost.model.driverLoaded = false
        staleHost.model.startHostOnly(keepRPC: true)
        check(staleHost.model.phase == .ready && staleHost.model.selectedAddress == changed.address && staleHost.invocations.isEmpty,
              "host-only still requires review of a freshly changed network address before any worker starts")
        staleHost.model.selectedAddress = "not-an-address"
        check(!staleHost.model.canStartHostOnly, "host-only rejects malformed IPv4 selection")
        let noRuntime = SessionModel(addressProvider: { [address] }, edition: .full)
        noRuntime.phase = .ready; noRuntime.selectedAddress = address.address
        check(!noRuntime.canStartHostOnly, "host-only requires the prepared runtime")

        let skippedFull = try SetupFixture(edition: .full)
        defer { skippedFull.dispose() }
        skippedFull.model.driverLoaded = false; skippedFull.model.keyDelayMs = 0; skippedFull.model.enumerationTimeoutSeconds = 0
        skippedFull.model.loadConfirmWaitMs = -1
        check(skippedFull.model.canSkipBootstrapTyping, "full-version manual SAVE can skip typing without a driver or typing timings")
        skippedFull.model.skipBootstrapTyping()
        check(skippedFull.model.phase == .awaitingSave &&
              skippedFull.model.activeEdition == .full && skippedFull.invocations.isEmpty,
              "full Skip enters only the manual SAVE checkpoint")
        skippedFull.model.finishBootstrapOnly()
        check(skippedFull.model.phase == .ready && skippedFull.model.workflowProgress.bootstrapTypingWasSkipped &&
              skippedFull.model.workflowProgress.state(for: 1) == .complete && skippedFull.model.workflowProgress.state(for: 2) == .pending,
              "confirming a skipped full SAVE completes setup but never claims a verified exploit")

        let skipGuards = try SetupFixture(edition: .full)
        defer { skipGuards.dispose() }
        skipGuards.model.keyDelayMs = 50; skipGuards.model.driverSetupRunning = true
        check(!skipGuards.model.canSkipBootstrapTyping, "Skip cannot overlap driver installation")
        skipGuards.model.driverSetupRunning = false
        for phase in [SessionPhase.bootstrap, .commands, .hostStarting, .rpcHeld, .awaitingSave, .failed, .cancelled, .verified] {
            skipGuards.model.phase = phase; skipGuards.model.skipBootstrapTyping()
            check(!skipGuards.model.canSkipBootstrapTyping && skipGuards.model.phase == phase && skipGuards.invocations.isEmpty,
                  "Skip cannot bypass an active, completed or uncertain \(phase) session")
        }
        noRuntime.skipBootstrapTyping()
        check(!noRuntime.canSkipBootstrapTyping && noRuntime.phase == .ready, "Skip requires a prepared runtime")
        failed.model.skipBootstrapTyping()
        check(failed.model.phase == .failed && !failed.model.workflowProgress.bootstrapTypingWasSkipped,
              "an actual interrupted bootstrap worker cannot be reclassified as a skipped complete bootstrap")

        let drainingKeyboard = try SetupFixture(edition: .full)
        defer { drainingKeyboard.dispose() }
        try drainingKeyboard.put("release-live"); try drainingKeyboard.put("hold-exit-live")
        drainingKeyboard.model.startKeyboardForwarding()
        try await until("keyboard before Skip drain guard") { drainingKeyboard.model.keyboardActive }
        drainingKeyboard.model.stopKeyboardForwarding()
        try await until("positive keyboard stop before worker exit") { drainingKeyboard.model.phase == .ready && drainingKeyboard.model.hasLiveWorkers }
        drainingKeyboard.model.skipBootstrapTyping()
        check(!drainingKeyboard.model.canSkipBootstrapTyping && drainingKeyboard.model.phase == .ready &&
              drainingKeyboard.invocations == ["live"] && !drainingKeyboard.model.workflowProgress.bootstrapTypingWasSkipped,
              "even a ready phase cannot Skip while its old worker is still draining")
        try drainingKeyboard.put("exit-live")
        try await until("keyboard drain after rejected Skip") { !drainingKeyboard.model.hasLiveWorkers }
        check(drainingKeyboard.model.canSkipBootstrapTyping, "Skip becomes available only after the confirmed worker exit")

        let remembered = try SetupFixture(edition: .full)
        defer { remembered.dispose() }
        try remembered.put("proof-controller-bootstrap", "usb-drd1\n")
        try remembered.put("pre-events-bootstrap", "{\"type\":\"controller\",\"controller\":\"usb-drd0\",\"message\":\"Fixture controller attempt only\"}\n")
        remembered.model.selectRunMode(.bootstrapOnly); remembered.model.start()
        try await until("attempt-only controller event") { remembered.model.status == "Fixture controller attempt only" }
        check(remembered.model.lastSuccessfulController == nil, "an attempted controller is never remembered without proof")
        try remembered.put("release-bootstrap")
        try await until("remembered bootstrap proof") { remembered.model.phase == .awaitingSave && !remembered.model.hasLiveWorkers }
        check(remembered.model.lastSuccessfulController == "usb-drd1" && remembered.model.controller == "auto", "bootstrap typing learns the responding controller")
        remembered.model.finishBootstrapOnly(); remembered.model.skipBootstrapTyping()
        check(remembered.model.lastSuccessfulController == "usb-drd1", "typing Skip preserves session controller memory")
        remembered.model.finishBootstrapOnly()

        let manualController = try SetupFixture(edition: .full)
        defer { manualController.dispose() }
        try manualController.put("proof-controller-live", "usb-drd3\n"); try manualController.put("release-live")
        manualController.model.startKeyboardForwarding()
        try await until("initial live controller proof") { manualController.model.keyboardActive }
        manualController.model.stopKeyboardForwarding()
        try await until("initial live controller stopped") { !manualController.model.hasLiveWorkers }
        manualController.model.controller = "usb-drd7"
        try manualController.put("proof-controller-live", "usb-drd7\n")
        manualController.model.startKeyboardForwarding()
        try await until("explicit manual live controller") { manualController.model.keyboardActive }
        manualController.model.stopKeyboardForwarding()
        try await until("explicit manual live stopped") { !manualController.model.hasLiveWorkers }
        var manualControllerArgs = try String(contentsOf: manualController.root.appendingPathComponent("arguments"), encoding: .utf8).split(separator: "\n")
        check(manualControllerArgs[1].contains("live usb-drd7 4") && !manualControllerArgs[1].contains("--preferred-controller") &&
              manualController.model.controller == "usb-drd7" && manualController.model.lastSuccessfulController == "usb-drd7",
              "explicit manual selection wins without a preferred-controller flag or picker changes")
        manualController.model.controller = "auto"
        try manualController.put("proof-controller-commands-only", "usb-drd7\n")
        manualController.model.startCommandsOnly(); try manualController.put("release-commands-only")
        try await until("commands prefer prior manual success") { !manualController.model.hasLiveWorkers }
        manualControllerArgs = try String(contentsOf: manualController.root.appendingPathComponent("arguments"), encoding: .utf8).split(separator: "\n")
        check(manualControllerArgs[2].contains("--preferred-controller usb-drd7"), "switching back to Automatic uses the last proven manual controller")

        let invalidProof = try SetupFixture(edition: .full)
        defer { invalidProof.dispose() }
        try invalidProof.put("pre-events-bootstrap", "{\"type\":\"keyboard-ready\",\"controller\":\"usb-drd3\"}\n{\"type\":\"typing\",\"kind\":\"commands-only\",\"controller\":\"usb-drd3\"}\n{\"type\":\"typing\",\"kind\":\"bootstrap\",\"controller\":\"usb-drd99\"}\n{\"type\":\"typing\",\"kind\":\"bootstrap\",\"controller\":\"usb-drd03\"}\n")
        try await bootstrap(invalidProof)
        check(invalidProof.model.lastSuccessfulController == nil, "wrong-purpose and noncanonical proof controllers are never remembered")
        invalidProof.model.finishBootstrapOnly()

        let cancelledProof = try SetupFixture(edition: .full)
        defer { cancelledProof.dispose() }
        try cancelledProof.put("late-events-bootstrap", "{\"type\":\"typing\",\"kind\":\"bootstrap\",\"controller\":\"usb-drd3\"}\n")
        cancelledProof.model.selectRunMode(.bootstrapOnly); cancelledProof.model.start()
        try await until("cancelled proof worker waiting") { FileManager.default.fileExists(atPath: cancelledProof.root.appendingPathComponent("waiting-bootstrap").path) }
        cancelledProof.model.cancel()
        try await until("cancelled late proof drained") { !cancelledProof.model.hasLiveWorkers }
        check(cancelledProof.model.lastSuccessfulController == nil && !cancelledProof.model.canSkipBootstrapTyping,
              "proof arriving after cancellation neither teaches a controller nor makes Skip safe")

        for unsafe in ["current-proof", "late-proof", "signal", "stop"] {
            let unsafeRetry = try SetupFixture(edition: .full)
            defer { unsafeRetry.dispose() }
            unsafeRetry.model.selectRunMode(.bootstrapOnly)
            try unsafeRetry.put("safe-failed-bootstrap")
            if unsafe == "current-proof" {
                try unsafeRetry.put("pre-events-bootstrap", "{\"type\":\"typing\",\"kind\":\"bootstrap\",\"controller\":\"usb-drd3\"}\n")
            } else if unsafe == "late-proof" {
                try unsafeRetry.put("after-safe-events-bootstrap", "{\"type\":\"typing\",\"kind\":\"bootstrap\",\"controller\":\"usb-drd3\"}\n")
            } else { try unsafeRetry.put("hold-exit-bootstrap") }
            unsafeRetry.model.start(); try unsafeRetry.put("release-bootstrap")
            if unsafe == "signal" || unsafe == "stop" {
                try await until("safe event before forced termination") { unsafeRetry.model.phase == .failed && unsafeRetry.model.hasLiveWorkers }
                if unsafe == "signal" {
                    let pidText = try String(contentsOf: unsafeRetry.root.appendingPathComponent("pid-bootstrap"), encoding: .utf8)
                    check(kill(pid_t(pidText.trimmingCharacters(in: .whitespacesAndNewlines))!, SIGKILL) == 0, "kill only the inert fixture adapter")
                } else { unsafeRetry.model.cancel() }
            }
            try await until("unsafe retry outcome drained") { !unsafeRetry.model.hasLiveWorkers }
            check(unsafeRetry.model.phase == .failed && !unsafeRetry.model.canSkipBootstrapTyping,
                  "\(unsafe) invalidates safe Skip even if a retrySafe event was emitted")
            if unsafe == "late-proof" {
                check(unsafeRetry.model.lastSuccessfulController == nil, "late proof after failure cannot teach a controller")
            }
        }

        let hostProgress = try SetupFixture(edition: .full, addressProvider: { [address] })
        defer { hostProgress.dispose() }
        hostProgress.model.addresses = [address]; hostProgress.model.selectedAddress = address.address
        try hostProgress.put("manual-host-fixture"); try hostProgress.put("host-stage-fixture")
        try hostProgress.put("manual-host-ready", "{\"type\":\"host-ready\",\"startCommand\":\"V=START(39380,192,0,2,42)\"}\n")
        hostProgress.model.startHostOnly(keepRPC: false)
        check(!hostProgress.model.hostIsExploiting, "starting a host does not imply the console exploit has begun")
        try hostProgress.put("release-host-ready")
        try await until("actual host waiting stage") { hostProgress.model.status == "Fixture host waiting" }
        check(!hostProgress.model.hostIsExploiting && hostProgress.model.phase == .waitingForConsole,
              "host readiness, waiting, arbitrary log text and invalid pipeline counts do not claim exploitation")
        try hostProgress.put("release-host-connected")
        try await until("actual host connected stage") { hostProgress.model.hostIsExploiting }
        check(hostProgress.model.phase == .waitingForConsole && hostProgress.invocations == ["host"],
              "a current owned connected event enables only the host progress indicator")
        try hostProgress.put("release-host-waiting")
        try await until("host returned to waiting") { hostProgress.model.status == "Fixture host waiting again" }
        check(!hostProgress.model.hostIsExploiting, "a real waiting stage clears the exploiting indicator")
        try hostProgress.put("release-host-pipeline")
        try await until("actual host pipeline stage") { hostProgress.model.hostIsExploiting && hostProgress.model.status == "Fixture actual pipeline" }
        try hostProgress.put("release-console-result")
        try await until("host pipeline final verification") { hostProgress.model.phase == .verified && !hostProgress.model.hasLiveWorkers }
        check(!hostProgress.model.hostIsExploiting, "final cleanup verification and host exit clear the indicator")

        let wrongHostRole = try SetupFixture(edition: .full)
        defer { wrongHostRole.dispose() }
        try wrongHostRole.put("pre-events-bootstrap", "{\"type\":\"host-stage\",\"stage\":\"connected\"}\n{\"type\":\"host-stage\",\"stage\":\"pipeline\",\"completed\":1,\"total\":4}\n")
        try await bootstrap(wrongHostRole)
        check(!wrongHostRole.model.hostIsExploiting, "HID-role events cannot spoof the host exploit progress")
        wrongHostRole.model.finishBootstrapOnly()

        let stoppedHostProgress = try SetupFixture(edition: .full, addressProvider: { [address] })
        defer { stoppedHostProgress.dispose() }
        stoppedHostProgress.model.addresses = [address]; stoppedHostProgress.model.selectedAddress = address.address
        try stoppedHostProgress.put("manual-host-fixture"); try stoppedHostProgress.put("host-stage-fixture")
        try stoppedHostProgress.put("manual-host-ready", "{\"type\":\"host-ready\"}\n")
        try stoppedHostProgress.put("late-events-host", "{\"type\":\"host-stage\",\"stage\":\"connected\"}\n{\"type\":\"host-stage\",\"stage\":\"pipeline\",\"completed\":1,\"total\":4}\n")
        stoppedHostProgress.model.startHostOnly(keepRPC: false)
        try stoppedHostProgress.put("release-host-ready"); try stoppedHostProgress.put("release-host-connected")
        try await until("connected host before cancellation") { stoppedHostProgress.model.hostIsExploiting }
        stoppedHostProgress.model.cancel()
        check(!stoppedHostProgress.model.hostIsExploiting, "cancellation immediately clears host exploitation status")
        try await until("cancelled host late output drained") { !stoppedHostProgress.model.hasLiveWorkers }
        check(stoppedHostProgress.model.phase == .cancelled && !stoppedHostProgress.model.hostIsExploiting,
              "late current-generation host events after cancellation cannot relight the indicator")

        for edition in SmileBASICEdition.allCases {
        let commandFlow = try SetupFixture(edition: edition, addressProvider: { [address] })
        defer { commandFlow.dispose() }
        commandFlow.model.addresses = [address]; commandFlow.model.selectedAddress = address.address
        try commandFlow.put("command-flow-host")
        try commandFlow.put("pre-events-commands", "{\"type\":\"command-start\",\"kind\":\"commands\",\"step\":1,\"completed\":0,\"total\":99,\"label\":\"LOAD\"}\n{\"type\":\"command-start\",\"kind\":\"commands\",\"step\":2,\"completed\":1,\"total\":4,\"label\":\"START\"}\n{\"type\":\"command-start\",\"kind\":\"commands-only\",\"step\":1,\"completed\":0,\"total\":4,\"label\":\"LOAD\"}\n")
        commandFlow.model.selectRunMode(.exploitOnly); commandFlow.model.start()
        check(commandFlow.model.phase == .hostStarting && commandFlow.model.status == "Starting ns2jb host…",
              "initial host startup has a host-specific status")
        try commandFlow.put("release-command-host-ready")
        try await until("standard command helper waiting before USB readiness", diagnostic: {
            "\nphase=\(commandFlow.model.phase) status=\(commandFlow.model.status) detail=\(commandFlow.model.detail)" +
            "\nworkers=\(commandFlow.model.hasLiveWorkers) invocations=\(commandFlow.invocations) log=\(commandFlow.model.log)"
        }) {
            commandFlow.model.phase == .commands && FileManager.default.fileExists(atPath: commandFlow.root.appendingPathComponent("waiting-commands").path)
        }
        let commandArguments = try String(contentsOf: commandFlow.root.appendingPathComponent("arguments"), encoding: .utf8)
        check(commandArguments.contains("--load-confirm-wait-ms 0") && commandArguments.contains("--load-wait-ms 1000") &&
              commandArguments.contains("--run-wait-ms 0") && commandArguments.contains("--remove-wait-ms 0") &&
              commandArguments.contains("--demo") == (edition == .demo) &&
              !commandArguments.contains("--save-name") && !commandArguments.contains("--load-name") &&
              !commandArguments.contains("--start-port"),
              "both editions pass one second after LOAD confirmation without duplicating host profile flags")
        try await Task.sleep(nanoseconds: 30_000_000)
        check(commandFlow.model.status == "Waiting for USB keyboard…" && commandFlow.model.isEnumerating,
              "standard commands wait for USB and ignore invalid count, label and purpose events")
        try commandFlow.put("release-commands")
        try await until("USB ready before first standard command") { commandFlow.model.status == "Preparing LOAD…" }
        check(commandFlow.model.progressLabel == "0 of 4 commands sent", "USB readiness prepares the first command without claiming it was sent")
        for (index, label) in ["LOAD", "RUN", "REMOVE", "START"].enumerated() {
            let step = index + 1
            try commandFlow.put("release-command-start-\(step)")
            try await until("actual \(label) command start") { commandFlow.model.status == "Sending \(label)…" }
            check(commandFlow.model.progressLabel == "\(index) of 4 commands sent", "\(label) headline follows its current native command event")
            if label == "RUN" {
                try commandFlow.put("release-overlap-host-stage")
                try await until("host exploitation overlaps RUN typing") { commandFlow.model.hostIsExploiting }
                try await Task.sleep(nanoseconds: 30_000_000)
                check(commandFlow.model.status == "Sending RUN…" && commandFlow.model.phase == .commands &&
                      commandFlow.model.progressLabel == "1 of 4 commands sent",
                      "host-stage and host-role command/typing events cannot overwrite the actual active command")
            }
            try commandFlow.put("release-command-complete-\(step)")
            try await until("actual \(label) command completion") { commandFlow.model.status == "\(label) sent" }
            check(commandFlow.model.progressLabel == "\(step) of 4 commands sent", "\(label) completion counts only submitted commands")
            if step == 1 {
                try commandFlow.put("release-load-confirmation")
                try await until("post-confirmation LOAD wait") { commandFlow.model.status == "Waiting after LOAD…" }
                check(commandFlow.model.progressLabel.contains("1 of 4 commands sent"), "LOAD settle wait preserves command progress")
                try commandFlow.put("release-command-wait-1")
            }
        }
        check(commandFlow.model.phase == .commands && !commandFlow.model.canLaunchHomebrew,
              "START submission alone does not claim host verification or held RPC")
        try commandFlow.put("release-command-transfer")
        try await until("standard command transfer drained") { commandFlow.model.phase == .waitingForConsole }
        try await Task.sleep(nanoseconds: 30_000_000)
        check(commandFlow.model.status == "Fixture exploit active while RUN is sent" && commandFlow.model.hostIsExploiting,
              "after transfer the active host stage resumes, and late HID command events cannot relabel it")
        try commandFlow.put("release-command-host-final")
        try await until("standard flow final host verification") { commandFlow.model.phase == .verified && !commandFlow.model.hasLiveWorkers }
        check(!commandFlow.model.hostIsExploiting && commandFlow.invocations == ["host", "commands"],
              "the standard four-command flow keeps the existing single-host verification lifecycle")
        }

        let ui = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        check(ui.contains("I’m using the SmileBASIC demo") && ui.contains("selectedEdition"), "the view exposes the demo edition selector")
        check(ui.contains("Picker(\"Video output\"") && ui.contains("$model.stremioQuality"), "Stremio offers the persistent quality selection")
        check(SmileBASICEdition.allCases == [.full, .demo] && SmileBASICEdition(rawValue: "demo") == .demo, "full and demo editions can be selected")
        print("First-time setup, keyboard, commands-only, host-only and homebrew model checks passed: \(checks). No app, driver, keychain, USB or RPC operations run.")
    }
}
