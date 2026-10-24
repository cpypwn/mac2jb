import SwiftUI
import AppKit

private let ink = Color(red: 0.08, green: 0.15, blue: 0.18)
private let teal = Color(red: 0.00, green: 0.48, blue: 0.43)
private let mist = Color(red: 0.95, green: 0.97, blue: 0.96)

struct ContentView: View {
    @ObservedObject var model: SessionModel
    @State private var readyConfirmed = false
    @State private var savedConfirmed = false
    @State private var showLogs = false
    @State private var driverMessage: String?
    @State private var driverLoading = false
    @State private var showFailure = false
    @State private var failureText = ""

    private var stage: Int {
        switch model.phase {
        case .preparing, .ready: return 0
        case .bootstrap, .awaitingSave: return 1
        case .hostStarting, .commands, .waitingForConsole: return 2
        case .verified: return 3
        default: return 2
        }
    }
    private var canConfigure: Bool {
        [.ready, .failed, .cancelled].contains(model.phase)
    }
    private var headline: String {
        switch model.phase {
        case .preparing: return "Getting everything ready."
        case .ready: return "From Mac to SmileBASIC."
        case .bootstrap: return "Your Mac is doing the typing."
        case .awaitingSave: return "A quick check on your Switch."
        case .hostStarting: return "Starting a fresh session."
        case .commands: return "Sending the next four commands."
        case .waitingForConsole: return "Connected. Follow the progress here."
        case .verified: return "FS execution verified."
        case .failed: return "Let’s check what happened."
        case .cancelled: return "Session stopped."
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    if canConfigure { setup }
                    else { activeSession }
                    activity
                    footer
                }
                .padding(34)
            }
            .background(mist)
        }
        .frame(minWidth: 1020, minHeight: 740)
        .preferredColorScheme(.light)
        .tint(teal)
        .onAppear {
            model.prepare()
            NSApp.activate(ignoringOtherApps: true)
        }
        .onChange(of: model.phase) { _, phase in
            readyConfirmed = false
            savedConfirmed = false
            if phase == .failed {
                showLogs = true
                let location = model.diagnosticLogURL.map { "Log saved at:\n" + $0.path }
                    ?? "A diagnostic log could not be created. The session activity remains visible in this window."
                failureText = (model.error ?? model.detail) + "\n\n" + location
                showFailure = true
            }
        }
        .onChange(of: model.fullInstall) { _, _ in readyConfirmed = false }
        .alert("The session needs attention", isPresented: $showFailure) {
            if model.diagnosticLogURL != nil {
                Button("Open logs") { model.revealSessionFolder() }
            }
            Button("Close", role: .cancel) {}
        } message: { Text(failureText) }
        .alert("USB driver", isPresented: Binding(get: { driverMessage != nil }, set: { if !$0 { driverMessage = nil } })) {
            Button("OK") { driverMessage = nil }
        } message: { Text(driverMessage ?? "") }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "keyboard.fill").font(.system(size: 27, weight: .medium)).foregroundStyle(Color.mint)
                Text("mac2jb").font(.system(size: 26, weight: .bold, design: .rounded)).foregroundStyle(.white)
            }
            .padding(.top, 48)
            Text("A LITTLE LESS MANUAL.")
                .font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(1.2)
                .foregroundStyle(.white.opacity(0.4)).padding(.top, 13)
            VStack(spacing: 26) {
                step(0, "Prepare", "Mac, network & console")
                step(1, "Type bootstrap", model.fullInstall ? "Save NS2 once" : "Use your saved NS2")
                step(2, "Run & verify", "Host and commands")
            }.padding(.top, 55)
            Spacer(minLength: 40)
            Rectangle().fill(.white.opacity(0.12)).frame(height: 1)
            VStack(alignment: .leading, spacing: 12) {
                Label("Apple silicon", systemImage: "desktopcomputer")
                Label("Everything bundled", systemImage: "shippingbox")
                Label("Private session logs", systemImage: "lock")
            }
            .font(.system(size: 11)).foregroundStyle(.white.opacity(0.58)).padding(.vertical, 24)
            Text("v0.3.0 · GUI DEMO")
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .foregroundStyle(.white.opacity(0.35))
        }
        .padding(.horizontal, 25).padding(.bottom, 30)
        .frame(width: 225)
        .background(ink)
    }

    private func step(_ number: Int, _ title: String, _ subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(stage == number ? Color.mint : .white.opacity(0.08)).frame(width: 29, height: 29)
                if stage > number {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Color.mint)
                } else {
                    Text(String(format: "%02d", number + 1)).font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(stage == number ? ink : .white.opacity(0.45))
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(stage == number ? 1 : 0.65))
                Text(subtitle).font(.system(size: 10)).foregroundStyle(.white.opacity(0.35))
            }.padding(.top, 2)
            Spacer(minLength: 0)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Text("MAC → SWITCH 2").font(.system(size: 10, weight: .bold, design: .monospaced)).tracking(1.4).foregroundStyle(teal)
                Spacer()
                Label("Local preview", systemImage: "circle.fill").font(.system(size: 10, weight: .medium)).foregroundStyle(teal)
                    .padding(.horizontal, 11).padding(.vertical, 7).background(teal.opacity(0.08), in: Capsule())
            }
            Text(headline).font(.system(size: 31, weight: .bold, design: .rounded)).tracking(-0.9).foregroundStyle(ink)
            Text(canConfigure ? "Choose your starting point. mac2jb handles the Mac side in this window." : model.detail)
                .font(.system(size: 13)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var setup: some View {
        VStack(spacing: 18) {
            if model.phase == .failed || model.phase == .cancelled {
                note(model.detail + " Restart the console before another post-bootstrap attempt. Clear any partial bootstrap before typing again.", icon: "exclamationmark.circle", color: .orange)
            }
            panel {
                VStack(alignment: .leading, spacing: 16) {
                    eyebrow("01 / STARTING POINT")
                    HStack(spacing: 12) {
                        modeCard(full: true, title: "Full setup", subtitle: "Type the bootstrap, then run.", icon: "keyboard")
                        modeCard(full: false, title: "NS2 already saved", subtitle: "Skip straight to the host.", icon: "bolt")
                    }
                    Divider()
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Mac address on the Switch’s network").font(.system(size: 12, weight: .semibold))
                            if model.addresses.isEmpty {
                                Text("Connect this Mac to your local network, then refresh.").font(.system(size: 11)).foregroundStyle(.secondary)
                            } else {
                                Picker("Network address", selection: $model.selectedAddress) {
                                    ForEach(model.addresses) { address in
                                        Text(address.label).tag(address.address)
                                    }
                                }.labelsHidden().frame(maxWidth: .infinity)
                            }
                        }
                        Button { model.refreshChecks() } label: { Image(systemName: "arrow.clockwise") }
                            .help("Refresh network and driver checks").padding(.top, 22)
                    }
                    DisclosureGroup("USB controller options") {
                        HStack {
                            Picker("Controller", selection: $model.controller) {
                                Text("Automatic · 0, 1, 3").tag("auto")
                                ForEach(0..<16) { Text("usb-drd\($0)").tag("usb-drd\($0)") }
                            }
                            Text("50 ms per key").font(.system(size: 11)).foregroundStyle(.secondary)
                        }.padding(.top, 10)
                    }.font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            panel {
                VStack(alignment: .leading, spacing: 15) {
                    eyebrow("02 / READY CHECK")
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: model.driverInstalled ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                            .foregroundStyle(model.driverInstalled ? teal : .orange)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("USB gadget driver").font(.system(size: 12, weight: .semibold))
                            Text(model.driverStatus).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer()
                        if model.driverInstalled {
                            Button(driverLoading ? "Loading…" : "Load driver…") { loadDriver() }
                                .font(.system(size: 11)).disabled(driverLoading)
                        }
                    }
                    Text(model.fullInstall
                         ? "On the Switch: choose your SmileBASIC project and open an empty slot 0 editor. Use a data cable; if the Mac is charging the Switch, reconnect it."
                         : "On the Switch: restart the console, open the project containing NS2 in slot 0, and select Direct mode.")
                        .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Toggle("The Switch is ready on the screen described above", isOn: $readyConfirmed)
                        .toggleStyle(.checkbox).font(.system(size: 12, weight: .medium))
                    HStack {
                        Text(model.fullInstall ? "Bootstrap typing takes about 7–10 minutes." : "Starts a new host session with fresh pairing values.")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                        Spacer()
                        Button { showLogs = true; model.start() } label: {
                            HStack(spacing: 10) { Text(model.fullInstall ? "Start full setup" : "Start session"); Image(systemName: "arrow.right") }
                                .padding(.horizontal, 10).padding(.vertical, 6)
                        }
                        .buttonStyle(PrimaryActionStyle()).fixedSize()
                        .disabled(!readyConfirmed || model.selectedAddress.isEmpty || model.runtime == nil || !model.driverInstalled)
                    }
                }
            }
        }
    }

    private var activeSession: some View {
        panel {
            VStack(alignment: .leading, spacing: 20) {
                eyebrow("SESSION / \(model.phase == .verified ? "COMPLETE" : "IN PROGRESS")")
                HStack(alignment: .center, spacing: 18) {
                    Image(systemName: model.phase == .verified ? "checkmark.seal.fill" : "cable.connector")
                        .font(.system(size: 34)).foregroundStyle(teal).frame(width: 56, height: 56)
                        .background(teal.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                    VStack(alignment: .leading, spacing: 6) {
                        Text(model.status).font(.system(size: 17, weight: .semibold)).foregroundStyle(ink)
                        Text(model.selectedAddress.isEmpty ? "Preparing the embedded runtime" : "\(model.selectedAddress) · \(model.controller == "auto" ? "Automatic controller" : model.controller)")
                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                    }
                }
                if model.isBusy {
                    if let progress = model.progress { ProgressView(value: progress).tint(teal) }
                    else { ProgressView().progressViewStyle(.linear).tint(teal) }
                }
                if model.phase == .awaitingSave {
                    Divider()
                    Text("Inspect the typed program, save it as NS2 in slot 0, then enter Direct mode in the same project. The GUI will send LOAD, RUN, REMOVE, and this session’s START command.")
                        .font(.system(size: 13)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Toggle("NS2 is saved in slot 0 and Direct mode is open", isOn: $savedConfirmed)
                        .toggleStyle(.checkbox).font(.system(size: 12, weight: .medium))
                    Button("Continue to host & commands") { model.confirmSavedAndDirectMode() }
                        .buttonStyle(PrimaryActionStyle()).fixedSize().disabled(!savedConfirmed)
                } else if model.phase == .verified {
                    Text("The host confirmed execution, restoration, and cleanup. Restart the console when finished.")
                        .font(.system(size: 13)).foregroundStyle(.secondary)
                } else if model.phase == .waitingForConsole {
                    Text("Keyboard transmission is complete. Keep SmileBASIC open and both devices awake while the host checks the result.")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                if model.isBusy || model.phase == .awaitingSave {
                    HStack {
                        Label("Only this app’s session will be stopped", systemImage: "lock")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                        Spacer()
                        Button("Stop session", role: .destructive) { model.cancel() }
                    }
                }
            }
        }
    }

    private var activity: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button { showLogs.toggle() } label: {
                    Label("Session activity", systemImage: showLogs ? "chevron.down" : "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                }.buttonStyle(.plain)
                Spacer()
                Button("Open session logs") { model.revealSessionFolder() }
                    .font(.system(size: 11)).disabled(model.runtime == nil)
            }.foregroundStyle(.secondary)
            if showLogs {
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(model.log.isEmpty ? "Ready when you are. Session activity will appear here." : model.log)
                            .font(.system(size: 10, design: .monospaced)).foregroundStyle(ink.opacity(0.8))
                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(14)
                        Color.clear.frame(height: 1).id("end")
                    }
                    .frame(height: 140)
                    .background(.white, in: RoundedRectangle(cornerRadius: 10))
                    .onChange(of: model.log) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
                }
            }
        }
    }

    private var footer: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle").padding(.top, 1)
            Text("First time? Install and approve a compatible USB gadget driver first. The bundled app needs no Node.js or build tools. v0.2.1 CLI remains available.")
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button("Setup guide ↗") {
                NSWorkspace.shared.open(URL(string: "https://github.com/cpypwn/mac2jb#prerequisites-and-important-security-notes")!)
            }.buttonStyle(.plain).foregroundStyle(teal)
        }.font(.system(size: 10)).foregroundStyle(.secondary)
    }

    private func modeCard(full: Bool, title: String, subtitle: String, icon: String) -> some View {
        Button { model.fullInstall = full } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: icon).font(.system(size: 17)).frame(width: 22)
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.system(size: 13, weight: .semibold))
                    Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: model.fullInstall == full ? "largecircle.fill.circle" : "circle").font(.system(size: 14))
            }
            .foregroundStyle(model.fullInstall == full ? teal : ink)
            .padding(15).frame(maxWidth: .infinity, alignment: .leading)
            .background(model.fullInstall == full ? teal.opacity(0.06) : .white, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(model.fullInstall == full ? teal.opacity(0.6) : .gray.opacity(0.18), lineWidth: 1))
        }.buttonStyle(.plain)
    }
    private func eyebrow(_ text: String) -> some View {
        Text(text).font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(1).foregroundStyle(.secondary)
    }
    private func panel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content().padding(22).frame(maxWidth: .infinity, alignment: .leading)
            .background(.white, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(ink.opacity(0.07), lineWidth: 1))
    }
    private func note(_ text: String, icon: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 10) { Image(systemName: icon); Text(text).fixedSize(horizontal: false, vertical: true) }
            .font(.system(size: 12)).foregroundStyle(color).padding(16)
            .frame(maxWidth: .infinity, alignment: .leading).background(color.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
    }
    private func loadDriver() {
        driverLoading = true
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", "do shell script \"/usr/bin/kmutil load -p /Library/Extensions/usbgadget.kext\" with administrator privileges"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        task.terminationHandler = { task in
            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                driverLoading = false
                model.refreshChecks()
                model.recordDiagnostic(task.terminationStatus == 0 ? "macOS accepted the installed driver load request." : "Driver load request failed: " + output)
                driverMessage = task.terminationStatus == 0
                    ? "macOS accepted the driver load request. Follow any approval or restart instructions. The USB connection still needs to enumerate."
                    : "macOS did not load the driver.\n\n\(output.prefix(1400))\n\nLog: \(model.diagnosticLogURL?.path ?? "Log unavailable")"
            }
        }
        do { try task.run() }
        catch { driverLoading = false; driverMessage = error.localizedDescription }
    }
}

private struct PrimaryActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(enabled ? Color.white : ink.opacity(0.4))
            .frame(minWidth: 145, minHeight: 38)
            .padding(.horizontal, 12)
            .background(enabled ? teal.opacity(configuration.isPressed ? 0.8 : 1) : ink.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }
}
