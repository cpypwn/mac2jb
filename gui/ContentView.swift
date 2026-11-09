import SwiftUI
import AppKit
import Combine
import UniformTypeIdentifiers

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
    @StateObject private var civSwitch = CivSwitchModel()
    @StateObject private var civSwitchControlCenter = CivSwitchControlCenterModel()
    @StateObject private var dnsSwitch = DNSwitchModel()
    @StateObject private var webKitResearch = WebKitResearchModel()
    @StateObject private var artemisUpdates = ArtemisUpdateChecker()
    @State private var dnsSwitchDestinationURL = ""
    @State private var readyConfirmed = false
    @State private var setupReady = false
    @State private var developerReady = false
    @State private var hostOnlyKeepRPC = false
    @State private var commandsToSend: Set<PostBootstrapCommand> = [.load, .run, .remove]
    @State private var savedConfirmed = false
    @State private var saveDirectModeReady = false
    @State private var showNS2JBSetup = false
    @State private var showBootstrapSetup = false
    @State private var showCivSwitchSetup = false
    @State private var civSwitchReady = false
    @State private var civSwitchConsoleAddress = ""
    @State private var showDeveloperOptions = false
    @State private var toolsContentHeight: CGFloat = 0
    @State private var followConsole = true
    @State private var activityTab = 0
    @State private var driverMessage: String?
    @State private var confirmUpdate = false
    @State private var confirmClearPastSessions = false
    @State private var showFailure = false
    @State private var failureText = ""
    @State private var showUpdateFailure = false
    @State private var selectedLuaEditorSave: URL?
    @State private var luaEditorSelectionMessage: String?
    @State private var nativeSDRomFolder = "/sd/roms/nes"
    @State private var modloaderFolder: URL?

    private var canConfigure: Bool {
        [.ready, .failed, .cancelled].contains(model.phase) &&
        !(model.phase == .failed && model.seedsowInstallStarted)
    }
    private var configurationLocked: Bool { model.hasLiveWorkers || model.driverSetupRunning || model.rpcDiscoveryRunning || model.sessionCleanupRunning || civSwitch.isRunning || civSwitchControlCenter.isRunning || !canConfigure }
    private var civSwitchAddressValid: Bool {
        let parts = civSwitchConsoleAddress.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { part in
            !part.isEmpty && part.count <= 3 && part.utf8.allSatisfy { (48...57).contains($0) } &&
            Int(part).map { (0...255).contains($0) && String($0) == String(part) } == true
        }
    }
    private var showHostOnlyHomebrew: Bool {
        hostOnlyKeepRPC && (canConfigure || model.activeRunMode == .hostOnlyHeld)
    }
    private var nativeSDRomFolderValid: Bool {
        nativeSDRomFolder.utf8.count <= 240 && nativeSDRomFolder.hasPrefix("/sd/") &&
        !nativeSDRomFolder.hasSuffix("/") &&
        !nativeSDRomFolder.contains("//") && !nativeSDRomFolder.contains("\\") &&
        !nativeSDRomFolder.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) &&
        !nativeSDRomFolder.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }
    private var driverSetupBlocked: Bool { model.runtime == nil || configurationLocked || updater.blocksNewSession }
    private var timingSettingsValid: Bool {
        (1...2000).contains(model.keyDelayMs) && (0...2000).contains(model.keyHoldMs) &&
        (0...2000).contains(model.enterSettleMs) && (1...16).contains(model.pollInterval) &&
        (1...120).contains(model.enumerationTimeoutSeconds) &&
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
        case .installingSave: return "You’re ready to go"
        case .rpcFinishing: return "Finishing up safely"
        case .launchingHomebrew: return model.postRun.homebrewStage == .selecting ? "Choose a game" : "Opening \(model.homebrewTitle)"
        case .homebrewRunning: return model.modloaderInstallReady ? "Modloader ready" : "\(model.homebrewTitle) is running"
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
                    .onChange(of: model.phase) { previous, current in
                        if previous == .installingSave && current == .rpcHeld && model.seedsowInstallCompleted {
                            DispatchQueue.main.async {
                                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
                                    proxy.scrollTo(model.activeRunMode == .hostOnlyHeld
                                                   ? "hostonly-homebrew" : "seedsow-homebrew", anchor: .top)
                                }
                            }
                        } else {
                            scrollToKeyboardIfNeeded(proxy)
                        }
                    }
                    .onChange(of: model.savekitChoiceFinished) { _, finished in
                        if finished {
                            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
                                let target = model.activeRunMode == .seedsowSave ? "seedsow-homebrew" :
                                    model.activeRunMode == .hostOnlyHeld ? "hostonly-homebrew" : "savekit-homebrew"
                                proxy.scrollTo(target, anchor: .top)
                            }
                        }
                    }
                    .onChange(of: toolsContentHeight) { _, _ in scrollToKeyboardIfNeeded(proxy) }
                }
            }.ignoresSafeArea(.container, edges: .top)
        }
        .frame(minWidth: 760, minHeight: 560)
        .preferredColorScheme(.dark).tint(teal)
        .onAppear {
            model.accountProgressHandler = { [weak account] update in account?.handleProgress(update) }
            model.prepare(); updater.start()
            dnsSwitch.refreshAddresses()
            NSApp.activate(ignoringOtherApps: true)
        }
        .onDisappear {
            model.accountProgressHandler = nil
            account.cancelSignIn()
            civSwitch.cancel()
            civSwitchControlCenter.stop()
            dnsSwitch.stopForTermination()
            webKitResearch.stopForTermination()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            model.refreshNetworkAddressesIfIdle()
            dnsSwitch.refreshAddresses()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
            dnsSwitch.stopForTermination()
            webKitResearch.stopForTermination()
            civSwitchControlCenter.stop()
        }
        .onChange(of: model.phase) { _, phase in
            readyConfirmed = false; setupReady = false; developerReady = false; savedConfirmed = false; saveDirectModeReady = false
            if phase == .hostStarting && model.activeRunMode != .hostOnlyHeld {
                selectedLuaEditorSave = nil; luaEditorSelectionMessage = nil
            }
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
        .onChange(of: showNS2JBSetup) { _, shown in
            if shown { showBootstrapSetup = false; readyConfirmed = false; setupReady = false }
        }
        .onChange(of: showCivSwitchSetup) { _, shown in if shown { civSwitchReady = false } }
        .onChange(of: showDeveloperOptions) { _, shown in if shown { developerReady = false } }
        .sheet(isPresented: $showNS2JBSetup) {
            if showBootstrapSetup { firstTimeSetup }
            else { ns2jbSetup }
        }
        .sheet(isPresented: $showCivSwitchSetup) {
            civSwitchSetup.interactiveDismissDisabled(civSwitch.isRunning || civSwitchControlCenter.isRunning)
        }
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
        .confirmationDialog("Clear past session data?", isPresented: $confirmClearPastSessions) {
            Button("Clear past session data", role: .destructive) { model.clearPastSessionData() }
        } message: {
            Text("This keeps the current session, save exports, dumps and source snapshots.")
        }
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
                if model.seedsowBackupFolder != nil {
                    Button("Open original save backup") { model.revealSeedsowBackup() }
                }
            }
            panel {
                VStack(alignment: .leading, spacing: 24) {
                    essentials
                    Divider().overlay(.white.opacity(0.04))
                    VStack(alignment: .leading, spacing: 5) {
                        Text("ns2jb").font(.system(size: 15, weight: .semibold)).foregroundStyle(ink)
                        Text(model.selectedHost.supportsDemo
                             ? "SmileBASIC 4 full game or demo supported."
                             : "SmileBASIC 4 full game supported.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    Button { showNS2JBSetup = true } label: {
                        HStack(spacing: 14) { Text("Jailbreak with ns2jb"); Image(systemName: "arrow.right") }
                    }.buttonStyle(PrimaryActionStyle(large: true))
                        .disabled(configurationLocked || updater.blocksNewSession)
                    Divider().overlay(.white.opacity(0.04))
                    VStack(alignment: .leading, spacing: 10) {
                        Text("CivSwitch").font(.system(size: 15, weight: .semibold))
                        Text("Use a Civilization VII cartridge and its own setup. For Artemis launcher saves, use ns2jb above.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                        Button { showCivSwitchSetup = true } label: {
                            HStack(spacing: 14) { Text("Jailbreak with CivSwitch"); Image(systemName: "arrow.right") }
                        }
                        .buttonStyle(PrimaryActionStyle(large: true))
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
        .font(.system(size: 12, weight: .medium)).foregroundStyle(ink)
        .disabled(configurationLocked || updater.blocksNewSession || !model.selectedHost.supportsDemo)
        .help(model.selectedHost.supportsDemo ? "Use the demo LOADV command." : "Choose Cellenseres, Kurumuz or BermTheSequel to use the SmileBASIC demo.")
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
        showNS2JBSetup = false
        showBootstrapSetup = false
        model.start()
    }

    private var ns2jbSetup: some View {
        sheetFrame(title: "ns2jb setup", subtitle: "Choose your SmileBASIC edition and confirm the Switch is ready.",
                   close: { showNS2JBSetup = false }) {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("First-time setup")
                        .font(.system(size: 14, weight: .semibold)).foregroundStyle(ink)
                    Text("Type and save the bootstrap for \(model.selectedHost.label) once before jailbreaking.")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    Button("Open first-time setup") { showBootstrapSetup = true }
                        .buttonStyle(.bordered).disabled(configurationLocked)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.08), lineWidth: 1))
                VStack(alignment: .leading, spacing: 8) {
                    Text("Restart your Switch and open SmileBASIC → Make a Program.")
                    Text("USB power: Switch → Mac. The Mac must not charge the Switch.")
                    Text("Connect both devices to the same local network. The Switch must use Ethernet.")
                }
                .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
                demoEditionCheckbox
                Toggle("My Switch is ready and connected by USB", isOn: $readyConfirmed)
                    .toggleStyle(.checkbox).font(.system(size: 12, weight: .medium)).foregroundStyle(ink)
                    .disabled(configurationLocked)
                if !model.driverLoaded {
                    note("Install the USB driver on the main screen before starting ns2jb.",
                         icon: "cable.connector", color: .orange)
                }
                if model.selectedAddress.isEmpty {
                    note("Choose this Mac’s network connection on the main screen before starting the jailbreak.",
                         icon: "network", color: .orange)
                }
                Button("Start jailbreak") {
                    beginRun(model.selectedHost.supportsSaveKit ? .seedsowSave :
                             model.selectedHost.supportsHeldRPC ? .heldRPC : .exploitOnly)
                }
                .buttonStyle(PrimaryActionStyle())
                .disabled(startBlocked || !readyConfirmed || model.selectedAddress.isEmpty)
            }
        }
    }

    private var firstTimeSetup: some View {
        sheetFrame(title: "First-time setup", subtitle: "Save a small program once. After that, use Jailbreak with ns2jb.", compact: true,
                   close: { showNS2JBSetup = false }, skip: {
                       guard model.canSkipBootstrapTyping, !updater.blocksNewSession else { return }
                       model.skipBootstrapTyping()
                       if model.phase == .awaitingSave { showNS2JBSetup = false }
                   }, skipDisabled: !model.canSkipBootstrapTyping || updater.blocksNewSession) {
            VStack(alignment: .leading, spacing: 18) {
                demoEditionCheckbox
                VStack(alignment: .leading, spacing: 6) {
                    Text("Already saved a compatible bootstrap?")
                        .font(.system(size: 12, weight: .semibold))
                    Text("9 arguments: pepsipu and IZMYSH share the same program. pepsipu loads NS2; IZMYSH loads NS2I.")
                    Text("5 arguments: kurumuz and Cellenseres share the same program. BermTheSequel has an extra check, so use its own saved copy.")
                    Text("If the matching program is already saved as \(model.selectedHost.saveName), you can skip both typing and saving.")
                    Button("Use saved \(model.selectedHost.saveName) bootstrap") {
                        showBootstrapSetup = false
                    }
                    .buttonStyle(.bordered).foregroundStyle(teal)
                }
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
                Label("Open SmileBASIC → Make a Program with an empty editor.", systemImage: "keyboard")
                    .font(.system(size: 13, weight: .medium))
                Text("Keep the editor open. Your Mac will type the bootstrap, then guide you through saving it as \(model.selectedHost.saveName).")
                    .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
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

    private var civSwitchSetup: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("CivSwitch setup").font(.system(size: 26, weight: .bold, design: .rounded))
                        Text("A separate Civilization VII cartridge entry point. SmileBASIC and the selected ns2jb host are not used.")
                            .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    Spacer(minLength: 8)
                    Button("Done") { showCivSwitchSetup = false }
                        .disabled(civSwitch.isRunning || civSwitchControlCenter.isRunning)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("Before starting").font(.system(size: 15, weight: .semibold))
                    Text("Use a physical Switch 1 Civilization VII cartridge at version 1.0.0, with the Switch system language set to English (US).")
                    Text("On the Switch, open Multiplayer → Wireless → Create Game → Host Lobby → Chat. In docked mode, focus the chat input.")
                    Text("Connect the Switch to this Mac by USB and keep both devices on the same network.")
                    Text("USB power must flow Switch → Mac. If the Mac charges the Switch, unplug at the Switch for a second, then reconnect it.")
                    Text("The first transfer can take 15–20 minutes.")
                    Text("After the loader opens, choose Install boot trigger to back up and replace Civilization VII single-player saves with a persistent Load Game trigger.")
                }
                .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Switch IPv4 address").font(.system(size: 12, weight: .semibold))
                    TextField("192.168.1.100", text: $civSwitchConsoleAddress)
                        .textFieldStyle(.roundedBorder).font(.system(size: 13, design: .monospaced))
                        .disabled(civSwitch.isRunning)
                    Toggle("The cartridge, system language and chat screen are ready", isOn: $civSwitchReady)
                        .toggleStyle(.checkbox).font(.system(size: 12)).disabled(civSwitch.isRunning)
                    if !model.driverLoaded {
                        Text("Load the USB driver from the main screen before starting CivSwitch.")
                            .font(.system(size: 11)).foregroundStyle(.orange)
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 12) {
                        if civSwitch.canStart {
                            Button("Start CivSwitch") {
                                civSwitch.start(consoleAddress: civSwitchConsoleAddress.trimmingCharacters(in: .whitespacesAndNewlines),
                                                runtimeRoot: model.runtime?.root,
                                                controller: model.controller,
                                                enumerationTimeoutSeconds: model.enumerationTimeoutSeconds)
                            }
                            .buttonStyle(PrimaryActionStyle())
                            .disabled(!civSwitchReady || !civSwitchAddressValid || model.runtime == nil ||
                                      !model.driverLoaded || configurationLocked || updater.blocksNewSession)
                        }
                        if civSwitch.canAttach {
                            Button("Connect to open loader") {
                                civSwitch.attachExisting(consoleAddress: civSwitchConsoleAddress,
                                                         runtimeRoot: model.runtime?.root)
                            }
                            .disabled(!civSwitchAddressValid || model.runtime == nil ||
                                      configurationLocked || updater.blocksNewSession)
                        }
                        if civSwitch.canRetryProbe {
                            Button("Check loader again") { civSwitch.retryProbe() }
                                .buttonStyle(PrimaryActionStyle())
                                .disabled(model.runtime == nil || configurationLocked || updater.blocksNewSession)
                        }
                        if civSwitch.canInstallTrigger {
                            Button("Install boot trigger") { civSwitch.installTrigger() }
                                .buttonStyle(PrimaryActionStyle())
                                .disabled(model.runtime == nil || configurationLocked || updater.blocksNewSession)
                        }
                        if civSwitch.canReset {
                            Button("Restart full transfer") {
                                civSwitch.reset()
                                civSwitchReady = false
                            }
                            .disabled(civSwitchControlCenter.isRunning)
                        }
                        if civSwitch.canCancel {
                            Button("Stop CivSwitch") { civSwitch.cancel() }
                        }
                        }
                        if (AppBuildIdentity.isTestBuild && civSwitch.canShowDemo) ||
                            civSwitch.canSendPayload || civSwitch.backupFolder != nil {
                            HStack(spacing: 12) {
                                if AppBuildIdentity.isTestBuild && civSwitch.canShowDemo {
                                    Button("Show cpypwn demo") { civSwitch.showDemo() }
                                        .disabled(model.runtime == nil || configurationLocked || updater.blocksNewSession ||
                                                  civSwitchControlCenter.isRunning)
                                }
                                if civSwitch.canSendPayload {
                                    Button("Send JavaScript…") { chooseCivSwitchDirectPayload() }
                                        .disabled(model.runtime == nil || configurationLocked || updater.blocksNewSession ||
                                                  civSwitchControlCenter.isRunning)
                                }
                                if let backup = civSwitch.backupFolder {
                                    Button("Open CivSwitch save backup") { NSWorkspace.shared.open(backup) }
                                }
                            }
                        }
                    }
                    Text(civSwitch.status).font(.system(size: 13, weight: .semibold))
                    if !civSwitch.detail.isEmpty {
                        Text(civSwitch.detail).font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    if civSwitch.isRunning {
                        if let progress = civSwitch.progress { ProgressView(value: progress).tint(teal) }
                        else { ProgressView().progressViewStyle(.linear).tint(teal) }
                    }
                    ScrollView {
                        Text(civSwitch.log.isEmpty ? "Activity will appear here." : civSwitch.log)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Mac2jbTheme.muted).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    }
                    .frame(height: 160)
                    .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10))
                    if let logURL = civSwitch.diagnosticLogURL {
                        Button("Open CivSwitch log") { NSWorkspace.shared.open(logURL) }
                            .font(.system(size: 11))
                    }
                }
                if civSwitch.canShowDemo || civSwitchControlCenter.isRunning {
                    Divider().overlay(.white.opacity(0.04))
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Control Center").font(.system(size: 15, weight: .semibold))
                        Text("Explore Civilization VII saves and installed content, monitor input, or stage JavaScript through the verified loader.")
                            .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                        HStack(spacing: 12) {
                            if civSwitchControlCenter.isRunning {
                                Button("Stop Control Center") { civSwitchControlCenter.stop() }
                                    .disabled(!civSwitchControlCenter.isRunning)
                            } else {
                                Button("Open Control Center") {
                                    civSwitchControlCenter.start(
                                        address: civSwitchConsoleAddress.trimmingCharacters(in: .whitespacesAndNewlines),
                                        runtimeRoot: model.runtime?.root)
                                }
                                .buttonStyle(PrimaryActionStyle())
                                .disabled(!civSwitch.canShowDemo || model.runtime == nil ||
                                          updater.blocksNewSession)
                            }
                            if civSwitchControlCenter.payloadModeAvailable {
                                Button("Stage JavaScript…") { chooseCivSwitchPayload() }
                                    .disabled(civSwitchControlCenter.staging)
                            }
                            if civSwitchControlCenter.backupFolder != nil {
                                Button("Open save exports") { civSwitchControlCenter.openBackups() }
                            }
                        }
                        if civSwitchControlCenter.ready {
                            Text("Enter Payload Mode on the Switch before choosing a JavaScript file. Press A there to run it or B to return.")
                                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                        }
                        Text(civSwitchControlCenter.status)
                            .font(.system(size: 12, weight: .semibold))
                        if civSwitchControlCenter.isRunning || !civSwitchControlCenter.log.isEmpty {
                            ScrollView {
                                Text(civSwitchControlCenter.log.isEmpty ? "Control Center activity will appear here." : civSwitchControlCenter.log)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(Mac2jbTheme.muted).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                            }
                            .frame(height: 120)
                            .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10))
                        }
                    }
                }
            }
            .padding(30)
        }
        .frame(width: 720, height: 650)
        .background { Mac2jbBackdrop() }
        .preferredColorScheme(.dark).tint(teal)
    }

    private func chooseCivSwitchPayload() {
        let picker = NSOpenPanel()
        picker.title = "Choose a JavaScript payload for CivSwitch Payload Mode"
        picker.canChooseDirectories = false
        picker.canChooseFiles = true
        picker.allowsMultipleSelection = false
        if let javaScript = UTType(filenameExtension: "js") {
            picker.allowedContentTypes = [javaScript]
        }
        picker.begin { response in
            if response == .OK, let url = picker.url { civSwitchControlCenter.stagePayload(url) }
        }
    }

    private func chooseCivSwitchDirectPayload() {
        let picker = NSOpenPanel()
        picker.title = "Choose JavaScript for the open CivSwitch loader"
        picker.canChooseDirectories = false
        picker.canChooseFiles = true
        picker.allowsMultipleSelection = false
        if let javaScript = UTType(filenameExtension: "js") {
            picker.allowedContentTypes = [javaScript]
        }
        picker.begin { response in
            if response == .OK, let url = picker.url { civSwitch.sendPayload(url) }
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
                             ? "IZMYSH uses its own host and START protocol. This GUI profile currently supports exploit verification only; use Cellenseres, Kurumuz or BermTheSequel for held RPC and homebrew."
                             : "pepsipu closes RPC after verification. Choose Cellenseres, Kurumuz or BermTheSequel for held RPC and homebrew.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    if !model.selectedHost.supportsDemo {
                        Text("This host’s bundled version supports the full edition of SmileBASIC.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    Toggle("The Switch is ready on the command screen", isOn: $developerReady)
                        .toggleStyle(.checkbox).font(.system(size: 12))
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
                    if showHostOnlyHomebrew && (canConfigure || !model.postRun.dumpInProgress) {
                        homebrewSection.id("hostonly-homebrew")
                    }
                    Divider()
                    existingRPCControls
                    Divider()
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
            panel { ArtemisHTTPView() }
            panel { dnsSwitchSettings }
            panel { webKitResearchSettings }
            panel { NSPBoxToolsView(runtimeRoot: model.runtime?.root) }
            panel { NUPToolsView(runtimeRoot: model.runtime?.root) }
            panel {
                VStack(alignment: .leading, spacing: 12) {
                    Text("SD card files")
                        .font(.system(size: 15, weight: .semibold))
                    Text("Browse or download files from the Switch SD card over a verified held RPC session. This browser is read-only and needs the Switch to remain on the same network.")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 10) {
                        TextField("Switch IPv4 address", text: $model.sdConsoleAddress)
                            .textFieldStyle(.roundedBorder).frame(maxWidth: 200)
                            .disabled(model.sdBusy || model.sdRunning)
                        Button("Open SD browser") { model.startSDBrowser() }
                            .disabled(!model.canStartSDBrowser)
                        if model.canStopSDBrowser {
                            Button("Stop browser") { model.stopSDBrowser() }
                                .disabled(model.sdBusy && !model.sdRunning)
                        }
                    }
                    if model.sdRunning {
                        Button("Open local SD panel ↗") { model.openSDBrowser() }
                        Text(model.sdFTPURL).font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(Mac2jbTheme.muted).textSelection(.enabled)
                    }
                    Text(model.sdMessage).font(.system(size: 10))
                        .foregroundStyle(Mac2jbTheme.muted)
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
                    Divider()
                    Button("Clear past session data…") { confirmClearPastSessions = true }
                        .disabled(!model.canClearPastSessionData)
                    Text(model.sessionCleanupMessage.isEmpty
                         ? "Keeps this session, save exports, dumps and source snapshots"
                         : model.sessionCleanupMessage)
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                }
            }
        }
    }

    private var dnsSwitchSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("DNSwitch")
                .font(.system(size: 15, weight: .semibold))
            HStack(spacing: 10) {
                if dnsSwitch.addresses.isEmpty {
                    Text("No Mac network address found")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                } else {
                    Picker("Mac network address", selection: $dnsSwitch.selectedAddress) {
                        ForEach(dnsSwitch.addresses) { address in
                            Text(address.label).tag(address.address)
                        }
                    }
                    .frame(maxWidth: 300)
                    .disabled(dnsSwitch.isActive)
                }
                Button("Refresh addresses") { dnsSwitch.refreshAddresses() }
                    .disabled(dnsSwitch.isActive)
            }
            TextField("Research page URL (optional; shown as a link on the portal)", text: $dnsSwitchDestinationURL)
                .textFieldStyle(.roundedBorder)
                .disabled(dnsSwitch.isActive)
            Text("Starting the local DNS and HTTP listeners requires a macOS administrator prompt for ports 53 and 80. The service stops after 30 minutes.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button("Start DNSwitch") {
                    dnsSwitch.start(destinationURL: dnsSwitchDestinationURL, runtimeRoot: model.runtime?.root)
                }
                .disabled(!dnsSwitch.canStart || dnsSwitch.selectedAddress.isEmpty || model.runtime == nil)
                if dnsSwitch.canStop {
                    Button("Stop DNSwitch") { dnsSwitch.stop() }
                }
            }
            Text(dnsSwitch.status)
                .font(.system(size: 11, weight: .semibold))
            Text(dnsSwitch.detail)
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Divider()
            Text("On your Switch")
                .font(.system(size: 12, weight: .semibold))
            Text("1. Keep the Switch and Mac on the same network. Open System Settings → Internet → Internet Settings → your network → Change Settings → DNS Settings → Manual.")
            Text("2. Set Primary DNS to \(dnsSwitch.isActive ? dnsSwitch.activeAddress : dnsSwitch.selectedAddress). If a Secondary DNS is required, use the same address. Save the settings.")
            Text("3. Run Test Connection. The portal may loop or fail to open; if it does, stop DNSwitch and restore your DNS settings.")
            Text("4. If the portal stays open and you chose a research URL, tap cpypwn to open it.")
            Text("5. When finished, stop DNSwitch and restore your DNS settings on the Switch.")
        }
        .font(.system(size: 11))
    }

    private var webKitResearchSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Switch browser research")
                .font(.system(size: 15, weight: .semibold))
            Picker("Probe source", selection: $webKitResearch.sourceMode) {
                Text("mac2jb probes").tag(WebKitResearchModel.SourceMode.bundled)
                Text("Upstream research").tag(WebKitResearchModel.SourceMode.upstream)
                Text("Local folder").tag(WebKitResearchModel.SourceMode.localFolder)
            }
            .pickerStyle(.segmented)
            .disabled(webKitResearch.isRunning)
            if webKitResearch.sourceMode == .bundled {
                Picker("Browser probe", selection: $webKitResearch.selectedProbeID) {
                    ForEach(webKitResearch.probes) { probe in
                        Text(probe.title).tag(probe.id)
                    }
                }
                .disabled(webKitResearch.isRunning || webKitResearch.probes.isEmpty)
                if let probe = webKitResearch.probes.first(where: { $0.id == webKitResearch.selectedProbeID }) {
                    Text(probe.description)
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let folder = webKitResearch.storedURL {
                    Button("Open stored probe files") { NSWorkspace.shared.open(folder) }
                }
            } else if webKitResearch.sourceMode == .upstream {
                if let folder = webKitResearch.upstreamStoredURL {
                    Button("Open included research files") { NSWorkspace.shared.open(folder) }
                }
            } else {
                HStack(spacing: 10) {
                    Button("Choose research folder…") { chooseWebKitResearchFolder() }
                        .disabled(webKitResearch.isRunning)
                    Button("Open upstream source") {
                        if let url = URL(string: "https://github.com/Jmesmykil/switch2-captive-portal-research") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    if let folder = webKitResearch.sourceURL {
                        Text(folder.lastPathComponent).lineLimit(1).truncationMode(.middle)
                            .foregroundStyle(Mac2jbTheme.muted)
                    }
                }
            }
            if !dnsSwitch.addresses.isEmpty {
                Picker("Mac network address", selection: $dnsSwitch.selectedAddress) {
                    ForEach(dnsSwitch.addresses) { address in
                        Text(address.label).tag(address.address)
                    }
                }
                .frame(maxWidth: 300)
                .disabled(webKitResearch.isRunning || dnsSwitch.isActive)
            }
            HStack(spacing: 10) {
                Button("Start research page") {
                    webKitResearch.start(runtimeRoot: model.runtime?.root, address: dnsSwitch.selectedAddress)
                }
                .disabled(webKitResearch.isRunning ||
                          (webKitResearch.sourceMode == .bundled ? webKitResearch.probes.isEmpty :
                           webKitResearch.sourceMode == .upstream ? webKitResearch.upstreamStoredURL == nil :
                           webKitResearch.sourceURL == nil) ||
                          dnsSwitch.selectedAddress.isEmpty || model.runtime == nil)
                if webKitResearch.isRunning {
                    Button("Stop research page") { webKitResearch.stop() }
                }
                if let url = webKitResearch.readyURL {
                    Button("Open page") { NSWorkspace.shared.open(url) }
                    Button("Use with DNSwitch") { dnsSwitchDestinationURL = url.absoluteString }
                        .disabled(dnsSwitch.isActive)
                }
            }
            Text(webKitResearch.status)
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let reportURL = webKitResearch.reportURL {
                Button("Open saved reports") { NSWorkspace.shared.open(reportURL) }
                    .disabled(!FileManager.default.fileExists(atPath: reportURL.path))
            }
        }
        .font(.system(size: 11))
        .onAppear { webKitResearch.loadCatalog(runtimeRoot: model.runtime?.root) }
        .onChange(of: model.runtime?.root.path) { _, _ in
            webKitResearch.loadCatalog(runtimeRoot: model.runtime?.root)
        }
        .onChange(of: webKitResearch.sourceMode) { _, _ in
            webKitResearch.loadCatalog(runtimeRoot: model.runtime?.root)
        }
    }

    private func chooseWebKitResearchFolder() {
        let picker = NSOpenPanel()
        picker.title = "Choose the Switch browser research folder"
        picker.canChooseDirectories = true
        picker.canChooseFiles = false
        picker.allowsMultipleSelection = false
        picker.begin { response in
            if response == .OK, let url = picker.url { webKitResearch.selectSource(url) }
        }
    }

    private var existingRPCControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("RPC already held").font(.system(size: 15, weight: .semibold))
            Text("Find an open session on this Mac or choose its switch2 run folder. Keep the original host and SmileBASIC open.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            TextField("Existing run folder", text: $model.existingRPCRunPath)
                .textFieldStyle(.roundedBorder).font(.system(size: 11))
                .disabled(!model.canChangeHost)
            HStack(spacing: 12) {
                Button("Find open RPC") { model.findOpenRPC() }
                    .disabled(!model.canFindOpenRPC || updater.blocksNewSession)
                Button("Choose run folder…") { chooseExistingRPCRun() }.disabled(!model.canChangeHost)
                Spacer()
                Button("Connect to open RPC") { model.attachExistingRPC() }
                    .disabled(!model.canAttachExistingRPC || updater.blocksNewSession)
            }.font(.system(size: 11))
            if model.rpcDiscoveryRunning {
                ProgressView().controlSize(.small)
            }
            if model.rpcDiscoveredSessions.count > 1 {
                HStack(spacing: 12) {
                    Picker("Verified session", selection: $model.selectedDiscoveredRPCPath) {
                        ForEach(model.rpcDiscoveredSessions) { candidate in
                            Text(candidate.description).tag(candidate.path)
                        }
                    }
                    Button("Connect selected session") { model.connectDiscoveredRPC() }
                        .disabled(!model.canChangeHost || updater.blocksNewSession)
                }.font(.system(size: 11))
            }
            if !model.rpcDiscoveryMessage.isEmpty {
                Text(model.rpcDiscoveryMessage).font(.system(size: 11))
                    .foregroundStyle(Mac2jbTheme.muted).fixedSize(horizontal: false, vertical: true)
            }
            Text("After connecting, choose a homebrew app. Disconnect stops this app’s workers and leaves the original host running.")
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
                    Toggle("Adjust for SmileBASIC auto-indent", isOn: $model.keyboardTextAutoIndent)
                        .toggleStyle(.checkbox)
                        .font(.system(size: 11))
                        .disabled(model.keyboardTextSending)
                    Text("Paste with ⌘V. ASCII text, tabs and newlines only; 16 KiB maximum. Newlines press Enter. No extra Enter is added.")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                    HStack {
                        Button("Send text") { model.sendKeyboardText() }.disabled(!model.canSendKeyboardText)
                        Text("\(model.keyDelayMs) ms release gap").font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
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
            HStack {
                Button("Experimental fast profile") { model.useExperimentalTypingTiming() }
                Button("Stock defaults") { model.useStockTiming() }
            }
            Text("Typing settings are saved. The fast profile is experimental. Verify the transferred text before saving.")
                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            timingField("Release gap", units: "ms", value: $model.keyDelayMs, range: 1...2000)
            timingField("Key hold", units: "ms", value: $model.keyHoldMs, range: 0...2000)
            timingField("After Enter", units: "ms", value: $model.enterSettleMs, range: 0...2000)
            timingField("USB polling interval", units: "bInterval", value: $model.pollInterval, range: 1...16)
            Text("At high speed: 6 = 4 ms polling; 10 = 64 ms. Applies to bootstrap and command typing.")
                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            timingField("Enumeration timeout per controller", units: "s", value: $model.enumerationTimeoutSeconds, range: 1...120)
            Divider()
            timingField("Before confirming LOAD / LOADV", units: "ms", value: $model.loadConfirmWaitMs, range: 0...120000)
            timingField("After LOAD → before RUN", units: "ms", value: $model.loadWaitMs, range: 0...120000)
            timingField("After RUN → before REMOVE", units: "ms", value: $model.runWaitMs, range: 0...120000)
            timingField("After REMOVE → before START", units: "ms", value: $model.removeWaitMs, range: 0...120000)
            HStack {
                Text("Stock: 10 ms release gap · no added hold or Enter wait · polling interval 10 · 4 s connection · 1 s after LOAD.")
                    .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                Spacer(minLength: 8)

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
                    Button("Skip typing", action: skip)
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
                if model.isBusy && model.phase != .installingSave {
                    if let progress = model.progress { ProgressView(value: progress).tint(teal) }
                    else { ProgressView().progressViewStyle(.linear).tint(teal) }
                    if !model.progressLabel.isEmpty {
                        Text(model.progressLabel).font(.system(size: 11, design: .monospaced)).foregroundStyle(Mac2jbTheme.muted).monospacedDigit()
                    }
                    if model.phase == .bootstrap {
                        HStack(spacing: 14) {
                            Text("Elapsed " + durationText(model.bootstrapElapsedSeconds))
                            if let remaining = model.bootstrapEstimatedRemainingSeconds {
                                Text("Bootstrap write ETA · " + durationText(remaining.rounded(.up)) + " remaining")
                            } else if !model.isEnumerating {
                                Text("Calculating bootstrap write ETA…")
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
                if model.activeRunMode == .seedsowSave {
                    if (model.phase == .rpcHeld || model.phase == .installingSave ||
                        model.phase == .failed && model.seedsowInstallStarted) &&
                       !model.postRun.homebrewAttempted &&
                       (!model.savekitChoiceStarted || model.savekitChoiceFinished) {
                        postJailbreakChoice.id("seedsow-homebrew")
                    }
                    if (model.savekitChoiceStarted || model.seedsowInstallCompleted) &&
                       !model.savekitChoiceFinished && model.phase == .rpcHeld {
                        Divider()
                        if model.savekitChoiceStarted {
                            SaveKitToolsView(model: model, experimentalTools: true)
                            SaveKitResearchView(runtimeRoot: model.runtime?.root)
                        } else {
                            DisclosureGroup("SaveKit tools") {
                                SaveKitToolsView(model: model, experimentalTools: true)
                                SaveKitResearchView(runtimeRoot: model.runtime?.root)
                            }.font(.system(size: 12, weight: .semibold))
                        }
                    }
                }
                if model.phase == .verified || model.phase == .commandsSent || model.phase == .rpcDetached {
                    if model.phase == .verified && !model.modloaderInstallReady {
                        Text(model.activeRunMode == .seedsowSave && model.seedsowInstallCompleted
                             ? model.seedsowInstallSkipped
                               ? "The existing save was preserved and RPC cleanup was verified."
                               : "Save installation and RPC cleanup were verified. Close SmileBASIC, then open the selected demo."
                             : "The session finished and cleanup was confirmed. Restart the Switch before starting again.")
                            .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    Button("Back to start") { model.returnToStart() }.buttonStyle(PrimaryActionStyle()).disabled(!model.canReturnToStart)
                }
                if model.phase == .failed && model.seedsowInstallStarted {
                    Button("Back to start") { model.returnToStart() }
                        .buttonStyle(PrimaryActionStyle())
                        .disabled(!model.canReturnToStart)
                }
                if model.postRun.isActive && model.phase != .installingSave { postRunControls }
                if model.activeRunMode == .seedsowSave && model.postRun.homebrewAttempted {
                    if model.homebrewApp == .mintBrew { mintBrewFolderControls }
                    else { homebrewSection }
                }
                if model.activeRunMode != .seedsowSave && !showHostOnlyHomebrew && model.activeSessionSupportsHomebrew &&
                    model.postRun.stage == .held && !model.postRun.dumpInProgress &&
                    (model.postRun.heldConfirmed || model.postRun.homebrewAttempted) {
                    if model.activeRunMode == .heldRPC && model.postRun.homebrewAttempted &&
                        model.homebrewApp == .mintBrew {
                        mintBrewFolderControls
                    } else {
                        homebrewSection.id("savekit-homebrew")
                    }
                }
                if model.postRun.dumpCompleted, model.dumpFolder != nil { Button("Open dump folder") { model.revealDumpFolder() } }
                if (model.isBusy || model.phase == .awaitingSave) && !model.postRun.isActive {
                    HStack {
                        Text(model.phase == .preparing
                             ? "Preparing bundled tools for \(model.selectedHost.label) and checking this Mac’s USB driver and network."
                             : "Keep SmileBASIC open until the session finishes.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                        Spacer()
                        if (!model.isInitialPreparation || model.phase != .preparing) &&
                            (model.activeRunMode != .seedsowSave || !model.seedsowInstallStarted) {
                            Button("Stop session", role: .destructive) { model.cancel() }
                                .disabled(model.savekitBusy)
                        }
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
            Button("\(model.activeHost.saveName) saved — back to start") {
                model.finishBootstrapOnly()
            }
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
                    : model.modloaderInstallReady
                      ? "Finish the session, close SmileBASIC without restarting the Switch, then launch the game."
                      : model.isAttachedRPCSession ? "When you’re done, disconnect here. The original host keeps its RPC session open." : "When you’re done, finish the session before closing SmileBASIC.")
                .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
            HStack {
                Button("Session details…") { showDeveloperOptions = true }.font(.system(size: 11))
                if model.canDumpSystemCode {
                    Button("Dump system code") { model.dumpSystemCode() }
                        .font(.system(size: 11))
                }
                if model.canStopCurrentHomebrew {
                    Button("Stop current homebrew") { model.stopCurrentHomebrew() }
                        .font(.system(size: 11))
                }
                Spacer()
                if model.postRun.cleanupBlocked {
                    Button("Stop session", role: .destructive) { model.cancel() }
                        .disabled(model.savekitBusy)
                } else {
                    Button(model.isAttachedRPCSession ? "Disconnect" : "Finish session") { model.finishPostRun() }
                        .buttonStyle(PrimaryActionStyle())
                        .disabled(!model.postRun.canFinish || model.savekitBusy || model.pendingHomebrewAction != nil)
                }
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

    private var nativeRomFolderControl: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Text("SD ROM folder")
                    .font(.system(size: 11, weight: .medium))
                TextField("/sd/roms/nes", text: $nativeSDRomFolder)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 11, design: .monospaced))
                    .frame(maxWidth: 260)
                    .disabled(!model.canLaunchNativeHBLauncher)
            }
            Text(nativeSDRomFolderValid
                 ? "MintNES imports supported .nes ROMs from this Switch SD folder before launch"
                 : "Enter an absolute folder under /sd/")
                .font(.system(size: 10))
                .foregroundStyle(nativeSDRomFolderValid ? Mac2jbTheme.muted : .orange)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var postJailbreakChoice: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Choose what to open")
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(ink)
            Text(model.phase == .installingSave
                 ? "Installing a save. Other options will become available after RPC is verified."
                 : model.phase == .failed && model.seedsowInstallStarted
                 ? "RPC is no longer available. Restart the Switch before another app attempt."
                 : "RPC is held. Choose one path for this session.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "square.grid.3x3.fill").font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
                VStack(alignment: .leading, spacing: 5) {
                    Text("MintBrew").font(.system(size: 13, weight: .semibold))
                    Text("Open the homebrew library on your Switch")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                }
                Spacer(minLength: 8)
                Button("Open MintBrew") {
                    model.launchMintBrew(accountAddons: account.addonURLs,
                                         libraryItems: account.libraryPayload())
                }.disabled(!model.canLaunchHomebrew)
            }
            Divider()
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "cpu").font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
                VStack(alignment: .leading, spacing: 5) {
                    Text("HBLauncher").font(.system(size: 13, weight: .semibold))
                    Text("Open the native app library in this held session")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    HStack(spacing: 10) {
                        Button("Open native apps folder") { model.openNativeAppsFolder() }
                        Button("Open MintNES ROM folder") { model.openNativeROMsFolder() }
                    }.font(.system(size: 11)).disabled(model.phase == .installingSave)
                    nativeRomFolderControl
                }
                Spacer(minLength: 8)
                Button("Open HBLauncher") { model.launchNativeHBLauncher(sdRomFolder: nativeSDRomFolder) }
                    .disabled(!model.canLaunchNativeHBLauncher || !nativeSDRomFolderValid)
            }
            Divider()
            ounceCakeRow
            Divider()
            modloaderRow
            Divider()
            artemisInstallerRow
            Divider()
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "externaldrive.badge.person.crop")
                    .font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
                VStack(alignment: .leading, spacing: 5) {
                    Text("SaveKit").font(.system(size: 13, weight: .semibold))
                    Text("Inspect, back up or manage saves in this held RPC session")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                }
                Spacer(minLength: 8)
                if !model.seedsowInstallCompleted || model.savekitChoiceFinished {
                    Button("Start SaveKit") { model.startSaveKit() }
                        .disabled(!model.canStartSaveKit)
                }
            }
        }
        .font(.system(size: 11))
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
    }

    private var artemisInstallerRow: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "square.and.arrow.down")
                .font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
            VStack(alignment: .leading, spacing: 8) {
                Text("Save installers").font(.system(size: 13, weight: .semibold))
                Text("Artemis launcher")
                    .font(.system(size: 11, weight: .semibold))
                HStack(spacing: 10) {
                    Button("Install seedsowhax (demo)") {
                        model.installArtemisSave(game: .seedsow, seedsowEdition: .demo)
                    }
                    Button("Install seedsowhax (full game)") {
                        model.installArtemisSave(game: .seedsow, seedsowEdition: .full)
                    }.help("Requires an existing Seedsow Lullaby full-game save")
                }.disabled(!model.canInstallArtemisSave)
                HStack(spacing: 10) {
                    Button("Install norahax") { model.installArtemisSave(game: .nora1) }
                        .help("Nora, Princess and Stray Cat HD demo")
                    Button("Install nora2hax") { model.installArtemisSave(game: .nora) }
                        .help("Nora, Princess and Crying Cat 2 demo")
                    Button("Install hamihax") { model.installArtemisSave(game: .hamidashi) }
                }.disabled(!model.canInstallArtemisSave)
                HStack(spacing: 10) {
                    Button("Check for upstream update") {
                        artemisUpdates.check(runtimeRoot: model.runtime?.root)
                    }.disabled(artemisUpdates.isChecking || model.runtime == nil || model.phase == .installingSave)
                    if artemisUpdates.isChecking { ProgressView().controlSize(.small) }
                    if let page = artemisUpdates.releasePage {
                        Link("View release ↗", destination: page)
                    }
                }.font(.system(size: 10))
                if !artemisUpdates.message.isEmpty {
                    Text(artemisUpdates.message)
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text("Seedsow Lua Editor save")
                        .font(.system(size: 11, weight: .semibold))
                    Text("This will overwrite the Artemis launcher and overlapping save slots")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 10) {
                        if AppBuildIdentity.isTestBuild {
                            Button("Install Lua editor save") { model.installSeedsowSave() }
                        }
                        Button("Install Lua Editor Pro (demo)") { model.installSeedsowSave(pro: true) }
                    }.disabled(!model.canInstallSeedsowSave)
                }.padding(.top, 4)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Balatro")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Requires the Switch 1 cartridge in compatibility mode; the native Switch 2 edition is unsupported. This save opens a Lua and FTP launcher instead of the game.")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 10) {
                        Button("Install Balatro RCE") { model.installBalatroSave(variant: .upstream) }
                        if AppBuildIdentity.isTestBuild {
                            Button("Install cpypwn showcase") { model.installBalatroSave(variant: .showcase) }
                        }
                    }.disabled(!model.canInstallBalatroSave)
                }.padding(.top, 4)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Gravity Circuit")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Install the bundled Lua and FTP save for versions 1.0.0 and 1.2.1")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                    Button("Install Gravity Circuit save") { model.installGravCircSave() }
                        .disabled(!model.canInstallGravCircSave)
                }.padding(.top, 4)
                if model.phase == .installingSave {
                    VStack(alignment: .leading, spacing: 7) {
                        if let progress = model.progress { ProgressView(value: progress).tint(teal) }
                        else { ProgressView().progressViewStyle(.linear).tint(teal) }
                        Text(model.status)
                            .font(.system(size: 11, weight: .semibold))
                        if !model.progressLabel.isEmpty {
                            Text(model.progressLabel)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(Mac2jbTheme.muted)
                        }
                    }.padding(.vertical, 4)
                }
                if model.phase == .failed && model.seedsowInstallStarted {
                    Text(model.detail)
                        .font(.system(size: 10)).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !model.seedsowUsers.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Choose the console user whose \(model.activeSaveTitle) save will be updated")
                            .font(.system(size: 11, weight: .semibold))
                        Picker("Console user", selection: $model.selectedSeedsowUser) {
                            ForEach(model.seedsowUsers, id: \.self) { user in Text(user).tag(user) }
                        }
                        Button("Back up and install save") { model.selectSeedsowUser() }
                            .buttonStyle(PrimaryActionStyle())
                    }
                }
                if model.seedsowBackupFolder != nil {
                    Button("Open original save backup") { model.revealSeedsowBackup() }
                }
                if model.seedsowInstallCompleted && model.phase == .rpcHeld {
                    Text(model.seedsowInstallSkipped
                         ? "Existing \(model.activeSaveTitle) save preserved"
                         : model.installingSeedsowEditorSave
                           ? model.installingSeedsowEditorPro
                             ? "Seedsow Lua Editor Pro installed"
                             : "Seedsow Lua Editor save installed"
                           : model.activeSaveGame == .balatro
                             ? model.activeBalatroVariant == .showcase
                               ? "Balatro cpypwn showcase installed"
                               : "Balatro RCE save installed"
                           : model.activeSaveGame == .gravcirc
                             ? "Gravity Circuit save installed"
                           : "\(model.activeSaveGame?.launcher ?? "Artemis launcher") save installed")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                } else {
                    Text("Close the selected game before installing. Installing can replace game progress; the original save is verified and kept as a backup.")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
        }
    }

    private var customSeedsowEditorControl: some View {
        DisclosureGroup("Custom Seedsow Lua editor save") {
            VStack(alignment: .leading, spacing: 8) {
                Button("Choose editor save…") { chooseLuaEditorSave() }
                    .disabled(!model.canInstallSeedsowSave && !canConfigure)
                if let selectedLuaEditorSave {
                    Text(selectedLuaEditorSave.lastPathComponent)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Mac2jbTheme.muted).textSelection(.enabled)
                    Button("Install selected save") {
                        model.installSeedsowSave(source: selectedLuaEditorSave)
                    }.disabled(!model.canInstallSeedsowSave)
                }
                if let luaEditorSelectionMessage {
                    Text(luaEditorSelectionMessage).font(.system(size: 10)).foregroundStyle(.orange)
                }
            }.padding(.top, 6)
        }
        .font(.system(size: 11))
        .padding(.leading, 44)
    }

    private func chooseLuaEditorSave() {
        guard model.canInstallSeedsowSave || showHostOnlyHomebrew && canConfigure else { return }
        let picker = NSOpenPanel()
        picker.title = "Choose a Seedsow Lua editor save"
        picker.message = "Select a ZIP archive or a folder containing the editor save files."
        picker.canChooseDirectories = true
        picker.canChooseFiles = true
        picker.allowsMultipleSelection = false
        picker.begin { response in
            guard response == .OK, let url = picker.url else { return }
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
            guard values?.isDirectory == true ||
                  values?.isRegularFile == true && url.pathExtension.lowercased() == "zip" else {
                selectedLuaEditorSave = nil
                luaEditorSelectionMessage = "Choose a ZIP archive or a folder of save files."
                return
            }
            selectedLuaEditorSave = url.standardizedFileURL
            luaEditorSelectionMessage = nil
        }
    }

    private var homebrewSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Choose an app")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(ink)
            Text(model.phase == .installingSave
                 ? "Installing a save. Other options will become available after RPC is verified."
                 : model.phase == .failed && model.seedsowInstallStarted
                 ? "RPC is no longer available. Restart the Switch before another app attempt."
                 : canConfigure && showHostOnlyHomebrew
                 ? "Run host only with Hold RPC after success checked. Choose an app here once the host confirms 4/4 verification and holds RPC open."
                 : model.postRun.cleanupBlocked
                 ? "Restart your Switch before starting another session."
                 : model.postRun.homebrewAttempted
                    ? "Stop the current homebrew app before choosing another."
                    : model.activeRunMode == .seedsowSave && model.seedsowInstallCompleted
                        ? "The launcher save is ready. RPC remains open; choose a homebrew app for this session."
                    : model.postRun.heldConfirmed ? "Your Switch is connected. Choose one app for this session." : "Waiting for the host to verify the Switch and hold RPC open.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted).fixedSize(horizontal: false, vertical: true)
            homebrewRow(icon: "square.grid.3x3.fill", title: "MintBrew",
                        description: "Open the homebrew library on your Switch",
                        actionTitle: model.postRun.homebrewAttempted && model.homebrewApp == .mintBrew
                            ? homebrewActionTitle : "Launch MintBrew",
                        enabled: model.canLaunchHomebrew, action: {
                            model.launchMintBrew(accountAddons: account.addonURLs,
                                                 libraryItems: account.libraryPayload())
                        }) {
                Button("Open MintBrew apps folder") { model.openMintBrewAppsFolder() }
                    .font(.system(size: 11)).disabled(model.runtime == nil || model.phase == .installingSave)
                    .font(.system(size: 11))
                Text("Add or remove apps while this session is open. Refresh the list on your Switch.")
                    .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                if model.homebrewFolder != nil {
                    Button("Open homebrew logs") { model.revealHomebrewLogs() }
                        .font(.system(size: 11))
                }
            }
            homebrewRow(icon: "cpu", title: "HBLauncher",
                        description: "Run native AArch64 apps in this held session",
                        actionTitle: "Launch HBLauncher",
                        enabled: model.canLaunchNativeHBLauncher && nativeSDRomFolderValid,
                        action: { model.launchNativeHBLauncher(sdRomFolder: nativeSDRomFolder) }) {
                HStack(spacing: 10) {
                    Button("Open native apps folder") { model.openNativeAppsFolder() }
                    Button("Open MintNES ROM folder") { model.openNativeROMsFolder() }
                }.font(.system(size: 11)).disabled(model.runtime == nil || model.phase == .installingSave)
                nativeRomFolderControl
            }
            Divider()
            ounceCakeRow
            Divider()
            modloaderRow
            if showHostOnlyHomebrew && model.selectedHost.supportsSaveKit {
                artemisInstallerRow
                customSeedsowEditorControl
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "externaldrive.badge.person.crop")
                            .font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
                        VStack(alignment: .leading, spacing: 5) {
                            Text("SaveKit").font(.system(size: 13, weight: .semibold))
                            Text("Inspect, back up or manage game saves in this held RPC session")
                                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                        }
                        Spacer(minLength: 8)
                        if (!model.savekitChoiceStarted || model.savekitChoiceFinished) &&
                           (!model.seedsowInstallCompleted || model.savekitChoiceFinished) {
                            Button("Start SaveKit") { model.startSaveKit() }
                                .disabled(!model.canStartSaveKit)
                        }
                    }
                    if model.activeRunMode == .hostOnlyHeld && model.phase == .rpcHeld &&
                       !model.savekitChoiceFinished && !model.postRun.homebrewAttempted &&
                       (model.savekitChoiceStarted || model.seedsowInstallCompleted) {
                        if model.savekitChoiceStarted {
                            SaveKitToolsView(model: model, experimentalTools: true)
                            SaveKitResearchView(runtimeRoot: model.runtime?.root)
                        } else {
                            DisclosureGroup("SaveKit tools") {
                                SaveKitToolsView(model: model, experimentalTools: true)
                                SaveKitResearchView(runtimeRoot: model.runtime?.root)
                            }
                        }
                    } else if canConfigure {
                        Text("Available after the host completes 4/4 with RPC held")
                            .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                            .padding(.leading, 44)
                    }
                }
                Divider()
            }
            if showHostOnlyHomebrew {
                izlauncherRow
                customHomebrewRow
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
    }

    private var modloaderRow: some View {
        homebrewRow(icon: "puzzlepiece.extension.fill", title: "Modloader",
                    description: "Load game mods for this boot",
                    actionTitle: model.modloaderInstallReady ? "Ready" :
                        model.pendingHomebrewAction == "modloader-install" ? "Checking…" :
                        model.homebrewApp == .modloader && model.postRun.homebrewStage == .failed ? "Unavailable" :
                        model.homebrewApp == .modloader && model.postRun.homebrewAttempted ? "Installing…" : "Install modloader",
                    enabled: model.canLaunchModloader && modloaderFolder != nil,
                    action: {
                        if let modloaderFolder { model.installModloader(modsFolder: modloaderFolder) }
                    }) {
            HStack(spacing: 8) {
                Button("Choose mods folder…") { chooseModloaderFolder() }
                    .disabled(model.postRun.homebrewAttempted || model.pendingHomebrewAction != nil || model.phase == .installingSave)
                if let modloaderFolder {
                    Text(modloaderFolder.lastPathComponent)
                        .lineLimit(1).truncationMode(.middle)
                        .help(modloaderFolder.path)
                }
            }.font(.system(size: 11))
            Text("Select a folder with contents or exefs_patches directly inside it")
                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            if model.homebrewApp == .modloader && !model.homebrewMessage.isEmpty {
                Text(model.modloaderInstallReady ? "Installed for this boot" : model.homebrewMessage)
                    .font(.system(size: 10))
                    .foregroundStyle(model.modloaderInstallReady ? teal : Mac2jbTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            } else if (model.postRun.isActive ? model.activeHost : model.selectedHost) != .cellenseres {
                Text("Modloader requires a Cellenseres host session")
                    .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            }
        }
    }

    private func chooseModloaderFolder() {
        let picker = NSOpenPanel()
        picker.title = "Choose a modloader folder"
        picker.canChooseDirectories = true
        picker.canChooseFiles = false
        picker.allowsMultipleSelection = false
        picker.begin { response in
            if response == .OK { modloaderFolder = picker.url }
        }
    }

    private var izlauncherRow: some View {
        homebrewRow(icon: "square.stack.3d.up", title: "IZlauncher",
                    description: "Run IZ2S modules in this held RPC session",
                    actionTitle: "Launch IZlauncher", enabled: model.canLaunchIZlauncher,
                    action: { model.launchIZlauncher() }) {
            if model.izlauncherCatalogLoaded {
                Text("Modules on this Mac").font(.system(size: 11, weight: .semibold))
                ForEach(model.izlauncherModules) { item in
                    Toggle("\(item.name) \(item.version)", isOn: Binding(
                        get: { model.selectedIZlauncherModuleIDs.contains(item.id) },
                        set: { model.selectIZlauncherModule(item.id, selected: $0) }
                    )).toggleStyle(.checkbox).font(.system(size: 11))
                }
            }
            Text(model.izlauncherModuleMessage)
                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            HStack(spacing: 10) {
                Button("Load selected modules") { model.loadIZlauncherModules() }
                    .disabled(!model.canLoadIZlauncherModules)
                Button("Add compatible module…") { chooseIZlauncherModule() }
                    .disabled(!model.canLaunchIZlauncher)
            }.font(.system(size: 11))
            if model.izlauncherPanelURL != nil {
                Button("Open local control panel ↗") { model.openIZlauncherPanel() }
                    .disabled(!model.canOpenIZlauncherPanel)
                    .font(.system(size: 11))
            }
            if !model.izlauncherPanelMessage.isEmpty {
                Text(model.izlauncherPanelMessage)
                    .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            }
        }
    }

    private func chooseIZlauncherModule() {
        guard model.canLaunchIZlauncher else { return }
        let picker = NSOpenPanel()
        picker.title = "Choose a compatible IZlauncher module"
        picker.canChooseDirectories = true
        picker.canChooseFiles = false
        picker.allowsMultipleSelection = false
        picker.begin { response in
            if response == .OK, let url = picker.url { model.launchIZlauncher(moduleFolder: url) }
        }
    }

    private var customHomebrewRow: some View {
        homebrewRow(icon: "folder.fill", title: "Custom homebrew",
                    description: "Choose a GPU app, native app, IZlauncher module, or RPC package for this held session",
                    actionTitle: "Choose folder…", enabled: model.canLaunchHomebrew,
                    action: { chooseCustomHomebrew() }) {
            TextField("Switch IPv4 address for OunceCake", text: $model.ounceCakeConsoleAddress)
                .textFieldStyle(.roundedBorder).frame(maxWidth: 240)
                .font(.system(size: 11)).disabled(!model.canLaunchHomebrew)
            Text("An IPv4 address is needed for OunceCake-compatible WebDAV packages")
                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
        }
    }

    private var ounceCakeRow: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "externaldrive.fill")
                .font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
            VStack(alignment: .leading, spacing: 8) {
                Text("OunceCake").font(.system(size: 13, weight: .semibold)).foregroundStyle(ink)
                Text("Browse a selected game’s files")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                TextField("Switch IPv4 address", text: $model.ounceCakeConsoleAddress)
                    .textFieldStyle(.roundedBorder).frame(maxWidth: 240)
                    .font(.system(size: 11)).disabled(!model.canLaunchHomebrew)
                if model.ounceCakeSession.stage == .choosing {
                    Picker("Game", selection: $model.selectedOunceCakeGame) {
                        ForEach(model.ounceCakeSession.games) { game in
                            Text(game.name).tag(game.titleId)
                        }
                    }.frame(maxWidth: 420)
                    Button("Open selected game") { model.startOunceCakeShare() }
                        .disabled(!model.canSelectOunceCakeGame)
                }
                if model.ounceCakeSession.stage == .serving,
                   let webDAV = model.ounceCakeSession.endpoint?.address {
                    HStack(spacing: 8) {
                        Text("WebDAV \(webDAV)").textSelection(.enabled)
                        Button("Copy") { model.copyOunceCakeAddress() }
                    }.font(.system(size: 11))
                    if let ftp = model.ounceCakeFTPURL {
                        HStack(spacing: 8) {
                            Text("FTP on this Mac \(ftp)").textSelection(.enabled)
                            Button("Copy") { model.copyOunceCakeAddress(ftp: true) }
                        }.font(.system(size: 11))
                    }
                }
            }
            Spacer(minLength: 8)
            HStack(spacing: 8) {
                Button("WebDAV") { model.launchOunceCake(ftp: false) }
                Button("FTP on this Mac") { model.launchOunceCake(ftp: true) }
            }.font(.system(size: 11, weight: .medium))
                .disabled(!model.canLaunchOunceCake)
        }
    }

    private func chooseCustomHomebrew() {
        guard model.canLaunchHomebrew else { return }
        let picker = NSOpenPanel()
        picker.title = "Choose a built homebrew folder"
        picker.canChooseDirectories = true
        picker.canChooseFiles = false
        picker.allowsMultipleSelection = false
        picker.begin { response in
            if response == .OK, let url = picker.url { model.launchCustomHomebrew(folder: url) }
        }
    }

    private func homebrewRow<Details: View>(icon: String, title: String, description: String?,
                                            actionTitle: String, enabled: Bool,
                                            action: @escaping () -> Void,
                                            @ViewBuilder details: () -> Details) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(ink)
                if let description {
                    Text(description).font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                }
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
        case .idle: return "Launch MintBrew"
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
