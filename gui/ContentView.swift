import SwiftUI
import AppKit
import Combine

private let ink = Mac2jbTheme.ink
private let teal = Mac2jbTheme.mint
private let lastCivSwitchAddressKey = "lastCivSwitchConsoleAddress"

private struct ToolsContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct KaiHENContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

struct ContentView: View {
    @ObservedObject var model: SessionModel
    @ObservedObject var updater: AppUpdater
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var civSwitch = CivSwitchModel()
    @StateObject private var civFS = CivSwitchFSModel()
    @StateObject private var kaiHEN = KaiHENModel()
    @StateObject private var civKaiHEN = CivSwitchKaiHENModel()
    @StateObject private var seedsowKaiHEN = SeedsowKaiHENModel()
    @StateObject private var seedsowSemiUntethered = SeedsowSemiUntetheredModel()
    @StateObject private var artemisFS = ArtemisFSModel()
    @StateObject private var offlineEthernet = OfflineEthernetModel()
    @StateObject private var bundledUpdates = BundledUpdateChecker()
    @State private var smilePowerConfirmed = false
    @State private var smileDirectModeConfirmed = false
    @State private var civLoaderConfirmed = false
    @State private var seedsowHTTPConfirmed = false
    @State private var setupReady = false
    @State private var developerReady = false
    @State private var hostOnlyKeepRPC = false
    @State private var commandsToSend: Set<PostBootstrapCommand> = [.load, .run, .remove]
    @State private var savedConfirmed = false
    @State private var saveDirectModeReady = false
    @State private var showNS2JBSetup = false
    @State private var showBootstrapSetup = false
    @State private var showCivSwitchSetup = false
    @State private var showSeedsowKaiHENSetup = false
    @State private var showKaiHENInstaller = false
    @State private var showOfflineEthernetSetup = false
    @State private var showCivSwitchFirstTime = false
    @State private var civSwitchReady = false
    @State private var civSwitchConsoleAddress = UserDefaults.standard.string(forKey: lastCivSwitchAddressKey) ?? ""
    @State private var civFSAttachedRunPath: String?
    @State private var artemisFSAttachedRunPath: String?
    @State private var showDeveloperOptions = false
    @State private var toolsContentHeight: CGFloat = 0
    @State private var kaiHENContentHeight: CGFloat = 0
    @State private var followConsole = true
    @State private var activityTab = 0
    @State private var driverMessage: String?
    @State private var confirmUpdate = false
    @State private var confirmClearPastSessions = false
    @State private var showFailure = false
    @State private var failureText = ""
    @State private var failureLogURL: URL?
    @State private var showBundledUpdates = false

    private var canConfigure: Bool {
        [.ready, .failed, .cancelled].contains(model.phase) &&
        !(model.phase == .failed && model.seedsowInstallStarted)
    }
    private var civFirstTimeTransferActive: Bool {
        showCivSwitchFirstTime && !showCivSwitchSetup &&
        [.typing, .verifying, .stopping].contains(civSwitch.phase)
    }
    private var configurationLocked: Bool {
        model.hasLiveWorkers || model.driverSetupRunning || model.rpcDiscoveryRunning ||
        model.sessionCleanupRunning || civSwitch.isRunning ||
        civFS.isRunning || kaiHEN.isRunning || civKaiHEN.isRunning ||
        seedsowKaiHEN.isRunning || seedsowSemiUntethered.isRunning ||
        artemisFS.isRunning || !canConfigure
    }
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
    private var driverSetupBlocked: Bool { model.runtime == nil || configurationLocked || updater.blocksNewSession }
    private var timingSettingsValid: Bool {
        (1...2000).contains(model.keyDelayMs) && (0...2000).contains(model.keyHoldMs) &&
        (0...2000).contains(model.enterSettleMs) && (1...16).contains(model.pollInterval) &&
        (1...120).contains(model.enumerationTimeoutSeconds) &&
        (1...60).contains(model.hostStageTimeoutMinutes) &&
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
        case .rpcHeld: return model.savekitSessionBlocked || model.savekitReturnBlocked
            ? "Save action needs attention" : "You’re ready to go"
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
        dialogsContent
    }

    private var rootContent: some View {
        ZStack {
            Mac2jbBackdrop()
            GeometryReader { viewport in
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(spacing: 16) {
                            if showFailure && civFS.phase != .failed { sessionFailureBanner }
                            if let driverMessage { driverStatusBanner(driverMessage) }
                            if updater.state != .idle { updateStatus }
                            if canConfigure && civFirstTimeTransferActive {
                                civSwitchTransferSession
                            } else if canConfigure && kaiHEN.phase != .idle {
                                kaiHENSession
                            } else if canConfigure && civKaiHEN.phase != .idle {
                                civKaiHENSession
                            } else if canConfigure && seedsowKaiHEN.phase != .idle {
                                seedsowKaiHENSession
                            } else if canConfigure && (civFS.isRunning || civFS.phase == .failed) {
                                civSwitchFSSession
                            } else if canConfigure && artemisFS.isRunning {
                                artemisFSChecking
                            } else if canConfigure {
                                home
                            } else {
                                activeSession
                            }
                            toolsBubble
                            Text("mac2jb · v\(AppBuildIdentity.version)")
                                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        .frame(maxWidth: 820).padding(.horizontal, 30).padding(.vertical, 24)
                        .frame(maxWidth: .infinity, minHeight: viewport.size.height, alignment: .center)
                    }
                    .onChange(of: model.phase) { _, _ in scrollToKeyboardIfNeeded(proxy) }
                    .onChange(of: toolsContentHeight) { _, _ in scrollToKeyboardIfNeeded(proxy) }
                }
            }.ignoresSafeArea(.container, edges: .top)
        }
        .frame(minWidth: 760, minHeight: 560)
        .preferredColorScheme(.dark).tint(teal)
    }

    private var lifecycleBaseContent: some View {
        rootContent
        .onAppear {
            model.prepare(); updater.start()
            if model.runtime != nil {
                offlineEthernet.open(runtimeRoot: model.runtime?.root)
                bundledUpdates.checkKaiHENAtBoot(runtimeRoot: model.runtime?.root)
            }
            NSApp.activate(ignoringOtherApps: true)
        }
        .onDisappear {
            offlineEthernet.close()
            civSwitch.cancel()
            civFS.stop()
            kaiHEN.stop()
            civKaiHEN.stop()
            seedsowKaiHEN.stop()
            seedsowSemiUntethered.stop()
            artemisFS.stop()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            model.refreshNetworkAddressesIfIdle()
            offlineEthernet.refreshAdapters()
        }
        .onChange(of: model.runtime?.root.path) { _, path in
            if path != nil {
                offlineEthernet.open(runtimeRoot: model.runtime?.root)
                bundledUpdates.checkKaiHENAtBoot(runtimeRoot: model.runtime?.root)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
            civSwitch.cancel()
            civFS.stop()
            kaiHEN.stop()
            civKaiHEN.stop()
            seedsowKaiHEN.stop()
            seedsowSemiUntethered.stop()
            artemisFS.stop()
        }
        .onChange(of: model.phase) { _, phase in
            setupReady = false; developerReady = false; savedConfirmed = false; saveDirectModeReady = false
            if phase == .failed {
                let location = model.diagnosticLogURL.map { "Log saved at:\n" + $0.path }
                    ?? "A diagnostic log could not be created. Expand Console & Developer Options to view session activity."
                failureLogURL = model.diagnosticLogURL
                failureText = (model.error ?? model.detail) + "\n\n" + location
                presentFailure()
            }
        }
    }

    private var lifecyclePhaseContent: some View {
        lifecycleBaseContent
        .onChange(of: civFS.phase) { _, phase in
            if phase == .starting {
                civFSAttachedRunPath = nil
            } else if phase == .held, let runPath = civFS.runPath,
                      civFSAttachedRunPath != runPath, model.canChangeHost,
                      !updater.blocksNewSession {
                civFSAttachedRunPath = runPath
                model.attachCivSwitchFSRun(runPath)
            } else if phase == .failed {
                failureLogURL = civFS.failureLogURL ?? civFS.diagnosticLogURL
                let location = failureLogURL.map { "Log saved at:\n" + $0.path }
                    ?? "A diagnostic log could not be created."
                let sessionLog = civFS.diagnosticLogURL != failureLogURL
                    ? civFS.diagnosticLogURL.map { "\nSession log:\n" + $0.path } ?? "" : ""
                failureText = civFS.status + "\n\n" + location + sessionLog
                presentFailure()
            }
        }
        .onChange(of: artemisFS.phase) { _, phase in
            if phase == .checking {
                artemisFSAttachedRunPath = nil
            } else if phase == .held, let runPath = artemisFS.runPath,
                      artemisFSAttachedRunPath != runPath, model.canChangeHost,
                      !updater.blocksNewSession {
                artemisFSAttachedRunPath = runPath
                model.attachArtemisFSRun(runPath)
            } else if phase == .failed {
                failureLogURL = artemisFS.failureLogURL ?? artemisFS.diagnosticLogURL
                let location = failureLogURL.map { "Log saved at:\n" + $0.path }
                    ?? "A diagnostic log could not be created."
                let sessionLog = artemisFS.diagnosticLogURL != failureLogURL
                    ? artemisFS.diagnosticLogURL.map { "\nSession log:\n" + $0.path } ?? "" : ""
                failureText = artemisFS.status + "\n\n" + location + sessionLog
                presentFailure()
            }
        }
        .onChange(of: civSwitch.phase) { _, phase in
            if phase == .verified && showCivSwitchFirstTime && !showCivSwitchSetup {
                showCivSwitchFirstTime = false
                showCivSwitchSetup = true
            } else if (phase == .failed || phase == .cancelled) &&
                      showCivSwitchFirstTime && !showCivSwitchSetup {
                showCivSwitchFirstTime = false
                if phase == .failed {
                    failureLogURL = civSwitch.diagnosticLogURL
                    failureText = civSwitch.detail + (failureLogURL.map { "\n\nLog saved at:\n" + $0.path } ?? "")
                    presentFailure()
                }
            }
        }
    }

    private var lifecycleContent: some View {
        lifecyclePhaseContent
        .onChange(of: offlineEthernet.phase) { _, phase in
            if phase == "ready" { selectOfflineEthernetAddress() }
            if phase == "restored" { model.refreshNetworkAddressesIfIdle() }
        }
        .onChange(of: model.runMode) { _, _ in setupReady = false; developerReady = false }
        .onChange(of: model.selectedHost) { _, _ in
            setupReady = false; developerReady = false
            savedConfirmed = false; saveDirectModeReady = false; hostOnlyKeepRPC = false
        }
        .onChange(of: civSwitchConsoleAddress) { _, address in
            if civSwitchAddressValid {
                UserDefaults.standard.set(address.trimmingCharacters(in: .whitespacesAndNewlines),
                                          forKey: lastCivSwitchAddressKey)
            }
        }
        .onChange(of: showNS2JBSetup) { _, shown in
            if shown {
                showBootstrapSetup = false
                setupReady = false
                smilePowerConfirmed = false
                smileDirectModeConfirmed = false
            }
        }
        .onChange(of: showCivSwitchSetup) { _, shown in
            if shown {
                civSwitchReady = false
                civLoaderConfirmed = false
                showCivSwitchFirstTime = false
            }
        }
        .onChange(of: showSeedsowKaiHENSetup) { _, shown in
            if shown { seedsowHTTPConfirmed = false }
        }
        .onChange(of: civSwitch.triggerInstalled) { _, installed in
            if installed { showCivSwitchFirstTime = false }
        }
        .onChange(of: showDeveloperOptions) { _, shown in if shown { developerReady = false } }
    }

    private var sheetContent: some View {
        lifecycleContent
        .sheet(isPresented: $showNS2JBSetup) {
            if showBootstrapSetup { firstTimeSetup }
            else { ns2jbSetup }
        }
        .sheet(isPresented: $showCivSwitchSetup) { civSwitchSheet }
        .sheet(isPresented: $showSeedsowKaiHENSetup) { seedsowKaiHENSetup }
        .sheet(isPresented: $showOfflineEthernetSetup) { offlineEthernetSheet }
        .sheet(isPresented: $showBundledUpdates) { bundledUpdatesSheet }
    }

    private var dialogsContent: some View {
        sheetContent
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

    private var sessionFailureBanner: some View {
        panel {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("The session needs attention", systemImage: "exclamationmark.triangle")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.orange)
                    Spacer()
                    Button("Dismiss") { showFailure = false }
                    Button("Quit mac2jb") { quitMac2jb() }
                }
                Text(failureText)
                    .font(.system(size: 12))
                    .foregroundStyle(ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if let failureLogURL {
                    Button("Open logs") { NSWorkspace.shared.activateFileViewerSelecting([failureLogURL]) }
                }
            }
        }
    }

    private func presentFailure() {
        showFailure = true
        if !NSApp.isActive {
            NSApp.requestUserAttention(.informationalRequest)
        }
    }

    private func driverStatusBanner(_ message: String) -> some View {
        panel {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("USB driver", systemImage: "cable.connector")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(ink)
                    Spacer()
                    Button("Dismiss") { driverMessage = nil }
                }
                Text(message)
                    .font(.system(size: 12))
                    .foregroundStyle(ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
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
            connectionStatusRow
            kaiHENInstallerCard
        }
    }

    private var connectionStatusRow: some View {
        GeometryReader { area in
            let cardWidth = max(0, (area.size.width - 20) / 3)
            HStack(alignment: .center, spacing: 10) {
                compactStatusPanel(width: cardWidth) { networkPicker }
                compactStatusPanel(width: cardWidth) { driverStatusControl }
                compactStatusPanel(width: cardWidth) { updatesStatusControl }
            }
        }
        .frame(height: 76)
    }

    private var kaiHENInstallerCard: some View {
        panel {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    showKaiHENInstaller.toggle()
                } label: {
                    HStack {
                        Text("kaiHEN installer")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(ink)
                        Spacer()
                        Image(systemName: "chevron.down")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(teal)
                            .rotationEffect(.degrees(showKaiHENInstaller ? 180 : 0))
                            .animation(.easeInOut(duration: 0.24), value: showKaiHENInstaller)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(showKaiHENInstaller ? "Expanded" : "Collapsed")
                VStack(alignment: .leading, spacing: 10) {
                    Divider().overlay(.white.opacity(0.04))
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Civilization VII").font(.system(size: 16, weight: .semibold))
                        Text("Use the saved CivSwitch loader to run kaiHEN")
                            .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                        Button("Jailbreak with CivSwitch") { showCivSwitchSetup = true }
                            .buttonStyle(PrimaryActionStyle(large: true))
                            .disabled(configurationLocked || updater.blocksNewSession)
                    }
                    Divider().overlay(.white.opacity(0.04))
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Seedsow Lullaby").font(.system(size: 16, weight: .semibold))
                        Text("Use the Artemis loader’s HTTP mode to run kaiHEN")
                            .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                        Button("Jailbreak with Seedsow FS") { showSeedsowKaiHENSetup = true }
                            .buttonStyle(PrimaryActionStyle(large: true))
                            .disabled(configurationLocked || updater.blocksNewSession)
                    }
                    Divider().overlay(.white.opacity(0.04))
                    VStack(alignment: .leading, spacing: 10) {
                        Text("SmileBASIC 4").font(.system(size: 16, weight: .semibold))
                        Text("Use the saved Kurumuz bootstrap to run kaiHEN")
                            .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                        Button("Jailbreak with ns2jb") {
                            model.selectHost(.kurumuz)
                            showNS2JBSetup = true
                        }
                        .buttonStyle(PrimaryActionStyle(large: true))
                        .disabled(configurationLocked || updater.blocksNewSession)
                    }
                }
                .padding(.top, 10)
                .fixedSize(horizontal: false, vertical: true)
                .background {
                    GeometryReader { content in
                        Color.clear.preference(key: KaiHENContentHeightKey.self, value: content.size.height)
                    }
                }
                .modifier(AnimatedExpansionLayout(height: showKaiHENInstaller ? kaiHENContentHeight : 0))
                .opacity(showKaiHENInstaller ? 1 : 0)
                .animation(.easeInOut(duration: 0.24), value: showKaiHENInstaller ? kaiHENContentHeight : 0)
                .allowsHitTesting(showKaiHENInstaller)
                .accessibilityHidden(!showKaiHENInstaller)
                .onPreferenceChange(KaiHENContentHeightKey.self) { height in
                    if height.isFinite && height > 0 && abs(height - kaiHENContentHeight) > 0.5 {
                        kaiHENContentHeight = height
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
        .help(model.selectedHost.supportsDemo ? "Use the demo LOADV command." : "Choose Kurumuz or BermTheSequel to use the SmileBASIC demo.")
    }

    private var driverStatusControl: some View {
        VStack(alignment: .center, spacing: 8) {
            HStack(spacing: 6) {
                Label("USB driver", systemImage: "cable.connector")
                    .font(.system(size: 12, weight: .semibold))
                Text(model.driverLoaded ? "Ready" : "Optional")
                    .font(.system(size: 11))
                    .foregroundStyle(Mac2jbTheme.muted)
            }
            .help(model.driverLoaded ? "Ready for bootstrap writing" : "Only needed to write a bootstrap")
            Menu {
                Button("Refresh status") { model.refreshChecks() }
                Button(model.driverLoaded ? "Reinstall & load driver…" : "Install & load driver…") { loadDriver() }
            } label: {
                MintDropdownLabel(title: "Driver options", width: 132)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .disabled(driverSetupBlocked)
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private var bootstrapDriverControl: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.driverLoaded ? "USB driver ready" : "USB driver for first-time bootstrap writing")
                .font(.system(size: 12, weight: .semibold))
            if !model.driverLoaded {
                Text("Install this only if mac2jb needs to type a Civ VII or SmileBASIC bootstrap over USB.")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                Text(model.driverStatus).font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            }
            Button(model.driverLoaded ? "Refresh driver status" : "Install & load driver…") {
                if model.driverLoaded { model.refreshChecks() } else { loadDriver() }
            }
            .font(.system(size: 11)).disabled(driverSetupBlocked)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var networkPicker: some View {
        VStack(alignment: .center, spacing: 8) {
            Label("Mac connection", systemImage: "network")
                .font(.system(size: 12, weight: .semibold))
            HStack(spacing: 8) {
                Menu {
                    ForEach(model.addresses) { address in
                        Button(address.label) { model.selectedAddress = address.address }
                            .disabled(configurationLocked || offlineEthernet.active)
                    }
                    Divider()
                    Button("Offline Ethernet") { showOfflineEthernetSetup = true }
                } label: {
                    MintDropdownLabel(title: offlineEthernet.active ? "Offline Ethernet" :
                        model.addresses.first(where: { $0.address == model.selectedAddress })?.address ?? "Choose network")
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
                .help(offlineEthernet.active ? "Mac address: 192.168.2.2" :
                      model.addresses.first(where: { $0.address == model.selectedAddress })?.label ?? "Choose a Mac connection")
                circularRefreshButton("Refresh Mac connections", disabled: configurationLocked,
                                      refreshing: offlineEthernet.isRefreshingAdapters) {
                    model.refreshNetworkAddressesIfIdle()
                    offlineEthernet.refreshAdapters()
                }
            }
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private var updatesStatusControl: some View {
        VStack(alignment: .center, spacing: 8) {
            Label("Upstream updates", systemImage: "arrow.triangle.2.circlepath")
                .font(.system(size: 12, weight: .semibold))
            Button(bundledUpdates.isChecking ? "Checking…" : "Check for updates") {
                showBundledUpdates = true
                if !bundledUpdates.isChecking {
                    bundledUpdates.check(runtimeRoot: model.runtime?.root)
                    updater.check()
                }
            }
            .font(.system(size: 11))
            .disabled(model.runtime == nil)
        }
        .frame(maxWidth: .infinity, alignment: .center)
    }

    private func selectOfflineEthernetAddress() {
        model.refreshNetworkAddressesIfIdle()
        if model.addresses.contains(where: { $0.address == "192.168.2.2" }) {
            model.selectedAddress = "192.168.2.2"
        }
    }

    private var offlineEthernetSheet: some View {
        sheetFrame(title: "Offline Ethernet",
                   subtitle: "Connect the Switch directly to your Mac with an Ethernet cable.",
                   compact: true,
                   contentSpacing: 4,
                   close: { showOfflineEthernetSetup = false }) {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Mac Ethernet connection")
                        .font(.system(size: 12, weight: .semibold))
                    HStack(spacing: 8) {
                        Menu {
                            ForEach(offlineEthernet.adapters) { adapter in
                                Button("\(adapter.label) · \(adapter.interface)") {
                                    offlineEthernet.selectedInterface = adapter.interface
                                }
                            }
                        } label: {
                            MintDropdownLabel(title: offlineEthernet.adapters.first(where: { $0.interface == offlineEthernet.selectedInterface })
                                .map { "\($0.label) · \($0.interface)" } ?? "Choose Mac Ethernet connection",
                                width: 221)
                        }
                        .menuStyle(.button)
                        .menuIndicator(.hidden)
                        .buttonStyle(.plain)
                        .disabled(offlineEthernet.active || offlineEthernet.needsRestore)
                        circularRefreshButton("Refresh Ethernet adapters", disabled: offlineEthernet.active,
                                              refreshing: offlineEthernet.isRefreshingAdapters) {
                            offlineEthernet.refreshAdapters()
                        }
                    }
                }
                if !offlineEthernet.active, let issue = offlineEthernet.adapterIssue {
                    Text(issue).foregroundStyle(.orange)
                }
                HStack(spacing: 10) {
                    Button("Start offline Ethernet") { offlineEthernet.start() }
                        .disabled(!offlineEthernet.canStart || model.runtime == nil)
                    Button("Stop responder") { offlineEthernet.stop() }
                        .disabled(!offlineEthernet.canStop)
                    Button("Restore Mac Ethernet") { offlineEthernet.restore() }
                        .disabled(!offlineEthernet.canRestore)
                }
                Text(offlineEthernet.message)
                    .foregroundStyle(offlineEthernet.phase == "failed" ? .orange : ink)
                if !offlineEthernet.actionError.isEmpty {
                    Text(offlineEthernet.actionError).foregroundStyle(.orange)
                }
                if !offlineEthernet.logPath.isEmpty {
                    Button("Open Offline Ethernet log") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: offlineEthernet.logPath))
                    }
                }
                if offlineEthernet.active {
                    Text(offlineEthernet.switchSeen ? "Switch request received: \(offlineEthernet.lastSwitchRequest)" :
                         "Waiting for a connection test from 192.168.2.1")
                        .foregroundStyle(Mac2jbTheme.muted)
                }
                Divider()
                Text("On your Switch").font(.system(size: 12, weight: .semibold))
                Text("Set IP address to 192.168.2.1, subnet mask to 255.255.255.0, and gateway and both DNS fields to 192.168.2.2. Turn off proxy and IPv6, then run Test Connection.")
                    .foregroundStyle(Mac2jbTheme.muted)
                Text("mac2jb selects 192.168.2.2 for the jailbreak host when the responder is ready. Keep this app open during the session.")
                    .foregroundStyle(Mac2jbTheme.muted)
                Text("Stop ends the local DNS and HTTP service. Restore removes the temporary Mac address when you are done.")
                    .foregroundStyle(Mac2jbTheme.muted)
            }
            .font(.system(size: 11))
            .onAppear { offlineEthernet.open(runtimeRoot: model.runtime?.root) }
        }
    }

    private func beginRun(_ mode: SessionRunMode) {
        guard !startBlocked, mode == .bootstrapOnly || !model.selectedAddress.isEmpty else { return }
        model.selectRunMode(mode)
        showNS2JBSetup = false
        showBootstrapSetup = false
        model.start()
    }

    private var ns2jbSetup: some View {
        sheetFrame(title: "SmileBASIC 4",
                   subtitle: "Use the saved bootstrap to run kaiHEN.", compact: true,
                   close: { showNS2JBSetup = false }) {
            VStack(alignment: .leading, spacing: 12) {
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
                VStack(alignment: .leading, spacing: 7) {
                    demoEditionCheckbox
                    Toggle("USB power flows from the Switch to this Mac", isOn: $smilePowerConfirmed)
                        .toggleStyle(.checkbox).font(.system(size: 12, weight: .medium)).foregroundStyle(ink)
                        .disabled(configurationLocked)
                    Toggle("SmileBASIC Direct mode is open", isOn: $smileDirectModeConfirmed)
                        .toggleStyle(.checkbox).font(.system(size: 12, weight: .medium)).foregroundStyle(ink)
                        .disabled(configurationLocked)
                    Text("""
                        Restart your Switch and open SmileBASIC → Make a Program → Direct mode.
                        USB power: Switch → Mac. The Mac must not charge the Switch.
                        Connect both devices to the same local network. The Switch must use Ethernet.
                        """)
                        .font(.system(size: 12))
                        .foregroundStyle(Mac2jbTheme.muted)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !model.driverLoaded {
                    Text("Without the USB driver, enter the Direct mode commands manually.")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                }
                if model.selectedAddress.isEmpty {
                    note("Choose this Mac’s network connection on the main screen before starting the jailbreak.",
                         icon: "network", color: .orange)
                }
                if model.selectedHost == .kurumuz {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Keep an SD card inserted. mac2jb transfers kaiHEN files during the jailbreak and types the Direct mode commands.")
                            .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Jailbreak with ns2jb") {
                            kaiHEN.startNs2jb(macAddress: model.selectedAddress,
                                               runtimeRoot: model.runtime?.root,
                                               stageTimeoutMinutes: model.hostStageTimeoutMinutes,
                                               typing: KaiHENModel.TypingSettings(
                                                driverAvailable: model.driverLoaded,
                                                controller: model.controller,
                                                delayMs: model.keyDelayMs,
                                                enumerationTimeoutSeconds: model.enumerationTimeoutSeconds,
                                                loadWaitMs: model.loadWaitMs,
                                                runWaitMs: model.runWaitMs,
                                                removeWaitMs: model.removeWaitMs,
                                                loadConfirmWaitMs: model.loadConfirmWaitMs,
                                                keyHoldMs: model.keyHoldMs,
                                                enterSettleMs: model.enterSettleMs,
                                                pollInterval: model.pollInterval,
                                                demo: model.selectedEdition == .demo,
                                                preferredController: model.lastSuccessfulController))
                            if kaiHEN.phase != .idle { showNS2JBSetup = false }
                        }
                        .buttonStyle(PrimaryActionStyle())
                        .disabled(startBlocked || !smilePowerConfirmed || !smileDirectModeConfirmed ||
                                  !CivSwitchFSModel.validIPv4(model.selectedAddress))
                    }
                }
            }
        }
    }

    private var firstTimeSetup: some View {
        sheetFrame(title: "First-time setup", subtitle: "Save a small program once. After that, use ns2jb.", compact: true,
                   close: { showBootstrapSetup = false }, skip: {
                       guard model.canSkipBootstrapTyping, !updater.blocksNewSession else { return }
                       model.skipBootstrapTyping()
                       if model.phase == .awaitingSave { showNS2JBSetup = false }
                   }, skipDisabled: !model.canSkipBootstrapTyping || updater.blocksNewSession) {
            VStack(alignment: .leading, spacing: 18) {
                demoEditionCheckbox
                VStack(alignment: .leading, spacing: 6) {
                    Text("Already saved a compatible bootstrap?")
                        .font(.system(size: 12, weight: .semibold))
                    Text("9 arguments: pepsipu uses its own saved NS2 program.")
                    Text("5 arguments: Kurumuz uses NS2. BermTheSequel has an extra check, so use its own saved copy.")
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
                    bootstrapDriverControl
                }
                powerDirectionNotice
                Toggle("The empty editor is open and the USB cable is connected", isOn: $setupReady)
                    .toggleStyle(.checkbox).font(.system(size: 12))
                Button("Type the setup program") { beginRun(.bootstrapOnly) }
                    .buttonStyle(PrimaryActionStyle()).disabled(startBlocked || !setupReady)
            }
        }
    }

    private var civSwitchFirstTimeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("First-time setup")
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(ink)
            Text("Send the CivSwitch loader once. You can then install its saved boot trigger.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            Button("Open first-time setup") { showCivSwitchFirstTime = true }
                .buttonStyle(.bordered)
                .disabled(civSwitch.isRunning)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.08), lineWidth: 1))
    }

    private var civSwitchSheet: some View {
        Group {
            if showCivSwitchFirstTime { civSwitchFirstTimeSetup }
            else { civSwitchSetup }
        }
        .interactiveDismissDisabled(civSwitch.isRunning || civFS.isRunning || kaiHEN.isRunning || civKaiHEN.isRunning)
    }

    private var civSwitchAddressField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Switch IPv4 address").font(.system(size: 12, weight: .semibold))
            TextField("192.168.1.100", text: $civSwitchConsoleAddress)
                .textFieldStyle(.roundedBorder).font(.system(size: 13, design: .monospaced))
                .disabled(civSwitch.isRunning)
        }
    }

    private var civSwitchFirstTimeSetup: some View {
        sheetFrame(title: "First-time setup", subtitle: "Send the CivSwitch loader once. You can then install its saved boot trigger.",
                   compact: true,
                   close: { showCivSwitchFirstTime = false },
                   closeDisabled: civSwitch.isRunning) {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("1. Use a physical Switch 1 Civilization VII cartridge at version 1.0.0. Set System Language to English (US), then set Controllers & Accessories → USB Keyboard to English (US).")
                    Text("2. Open Multiplayer → Wireless → Create Game → Host Lobby → Chat. Switch the on-screen keyboard to English (QWERTY), not Pinyin or another IME. In docked mode, focus the chat input.")
                    Text("3. Connect the Switch to this Mac by USB and keep both devices on the same network. USB power must flow Switch → Mac. If the Mac charges the Switch, unplug at the Switch for a second, then reconnect it.")
                    Text("4. Enter the Switch IPv4 address below and confirm the chat screen is ready. The transfer can take 20–25 minutes.")
                    Text("5. When the loader opens, you can install its boot trigger. If installed, load the saved trigger from Civilization VII on later visits.")
                }
                .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
                civSwitchAddressField
                Toggle("The cartridge, English keyboard settings, and chat screen are ready", isOn: $civSwitchReady)
                    .toggleStyle(.checkbox).font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ink).disabled(civSwitch.isRunning)
                if !model.driverLoaded {
                    bootstrapDriverControl
                }
                HStack(spacing: 12) {
                    if civSwitch.canStart {
                        Button("Type CivSwitch payload") {
                            civSwitch.start(consoleAddress: civSwitchConsoleAddress.trimmingCharacters(in: .whitespacesAndNewlines),
                                            runtimeRoot: model.runtime?.root,
                                            controller: model.controller,
                                            enumerationTimeoutSeconds: model.enumerationTimeoutSeconds)
                            if civSwitch.phase == .typing { showCivSwitchSetup = false }
                        }
                        .buttonStyle(PrimaryActionStyle())
                        .disabled(!civSwitchReady || !civSwitchAddressValid || model.runtime == nil ||
                                  !model.driverLoaded || configurationLocked || updater.blocksNewSession)
                    }
                    if civSwitch.canRetryProbe {
                        Button("Check loader again") {
                            civSwitch.retryProbe()
                            if civSwitch.phase == .verifying { showCivSwitchSetup = false }
                        }
                            .disabled(model.runtime == nil || configurationLocked || updater.blocksNewSession)
                    }
                    if civSwitch.canInstallTrigger {
                        Button("Install CivSwitch boot trigger") { civSwitch.installTrigger() }
                            .buttonStyle(PrimaryActionStyle())
                            .disabled(model.runtime == nil || configurationLocked || updater.blocksNewSession)
                    }
                    if civSwitch.canReset {
                        Button("Restart full transfer") {
                            civSwitch.reset()
                            civSwitchReady = false
                        }
                    }
                    if civSwitch.canCancel {
                        Button("Stop CivSwitch") { civSwitch.cancel() }
                    }
                }
                if civSwitch.phase != .idle || !civSwitch.log.isEmpty { civSwitchActivity }
            }
        }
    }

    private var civSwitchActivity: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showCivSwitchFirstTime && civSwitch.isRunning {
                Text(civSwitch.status).font(.system(size: 13, weight: .semibold))
                if let progress = civSwitch.progress { ProgressView(value: progress).tint(teal) }
                else { ProgressView().progressViewStyle(.linear).tint(teal) }
            }
            Divider().overlay(.white.opacity(0.04))
            DisclosureGroup("Session details") {
                VStack(alignment: .leading, spacing: 8) {
                    Text(civSwitch.status).font(.system(size: 12, weight: .semibold))
                    if !civSwitch.detail.isEmpty {
                        Text(civSwitch.detail).font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
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
                .padding(.top, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.system(size: 11, weight: .medium))
        }
    }

    private var artemisFSChecking: some View {
        panel {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top, spacing: 16) {
                    Image(systemName: "network")
                        .font(.system(size: 29)).foregroundStyle(teal)
                        .frame(width: 52, height: 52)
                        .background(teal.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    VStack(alignment: .leading, spacing: 8) {
                        Text(artemisFS.phase == .held ? "Filesystem access ready" :
                             artemisFS.phase == .stopping ? "Stopping filesystem access" : "Jailbreaking…")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(ink)
                        Text(artemisFS.phase == .checking
                             ? "Jailbreak has four steps. Each can take several minutes. Please be patient and keep Seedsow Lullaby and mac2jb open."
                             : artemisFS.status)
                            .font(.system(size: 13)).foregroundStyle(Mac2jbTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                ProgressView(value: Double(artemisFS.progressStep), total: 4).tint(teal)
                if artemisFS.phase == .checking {
                    Text(artemisFS.status)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Mac2jbTheme.muted)
                        .monospacedDigit()
                }
                if artemisFS.isHeld, let runPath = artemisFS.runPath {
                    Button("Connect to held session") {
                        artemisFSAttachedRunPath = runPath
                        model.attachArtemisFSRun(runPath)
                    }
                    .disabled(!model.canChangeHost || updater.blocksNewSession)
                }
                DisclosureGroup("Session details") {
                    ScrollView {
                        Text(artemisFS.log.isEmpty ? "Activity will appear here." : artemisFS.log)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Mac2jbTheme.muted).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    }
                    .frame(height: 140)
                    .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10))
                }
                .font(.system(size: 11, weight: .medium))
                HStack {
                    Text("Keep Seedsow Lullaby and mac2jb open until the session finishes.")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    Spacer()
                    Button("Stop session", role: .destructive) { artemisFS.stop() }
                        .disabled(artemisFS.phase == .stopping)
                }
            }
        }
    }

    private var civSwitchFSSession: some View {
        panel {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top, spacing: 16) {
                    Image(systemName: "externaldrive.badge.person.crop")
                        .font(.system(size: 29))
                        .foregroundStyle(teal)
                        .frame(width: 52, height: 52)
                        .background(teal.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    VStack(alignment: .leading, spacing: 8) {
                        Text(civFS.phase == .held ? "Filesystem access ready" :
                             civFS.phase == .failed ? "Filesystem access needs attention" :
                             civFS.phase == .stopping ? "Stopping filesystem access" :
                             "Jailbreaking…")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(ink)
                        Text(civFS.isRunning
                             ? "Jailbreak has four steps. Each can take several minutes. Please be patient and keep Civilization VII and mac2jb open."
                             : civFS.status)
                            .font(.system(size: 13))
                            .foregroundStyle(Mac2jbTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if civFS.isRunning {
                    ProgressView(value: Double(civFS.progressStep), total: 4)
                        .tint(teal)
                    Text(civFS.status)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Mac2jbTheme.muted)
                        .monospacedDigit()
                }
                if civFS.isHeld, let runPath = civFS.runPath {
                    Button("Connect to held session") {
                        civFSAttachedRunPath = runPath
                        model.attachCivSwitchFSRun(runPath)
                    }
                        .buttonStyle(.bordered)
                        .disabled(!model.canChangeHost || updater.blocksNewSession)
                }
                DisclosureGroup("Session details") {
                    ScrollView {
                        Text(civFS.log.isEmpty ? "Activity will appear here." : civFS.log)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Mac2jbTheme.muted)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                    }
                    .frame(height: 140)
                    .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10))
                    if let logURL = civFS.failureLogURL ?? civFS.diagnosticLogURL {
                        Button("Open session log") { NSWorkspace.shared.open(logURL) }
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .font(.system(size: 11, weight: .medium))
                if civFS.isRunning {
                    HStack {
                        Text("Keep Civilization VII and mac2jb open until the session finishes.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                        Spacer()
                        Button(civFS.phase == .stopping ? "Stopping session…" : "Stop session", role: .destructive) {
                            civFS.stop()
                        }
                        .disabled(civFS.phase == .stopping || model.hasLiveWorkers)
                    }
                } else if civFS.phase == .failed {
                    HStack {
                        Spacer()
                        Button("Go back") { civFS.dismissFailure(); showFailure = false }
                    }
                }
            }
        }
    }

    private var kaiHENSession: some View {
        panel {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top, spacing: 16) {
                    Image(systemName: "square.stack.3d.up")
                        .font(.system(size: 29)).foregroundStyle(teal)
                        .frame(width: 52, height: 52)
                        .background(teal.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    VStack(alignment: .leading, spacing: 8) {
                        Text(kaiHEN.phase == .installed || kaiHEN.phase == .complete ? "kaiHEN ready" :
                             kaiHEN.phase == .failed ? "kaiHEN needs attention" :
                             kaiHEN.phase == .stopping ? "Stopping kaiHEN" : "Jailbreaking…")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(ink)
                        Text(kaiHEN.isRunning && kaiHEN.phase != .installed
                             ? "Jailbreak has four steps. Each can take several minutes. Please be patient and keep \(kaiHEN.launchPath == .ns2jb ? "SmileBASIC" : "Civilization VII") and mac2jb open."
                             : kaiHEN.status)
                            .font(.system(size: 13)).foregroundStyle(Mac2jbTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if kaiHEN.isRunning {
                    ProgressView(value: kaiHEN.progressStep, total: 4).tint(teal)
                }
                if kaiHEN.launchPath == .ns2jb && [.preparing, .running].contains(kaiHEN.phase) {
                    if !kaiHEN.typingStatus.isEmpty {
                        Text(kaiHEN.typingStatus)
                            .font(.system(size: 12))
                            .foregroundStyle(Mac2jbTheme.muted)
                    }
                    if let enumerationProgress = kaiHEN.enumerationProgress {
                        ProgressView(value: enumerationProgress)
                            .tint(teal)
                        if let remainingMs = kaiHEN.enumerationRemainingMs {
                            Text(String(format: "USB enumeration · %.1f seconds remaining", max(0, remainingMs) / 1000))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Mac2jbTheme.muted)
                        }
                    }
                    if let command = kaiHEN.startCommand {
                        DisclosureGroup("Show Direct mode commands") {
                            Text([model.selectedEdition.loadCommand(for: "NS2"), "RUN",
                                  "REMOVE NSR,&H60000000,&H3FFFFFFF", command]
                                .joined(separator: "\n"))
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(ink)
                                .textSelection(.enabled)
                        }
                        .font(.system(size: 11, weight: .medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Text("Waiting for the host to generate the START command")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                }
                Text(kaiHEN.status)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Mac2jbTheme.muted)
                    .monospacedDigit()
                DisclosureGroup("Session details") {
                    ScrollView {
                        Text(kaiHEN.log.isEmpty ? "Activity will appear here." : kaiHEN.log)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Mac2jbTheme.muted).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    }
                    .frame(height: 140)
                    .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10))
                    if let logURL = kaiHEN.diagnosticLogURL {
                        Button("Open session log") { NSWorkspace.shared.open(logURL) }
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .font(.system(size: 11, weight: .medium))
                HStack {
                    if kaiHEN.phase == .installed || kaiHEN.phase == .complete {
                        Text("Close \(kaiHEN.launchPath == .ns2jb ? "SmileBASIC" : "Civilization VII") normally. Hold R when opening a native game. If the game opens, close it and hold R on the next launch for hbmenu.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    } else if kaiHEN.isRunning {
                        Text("Keep \(kaiHEN.launchPath == .ns2jb ? "SmileBASIC" : "Civilization VII") and mac2jb open until this step finishes.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    Spacer()
                    if kaiHEN.isRunning {
                        Button(kaiHEN.phase == .stopping ? "Stopping session…" : "Stop session", role: .destructive) {
                            kaiHEN.stop()
                        }
                        .disabled(kaiHEN.phase == .stopping)
                    } else {
                        Button("Go back") { kaiHEN.dismiss() }
                    }
                }
            }
        }
    }

    private var seedsowKaiHENSession: some View {
        panel {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top, spacing: 16) {
                    Image(systemName: "square.stack.3d.up")
                        .font(.system(size: 29)).foregroundStyle(teal)
                        .frame(width: 52, height: 52)
                        .background(teal.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    VStack(alignment: .leading, spacing: 8) {
                        Text(seedsowKaiHEN.phase == .complete ? "kaiHEN ready" :
                             seedsowKaiHEN.phase == .failed ? "kaiHEN needs attention" :
                             seedsowKaiHEN.phase == .stopping ? "Stopping kaiHEN" : "Jailbreaking…")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(ink)
                        Text(seedsowKaiHEN.isRunning
                             ? "Jailbreak has four steps. Each can take several minutes. Please be patient and keep Seedsow Lullaby and mac2jb open."
                             : seedsowKaiHEN.status)
                            .font(.system(size: 13)).foregroundStyle(Mac2jbTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if seedsowKaiHEN.isRunning {
                    ProgressView(value: seedsowKaiHEN.progressStep, total: 4).tint(teal)
                }
                Text(seedsowKaiHEN.status)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Mac2jbTheme.muted)
                    .monospacedDigit()
                DisclosureGroup("Session details") {
                    ScrollView {
                        Text(seedsowKaiHEN.log.isEmpty ? "Activity will appear here." : seedsowKaiHEN.log)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Mac2jbTheme.muted)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                    }
                    .frame(height: 140)
                    .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10))
                    if let logURL = seedsowKaiHEN.diagnosticLogURL {
                        Button("Open session log") { NSWorkspace.shared.open(logURL) }
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .font(.system(size: 11, weight: .medium))
                HStack {
                    if seedsowKaiHEN.phase == .complete {
                        Text("Close Seedsow normally. Hold R when opening a native game; repeat if the first launch opens the game.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    Spacer()
                    if seedsowKaiHEN.isRunning {
                        Button(seedsowKaiHEN.phase == .stopping ? "Stopping session…" : "Stop session", role: .destructive) {
                            seedsowKaiHEN.stop()
                        }
                        .disabled(seedsowKaiHEN.phase == .stopping)
                    } else {
                        Button("Go back") { seedsowKaiHEN.dismiss() }
                    }
                }
            }
        }
    }

    private var civKaiHENSession: some View {
        panel {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top, spacing: 16) {
                    Image(systemName: "square.stack.3d.up")
                        .font(.system(size: 29)).foregroundStyle(teal)
                        .frame(width: 52, height: 52)
                        .background(teal.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    VStack(alignment: .leading, spacing: 8) {
                        Text(civKaiHEN.phase == .failed ? "kaiHEN needs attention" :
                             civKaiHEN.phase == .complete && civKaiHEN.operation == .install ? "kaiHEN trigger installed" :
                             civKaiHEN.phase == .complete ? "kaiHEN ready" :
                             civKaiHEN.operation == .runOnce ? "Jailbreaking…" : "Installing kaiHEN…")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(ink)
                        Text(civKaiHEN.isRunning && civKaiHEN.operation == .runOnce
                             ? "Jailbreak has four steps. Each can take several minutes. Please be patient and keep Civilization VII and mac2jb open."
                             : civKaiHEN.status)
                            .font(.system(size: 13)).foregroundStyle(Mac2jbTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if civKaiHEN.isRunning {
                    ProgressView(value: civKaiHEN.progressStep).tint(teal)
                    Text(civKaiHEN.status)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Mac2jbTheme.muted)
                        .monospacedDigit()
                }
                if civKaiHEN.phase == .complete {
                    if civKaiHEN.operation == .install {
                        Text("Close Civilization VII normally. On later boots, open it and choose Load Game to run kaiHEN from the saved trigger")
                            .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    } else {
                        Text("After kaiHEN loads, hold R when opening a native Switch 2 game. The first launch may save its policy; hold R again on the next launch for hbmenu")
                            .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                DisclosureGroup("Session details") {
                    ScrollView {
                        Text(civKaiHEN.log.isEmpty ? "Activity will appear here" : civKaiHEN.log)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Mac2jbTheme.muted)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                    }
                    .frame(height: 140)
                    .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 10))
                    if let logURL = civKaiHEN.diagnosticLogURL {
                        Button("Open session log") { NSWorkspace.shared.open(logURL) }
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .font(.system(size: 11, weight: .medium))
                HStack {
                    if civKaiHEN.isRunning {
                        Text("Keep Civilization VII and mac2jb open until this step finishes.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    Spacer()
                    if civKaiHEN.isRunning {
                        Button(civKaiHEN.phase == .stopping ? "Stopping…" : "Stop session", role: .destructive) {
                            civKaiHEN.stop()
                        }
                        .disabled(civKaiHEN.phase == .stopping)
                    } else {
                        Button("Go back") { civKaiHEN.dismiss() }
                    }
                }
            }
        }
    }

    private var civSwitchTransferSession: some View {
        panel {
            VStack(alignment: .leading, spacing: 22) {
                HStack(alignment: .top, spacing: 16) {
                    Image(systemName: "cable.connector")
                        .font(.system(size: 29))
                        .foregroundStyle(teal)
                        .frame(width: 52, height: 52)
                        .background(teal.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Your Mac is doing the typing")
                            .font(.system(size: 28, weight: .bold, design: .rounded))
                            .foregroundStyle(ink)
                        Text(civSwitch.detail)
                            .font(.system(size: 13))
                            .foregroundStyle(Mac2jbTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if let progress = civSwitch.progress {
                    ProgressView(value: progress).tint(teal)
                } else {
                    ProgressView().progressViewStyle(.linear).tint(teal)
                }
                Text(civSwitch.status)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Mac2jbTheme.muted)
                    .monospacedDigit()
                HStack {
                    Text("Keep Civilization VII and mac2jb open until the transfer finishes.")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    Spacer()
                    if civSwitch.canCancel {
                        Button("Stop session", role: .destructive) { civSwitch.cancel() }
                    }
                }
            }
        }
    }

    private var civSwitchKaiHENSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Keep an SD card inserted. mac2jb transfers the files during the jailbreak. Requires firmware 23.0.1 and a physical Civilization VII v1.0.0 cartridge.")
                .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Button("Jailbreak with CivSwitch") {
                kaiHEN.start(consoleAddress: civSwitchConsoleAddress.trimmingCharacters(in: .whitespacesAndNewlines),
                             runtimeRoot: model.runtime?.root)
                if kaiHEN.phase != .idle { showCivSwitchSetup = false }
            }
            .buttonStyle(PrimaryActionStyle())
            .disabled(!civLoaderConfirmed || !civSwitchAddressValid || model.runtime == nil || configurationLocked || updater.blocksNewSession)
            Button("Semi-untethered · experimental") {
                civKaiHEN.startInstall(
                    consoleAddress: civSwitchConsoleAddress.trimmingCharacters(in: .whitespacesAndNewlines),
                    runtimeRoot: model.runtime?.root)
                if civKaiHEN.phase != .idle { showCivSwitchSetup = false }
            }
            .buttonStyle(.bordered)
            .disabled(!civLoaderConfirmed || !civSwitchAddressValid || model.runtime == nil ||
                      configurationLocked || updater.blocksNewSession)
        }
    }

    private var civSwitchSetup: some View {
        sheetFrame(title: "Civilization VII", subtitle: "Run kaiHEN through the CivSwitch loader.",
                   compact: true,
                   close: { showCivSwitchSetup = false },
                   closeDisabled: civSwitch.isRunning || kaiHEN.isRunning || civKaiHEN.isRunning) {
            VStack(alignment: .leading, spacing: 20) {
                civSwitchFirstTimeSection
                VStack(alignment: .leading, spacing: 8) {
                    Text("Open the CivSwitch loader").font(.system(size: 15, weight: .semibold)).foregroundStyle(ink)
                    Text("Open Civilization VII and choose Load Game. Leave the Remote JS Loader open.")
                    Text("Keep the Switch and Mac on the same network, then connect using the Switch IPv4 address below.")
                }
                .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                civSwitchAddressField
                Toggle("Load Game opened the CivSwitch JS loader", isOn: $civLoaderConfirmed)
                    .toggleStyle(.checkbox)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ink)
                    .disabled(configurationLocked)
                if civSwitch.canInstallTrigger && !civSwitch.triggerInstalled {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("First-time transfer complete")
                            .font(.system(size: 14, weight: .semibold))
                        Button("Install persistent CivSwitch boot trigger") { civSwitch.installTrigger() }
                            .buttonStyle(PrimaryActionStyle())
                            .disabled(model.runtime == nil || configurationLocked || updater.blocksNewSession)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                civSwitchKaiHENSection
                if civSwitch.phase != .idle || !civSwitch.log.isEmpty {
                    civSwitchActivity
                }
            }
        }
    }

    private var seedsowKaiHENSetup: some View {
        sheetFrame(title: "Seedsow Lullaby", subtitle: "Run kaiHEN through the Artemis loader.",
                   compact: true,
                   close: { showSeedsowKaiHENSetup = false },
                   closeDisabled: seedsowKaiHEN.isRunning || seedsowSemiUntethered.isRunning) {
            VStack(alignment: .leading, spacing: 14) {
                Text("Load the Artemis launcher save in Seedsow Lullaby, then press Y to open HTTP mode. Keep the game open and the Switch and Mac on the same network.")
                    .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                civSwitchAddressField
                Toggle("Artemis loader HTTP mode is open after pressing Y", isOn: $seedsowHTTPConfirmed)
                    .toggleStyle(.checkbox)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(ink)
                    .disabled(configurationLocked)
                Button("Jailbreak with Seedsow FS") {
                    seedsowKaiHEN.start(consoleAddress: civSwitchConsoleAddress.trimmingCharacters(in: .whitespacesAndNewlines),
                                         runtimeRoot: model.runtime?.root)
                    if seedsowKaiHEN.phase != .idle { showSeedsowKaiHENSetup = false }
                }
                .buttonStyle(PrimaryActionStyle())
                .disabled(!seedsowHTTPConfirmed || !civSwitchAddressValid || model.runtime == nil || configurationLocked || updater.blocksNewSession)
                SeedsowSemiUntetheredView(
                    model: seedsowSemiUntethered,
                    runtimeRoot: model.runtime?.root,
                    canStart: seedsowHTTPConfirmed && !configurationLocked && !updater.blocksNewSession,
                    address: $civSwitchConsoleAddress)
            }
        }
        .interactiveDismissDisabled(seedsowKaiHEN.isRunning || seedsowSemiUntethered.isRunning)
    }

    private var developerOptions: some View {
        VStack(alignment: .leading, spacing: 22) {
            panel { usbTimingSettings }
            panel {
                VStack(alignment: .leading, spacing: 12) {
                    Text("ns2jb host").font(.system(size: 15, weight: .semibold))
                    HStack(spacing: 8) {
                        Text("Host").font(.system(size: 11, weight: .medium))
                        Menu {
                            ForEach(HostProfile.availableHosts) { host in
                                Button(host.label) { model.selectHost(host) }
                            }
                        } label: {
                            MintDropdownLabel(title: model.selectedHost.label)
                        }
                        .menuStyle(.button).menuIndicator(.hidden)
                        .buttonStyle(.plain)
                        .disabled(!model.canChangeHost || updater.blocksNewSession)
                    }
                    Text("After changing hosts, type and save the selected host’s bootstrap before running ns2jb.")
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    if !model.selectedHost.supportsHeldRPC {
                        Text("pepsipu closes RPC after verification. Choose Kurumuz or BermTheSequel for held RPC.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    if !model.selectedHost.supportsDemo {
                        Text("This host’s bundled version supports the full edition of SmileBASIC.")
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    Toggle("The Switch is ready on the command screen", isOn: $developerReady)
                        .toggleStyle(.checkbox).font(.system(size: 12))
                    Divider()
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
                        developerHeldRPCSection.id("hostonly-tools")
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
                        commandToggle(.load, title: "LOAD \"TXT:NS2\"")
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
            panel { keyboardControls }.id("keyboard-controls")
            panel {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Diagnostics").font(.system(size: 15, weight: .semibold))
                    Text(AppBuildIdentity.versionLabel).font(.system(size: 11, design: .monospaced)).foregroundStyle(Mac2jbTheme.muted)
                    if let sessionID = model.lastStoredSessionID {
                        Text("Last session ID: \(sessionID)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Mac2jbTheme.muted)
                            .textSelection(.enabled)
                    }
                    HStack(spacing: 10) {
                        Button("Open stored logs") { model.revealStoredLogs() }
                        Button("Open sessions") { model.revealStoredSessions() }
                    }
                    .disabled(model.lastStoredSessionID == nil)
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

    private var existingRPCControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("RPC already held").font(.system(size: 15, weight: .semibold))
            Text("Find an open ns2jb or CivSwitch filesystem session on this Mac, or choose its run folder. Keep the original host and console game open.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            TextField("Existing session or run folder", text: $model.existingRPCRunPath)
                .textFieldStyle(.roundedBorder).font(.system(size: 11))
                .disabled(!model.canChangeHost)
            HStack(spacing: 12) {
                Button("Find open RPC") { model.findOpenRPC() }
                    .disabled(!model.canFindOpenRPC || updater.blocksNewSession)
                Button("Choose session folder…") { chooseExistingRPCRun() }
                    .disabled(!model.canChangeHost)
                Spacer()
                Button("Connect to open RPC") { model.attachExistingRPC() }
                    .disabled(!model.canAttachExistingRPC || updater.blocksNewSession)
            }.font(.system(size: 11))
            if model.rpcDiscoveryRunning {
                ProgressView().controlSize(.small)
            }
            if model.rpcDiscoveredSessions.count > 1 {
                HStack(spacing: 12) {
                    Menu {
                        ForEach(model.rpcDiscoveredSessions) { candidate in
                            Button(candidate.description) {
                                model.selectedDiscoveredRPCPath = candidate.path
                            }
                        }
                    } label: {
                        MintDropdownLabel(title: model.rpcDiscoveredSessions.first(where: {
                            $0.path == model.selectedDiscoveredRPCPath
                        })?.description ?? "Verified session")
                    }
                    .menuStyle(.button).menuIndicator(.hidden)
                    .buttonStyle(.plain)
                    .frame(maxWidth: 420, alignment: .leading)
                    Button("Connect selected session") { model.connectDiscoveredRPC() }
                        .disabled(!model.canChangeHost || updater.blocksNewSession)
                }.font(.system(size: 11))
            }
            if !model.rpcDiscoveryMessage.isEmpty {
                Text(model.rpcDiscoveryMessage).font(.system(size: 11))
                    .foregroundStyle(Mac2jbTheme.muted).fixedSize(horizontal: false, vertical: true)
            }
            Text("After connecting, open developer options for SaveKit or OunceCake. Disconnect stops this app’s workers and leaves the original host running.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
        }
    }

    private func chooseExistingRPCRun() {
        guard model.canChangeHost else { return }
        let picker = NSOpenPanel()
        picker.title = "Choose the existing RPC session"
        picker.message = "Select the session folder in Application Support/mac2jb/Sessions, or its switch2 run folder."
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
            Text("Host timeouts").font(.system(size: 15, weight: .semibold))
            timingField("Maximum wait per stage", units: "min", value: $model.hostStageTimeoutMinutes, range: 1...60)
            Text("Applies to each jailbreak host stage, including FS acquisition.")
                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            Divider()
            Text("USB & timing").font(.system(size: 15, weight: .semibold))
            HStack(spacing: 8) {
                Text("Controller").font(.system(size: 11, weight: .medium))
                Menu {
                    Button("Automatic") { model.controller = "auto" }
                    ForEach(0..<16) { index in
                        Button("usb-drd\(index)") { model.controller = "usb-drd\(index)" }
                    }
                } label: {
                    MintDropdownLabel(title: model.controller == "auto" ? "Automatic" : model.controller)
                }
                .menuStyle(.button).menuIndicator(.hidden)
                .buttonStyle(.plain)
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
            Text("Stock: 10 ms release gap · no added hold or Enter wait · polling interval 10 · 4 s connection · 1 s after LOAD.")
                .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
            if !timingSettingsValid { Text("Enter values within the ranges shown before starting.").font(.system(size: 11)).foregroundStyle(.orange) }
        }.disabled(configurationLocked)
    }

    private func sheetFrame<Content: View>(title: String, subtitle: String, compact: Bool = false,
                                         contentSpacing: CGFloat = 24, close: @escaping () -> Void,
                                         closeDisabled: Bool = false,
                                         skip: (() -> Void)? = nil, skipDisabled: Bool = false,
                                         @ViewBuilder content: () -> Content) -> some View {
        let contents = VStack(alignment: .leading, spacing: contentSpacing) {
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
                    Button("Go back", action: close)
                        .disabled(closeDisabled || model.keyboardActive || model.phase == .keyboardConnecting)
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
                if model.phase == .verified || model.phase == .commandsSent || model.phase == .rpcDetached {
                    if model.phase == .verified {
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
                if model.postRun.heldConfirmed && model.phase == .rpcHeld {
                    sdCardFilesSection
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

    private var sdCardFilesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("SD card files").font(.system(size: 15, weight: .semibold))
            Text("Browse or download files from the Switch SD card over this held RPC session.")
                .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
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
            Text(model.sdMessage).font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
    }

    private var postRunControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            if model.postRun.heldConfirmed {
                Label(model.isAttachedFilesystemFS ? "Switch connection verified · 4/4" :
                      model.isAttachedRPCSession ? "Existing RPC connection verified" : "Switch connection verified · 4/4",
                      systemImage: "checkmark.shield.fill")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(teal)
            }
            Text(model.savekitSessionBlocked || model.savekitReturnBlocked
                 ? "Held RPC remains open. Finish this session before another save or app action. Keep the backup and log."
                 : model.postRun.cleanupBlocked
                 ? "Restart your Switch, then use Stop session. Cleanup could not be confirmed."
                 : model.phase == .dumpingFirmware
                    ? "Keep the active game open until the dump finishes. Stopping early may leave a partial dump."
                    : model.isAttachedFilesystemFS ? "When you’re done, disconnect here. Keep \(model.attachedFilesystemGameName) open until the filesystem host stops."
                      : model.isAttachedRPCSession ? "When you’re done, disconnect here. The original host keeps its RPC session open."
                      : "When you’re done, finish the session before closing SmileBASIC.")
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
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(updater.message)
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(ink)
                Spacer(minLength: 8)
                if !updater.requiredUpdate && updater.state == .current {
                    Button("Dismiss") { updater.dismiss() }
                        .font(.system(size: 11)).buttonStyle(.plain)
                }
            }
            if updater.requiredUpdate {
                Text("Update mac2jb before starting a new session. You can finish the current session first.")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
            }
            if updater.state == .downloading { ProgressView(value: updater.progress).tint(teal) }
            if updater.state == .available || updater.state == .ready || updater.state == .failed ||
                updater.candidate?.releaseURL != nil {
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
                        if updater.diagnosticURL != nil {
                            Button("Open update log") { updater.revealLog() }
                        }
                    }
                    Spacer(minLength: 0)
                    if !updater.requiredUpdate && updater.state == .failed {
                        Button("Dismiss") { updater.dismiss() }.buttonStyle(.plain)
                    }
                }.font(.system(size: 11))
            }
            if updater.state == .failed, let log = updater.diagnosticURL {
                Text(log.path)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(Mac2jbTheme.muted)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(teal.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }

    private var bundledUpdatesSheet: some View {
        sheetFrame(title: "Upstream updates", subtitle: "Bundled sources and available upstream versions.",
                   compact: bundledUpdates.results.count < 5,
                   close: { showBundledUpdates = false }) {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    Button("Check again") {
                        bundledUpdates.check(runtimeRoot: model.runtime?.root)
                        updater.check()
                    }
                    .disabled(bundledUpdates.isChecking || model.runtime == nil)
                    .help("Bundled source responses are reused for 30 minutes to stay within public API limits")
                    if bundledUpdates.isChecking { ProgressView().controlSize(.small) }
                    Text(bundledUpdates.message)
                        .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                }
                if bundledUpdates.results.isEmpty && !bundledUpdates.isChecking {
                    Text("No results yet")
                        .font(.system(size: 12)).foregroundStyle(Mac2jbTheme.muted)
                }
                ForEach(bundledUpdates.results) { result in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(result.name).font(.system(size: 12, weight: .semibold))
                            Spacer(minLength: 8)
                            if let url = result.sourceURL {
                                Link("Source ↗", destination: url).font(.system(size: 11))
                            }
                        }
                        Text("Bundled: \(result.pinned)   Upstream: \(result.latest)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Mac2jbTheme.muted)
                        Text(result.statusText)
                            .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if result.id != bundledUpdates.results.last?.id {
                        Divider().overlay(.white.opacity(0.04))
                    }
                }
            }
        }
    }

    private var developerHeldRPCSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            saveKitRow
            Divider()
            ounceCakeRow
            Divider()
            modloaderRow
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
    }

    private var saveKitRow: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "tray.and.arrow.down.fill")
                .font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
            VStack(alignment: .leading, spacing: 8) {
                Text("SaveKit").font(.system(size: 13, weight: .semibold)).foregroundStyle(ink)
                Text("Back up and restore saves after 4/4 verification with RPC held.")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Start SaveKit") { model.startSaveKit() }
                    .disabled(!model.canStartSaveKit)
                if model.savekitChoiceStarted && !model.savekitChoiceFinished && model.phase == .rpcHeld {
                    SaveKitToolsView(model: model, experimentalTools: true)
                    SaveKitResearchView(runtimeRoot: model.runtime?.root)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var ounceCakeRow: some View {
        let civFTP = model.isAttachedCivSwitchFS
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: "externaldrive.fill")
                .font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
            VStack(alignment: .leading, spacing: 8) {
                Text("OunceCake").font(.system(size: 13, weight: .semibold)).foregroundStyle(ink)
                Text("Browse a selected game’s files")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                TextField("Switch IPv4 address", text: $model.ounceCakeConsoleAddress)
                    .textFieldStyle(.roundedBorder).frame(maxWidth: 240)
                    .font(.system(size: 11)).disabled(!model.canLaunchHomebrew)
                HStack(spacing: 8) {
                    if civFTP {
                        Button("FTP on Switch") { model.launchOunceCake(ftp: true) }
                    } else {
                        Button("WebDAV") { model.launchOunceCake(ftp: false) }
                        Button("FTP on this Mac") { model.launchOunceCake(ftp: true) }
                    }
                }
                .font(.system(size: 11, weight: .medium))
                .disabled(!model.canLaunchOunceCake)
                if model.ounceCakeSession.stage == .choosing {
                    HStack(spacing: 8) {
                        Text("Game").font(.system(size: 11, weight: .medium))
                        Menu {
                            ForEach(model.ounceCakeSession.games) { game in
                                Button(game.name) { model.selectedOunceCakeGame = game.titleId }
                            }
                        } label: {
                            MintDropdownLabel(title: model.ounceCakeSession.games.first(where: {
                                $0.titleId == model.selectedOunceCakeGame
                            })?.name ?? "Choose game")
                        }
                        .menuStyle(.button).menuIndicator(.hidden)
                        .buttonStyle(.plain)
                    }.frame(maxWidth: 420, alignment: .leading)
                    Button("Open selected game") { model.startOunceCakeShare() }
                        .disabled(!model.canSelectOunceCakeGame)
                }
                if model.ounceCakeSession.stage == .serving,
                   let endpoint = model.ounceCakeSession.endpoint {
                    HStack(spacing: 8) {
                        Text("\(endpoint.service == .civFTP ? "FTP on Switch" : "WebDAV") \(endpoint.address)")
                            .textSelection(.enabled)
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
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var modloaderRow: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "puzzlepiece.extension.fill")
                .font(.system(size: 22)).foregroundStyle(teal).frame(width: 32)
            VStack(alignment: .leading, spacing: 8) {
                Text("ns2jb-modloader").font(.system(size: 13, weight: .semibold)).foregroundStyle(ink)
                Text("Install modloader to run compatible mods already on your Switch SD card.")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Button(model.modloaderInstallReady ? "Ready" : "Install modloader") {
                    model.installModloader()
                }
                .disabled(!model.canLaunchModloader)
                Text("If you would like to add more mods to your SD card:")
                    .font(.system(size: 11)).foregroundStyle(Mac2jbTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Write mods to SD card, then install…") { chooseModloaderFolder() }
                    .disabled(!model.canLaunchModloader)
                if model.homebrewApp == .modloader && !model.homebrewMessage.isEmpty {
                    Text(model.modloaderInstallReady ? "Installed for this boot" : model.homebrewMessage)
                        .font(.system(size: 10))
                        .foregroundStyle(model.modloaderInstallReady ? teal : Mac2jbTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                } else if model.isAttachedArtemisFS {
                    Text("Modloader is not verified with the Artemis HTTP host")
                        .font(.system(size: 10)).foregroundStyle(Mac2jbTheme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func chooseModloaderFolder() {
        let picker = NSOpenPanel()
        picker.title = "Choose a mods folder"
        picker.message = "Select a folder containing contents and/or exefs_patches. Matching files on the SD card will be updated."
        picker.canChooseDirectories = true
        picker.canChooseFiles = false
        picker.allowsMultipleSelection = false
        picker.begin { response in
            if response == .OK, let folder = picker.url { model.installModloader(modsFolder: folder) }
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
                if civFirstTimeTransferActive {
                    civSwitchTransferConsole
                } else if canConfigure && civFS.isRunning {
                    civSwitchFSConsole
                } else {
                    console
                    Divider().overlay(.white.opacity(0.04))
                    developerOptions
                }
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

    private var civSwitchFSConsole: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Console").font(.system(size: 12, weight: .semibold)).foregroundStyle(ink)
            ScrollView {
                Text(civFS.log.isEmpty ? "Waiting for filesystem host activity" : civFS.log)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Mac2jbTheme.muted)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(height: 180)
            .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 12))
            if let logURL = civFS.diagnosticLogURL {
                Button("Open CivSwitch log") { NSWorkspace.shared.open(logURL) }
                    .font(.system(size: 11))
            }
        }
    }

    private var civSwitchTransferConsole: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Console").font(.system(size: 12, weight: .semibold)).foregroundStyle(ink)
            ScrollView {
                Text(civSwitch.log.isEmpty ? "Waiting for CivSwitch transfer activity" : civSwitch.log)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Mac2jbTheme.muted)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .frame(height: 180)
            .background(.black.opacity(0.2), in: RoundedRectangle(cornerRadius: 12))
            if let logURL = civSwitch.diagnosticLogURL {
                Button("Open CivSwitch log") { NSWorkspace.shared.open(logURL) }
                    .font(.system(size: 11))
            }
        }
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
            Text(units).font(.system(size: 10)).lineLimit(1)
                .frame(width: 60, alignment: .leading)
            Text("\(range.lowerBound)–\(range.upperBound)")
                .font(.system(size: 9, design: .monospaced)).foregroundStyle(Mac2jbTheme.muted)
                .frame(width: 80, alignment: .trailing)
        }
    }
    private func panel<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content().modifier(GlassPanel())
    }
    private func compactStatusPanel<Content: View>(width: CGFloat, @ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, 14)
            .frame(width: width, height: 76, alignment: .center)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(.white.opacity(0.10), lineWidth: 1))
            .shadow(color: .black.opacity(0.12), radius: 18, y: 8)
    }
    private func circularRefreshButton(_ label: String, disabled: Bool, refreshing: Bool,
                                       action: @escaping () -> Void) -> some View {
        Button(action: action) {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0,
                                    paused: !refreshing || reduceMotion)) { context in
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(teal)
                    .rotationEffect(.degrees(refreshing && !reduceMotion
                        ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.8) * 450
                        : 0))
                    .frame(width: 30, height: 30)
                    .background(teal.opacity(0.10), in: Circle())
                    .overlay(Circle().stroke(.white.opacity(0.10), lineWidth: 1))
            }
        }
        .buttonStyle(.plain)
        .disabled(disabled || refreshing)
        .opacity(disabled ? 0.45 : 1)
        .help(label)
        .accessibilityLabel(label)
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
