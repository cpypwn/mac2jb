import SwiftUI
import AppKit
import Combine

private let ink = Mac2jbTheme.ink
private let teal = Mac2jbTheme.mint

private struct ToolsContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct ContentView: View {
    @ObservedObject var model: SessionModel
    @ObservedObject var updater: AppUpdater
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var account = StremioAccount()
    @State private var readyConfirmed = false
    @State private var setupReady = false
    @State private var developerReady = false
    @State private var hostOnlyKeepRPC = false
    @State private var commandsToSend: Set<PostBootstrapCommand> = [.load, .run, .remove]
    @State private var savedConfirmed = false
    @State private var saveDirectModeReady = false
    @State private var showFirstTimeSetup = false
    @State private var showDeveloperOptions = false
    @State private var toolsContentHeight: CGFloat = 0
    @State private var followConsole = true
    @State private var activityTab = 0
    @State private var driverMessage: String?
    @State private var confirmUpdate = false
    @State private var showFailure = false
    @State private var failureText = ""
    @State private var showUpdateFailure = false

    private var canConfigure: Bool { [.ready, .failed, .cancelled].contains(model.phase) }
    private var configurationLocked: Bool { model.hasLiveWorkers || model.driverSetupRunning || !canConfigure }
    private var showHostOnlyHomebrew: Bool {
        hostOnlyKeepRPC && (canConfigure || model.activeRunMode == .hostOnlyHeld)
    }
    private var driverSetupBlocked: Bool { model.runtime == nil || configurationLocked || updater.blocksNewSession }
    private var timingSettingsValid: Bool {
        (1...2000).contains(model.keyDelayMs) && (1...120).contains(model.enumerationTimeoutSeconds) &&
        [model.effectiveLoadConfirmWaitMs, model.loadWaitMs, model.runWaitMs, model.removeWaitMs]
            .allSatisfy { (0...120000).contains($0) }
    }
    private var startBlocked: Bool {
        model.runtime == nil || !model.driverLoaded || !timingSettingsValid || configurationLocked || updater.blocksNewSession
    }
    private var headline: String {
        switch model.phase {
        case .preparing: return "Getting everything ready"
        case .ready: return "Jailbreak your Switch"
        case .bootstrap: return "Your Mac is doing the typing"
        case .awaitingSave: return "One more step on your Switch"
        case .savingBootstrap: return model.status
        case .hostStarting: return model.hostIsExploiting ? "Jailbreaking…" : "Starting ns2jb host…"
        case .rpcAttaching: return "Connecting to open RPC…"
        case .rpcDetached: return "Disconnected"
        case .waitingForConsole:
            return model.hostIsExploiting ? "Jailbreaking…" : model.activeRunMode.isHostOnly ? "Waiting for your console commands" : "Waiting for the Switch to respond"
        case .commands: return model.status
        case .commandsSent: return model.keyboardIsLoading ? "Loading…" : "Commands sent"
        case .rpcHeld: return "You’re ready to go"
        case .dumpingFirmware: return "Saving system code"
        case .rpcFinishing: return "Finishing up safely"
        case .launchingHomebrew: return model.postRun.homebrewStage == .selecting ? "Choose a game" : "Opening \(model.homebrewTitle)"
        case .homebrewRunning: return "\(model.homebrewTitle) is running"
        case .homebrewStopped: return model.postRun.cleanupBlocked ? "Restart your Switch" : "Ready to finish"
        case .keyboardConnecting: return "Loading…"
        case .keyboardForwarding: return "Your Mac is the keyboard"
        case .verified: return "All done"
        case .failed: return "Let’s check what happened"
        case .cancelled: return "Session stopped"
        }
    }

    var body: some View {
        ZStack {
            Mac2jbBackdrop()
            GeometryReader { viewport in
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 16) {
                            if updater.state != .idle { updateStatus }
                            if canConfigure { home } else { activeSession }
                            toolsBubble
                            Text("mac2jb · v\(AppBuildIdentity.version)")
                                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        .frame(maxWidth: 820).padding(.horizontal, 30).padding(.vertical, 24)
                        .frame(maxWidth: .infinity, minHeight: viewport.size.height)
                    }
                    .onChange(of: model.phase) { _, _ in scrollToKeyboardIfNeeded(proxy) }
                    .onChange(of: toolsContentHeight) { _, _ in scrollToKeyboardIfNeeded(proxy) }
                }
            }.ignoresSafeArea(.container, edges: .top)
        }
        .frame(minWidth: 760, minHeight: 560)
        .preferredColorScheme(.dark).tint(teal)
        .onAppear {
            model.accountProgressHandler = { [weak account] update in account?.handleProgress(update) }
            model.mintBrewAccountProvider = { [weak account] in
                (account?.addonURLs ?? [], account?.libraryPayload() ?? [])
            }
            model.prepare(); updater.start()
            NSApp.activate(ignoringOtherApps: true)
        }
        .onDisappear {
            model.accountProgressHandler = nil
            model.mintBrewAccountProvider = nil
            account.cancelSignIn()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            model.refreshNetworkAddressesIfIdle()
        }
        .onChange(of: model.phase) { _, phase in
            readyConfirmed = false; setupReady = false; developerReady = false; savedConfirmed = false; saveDirectModeReady = false
            if phase == .failed {
                let location = model.diagnosticLogURL.map { "Log saved at:\n" + $0.path }
                    ?? "A diagnostic log could not be created. Expand Console & Developer Options to view session activity."
                failureText = (model.error ?? model.detail) + "\n\n" + location
                showFailure = true
            }
        }
        .onChange(of: model.runMode) { _, _ in readyConfirmed = false; setupReady = false; developerReady = false }
        .onChange(of: model.selectedHost) { _, _ in
            readyConfirmed = false; setupReady = false; developerReady = false
            savedConfirmed = false; saveDirectModeReady = false; hostOnlyKeepRPC = false
        }
        .onChange(of: model.selectedAddress) { _, _ in if canConfigure { readyConfirmed = false } }
        .onChange(of: updater.state) { _, state in if state == .failed { showUpdateFailure = true } }
        .onChange(of: showFirstTimeSetup) { _, shown in if shown { setupReady = false } }
        .onChange(of: showDeveloperOptions) { _, shown in if shown { developerReady = false } }
        .sheet(isPresented: $showFirstTimeSetup) { firstTimeSetup }
        .alert("The session needs attention", isPresented: $showFailure) {
            if model.diagnosticLogURL != nil { Button("Open logs") { model.revealSessionFolder() } }
            Button("Close", role: .cancel) {}
        } message: { Text(failureText) }
        .alert("USB driver", isPresented: Binding(get: { driverMessage != nil }, set: { if !$0 { driverMessage = nil } })) {
            Button("OK") { driverMessage = nil }
        } message: { Text(driverMessage ?? "") }
        .alert("The update needs attention", isPresented: $showUpdateFailure) {
            if updater.diagnosticURL != nil { Button("Open update log") { updater.revealLog() } }
            Button("Close", role: .cancel) {}
        } message: { Text(updater.message + (updater.diagnosticURL.map { "\n\nLog saved at:\n" + $0.path } ?? "")) }
        .confirmationDialog("Restart and update mac2jb?", isPresented: $confirmUpdate) {
            Button("Restart & update") {
                updater.install(canRestart: model.canRestartForUpdate) {
                    model.recordDiagnostic("Restarting mac2jb to install the verified update.")
                }
            }
        } message: { Text("The app will close, install the verified release, and reopen. Your logs and driver are kept. The previous app is saved as a backup.") }
    }

    private var home: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let notice = model.networkNotice { note(notice, icon: "network", color: .orange) }
            if model.phase == .failed || model.phase == .cancelled {
                note(model.detail, icon: "exclamationmark.circle", color: .orange)
                if model.hasLiveWorkers {
                    Text("Waiting for the previous session to close before starting again.").font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                }
                if model.dumpFolder != nil { Button("Open dump folder") { model.revealDumpFolder() } }
            }
            panel {
                VStack(alignment: .leading, spacing: 24) {
                    essentials
                    Divider().overlay(.white.opacity(0.04))
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Restart your Switch and open SmileBASIC → Make a Program.")
                            .font(.system(size: 12))
                        Text("USB power: Switch → Mac. The Mac must not charge the Switch.")
                            .font(.system(size: 11))
                        Text("Connect both devices to the same local network. The Switch must use Ethernet.")
                            .font(.system(size: 11))
                    }
                    .foregroundStyle(Mac2jbTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    VStack(alignment: .leading, spacing: 10) {
                        demoEditionCheckbox.foregroundStyle(Mac2jbTheme.muted)
                        Toggle("My Switch is ready and connected by USB", isOn: $readyConfirmed).toggleStyle(.checkbox).font(.system(size: 12, weight: .medium))
                            .fixedSize().disabled(configurationLocked)
                    }
                    VStack(alignment: .leading, spacing: 14) {
                        Button { beginRun(model.selectedHost.supportsHeldRPC ? .heldRPC : .exploitOnly) } label: {
                            HStack(spacing: 14) { Text("Jailbreak"); Image(systemName: "arrow.right") }
                        }.buttonStyle(PrimaryActionStyle(large: true))
                            .disabled(startBlocked || !readyConfirmed || model.selectedAddress.isEmpty)
                        Button("First time setting up mac2jb?") { showFirstTimeSetup = true }
                            .buttonStyle(.plain).font(.system(size: 12, weight: .medium)).foregroundStyle(teal)
                            .disabled(configurationLocked || updater.blocksNewSession)
                    }
                }
            }
        }
    }

    private var demoEditionCheckbox: some View {
        Toggle("I’m using the SmileBASIC demo", isOn: Binding(
            get: { model.selectedEdition == .demo },
            set: { model.selectedEdition = $0 ? .demo : .full }
        ))
        .toggleStyle(.checkbox)
        .font(.system(size: 12))
        .disabled(configurationLocked || updater.blocksNewSession || !model.selectedHost.supportsDemo)
        .help(model.selectedHost.supportsDemo ? "Use the demo LOADV command." : "Choose Kurumuz or BermTheSequel to use the SmileBASIC demo.")
    }

    private var essentials: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: model.driverLoaded ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    .foregroundStyle(model.driverLoaded ? teal : .orange).padding(.top, 2)
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.driverLoaded ? "USB driver loaded" : "USB driver setup needed")
                        .font(.system(size: 12, weight: .semibold))
                        .help("The driver check does not verify the cable connection. USB keyboard connection is checked when you start.")
                    if !model.driverLoaded {
                        Text(model.driverStatus).font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 6)
                Group {
                    if model.driverLoaded {
                        Menu(model.driverSetupRunning ? "Installing…" : "Driver options") {
                            Button("Refresh driver status") { model.refreshChecks() }
                            Button("Reinstall & load driver…") { loadDriver() }
                        }
                    } else {
                        Button(model.driverSetupRunning ? "Installing…" : "Install & load driver…") { loadDriver() }
                    }
                }
                .font(.system(size: 11)).disabled(driverSetupBlocked)
            }
            networkPicker
        }
    }

    private var networkPicker: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: model.addresses.isEmpty ? "network.slash" : "network").foregroundStyle(teal).frame(width: 16)
            VStack(alignment: .leading, spacing: 5) {
                Text("Mac connection").font(.system(size: 12, weight: .semibold))
                if model.addresses.isEmpty {
                    Text("No network address found.").font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                } else {
                    Picker("Mac connection", selection: $model.selectedAddress) {
                        ForEach(model.addresses) { address in Text(address.label).tag(address.address) }
                    }.labelsHidden().frame(maxWidth: 360, alignment: .leading)
                }
            }
            Spacer(minLength: 0)
            Button { model.refreshChecks() } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless).help("Refresh connection and driver checks")
        }.disabled(configurationLocked)
    }

    private func beginRun(_ mode: SessionRunMode) {
        guard !startBlocked, mode == .bootstrapOnly || !model.selectedAddress.isEmpty else { return }
        model.selectRunMode(mode)
        showFirstTimeSetup = false
        model.start()
    }

    private var firstTimeSetup: some View {
        sheetFrame(title: "First-time setup", subtitle: "Save a small program once. After that, use Jailbreak.", compact: true,
                   close: { showFirstTimeSetup = false }, skip: {
                       guard model.canSkipBootstrapTyping, !updater.blocksNewSession else { return }
                       model.skipBootstrapTyping()
                       if model.phase == .awaitingSave { showFirstTimeSetup = false }
                   }, skipDisabled: !model.canSkipBootstrapTyping || updater.blocksNewSession) {
            VStack(alignment: .leading, spacing: 18) {
                Label("Open SmileBASIC → Make a Program with an empty editor.", systemImage: "keyboard")
                    .font(.system(size: 13, weight: .medium))
                Text("Keep the editor open. Your Mac will type the bootstrap, then guide you through saving it as \(model.selectedHost.saveName).")
                    .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                demoEditionCheckbox
                Text("After typing, return to Direct mode so mac2jb can type the save command.")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted).fixedSize(horizontal: false, vertical: true)
                if !model.driverLoaded {
                    note("Install the USB driver on the main screen before typing the setup program.", icon: "cable.connector", color: .orange)
                }
                powerDirectionNotice
                Toggle("The empty editor is open and the USB cable is connected", isOn: $setupReady)
                    .toggleStyle(.checkbox).font(.system(size: 12))
                Button("Type the setup program") { beginRun(.bootstrapOnly) }
                    .buttonStyle(PrimaryActionStyle()).disabled(startBlocked || !setupReady)
            }
        }
    }

    private var developerOptions: some View {
        VStack(alignment: .leading, spacing: 22) {
            panel {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Host").font(.system(size: 15, weight: .semibold))
                    Picker("Host", selection: Binding(get: { model.selectedHost }, set: { model.selectHost($0) })) {
                        ForEach(HostProfile.allCases) { host in Text(host.label).tag(host) }
                    }.pickerStyle(.menu).disabled(!model.canChangeHost || updater.blocksNewSession)
                    Text("After changing hosts, type and save the selected host’s bootstrap before running Jailbreak.")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    if !model.selectedHost.supportsHeldRPC {
                        Text(model.selectedHost == .izmysh
                             ? "IZMYSH uses its own host and START protocol. This GUI profile currently supports exploit verification only; use Kurumuz or BermTheSequel for held RPC and homebrew."
                             : "pepsipu closes RPC after verification. Choose kurumuz or BermTheSequel for held RPC and homebrew.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    if !model.selectedHost.supportsDemo {
                        Text("This host’s bundled version supports the full edition of SmileBASIC.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                }
            }
            panel {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Additional tools").font(.system(size: 15, weight: .semibold))
                    Text("To start a new host or exploit, restart the Switch and open SmileBASIC → Make a Program with \(model.selectedHost.saveName) saved.")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    HStack(spacing: 16) {
                        Button("Run host only") { model.startHostOnly(keepRPC: hostOnlyKeepRPC) }
                            .disabled(!model.canStartHostOnly || updater.blocksNewSession)
                        Toggle("Hold RPC after success", isOn: $hostOnlyKeepRPC)
                            .toggleStyle(.checkbox).font(.system(size: 12)).disabled(configurationLocked || !model.selectedHost.supportsHeldRPC)
                    }
                    if showHostOnlyHomebrew && (canConfigure || !model.postRun.dumpInProgress) { homebrewSection }
                    Divider()
                    existingRPCControls
                    Divider()
                    Toggle("The Switch is ready on the command screen", isOn: $developerReady).toggleStyle(.checkbox).font(.system(size: 12))
                    HStack(spacing: 12) {
                        Button("Run exploit only") { beginRun(.exploitOnly) }
                            .disabled(startBlocked || !developerReady || model.selectedAddress.isEmpty)
                        Button("Dump system code") {
                            if model.canDumpSystemCode { model.dumpSystemCode() }
                            else { beginRun(.systemCodeDump) }
                        }.disabled(!model.canDumpSystemCode &&
                                   (startBlocked || !developerReady || model.selectedAddress.isEmpty || !model.selectedHost.supportsHeldRPC))
                    }
                    Divider()
                    Text("Commands to send").font(.system(size: 12, weight: .semibold))
                    VStack(alignment: .leading, spacing: 10) {
                        commandToggle(.load, title: model.selectedHost == .izmysh ? "LOAD \"TXT:NS2I\"" : "LOAD \"TXT:NS2\"")
                        commandToggle(.run, title: "RUN")
                        commandToggle(.remove, title: "REMOVE NSR,&H60000000,&H3FFFFFFF")
                        commandToggle(.start, title: "START — finish with keyboard")
                    }.disabled(configurationLocked)
                    Button("Type commands only") {
                        model.startCommandsOnly(commands: selectedCommands, startPrefix: commandsToSend.contains(.start))
                    }.disabled(startBlocked || !developerReady || !model.canStartCommandsOnly(commands: selectedCommands, startPrefix: commandsToSend.contains(.start)))
                    if commandsToSend.contains(.start) {
                        Text("START types V=START(\(model.selectedHost.startPort), without Enter, then opens keyboard mirroring.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                }
            }
            panel { stremioSettings }
            panel { keyboardControls }.id("keyboard-controls")
            panel { usbTimingSettings }
            panel {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Diagnostics").font(.system(size: 15, weight: .semibold))
                    Text(AppBuildIdentity.versionLabel).font(.system(size: 11, design: .monospaced)).foregroundStyle(Mac2jbTheme.muted)
                    if model.postRun.isActive {
                        HStack {
                            Button(model.postRun.statusInFlight ? "Checking…" : "Check RPC") { model.checkRPCStatus() }.disabled(!model.postRun.canCheckStatus)
                            Button("Copy RPC command") { model.copyRPCCommand() }.disabled(model.rpcCommand.isEmpty)
                            Button("Open run logs") { model.revealRunFolder() }
                        }.font(.system(size: 11))
                        if !model.rpcStatus.isEmpty { Text(model.rpcStatus).font(.system(size: 11)).textSelection(.enabled) }
                    }
                }
            }
        }
    }

    private var existingRPCControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("RPC already held").font(.system(size: 15, weight: .semibold))
            Text("Use a session that is already jailbroken on this Mac. Select its switch2 run folder and keep the original host and SmileBASIC open.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            TextField("Existing run folder", text: $model.existingRPCRunPath)
                .textFieldStyle(.roundedBorder).font(.system(size: 11))
                .disabled(!model.canChangeHost)
            HStack {
                Button("Choose run folder…") { chooseExistingRPCRun() }.disabled(!model.canChangeHost)
                Spacer()
                Button("Connect to open RPC") { model.attachExistingRPC() }
                    .disabled(!model.canAttachExistingRPC || updater.blocksNewSession)
            }.font(.system(size: 11))
            Text(model.selectedHost.supportsHeldRPC
                 ? "After connecting, choose a homebrew app. Disconnect stops this app’s workers and leaves the original host running."
                 : "Choose kurumuz or BermTheSequel above to connect to held RPC.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
        }
    }

    private func chooseExistingRPCRun() {
        guard model.canChangeHost else { return }
        let picker = NSOpenPanel()
        picker.title = "Choose the existing RPC run"
        picker.message = "Select the switch2 run folder shown by the original host. It contains connection.json and result.json."
        picker.canChooseDirectories = true; picker.canChooseFiles = false; picker.allowsMultipleSelection = false
        if model.existingRPCRunPath.hasPrefix("/") { picker.directoryURL = URL(fileURLWithPath: model.existingRPCRunPath) }
        picker.begin { response in
            if response == .OK, let url = picker.url { model.existingRPCRunPath = url.path }
        }
    }

    private var selectedCommands: [PostBootstrapCommand] {
        PostBootstrapCommand.allCases.filter { commandsToSend.contains($0) }
    }

    private func commandToggle(_ command: PostBootstrapCommand, title: String) -> some View {
        Toggle(title, isOn: Binding(get: { commandsToSend.contains(command) }, set: { selected in
            if selected { commandsToSend.insert(command) }
            else { commandsToSend.remove(command) }
        }))
        .toggleStyle(.checkbox).font(.system(size: 11, design: .monospaced))
    }

    private var keyboardControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Live keyboard").font(.system(size: 15, weight: .semibold))
            if !model.keyboardIsLoading {
                Text("Use this Mac’s keyboard to type on the Switch. Click the capture area while connected; Escape stops forwarding.")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                Text(model.keyboardStatus).font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            }
            if keyboardPanelOpen {
                if model.keyboardIsLoading {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("Loading…").font(.system(size: 13, weight: .medium))
                    }
                    .frame(maxWidth: .infinity, minHeight: 110)
                    .background(.black.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                } else if model.keyboardActive {
                    if model.keyboardTextSending {
                        VStack(alignment: .leading, spacing: 6) {
                            ProgressView(value: Double(model.keyboardTextSent), total: Double(max(1, model.keyboardTextTotal)))
                            Text("\(model.keyboardTextSent) of \(model.keyboardTextTotal) characters sent")
                                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                        }
                    } else {
                        KeyboardCaptureView(active: model.keyboardAcceptsPhysicalInput, onReport: { model.sendKeyboardReport($0) }, onStop: { model.stopKeyboardForwarding() })
                            .frame(height: 80).background(.black.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                    }
                    Text("Paste or type text").font(.system(size: 12, weight: .medium))
                    KeyboardTextEditor(text: $model.keyboardText, isEditable: !model.keyboardTextSending)
                        .frame(minHeight: 100, maxHeight: 160)
                        .padding(6)
                        .background(.black.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
                    Text("Paste with ⌘V. ASCII text, tabs and newlines only; 16 KiB maximum. Newlines press Enter. No extra Enter is added.")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                    HStack {
                        Button("Send text") { model.sendKeyboardText() }.disabled(!model.canSendKeyboardText)
                        Text("\(model.keyDelayMs) ms per key").font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    if !model.keyboardTextStatus.isEmpty {
                        Text(model.keyboardTextStatus).font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    if !model.keyboardText.isEmpty, !model.keyboardTextSending, let message = model.keyboardTextValidationMessage {
                        Text(message).font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                }
                Button("Stop keyboard") { model.stopKeyboardForwarding() }
                    .disabled(model.phase == .keyboardForwarding && !model.keyboardActive)
            } else {
                Button("Use Mac keyboard") { model.startKeyboardForwarding() }.disabled(!model.canStartKeyboard || updater.blocksNewSession)
            }
        }
    }

    private var usbTimingSettings: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("USB & timing").font(.system(size: 15, weight: .semibold))
            Picker("Controller", selection: $model.controller) {
                Text("Automatic").tag("auto")
                ForEach(0..<16) { Text("usb-drd\($0)").tag("usb-drd\($0)") }
            }
            if model.controller == "auto", let controller = model.lastSuccessfulController {
                Text("Will try \(controller) first.")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            }
            timingField("Delay per key", units: "ms", value: $model.keyDelayMs, range: 1...2000)
            timingField("Enumeration timeout per controller", units: "s", value: $model.enumerationTimeoutSeconds, range: 1...120)
            Divider()
            timingField("Before confirming LOAD / LOADV", units: "ms", value: $model.loadConfirmWaitMs, range: 0...120000)
            timingField("After LOAD → before RUN", units: "ms", value: $model.loadWaitMs, range: 0...120000)
            timingField("After RUN → before REMOVE", units: "ms", value: $model.runWaitMs, range: 0...120000)
            timingField("After REMOVE → before START", units: "ms", value: $model.removeWaitMs, range: 0...120000)
            HStack {
                Text("Defaults: 10 ms/key · 4 s connection · 1 s after LOAD confirmation; other command waits are 0.")
                    .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                Spacer(minLength: 8)
                Button("Reset defaults") {
                    model.keyDelayMs = 10; model.enumerationTimeoutSeconds = 4
                    model.loadConfirmWaitMs = 0; model.loadWaitMs = 1000; model.runWaitMs = 0; model.removeWaitMs = 0
                }.font(.system(size: 10))
            }
            if !timingSettingsValid { Text("Enter values within the ranges shown before starting.").font(.system(size: 11)).foregroundStyle(.orange) }
        }.disabled(configurationLocked)
    }

    private func sheetFrame<Content: View>(title: String, subtitle: String, compact: Bool = false, close: @escaping () -> Void,
                                         skip: (() -> Void)? = nil, skipDisabled: Bool = false,
                                         @ViewBuilder content: () -> Content) -> some View {
        let contents = VStack(alignment: .leading, spacing: 24) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 7) {
                    Text(title).font(.system(size: 26, weight: .bold, design: .rounded))
                    Text(subtitle).font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                }
                Spacer()
                if let skip {
                    Button("Cancel", action: close)
                    Button("Skip", action: skip)
                        .disabled(skipDisabled)
                        .help("Continue to saving. The complete current bootstrap must already be in PRG0.")
                } else {
                    Button("Done", action: close).disabled(model.keyboardActive || model.phase == .keyboardConnecting)
                }
            }
            content()
        }.padding(30)
        return Group {
            if compact {
                contents.frame(width: 720).fixedSize(horizontal: false, vertical: true)
            } else {
                ScrollView { contents }.frame(width: 720, height: 650)
            }
        }.background { Mac2jbBackdrop() }.preferredColorScheme(.dark).tint(teal)
    }

    private var activeSession: some View {
        panel {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top, spacing: 16) {
                    Image(systemName: model.phase == .verified || model.postRun.heldConfirmed ? "checkmark.circle.fill" : model.activeRunMode.isHostOnly ? "network" : "cable.connector")
                        .font(.system(size: 29)).foregroundStyle(teal).frame(width: 52, height: 52)
                        .background(teal.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    VStack(alignment: .leading, spacing: 8) {
                        Text(headline).font(.system(size: 28, weight: .bold, design: .rounded)).foregroundStyle(ink)
                        Text(model.detail).font(.system(size: 13)).foregroundStyle(Mac2jbTheme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if model.isBusy {
                    if let progress = model.progress { ProgressView(value: progress).tint(teal) }
                    else { ProgressView().progressViewStyle(.linear).tint(teal) }
                    if !model.progressLabel.isEmpty {
                        Text(model.progressLabel).font(.system(size: 11, design: .monospaced)).foregroundStyle(Mac2jbTheme.muted).monospacedDigit()
                    }
                    if model.phase == .bootstrap {
                        HStack(spacing: 14) {
                            Text("Elapsed " + durationText(model.bootstrapElapsedSeconds))
                            if let remaining = model.bootstrapEstimatedRemainingSeconds {
                                Text(durationText(remaining.rounded(.up)) + " remaining")
                            }
                        }.font(.system(size: 11, design: .monospaced)).foregroundStyle(Mac2jbTheme.muted).monospacedDigit()
                    }
                }
                if model.isEnumerating { powerDirectionNotice }
                if model.activeRunMode.isHostOnly,
                   model.phase == .waitingForConsole, !model.hostStartCommand.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Enter these once in SmileBASIC:").font(.system(size: 12, weight: .semibold))
                        Text([model.activeEdition.loadCommand(for: model.activeHost.saveName), "RUN", "REMOVE NSR,&H60000000,&H3FFFFFFF", model.hostStartCommand].joined(separator: "\n"))
                            .font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
                        Text("Enter each line separately. Confirm LOAD when prompted. “Out of memory” after REMOVE is expected.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                        Button("Send commands over USB") { model.sendHostOnlyCommands() }
                            .buttonStyle(PrimaryActionStyle())
                            .disabled(!model.canSendHostOnlyCommands)
                        Text(model.driverLoaded
                             ? "Use this before entering any commands manually. It sends the current host’s START command."
                             : "Load the USB driver to send these commands automatically.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                }
                if model.phase == .awaitingSave { saveSetupControls }
                if model.phase == .verified || model.phase == .commandsSent || model.phase == .rpcDetached {
                    if model.phase == .verified {
                        Text("The session finished and cleanup was confirmed. Restart the Switch before starting again.")
                            .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    Button("Back to start") { model.returnToStart() }.buttonStyle(PrimaryActionStyle()).disabled(!model.canReturnToStart)
                }
                if model.postRun.isActive { postRunControls }
                if !showHostOnlyHomebrew && model.activeSessionSupportsHomebrew &&
                    model.postRun.stage == .held && !model.postRun.dumpInProgress &&
                    (model.postRun.heldConfirmed || model.postRun.homebrewAttempted) {
                    if model.activeRunMode == .heldRPC && model.postRun.homebrewAttempted &&
                        model.homebrewApp == .mintBrew {
                        mintBrewFolderControls
                    } else {
                        homebrewSection
                    }
                }
                if model.postRun.dumpCompleted, model.dumpFolder != nil { Button("Open dump folder") { model.revealDumpFolder() } }
                if model.isBusy || model.phase == .awaitingSave {
                    HStack {
                        Text("Keep SmileBASIC open until the session finishes.").font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                        Spacer()
                        Button("Stop session", role: .destructive) { model.cancel() }
                    }
                }
            }
        }
    }

    private var saveSetupControls: some View {
        VStack(alignment: .leading, spacing: 15) {
            Divider()
            if model.bootstrapSaveCommandSent {
                Label("Save command typed", systemImage: "keyboard")
                    .font(.system(size: 13, weight: .semibold))
                Text("Confirm saving on the Switch. Overwrite the existing \(model.activeHost.saveName) file if prompted, then wait for saving to finish.")
                    .font(.system(size: 13)).foregroundStyle(Mac2jbTheme.muted)
            } else {
                Text(model.workflowProgress.bootstrapTypingWasSkipped
                     ? model.activeEdition.saveInstructions(for: model.activeHost.saveName).replacingOccurrences(of: "The bootstrap has finished typing. ", with: "Check that the complete current bootstrap is already in PRG0. ")
                     : model.activeEdition.saveInstructions(for: model.activeHost.saveName)).font(.system(size: 13)).foregroundStyle(Mac2jbTheme.muted)
                Toggle("Direct mode is open with an empty command prompt", isOn: $saveDirectModeReady)
                    .toggleStyle(.checkbox).font(.system(size: 12)).disabled(model.hasLiveWorkers)
                Button("Type save command") { model.typeBootstrapSave(directModeConfirmed: saveDirectModeReady) }
                    .buttonStyle(PrimaryActionStyle()).disabled(!saveDirectModeReady || !model.canTypeBootstrapSave)
                if !model.driverLoaded {
                    Text("Load the USB driver to type automatically, or use the manual command below.")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                }
            }
            DisclosureGroup("Save command (manual option)") {
                Text(model.activeEdition.saveCommands(for: model.activeHost.saveName).joined(separator: "\n"))
                    .font(.system(size: 14, design: .monospaced)).textSelection(.enabled)
            }.font(.system(size: 12))
            Toggle(model.activeEdition.savedConfirmation(for: model.activeHost.saveName), isOn: $savedConfirmed)
                .toggleStyle(.checkbox).font(.system(size: 12)).disabled(model.hasLiveWorkers)
            Button("\(model.activeHost.saveName) saved — back to start") { model.finishBootstrapOnly() }
                .buttonStyle(PrimaryActionStyle()).disabled(!savedConfirmed || model.hasLiveWorkers)
        }
    }

    private var postRunControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            if model.postRun.heldConfirmed {
                Label(model.isAttachedRPCSession ? "Existing RPC connection verified" : "Switch connection verified · 4/4", systemImage: "checkmark.shield.fill")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(teal)
            }
            Text(model.postRun.cleanupBlocked
                 ? "Restart your Switch, then use Stop session. Cleanup could not be confirmed."
                 : model.phase == .dumpingFirmware
                    ? "Keep SmileBASIC open until the dump finishes. Stopping early may leave a partial dump."
                    : model.isAttachedRPCSession ? "When you’re done, disconnect here. The original host keeps its RPC session open." : "When you’re done, finish the session before closing SmileBASIC.")
                .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
            HStack {
                Button("Session details…") { showDeveloperOptions = true }.font(.system(size: 11))
                if model.canDumpSystemCode {
                    Button("Dump system code") { model.dumpSystemCode() }
                        .font(.system(size: 11))
                }
                Spacer()
                Button(model.isAttachedRPCSession ? "Disconnect" : "Finish session") { model.finishPostRun() }.buttonStyle(PrimaryActionStyle()).disabled(!model.postRun.canFinish)
            }
        }
    }

    private var updateStatus: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(updater.message).font(.system(size: 12, weight: .medium)).foregroundStyle(ink)
            if updater.requiredUpdate {
                Text("Update mac2jb before starting a new session. You can finish the current session first.")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            }
            if updater.state == .downloading { ProgressView(value: updater.progress).tint(teal) }
            HStack {
                if updater.state == .available {
                    Button("Download update") { updater.download() }.buttonStyle(.borderedProminent)
                }
                if updater.state == .ready {
                    Button("Restart & update") { confirmUpdate = true }
                        .buttonStyle(.borderedProminent).disabled(!model.canRestartForUpdate)
                    if !model.canRestartForUpdate {
                        Text("Available after the current session or driver setup finishes.")
                            .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                    }
                }
                if let release = updater.candidate?.releaseURL {
                    Link("Release notes ↗", destination: release)
                }
                if updater.state == .failed {
                    Button("Try again") { updater.dismiss(); updater.check() }
                    Link("Open releases ↗", destination: URL(string: "https://github.com/cpypwn/mac2jb/releases/latest")!)
                    if updater.hasDownloadedApp { Button("Show downloaded app") { updater.revealDownloadedApp() } }
                    if let log = updater.diagnosticURL {
                        Button("Open update log") { updater.revealLog() }
                        Text(log.path).font(.system(size: 9)).textSelection(.enabled)
                    }
                }
                Spacer(minLength: 0)
                if !updater.requiredUpdate && (updater.state == .current || updater.state == .failed) {
                    Button("Dismiss") { updater.dismiss() }.buttonStyle(.plain)
                }
            }.font(.system(size: 11))
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(teal.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }

    private var mintBrewFolderControls: some View {
        HStack(spacing: 14) {
            Button("Open MintBrew apps folder") { model.openMintBrewAppsFolder() }
                .disabled(model.runtime == nil)
            if model.homebrewFolder != nil {
                Button("Open homebrew logs") { model.revealHomebrewLogs() }
            }
            Spacer(minLength: 0)
        }
        .font(.system(size: 11, weight: .medium))
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
    }

    private var homebrewSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Choose an app")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(ink)
            Text(canConfigure && showHostOnlyHomebrew
                 ? "Run host only with Hold RPC after success checked. Choose an app here once the host confirms 4/4 verification and holds RPC open."
                 : model.postRun.cleanupBlocked
                 ? "Restart your Switch before starting another session."
                 : model.postRun.homebrewAttempted
                    ? "One app per console session. Restart the console and start a fresh host session before choosing another."
                    : model.postRun.heldConfirmed ? "Your Switch is connected. Choose one app for this session." : "Waiting for the host to verify the Switch and hold RPC open.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted).fixedSize(horizontal: false, vertical: true)
            homebrewRow(icon: "square.grid.3x3.fill", title: "MintBrew",
                        description: "Launch the combined homebrew library on your Switch.",
                        actionTitle: model.postRun.homebrewAttempted && model.homebrewApp == .mintBrew
                            ? homebrewActionTitle : "Launch MintBrew",
                        enabled: model.canLaunchHomebrew, action: {
                            model.launchMintBrew(accountAddons: account.addonURLs,
                                                 libraryItems: account.libraryPayload())
                        }) {
                Button("Open MintBrew apps folder") { model.openMintBrewAppsFolder() }
                    .font(.system(size: 11)).disabled(model.runtime == nil)
                    .font(.system(size: 11))
                Text("Add or remove apps while this session is open. Refresh the list on your Switch.")
                    .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                if model.homebrewFolder != nil {
                    Button("Open homebrew logs") { model.revealHomebrewLogs() }
                        .font(.system(size: 11))
                }
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
    }

    private func homebrewRow<Details: View>(icon: String, title: String, description: String,
                                            actionTitle: String, enabled: Bool,
                                            action: @escaping () -> Void,
                                            @ViewBuilder details: () -> Details) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(ink)
                Text(description).font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                details()
            }
            Spacer(minLength: 8)
            Button(actionTitle, action: action)
                .font(.system(size: 11, weight: .medium)).disabled(!enabled)
        }
    }

    private var stremioAccountControls: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 10) {
                if account.signingIn {
                    ProgressView().controlSize(.small)
                    Button("Cancel sign-in") { account.cancelSignIn() }
                } else if account.signedIn {
                    Text(account.displayName.map { "Stremio: \($0)" } ?? "Signed in to Stremio")
                    Text("\(account.libraryCount) library items").foregroundStyle(Mac2jbTheme.muted)
                    Button("Refresh") { account.refresh() }
                    Button("Sign out") { account.signOut() }
                } else {
                    Button("Sign in to Stremio") { account.signIn() }
                    Text("Optional · account stays on this Mac").foregroundStyle(Mac2jbTheme.muted)
                }
            }
            .disabled(model.postRun.homebrewAttempted && model.hasLiveWorkers)
            Text(account.status).foregroundStyle(Mac2jbTheme.muted).fixedSize(horizontal: false, vertical: true)
            if !account.watchProgressStatus.isEmpty {
                Text(account.watchProgressStatus).foregroundStyle(Mac2jbTheme.muted)
            }
        }
        .font(.system(size: 10))
    }

    private var stremioSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Stremio").font(.system(size: 15, weight: .semibold))
            Text("Set video output before launching Stremio through MintBrew.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            Picker("Video output", selection: $model.stremioQuality) {
                ForEach(StremioQuality.allCases) { quality in
                    Text(quality.label).tag(quality)
                }
            }
            .pickerStyle(.menu).font(.system(size: 11))
            .disabled(model.postRun.homebrewAttempted)
            TextField("Optional Stremio add-on manifest URL", text: $model.stremioAddonURL)
                .textFieldStyle(.roundedBorder).font(.system(size: 11))
                .disabled(model.postRun.homebrewAttempted)
            Text("Use your account add-ons, or leave empty for the bundled sample. Library and progress sync when signed in. Audio and SRT/WebVTT subtitle options are in the player. Torrents aren’t supported.")
                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted).fixedSize(horizontal: false, vertical: true)
            stremioAccountControls
            if !model.stremioToolsAvailable {
                Text("Install Stremio on this Mac to enable the player.")
                    .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            }
        }
    }

    private var homebrewActionTitle: String {
        switch model.postRun.homebrewStage {
        case .idle: return "Launch GPUBrew"
        case .launching: return "Starting…"
        case .selecting: return "Choose a game"
        case .running: return "Running"
        case .stopped, .failed: return "Launch unavailable"
        }
    }

    private var keyboardPanelOpen: Bool {
        model.keyboardIsLoading || model.keyboardActive
    }

    private var expansionAnimation: Animation? {
        reduceMotion ? nil : .spring(response: 0.36, dampingFraction: 0.88)
    }

    private func scrollToKeyboardIfNeeded(_ proxy: ScrollViewProxy) {
        if keyboardPanelOpen && showDeveloperOptions {
            proxy.scrollTo("keyboard-controls", anchor: .center)
        }
    }

    private var toolsBubble: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                guard !showDeveloperOptions || !keyboardPanelOpen else { return }
                showDeveloperOptions.toggle()
            } label: {
                HStack {
                    Text("Console & Developer Options").font(.system(size: 12, weight: .semibold)).foregroundStyle(ink)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(teal).rotationEffect(.degrees(showDeveloperOptions ? 180 : 0))
                        .animation(expansionAnimation, value: showDeveloperOptions)
                }
                .padding(.vertical, 4).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(showDeveloperOptions ? "Expanded" : "Collapsed")
            .help(keyboardPanelOpen ? "Stop keyboard forwarding before closing this panel." : "Expand to show the console and developer tools")
            VStack(alignment: .leading, spacing: 18) {
                console
                Divider().overlay(.white.opacity(0.04))
                developerOptions
            }
            .padding(.top, 16)
            .fixedSize(horizontal: false, vertical: true)
            .background {
                GeometryReader { content in
                    Color.clear.preference(key: ToolsContentHeightKey.self, value: content.size.height)
                }
            }
            .modifier(AnimatedExpansionLayout(height: showDeveloperOptions ? toolsContentHeight : 0))
            .opacity(showDeveloperOptions ? 1 : 0)
            .animation(expansionAnimation, value: showDeveloperOptions ? toolsContentHeight : 0)
            .allowsHitTesting(showDeveloperOptions).disabled(!showDeveloperOptions)
            .accessibilityHidden(!showDeveloperOptions)
            .onPreferenceChange(ToolsContentHeightKey.self) { height in
                if height.isFinite && height > 0 && abs(height - toolsContentHeight) > 0.5 {
                    toolsContentHeight = height
                }
            }
        }
        .padding(20)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(.white.opacity(0.10), lineWidth: 1))
        .shadow(color: .black.opacity(0.16), radius: 20, y: 8)
    }

    private var selectedConsoleLog: String {
        switch activityTab {
        case 1: return model.hostLog
        case 2: return model.usbLog
        case 3: return model.pipelineLog
        case 4: return model.acquisitionLog
        default: return model.log
        }
    }

    private var console: some View {
        ScrollViewReader { proxy in
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    Text("Console").font(.system(size: 12, weight: .semibold)).foregroundStyle(ink)
                    Picker("Console output", selection: $activityTab) {
                        Text("All").tag(0)
                        Text("Host").tag(1)
                        Text("USB & typing").tag(2)
                        Text("Pipeline").tag(3)
                        Text("Acquisition").tag(4)
                    }.pickerStyle(.segmented).labelsHidden().controlSize(.small).frame(width: 420)
                    Spacer(minLength: 0)
                    Button {
                        followConsole.toggle()
                        if followConsole { proxy.scrollTo("console-end", anchor: .bottom) }
                    } label: {
                        Image(systemName: followConsole ? "arrow.down.to.line.circle.fill" : "arrow.down.to.line.circle")
                    }
                    .help(followConsole ? "Pause following new output" : "Follow new output")
                    .accessibilityLabel("Follow console output")
                    Button { model.revealSessionFolder() } label: { Image(systemName: "folder") }
                        .help("Open session logs").accessibilityLabel("Open session logs")
                        .disabled(model.runtime == nil && model.diagnosticLogURL == nil)
                }.buttonStyle(.borderless).foregroundStyle(teal)
                ScrollView {
                    Text(selectedConsoleLog.isEmpty ? " " : selectedConsoleLog)
                        .font(.system(size: 10, design: .monospaced)).foregroundStyle(ink.opacity(0.8))
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    Color.clear.frame(height: 1).id("console-end")
                }
                .frame(height: 128)
                .background(.black.opacity(0.14), in: RoundedRectangle(cornerRadius: 14))
                .onChange(of: selectedConsoleLog) { _, _ in
                    if followConsole { proxy.scrollTo("console-end", anchor: .bottom) }
                }
                .onChange(of: activityTab) { _, _ in
                    followConsole = true
                    proxy.scrollTo("console-end", anchor: .bottom)
                }
                .onAppear { proxy.scrollTo("console-end", anchor: .bottom) }
                .onReceive(Timer.publish(every: 0.5, on: .main, in: .common).autoconnect()) { _ in
                    model.refreshExploitLogs()
                }
            }
        }
    }

    private var powerDirectionNotice: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "cable.connector").foregroundStyle(teal).padding(.top, 2)
            VStack(alignment: .leading, spacing: 5) {
                Text("The USB cable needs the right power direction.")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(ink)
                Text("The Switch should supply power to the Mac. If the Switch is charging from the Mac, unplug the USB-C cable from the Switch, wait about one second, then plug it back into the Switch. Check the power direction again before retrying.")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(teal.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
    }
    private func durationText(_ seconds: Double) -> String {
        guard seconds.isFinite else { return "Estimating…" }
        let total = Int(min(max(0, seconds), Double(Int.max / 60)))
        return total >= 60 ? "\(total / 60) min \(total % 60) sec" : "\(total) sec"
    }

    private func timingField(_ title: String, units: String, value: Binding<Int>, range: ClosedRange<Int>) -> some View {
        HStack(spacing: 8) {
            Text(title).font(.system(size: 11)).foregroundStyle(ink)
            Spacer(minLength: 10)
            TextField(title, value: value, format: .number.grouping(.never))
                .labelsHidden().accessibilityLabel(title)
                .textFieldStyle(.roundedBorder).multilineTextAlignment(.trailing)
                .frame(width: 78)
            Stepper(title, value: value, in: range).labelsHidden().accessibilityLabel(title)
                .frame(width: 20)
            Text(units).font(.system(size: 10)).frame(width: 21, alignment: .leading)
            Text("\(range.lowerBound)–\(range.upperBound)")
                .font(.system(size: 9, design: .monospaced)).foregroundStyle(Mac2jbTheme.muted)
                .frame(width: 80, alignment: .trailing)
        }
    }
    private func panel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content().modifier(GlassPanel())
    }
    private func note(_ text: String, icon: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 10) { Image(systemName: icon); Text(text).fixedSize(horizontal: false, vertical: true) }
            .font(.system(size: 12)).foregroundStyle(color).padding(16)
            .frame(maxWidth: .infinity, alignment: .leading).background(color.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
    }
    private func loadDriver() {
        guard !driverSetupBlocked, let runtime = model.runtime else { return }
        model.driverSetupRunning = true
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        let script = runtime.root.appendingPathComponent("scripts/install-driver.sh").path
        let command = "/bin/bash '" + script.replacingOccurrences(of: "'", with: "'\\''") + "'"
        let appleString = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        task.arguments = ["-e", "do shell script \"" + appleString + "\" with administrator privileges"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        task.terminationHandler = { task in
            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                model.driverSetupRunning = false
                model.refreshChecks()
                model.recordDiagnostic("Driver installer:\n" + output)
                driverMessage = task.terminationStatus == 0
                    ? "The bundled unsigned driver is installed. Approve it in System Settings → Privacy & Security if requested, then restart before starting mac2jb. Any previous driver was backed up; its path is in session activity.\n\n\(output.prefix(1400))"
                    : "Driver setup needs attention. Review the installer error below and macOS kernel-extension policy. Compatible custom SIP configurations are accepted; complete any approval/restart prompts.\n\n\(output.prefix(1400))\n\nLog: \(model.diagnosticLogURL?.path ?? "Log unavailable")"
            }
        }
        do { try task.run() }
        catch { model.driverSetupRunning = false; driverMessage = error.localizedDescription }
    }
}
