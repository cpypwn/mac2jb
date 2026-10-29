import AppKit
import Combine
import Darwin
import Foundation

struct IZlauncherModule: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let version: String
    let description: String
}

enum HomebrewAppID: Equatable {
    case mintBrew, izlauncher, custom

    var title: String {
        switch self {
        case .mintBrew: return "MintBrew"
        case .izlauncher: return "IZlauncher"
        case .custom: return "Custom homebrew"
        }
    }
}

struct IZlauncherPanelAddress {
    static func parse(_ raw: String) -> URL? {
        guard raw.utf8.count < 200, let parts = URLComponents(string: raw),
              parts.scheme == "http", parts.host == "127.0.0.1",
              parts.user == nil, parts.password == nil,
              let port = parts.port, (1024...65535).contains(port),
              parts.path == "/", parts.query == nil,
              let fragment = parts.fragment, fragment.utf8.count == 48,
              fragment.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              let url = parts.url, url.absoluteString == raw else { return nil }
        return url
    }
}

private struct GUIEvent: Decodable {
    let type: String
    let action: String?
    let customHomebrewKind: String?
    let adapter: String?
    let message: String?
    let kind: String?
    let path: String?
    let url: String?
    let rpcCommand: String?
    let startCommand: String?
    let completed: Double?
    let sent: Double?
    let total: Double?
    let partial: Bool?
    let step: Int?
    let line: Int?
    let label: String?
    let remainingMs: Double?
    let durationMs: Double?
    let watchProgress: StremioWatchProgress?
    let games: [OunceCakeGame]?
    let modules: [IZlauncherModule]?
    let host: String?
    let port: Int?
    let ftpURL: String?
    let cleanupBlocked: Bool?
    let retrySafe: Bool?
    let startPending: Bool?
    let controller: String?
    let mode: String?
    let stage: String?
    let sourceSession: String?
}

@MainActor final class SessionModel: ObservableObject {
    @Published var phase: SessionPhase = .preparing
    @Published private(set) var workflowProgress = WorkflowProgress()
    @Published var status = "Preparing the bundled tools"
    @Published var detail = "No system tools or downloads are needed."
    @Published var log = ""
    @Published private(set) var hostLog = ""
    @Published private(set) var usbLog = ""
    @Published private(set) var pipelineLog = "Waiting for pipeline.json"
    @Published private(set) var acquisitionLog = "Waiting for acquisition.log"
    @Published var progress: Double?
    @Published var progressLabel = ""
    @Published private(set) var bootstrapElapsedSeconds: Double = 0
    @Published private(set) var bootstrapEstimatedRemainingSeconds: Double?
    @Published private(set) var bootstrapSaveCommandSent = false
    @Published var isEnumerating = false
    @Published var addresses: [NetworkAddress] = []
    @Published var selectedAddress = ""
    @Published private(set) var activeAddress = ""
    @Published private(set) var networkNotice: String?
    @Published var controller = "auto"
    @Published private(set) var lastSuccessfulController: String?
    @Published private(set) var runMode: SessionRunMode = .heldRPC
    @Published private(set) var activeRunMode: SessionRunMode = .heldRPC
    @Published private(set) var selectedHost: HostProfile = .kurumuz
    @Published private(set) var activeHost: HostProfile = .kurumuz
    @Published var existingRPCRunPath = ""
    private var attachedRunDirectory: URL?
    @Published private(set) var activeEdition: SmileBASICEdition = .full
    @Published var selectedEdition: SmileBASICEdition = .full
    var fullInstall: Bool { runMode == .bootstrapOnly }
    @Published var keyDelayMs = 10
    @Published var enumerationTimeoutSeconds = 4
    @Published var loadWaitMs = 1000
    @Published var runWaitMs = 0
    @Published var removeWaitMs = 0
    @Published var loadConfirmWaitMs = 0
    var effectiveLoadConfirmWaitMs: Int { activeEdition.requiresLoadConfirmation ? loadConfirmWaitMs : 0 }
    @Published var driverStatus = "Checking the USB gadget driver…"
    @Published var driverInstalled = false
    @Published var driverLoaded = false
    @Published var driverSetupRunning = false
    @Published var error: String?
    @Published private(set) var diagnosticLogURL: URL?
    @Published private(set) var postRun = PostRunSessionState()
    @Published private(set) var rpcCommand = ""
    @Published private(set) var hostStartCommand = ""
    @Published private(set) var hostIsExploiting = false
    @Published private(set) var activeCommandSelection: PostBootstrapCommandSelection?
    var activeCommandCount: Int { activeCommandSelection?.commands.count ?? 4 }
    @Published private(set) var rpcStatus = ""
    @Published private(set) var dumpFolder: URL?
    @Published private(set) var homebrewMessage = ""
    @Published private(set) var homebrewFolder: URL?
    @Published private(set) var homebrewApp: HomebrewAppID = .mintBrew
    var homebrewTitle: String { homebrewApp.title }
    @Published private(set) var izlauncherPanelURL: URL?
    @Published private(set) var izlauncherPanelMessage = ""
    @Published private(set) var izlauncherPanelChecking = false
    @Published private(set) var pendingHomebrewAction: String?
    private var pendingCustomConsoleAddress: String?
    @Published private(set) var izlauncherModules: [IZlauncherModule] = []
    @Published private(set) var izlauncherCatalogLoaded = false
    @Published private(set) var selectedIZlauncherModuleIDs = Set<String>()
    @Published private(set) var izlauncherModuleMessage = "Hold RPC to list compatible modules."
    @Published var stremioAddonURL = ""
    @Published var stremioQuality: StremioQuality = .saved() {
        didSet { UserDefaults.standard.set(stremioQuality.rawValue, forKey: StremioQuality.preferenceKey) }
    }
    @Published private(set) var keyboardStatus = "Connect the Switch to use this Mac keyboard."
    @Published var keyboardText = ""
    @Published private(set) var keyboardTextSending = false
    @Published private(set) var keyboardTextSent = 0
    @Published private(set) var keyboardTextTotal = 0
    @Published private(set) var keyboardTextStatus = ""
    @Published var ounceCakeConsoleAddress = ""
    @Published var selectedOunceCakeGame = ""
    @Published private(set) var ounceCakeSession = OunceCakeSession()
    var accountProgressHandler: ((StremioWatchProgress) -> Void)?
    var mintBrewAccountProvider: (() -> (addonURLs: [String], libraryItems: [[String: Any]]))?
    var stremioToolsAvailable: Bool {
        FileManager.default.isExecutableFile(atPath: "/Applications/Stremio.app/Contents/MacOS/ffmpeg") &&
        FileManager.default.isExecutableFile(atPath: "/Applications/Stremio.app/Contents/MacOS/ffprobe")
    }
    private(set) var runtime: BundledRuntime?
    @Published private var hostProcess: Process?
    private var hostInput: Pipe?
    private var keyboardInput: Pipe?
    private var hidPurpose = ""
    private var hidCompletionReceived = false
    private var saveTypingStarted = false
    private var saveCommandStarted = false
    private var saveCommandCompleted = false
    private var keyboardStopRequested = false
    private var pendingKeyboardText: String?
    private var keyboardTextStarted = false
    private var startPrefixCompleted = false
    private var keyboardHandoffPending = false
    private var completingStartWithKeyboard = false
    private var hostOnlyKeyboardRunning = false
    private var hostOnlyKeyboardReady = false
    private var hostOnlyKeyboardUsed = false
    private var currentUSBStepHasProof = false
    @Published private var safeBootstrapRetryAfterUSBFailure = false
    @Published private var hidProcess: Process?
    private var preparing = false
    private var hostCompleted = false
    private var generation = UUID()
    private var runFolder: URL?
    private var sessionLog: FileHandle?
    private var hostSessionLog: FileHandle?
    private var usbSessionLog: FileHandle?
    private var sessionActivity: NSObjectProtocol?
    private var hostStageLabel = "Waiting for the Switch to connect over the local network"
    private var hostStageProgress: Double?
    private var bootstrapStartedAt: Date?
    private var bootstrapFinishAt: Date?
    private var bootstrapTimer: Timer?
    private var hasEnumeratedSuccessfully = false
    private let addressProvider: () -> [NetworkAddress]
    private var networkRefreshTimer: Timer?
    private var exploitLogRefreshDate = Date.distantPast
    private var hostReadyReceived = false
    private var hasHIDEvidence = false
    private var preflightNetworkFailureHandled = false

    init(addressProvider: @escaping () -> [NetworkAddress] = { NetworkSelection.localAddresses() }, runtime: BundledRuntime? = nil, edition: SmileBASICEdition? = nil) {
        self.addressProvider = addressProvider
        self.runtime = runtime
        selectedHost = runtime?.host ?? HostProfile.saved()
        activeHost = selectedHost
        if !selectedHost.supportsHeldRPC { runMode = .exploitOnly }
        if let edition { activeEdition = edition; selectedEdition = edition }
        workflowProgress.selectMode(fullInstall: false)
    }

    deinit { networkRefreshTimer?.invalidate() }

    var isBusy: Bool {
        phase == .commandsSent && hasLiveWorkers || [.preparing, .bootstrap, .savingBootstrap, .hostStarting, .rpcAttaching, .commands, .waitingForConsole,
         .rpcHeld, .dumpingFirmware, .rpcFinishing, .launchingHomebrew, .homebrewRunning, .homebrewStopped,
         .keyboardConnecting, .keyboardForwarding].contains(phase)
    }

    var keyboardActive: Bool {
        (phase == .keyboardForwarding || hostOnlyKeyboardRunning && hostOnlyKeyboardReady && phase == .waitingForConsole) &&
        !keyboardStopRequested
    }
    var keyboardAcceptsPhysicalInput: Bool { keyboardActive && !keyboardTextSending }
    var keyboardTextValidationMessage: String? {
        if keyboardText.utf8.count > 16 * 1024 { return "Use at most 16 KiB of text." }
        if keyboardText.isEmpty { return "Enter text to send." }
        let normalized = keyboardText.replacingOccurrences(of: "\r\n", with: "\n")
        if !normalized.utf8.allSatisfy({ $0 == 9 || $0 == 10 || (32...126).contains($0) }) {
            return "Use printable ASCII, tabs and newlines. Standalone carriage returns are not supported."
        }
        if !(1...2000).contains(keyDelayMs) { return "Use a key delay from 1 to 2000 ms." }
        return nil
    }
    var canSendKeyboardText: Bool {
        keyboardAcceptsPhysicalInput && keyboardInput != nil && hidProcess?.isRunning == true && keyboardTextValidationMessage == nil
    }
    var keyboardIsLoading: Bool {
        phase == .keyboardConnecting || phase == .commandsSent && keyboardHandoffPending ||
        hostOnlyKeyboardRunning && !hostOnlyKeyboardReady && !keyboardStopRequested && phase == .waitingForConsole
    }
    var canStartKeyboard: Bool {
        let hostOnlyWaiting = activeRunMode.isHostOnly && phase == .waitingForConsole && hostReadyReceived &&
            hostProcess?.isRunning == true && !hostIsExploiting && !postRun.isActive && !hasHIDEvidence
        return runtime != nil && driverLoaded && !driverSetupRunning && hidProcess == nil &&
            (hostOnlyWaiting || ([.ready,.failed,.cancelled].contains(phase) ||
                phase == .commandsSent && hidCompletionReceived) && hostProcess == nil)
    }
    var canSendHostOnlyCommands: Bool {
        activeRunMode.isHostOnly && phase == .waitingForConsole && hostReadyReceived &&
        hostProcess?.isRunning == true && hidProcess == nil && !hostIsExploiting &&
        !postRun.isActive && !hostOnlyKeyboardUsed && !hasHIDEvidence &&
        !hostStartCommand.isEmpty && driverLoaded && typingSettingsValid &&
        !driverSetupRunning && runtime != nil
    }
    private var typingSettingsValid: Bool {
        (1...2000).contains(keyDelayMs) && (1...120).contains(enumerationTimeoutSeconds) &&
        [loadWaitMs, runWaitMs, removeWaitMs, effectiveLoadConfirmWaitMs].allSatisfy { (0...120000).contains($0) }
    }
    func canStartCommandsOnly(commands: [PostBootstrapCommand] = [.load, .run, .remove], startCommand: String? = nil, startPrefix: Bool = false) -> Bool {
        [.ready, .failed, .cancelled].contains(phase) && canStartKeyboard && typingSettingsValid &&
            PostBootstrapCommandSelection(commands: commands, startCommand: startCommand, startPrefix: startPrefix, host: selectedHost) != nil
    }
    var canStartHostOnly: Bool {
        runtime != nil && Self.isIPv4(selectedAddress) && [.ready, .failed, .cancelled].contains(phase) &&
        !hasLiveWorkers && !driverSetupRunning
    }
    var canSkipBootstrapTyping: Bool {
        (phase == .ready || phase == .failed && safeBootstrapRetryAfterUSBFailure) &&
        runtime != nil && !hasLiveWorkers && !driverSetupRunning
    }
    var canTypeBootstrapSave: Bool {
        phase == .awaitingSave && activeRunMode == .bootstrapOnly && !bootstrapSaveCommandSent &&
        runtime != nil && driverLoaded && typingSettingsValid && !hasLiveWorkers && !driverSetupRunning
    }
    var isAttachedRPCSession: Bool { activeRunMode == .existingRPC }
    var canChangeHost: Bool {
        [.ready, .failed, .cancelled].contains(phase) && !preparing && !hasLiveWorkers && !driverSetupRunning
    }
    var canAttachExistingRPC: Bool {
        canChangeHost && runtime != nil && selectedHost.supportsHeldRPC &&
        existingRPCRunPath.hasPrefix("/") && !existingRPCRunPath.contains("\n") && !existingRPCRunPath.contains("\0")
    }
    var activeSessionSupportsHomebrew: Bool { activeRunMode == .heldRPC || activeRunMode == .hostOnlyHeld || isAttachedRPCSession }

    var hasLiveWorkers: Bool { hostProcess != nil || hidProcess != nil }
    var canLaunchHomebrew: Bool {
        phase == .rpcHeld && activeSessionSupportsHomebrew && postRun.canLaunchHomebrew && pendingHomebrewAction == nil &&
        hostProcess?.isRunning == true && hostInput != nil && runFolder != nil
    }
    var canDumpSystemCode: Bool {
        activeSessionSupportsHomebrew && postRun.canDumpSystemCode &&
        hostProcess?.isRunning == true && hostInput != nil && runFolder != nil
    }
    private var izlauncherRuntimeAvailable: Bool {
        guard let root = runtime?.root else { return false }
        let marker = root.appendingPathComponent("packaging/runtime-homebrew.json")
        guard FileManager.default.fileExists(atPath: marker.path) else { return true }
        guard let data = try? Data(contentsOf: marker),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let allowed = value["allowed"] as? [String] else { return false }
        return allowed.contains("izlauncher")
    }
    var canLaunchIZlauncher: Bool { canLaunchHomebrew && izlauncherRuntimeAvailable }
    var canLoadIZlauncherModules: Bool {
        phase == .homebrewRunning && homebrewApp == .izlauncher &&
        hostProcess?.isRunning == true && hostInput != nil && !selectedIZlauncherModuleIDs.isEmpty
    }
    var canOpenIZlauncherPanel: Bool {
        phase == .homebrewRunning && homebrewApp == .izlauncher && izlauncherPanelURL != nil &&
        hostProcess?.isRunning == true && !izlauncherPanelChecking
    }
    var canSelectOunceCakeGame: Bool {
        postRun.canSelectHomebrew && ounceCakeSession.stage == .choosing &&
        ounceCakeSession.games.contains { $0.titleId == selectedOunceCakeGame } && hostProcess?.isRunning == true
    }
    var canReturnToStart: Bool { [.verified, .commandsSent, .rpcDetached].contains(phase) && !hasLiveWorkers && !driverSetupRunning }

    func returnToStart() {
        guard canReturnToStart else { return }
        endSessionActivity()
        phase = .ready; status = "Ready for a fresh session"
        detail = isAttachedRPCSession ? "The original host still owns the RPC session. Choose your next action." : "Restart the console before another exploit attempt, then choose your next run mode."
        progress = nil; progressLabel = ""; error = nil
        izlauncherPanelURL = nil; izlauncherPanelMessage = ""; izlauncherPanelChecking = false
    }

    func selectRunMode(_ mode: SessionRunMode) {
        guard !isBusy, phase != .awaitingSave, !hasLiveWorkers, !driverSetupRunning else { return }
        guard selectedHost.supportsHeldRPC || ![.heldRPC, .hostOnlyHeld, .systemCodeDump, .existingRPC].contains(mode) else { return }
        runMode = mode
        workflowProgress.selectMode(fullInstall: mode == .bootstrapOnly)
    }

    func selectHost(_ host: HostProfile) {
        guard canChangeHost, host != selectedHost else { return }
        selectedHost = host
        UserDefaults.standard.set(host.rawValue, forKey: HostProfile.preferenceKey)
        if !host.supportsDemo { selectedEdition = .full }
        runMode = host.supportsHeldRPC ? .heldRPC : .exploitOnly
        activeRunMode = runMode; activeHost = host; attachedRunDirectory = nil
        workflowProgress = WorkflowProgress(); workflowProgress.selectMode(fullInstall: false)
        endSessionActivity()
        runtime = nil; phase = .preparing; error = nil; progress = nil
        status = "Preparing \(host.label)"
        detail = "Each host uses its own bootstrap and saved program name. Type and save this host’s bootstrap before running it."
        prepare()
    }

    var canRestartForUpdate: Bool {
        !isBusy && phase != .awaitingSave && !driverSetupRunning && hostProcess == nil && hidProcess == nil
    }

    var shouldShowFirstTimeFooter: Bool {
        !hasEnumeratedSuccessfully && [.preparing, .ready, .failed, .cancelled].contains(phase)
    }

    func prepare() {
        if networkRefreshTimer == nil {
            networkRefreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in self?.refreshNetworkAddressesIfIdle() }
            }
        }
        guard !preparing, runtime == nil else { return }
        preparing = true
        let host = selectedHost
        refreshChecks()
        Task {
            defer { preparing = false }
            do {
                let override = ProcessInfo.processInfo.environment["MAC2JB_SESSION_PARENT"].flatMap {
                    $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true)
                }
                let prepared = try await Task.detached(priority: .userInitiated) {
                    try BundledRuntime.prepare(sessionParent: override, host: host)
                }.value
                runtime = prepared
                openSessionLog(in: prepared.root)
                append("\(host.label) offline runtime prepared. Session files are private to your account.")
                // Keep a successfully prepared runtime available for retry,
                // but never undo a cancellation while extraction was running.
                guard phase == .preparing else { return }
                phase = .ready
                status = "Ready when you are"
                detail = "Selected host: \(host.label). Use its matching bootstrap, then choose your Mac’s network address."
            } catch {
                let message = "Could not prepare the bundled runtime: \(error.localizedDescription)"
                if phase == .preparing { fail(message) }
                else { append(message) }
            }
        }
    }

    func refreshChecks() {
        refreshNetworkAddressesIfIdle()
        driverInstalled = FileManager.default.fileExists(atPath: "/Library/Extensions/usbgadget.kext")
        driverStatus = driverInstalled ? "Driver installed; checking loaded status…" : "Driver not found in /Library/Extensions"
        Task {
            let installed = driverInstalled
            let result = await Task.detached { Self.capture("/usr/bin/kmutil", ["showloaded", "--list-only"]) }.value
            if result.0 == 0 {
                driverLoaded = result.1.contains("gay.bowser.usbgadget") || result.1.contains("usbgadget")
                driverStatus = driverLoaded
                    ? "USB gadget driver is loaded"
                    : (installed ? "Driver installed; not reported as loaded" : "USB gadget driver not reported as loaded")
            } else {
                driverLoaded = false
                driverStatus = installed ? "Driver installed; loaded status could not be verified" : "Driver installation and loaded status need checking"
            }
            let marker = "/Library/Extensions/.mac2jb-usbgadget-restart-required"
            if let attributes = try? FileManager.default.attributesOfItem(atPath: marker),
               let modified = attributes[.modificationDate] as? Date,
               modified > Date().addingTimeInterval(-ProcessInfo.processInfo.systemUptime) {
                driverLoaded = false
                driverStatus = "Driver installed — restart this Mac before starting a session"
            }
        }
    }

    func refreshNetworkAddressesIfIdle() {
        guard [.preparing, .ready, .failed, .cancelled].contains(phase), !hasLiveWorkers, !driverSetupRunning else { return }
        _ = refreshNetworkAddresses()
    }

    @discardableResult private func refreshNetworkAddresses() -> NetworkSelection.Refresh {
        let previous = selectedAddress
        let refresh = NetworkSelection.refresh(selected: previous, previous: addresses, available: addressProvider())
        addresses = refresh.addresses; selectedAddress = refresh.selected
        if refresh.changed, !previous.isEmpty {
            networkNotice = "The Mac’s network address changed. Review the current address, confirm the Switch is ready, then press Start again."
        }
        return refresh
    }

    @discardableResult func handleNetworkUnavailable(_ message: String, retrySafe: Bool) -> Bool {
        guard NetworkSelection.safePreflightFailure(retrySafe: retrySafe, hostStarting: phase == .hostStarting,
            hostReady: hostReadyReceived, hasHIDWorker: hidProcess != nil, hasHIDEvidence: hasHIDEvidence,
            postRunActive: postRun.isActive) else { return false }
        preflightNetworkFailureHandled = true
        _ = refreshNetworkAddresses()
        networkNotice = message
        endSessionActivity()
        workflowProgress = WorkflowProgress(); workflowProgress.selectMode(fullInstall: fullInstall)
        phase = .ready; status = "Review the Mac’s network address"
        hostIsExploiting = false
        detail = message; error = nil; progress = nil; progressLabel = ""; isEnumerating = false
        return true
    }

    func start(commandSelection: PostBootstrapCommandSelection? = nil) {
        guard !driverSetupRunning else { return }
        guard runMode != .existingRPC,
              selectedHost.supportsDemo || selectedEdition != .demo,
              selectedHost.supportsHeldRPC || ![.heldRPC, .hostOnlyHeld, .systemCodeDump].contains(runMode) else { return }
        guard !isBusy, phase != .awaitingSave, hostProcess == nil, hidProcess == nil else { return }
        if runMode.requiresNetworkAddress {
            let refresh = refreshNetworkAddresses()
            guard !refresh.changed, Self.isIPv4(selectedAddress), !selectedAddress.isEmpty else {
                networkNotice = refresh.changed
                    ? "The Mac’s network address changed. Review the current address, confirm the Switch is ready, then press Start again."
                    : "Connect this Mac to the Switch’s network, then choose a current Mac address before starting."
                status = "Review the Mac’s network address"
                detail = networkNotice ?? "Choose a current Mac network address."
                phase = .ready; error = nil
                workflowProgress = WorkflowProgress(); workflowProgress.selectMode(fullInstall: fullInstall)
                return
            }
        }
        guard let runtime else { return }
        guard runMode.isHostOnly || driverLoaded else { fail("Install/load the USB driver, complete any required restart, then refresh the driver check."); return }
        guard runMode.isHostOnly || typingSettingsValid else {
            fail("Use 1–2000 ms per key, 1–120 seconds for enumeration, and 0–120000 ms for each command wait.")
            return
        }
        beginAttempt(commandSelection: commandSelection)
        if activeRunMode == .bootstrapOnly { startHID("bootstrap", root: runtime.root) }
        else if activeRunMode == .commandsOnly { startHID("commands-only", root: runtime.root) }
        else { startHost(root: runtime.root) }
    }

    private func beginAttempt(commandSelection: PostBootstrapCommandSelection? = nil) {
        activeRunMode = runMode
        activeHost = selectedHost
        attachedRunDirectory = nil
        activeCommandSelection = activeRunMode == .commandsOnly ? (commandSelection ?? .standard) : nil
        activeEdition = selectedEdition
        activeAddress = activeRunMode.requiresNetworkAddress ? selectedAddress : ""
        hostReadyReceived = false; hasHIDEvidence = false; preflightNetworkFailureHandled = false
        hostIsExploiting = false
        networkNotice = nil
        workflowProgress.begin(fullInstall: activeRunMode == .bootstrapOnly)
        // Keep the Mac awake through typing, the save checkpoint, and host
        // verification. This assertion is scoped to this session only.
        endSessionActivity()
        sessionActivity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .idleSystemSleepDisabled],
            reason: "Completing the mac2jb USB and console session")
        generation = UUID()
        error = nil; progress = nil; progressLabel = ""; isEnumerating = false; hostCompleted = false; runFolder = nil
        pipelineLog = "Waiting for pipeline.json"
        acquisitionLog = "Waiting for acquisition.log"
        exploitLogRefreshDate = .distantPast
        postRun = PostRunSessionState(); rpcCommand = ""; hostStartCommand = ""; rpcStatus = ""; dumpFolder = nil
        homebrewMessage = ""; homebrewFolder = nil; homebrewApp = .mintBrew; pendingHomebrewAction = nil
        pendingCustomConsoleAddress = nil
        izlauncherPanelURL = nil; izlauncherPanelMessage = ""; izlauncherPanelChecking = false
        izlauncherModules = []; izlauncherCatalogLoaded = false; selectedIZlauncherModuleIDs = []
        izlauncherModuleMessage = "Hold RPC to list compatible modules."
        ounceCakeSession = OunceCakeSession(); selectedOunceCakeGame = ""
        startPrefixCompleted = false; keyboardHandoffPending = false; completingStartWithKeyboard = false
        hostOnlyKeyboardRunning = false; hostOnlyKeyboardReady = false; hostOnlyKeyboardUsed = false
        resetKeyboardTextTransfer()
        currentUSBStepHasProof = false; safeBootstrapRetryAfterUSBFailure = false
        bootstrapSaveCommandSent = false; saveTypingStarted = false; saveCommandStarted = false; saveCommandCompleted = false
        hasEnumeratedSuccessfully = false
        resetBootstrapTiming()
        hostStageLabel = "Waiting for the Switch to connect over the local network"
        hostStageProgress = nil
        append("\(AppBuildIdentity.diagnosticLabel); mode=\(activeRunMode.rawValue); edition=\(activeEdition.rawValue); controller=\(controller); address=\(activeAddress); keyDelayMs=\(keyDelayMs); enumerationTimeoutSeconds=\(enumerationTimeoutSeconds); loadConfirmWaitMs=\(effectiveLoadConfirmWaitMs); loadWaitMs=\(loadWaitMs); runWaitMs=\(runWaitMs); removeWaitMs=\(removeWaitMs). Starting \(activeRunMode.title).")
    }

    func startCommandsOnly(commands: [PostBootstrapCommand] = [.load, .run, .remove], startCommand: String? = nil, startPrefix: Bool = false) {
        guard canStartCommandsOnly(commands: commands, startCommand: startCommand, startPrefix: startPrefix),
              let selection = PostBootstrapCommandSelection(commands: commands, startCommand: startCommand, startPrefix: startPrefix, host: selectedHost) else { return }
        selectRunMode(.commandsOnly)
        start(commandSelection: selection)
    }

    func startHostOnly(keepRPC: Bool) {
        guard canStartHostOnly, !keepRPC || selectedHost.supportsHeldRPC else { return }
        selectRunMode(keepRPC ? .hostOnlyHeld : .hostOnly)
        start()
    }

    func sendHostOnlyCommands() {
        guard canSendHostOnlyCommands, let runtime else { return }
        startHID("commands", root: runtime.root)
    }

    func attachExistingRPC() {
        guard canAttachExistingRPC, let runtime else { return }
        let directory = Self.canonicalSessionURL(existingRPCRunPath)
        selectRunMode(.existingRPC)
        beginAttempt()
        attachedRunDirectory = directory
        phase = .rpcAttaching; status = "Connecting to the open RPC session"
        detail = "Keep the original host and SmileBASIC open. Checking the selected session…"
        launch(arguments: ["attach"], role: "host", root: runtime.root)
        guard hostProcess != nil, phase == .rpcAttaching else { return }
        _ = sendHostControl(["action": "attach", "connection": ["kind": "local", "runDirectory": directory.path]])
    }

    func skipBootstrapTyping() {
        guard canSkipBootstrapTyping else { return }
        selectRunMode(.bootstrapOnly)
        beginAttempt()
        workflowProgress.bootstrapTypingSkipped()
        phase = .awaitingSave; status = "Bootstrap typing skipped"
        detail = "Use the complete bootstrap already in PRG0. No bootstrap was typed or verified by this app. Follow the save steps below."
        progress = nil; progressLabel = "Typing skipped · save confirmation required"
        append("Bootstrap typing was explicitly skipped using the existing complete PRG0 program. No USB transfer or host was started.")
    }

    func finishBootstrapOnly() {
        guard phase == .awaitingSave, activeRunMode == .bootstrapOnly, !hasLiveWorkers else { return }
        workflowProgress.bootstrapOnlySaved()
        endSessionActivity()
        phase = .ready; status = "Bootstrap saved"
        detail = "\(activeHost.saveName) is saved in slot 0. Choose an exploit mode when you are ready to start a fresh console session."
        progress = nil; progressLabel = ""
        append("Bootstrap-only workflow finished after the save checkpoint. No host was started.")
    }

    func typeBootstrapSave(directModeConfirmed: Bool) {
        guard directModeConfirmed, canTypeBootstrapSave, let runtime else { return }
        saveTypingStarted = false; saveCommandStarted = false; saveCommandCompleted = false
        startHID("save-bootstrap", root: runtime.root)
    }

    func startKeyboardForwarding() {
        guard canStartKeyboard else { return }
        beginKeyboardForwarding(completingStart: false)
    }

    private func beginKeyboardForwarding(completingStart: Bool) {
        let alongsideHost = activeRunMode.isHostOnly && phase == .waitingForConsole &&
            hostReadyReceived && hostProcess?.isRunning == true && !hostIsExploiting &&
            !postRun.isActive && !hasHIDEvidence
        guard let runtime, hidProcess == nil, (alongsideHost || hostProcess == nil),
              driverLoaded, !driverSetupRunning else { return }
        if !alongsideHost { generation = UUID(); postRun = PostRunSessionState() }
        keyboardStopRequested = false
        resetKeyboardTextTransfer()
        completingStartWithKeyboard = completingStart
        hostOnlyKeyboardRunning = alongsideHost; hostOnlyKeyboardReady = false
        if !alongsideHost {
            phase = .keyboardConnecting; status = "Loading…"
            detail = completingStart
                ? "Connecting the live keyboard. Wait before finishing the START command."
                : "Connecting the live keyboard. Wait for the ready message before typing."
            error = nil; progress = nil; progressLabel = ""
        }
        keyboardStatus = "Loading…"
        launch(arguments: ["keyboard", "live", controller, String(enumerationTimeoutSeconds)] + preferredControllerArguments, role: "hid", root: runtime.root)
    }

    func sendKeyboardReport(_ report: [UInt8]) {
        guard keyboardAcceptsPhysicalInput, report.count == 8, report[1] == 0, let keyboardInput,
              hidProcess?.isRunning == true else { return }
        do {
            var data = try JSONSerialization.data(withJSONObject: ["report":report.map(Int.init)])
            data.append(10); try keyboardInput.fileHandleForWriting.write(contentsOf: data)
            if hostOnlyKeyboardRunning && report.contains(where: { $0 != 0 }) { hostOnlyKeyboardUsed = true }
        } catch { stopKeyboardForwarding() }
    }

    func sendKeyboardText() {
        guard keyboardAcceptsPhysicalInput, let keyboardInput, hidProcess?.isRunning == true else { return }
        if let message = keyboardTextValidationMessage { keyboardTextStatus = message; return }
        let original = keyboardText
        let normalized = original.replacingOccurrences(of: "\r\n", with: "\n")
        do {
            var data = try JSONSerialization.data(withJSONObject: ["text": normalized, "delayMs": keyDelayMs])
            data.append(10)
            pendingKeyboardText = original; keyboardTextStarted = false
            keyboardTextSent = 0; keyboardTextTotal = normalized.utf8.count; keyboardTextSending = true
            keyboardTextStatus = "Waiting to send text…"
            try keyboardInput.fileHandleForWriting.write(contentsOf: data)
            if hostOnlyKeyboardRunning { hostOnlyKeyboardUsed = true }
        } catch { stopKeyboardForwarding() }
    }

    private func resetKeyboardTextTransfer(message: String = "") {
        pendingKeyboardText = nil; keyboardTextStarted = false; keyboardTextSending = false
        keyboardTextSent = 0; keyboardTextTotal = 0; keyboardTextStatus = message
    }

    private func receiveKeyboardText(_ event: GUIEvent, role: String) {
        guard role == "hid", hidPurpose == "live", keyboardActive, keyboardTextSending,
              let original = pendingKeyboardText else { return }
        if event.type == "keyboard-text-rejected" {
            guard !keyboardTextStarted else { return }
            resetKeyboardTextTransfer(message: event.message ?? "The text could not be sent. Check it and try again.")
            return
        }
        guard event.total == Double(keyboardTextTotal) else { return }
        if event.type == "keyboard-text-started" {
            guard !keyboardTextStarted else { return }
            keyboardTextStarted = true; keyboardTextStatus = "Sending text…"
            return
        }
        guard keyboardTextStarted, let sent = event.sent, sent.isFinite,
              sent.rounded(.towardZero) == sent, sent >= Double(keyboardTextSent), sent <= Double(keyboardTextTotal) else { return }
        switch event.type {
        case "keyboard-text-progress":
            keyboardTextSent = Int(sent)
        case "keyboard-text-completed":
            guard sent == Double(keyboardTextTotal) else { return }
            let total = keyboardTextTotal
            if keyboardText == original { keyboardText = "" }
            resetKeyboardTextTransfer(message: "Sent \(total) characters. No extra Enter was added.")
        default: break
        }
    }

    func stopKeyboardForwarding() {
        if phase == .commandsSent && keyboardHandoffPending { cancel(); return }
        guard [.keyboardConnecting,.keyboardForwarding].contains(phase) || hostOnlyKeyboardRunning,
              !keyboardStopRequested else { return }
        sendKeyboardReport(Array(repeating: 0, count: 8))
        resetKeyboardTextTransfer(message: keyboardTextSending ? "Text sending stopped. Check the Switch before sending again." : "")
        keyboardStopRequested = true; keyboardStatus = "Disconnecting and releasing keys…"
        try? keyboardInput?.fileHandleForWriting.close(); keyboardInput = nil
        hidProcess?.terminate()
    }

    func cancel() {
        // Quit also calls cancel, so release the assertion even if the phase
        // has already moved to a terminal state.
        if hostProcess == nil { endSessionActivity() }
        hostIsExploiting = false
        let wasSafeUSBFailure = safeBootstrapRetryAfterUSBFailure
        safeBootstrapRetryAfterUSBFailure = false
        if phase == .failed && wasSafeUSBFailure && hasLiveWorkers { stopWorkers(); return }
        guard isBusy || phase == .awaitingSave else { return }
        keyboardHandoffPending = false
        // Remember the active step before replacing its phase with cancelled.
        let recovery = recoveryMessage("Session stopped.")
        workflowProgress.cancel()
        detail = recovery
        phase = .cancelled; progress = nil; progressLabel = ""; isEnumerating = false
        status = "Session stopped"
        error = nil
        postRun.stop()
        izlauncherPanelURL = nil; izlauncherPanelMessage = ""; izlauncherPanelChecking = false
        if ounceCakeSession.hasStarted { ounceCakeSession.stop() }
        append("Stop requested. Only this app’s worker processes are being stopped.")
        appendBootstrapDuration(outcome: "cancelled")
        stopWorkers()
    }

    func revealSessionFolder() {
        guard let folder = runtime?.root ?? diagnosticLogURL?.deletingLastPathComponent() else { return }
        NSWorkspace.shared.open(folder)
    }

    func revealRunFolder() {
        if let folder = runFolder ?? runtime?.root { NSWorkspace.shared.open(folder) }
    }

    func revealDumpFolder() { if let dumpFolder { NSWorkspace.shared.open(dumpFolder) } }

    func revealHomebrewLogs() {
        if let folder = homebrewFolder ?? runFolder { NSWorkspace.shared.open(folder) }
    }

    func openIZlauncherPanel() {
        guard canOpenIZlauncherPanel, let url = izlauncherPanelURL,
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
        parts.fragment = nil
        guard let probeURL = parts.url else { return }
        var request = URLRequest(url: probeURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 2
        let expected = generation
        izlauncherPanelChecking = true
        izlauncherPanelMessage = "Checking the local control panel…"
        Task {
            let reachable: Bool
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                reachable = (response as? HTTPURLResponse)?.statusCode == 200 &&
                    response.url?.scheme == "http" && response.url?.host == "127.0.0.1"
            } catch { reachable = false }
            guard generation == expected, izlauncherPanelURL == url else { return }
            izlauncherPanelChecking = false
            guard canOpenIZlauncherPanel else { return }
            if !reachable {
                izlauncherPanelMessage = "The local control panel is no longer responding. Restart its module in IZlauncher."
            } else if NSWorkspace.shared.open(url) {
                izlauncherPanelMessage = ""
            } else {
                izlauncherPanelMessage = "Could not open the local control panel in your default browser."
            }
        }
    }

    private func stremioLaunchOptions(accountAddons: [String], libraryItems: [[String: Any]]) -> [String: Any]? {
        guard accountAddons.count <= 32, libraryItems.count <= 500 else { return nil }
        let value = stremioAddonURL.trimmingCharacters(in: .whitespacesAndNewlines)
        return ["addonUrls": value.isEmpty ? accountAddons : [value],
                "libraryItems": libraryItems,
                "quality": stremioQuality.rawValue]
    }

    func launchMintBrew(accountAddons: [String] = [], libraryItems: [[String: Any]] = []) {
        guard canLaunchHomebrew,
              var control = stremioLaunchOptions(accountAddons: accountAddons, libraryItems: libraryItems) else { return }
        control["action"] = "launch-mintbrew"
        guard sendHostControl(control) else { return }
        homebrewApp = .mintBrew
        postRun.launchHomebrew()
        homebrewMessage = "Starting MintBrew in the current held session…"
        presentPostRunState()
    }

    func launchIZlauncher() {
        guard canLaunchIZlauncher else { return }
        var control: [String: Any] = ["action": "launch-izlauncher"]
        if !selectedIZlauncherModuleIDs.isEmpty { control["moduleIds"] = selectedIZlauncherModuleIDs.sorted() }
        guard sendHostControl(control) else { return }
        homebrewApp = .izlauncher
        izlauncherPanelURL = nil; izlauncherPanelMessage = ""; izlauncherPanelChecking = false
        postRun.launchHomebrew()
        homebrewMessage = "Starting IZlauncher in the current held session…"
        presentPostRunState()
    }

    func launchIZlauncher(moduleFolder: URL) {
        guard canLaunchIZlauncher else { return }
        var control: [String: Any] = ["action": "launch-izlauncher", "moduleFolderPath": moduleFolder.standardizedFileURL.path]
        if !selectedIZlauncherModuleIDs.isEmpty { control["moduleIds"] = selectedIZlauncherModuleIDs.sorted() }
        guard sendHostControl(control) else { return }
        pendingHomebrewAction = "launch-izlauncher"
        homebrewApp = .izlauncher
        izlauncherPanelURL = nil; izlauncherPanelMessage = ""; izlauncherPanelChecking = false
        homebrewMessage = "Checking the selected module folder…"
        status = "Checking IZlauncher module"
        detail = "Validating the module for this Mac and the console before opening IZlauncher."
    }

    func selectIZlauncherModule(_ id: String, selected: Bool) {
        guard izlauncherCatalogLoaded, izlauncherModules.contains(where: { $0.id == id }),
              canLaunchIZlauncher || phase == .homebrewRunning && homebrewApp == .izlauncher else { return }
        if selected {
            guard selectedIZlauncherModuleIDs.count < 15 || selectedIZlauncherModuleIDs.contains(id) else {
                izlauncherModuleMessage = "Choose no more than 15 modules in one session."
                return
            }
            selectedIZlauncherModuleIDs.insert(id)
        }
        else { selectedIZlauncherModuleIDs.remove(id) }
    }

    func loadIZlauncherModules() {
        guard canLoadIZlauncherModules,
              sendHostControl(["action": "load-izlauncher-modules", "ids": selectedIZlauncherModuleIDs.sorted()]) else { return }
        izlauncherModuleMessage = "Sending selected modules to IZlauncher…"
    }

    private func requestIZlauncherModules() {
        guard izlauncherRuntimeAvailable, phase == .rpcHeld, !izlauncherCatalogLoaded,
              sendHostControl(["action": "list-izlauncher-modules"]) else { return }
        izlauncherModuleMessage = "Reading compatible IZlauncher modules…"
    }

    func launchCustomHomebrew(folder: URL) {
        guard canLaunchHomebrew else { return }
        var control: [String: Any] = ["action": "launch-custom-homebrew",
                                      "customHomebrewPath": folder.standardizedFileURL.path]
        let address = OunceCakeSession.validConsoleAddress(ounceCakeConsoleAddress)
        if let address {
            control["consoleAddress"] = address
        }
        guard sendHostControl(control) else { return }
        pendingCustomConsoleAddress = address
        pendingHomebrewAction = "launch-custom-homebrew"
        homebrewApp = .custom
        homebrewMessage = "Checking the selected homebrew folder…"
        status = "Checking custom homebrew"
        detail = "Validating the selected package before starting it through the held RPC session."
    }

    func openMintBrewAppsFolder() {
        guard let runtime else { return }
        let folder = runtime.root.appendingPathComponent("vendor/MintBrew/apps", isDirectory: true)
        guard FileManager.default.fileExists(atPath: folder.path) else {
            detail = "The MintBrew app folder is unavailable in this session."
            return
        }
        if !NSWorkspace.shared.open(folder) { detail = "Could not open the MintBrew app folder in Finder." }
    }

    func refreshExploitLogs() {
        guard Date().timeIntervalSince(exploitLogRefreshDate) >= 0.4 else { return }
        exploitLogRefreshDate = Date()
        if activeHost == .izmysh {
            pipelineLog = "The IZMYSH host does not produce pipeline.json. See the Host log for its progress."
            acquisitionLog = "The IZMYSH host does not produce acquisition.log. See the Host log for its progress."
            return
        }
        guard let run = runFolder ?? attachedRunDirectory else { return }
        let directory = run.appendingPathComponent("switch2", isDirectory: true)
        pipelineLog = readExploitLog(directory.appendingPathComponent("pipeline.json"), limit: 1024 * 1024,
                                     placeholder: "Waiting for pipeline.json")
        acquisitionLog = readExploitLog(directory.appendingPathComponent("acquisition.log"), limit: 1024 * 1024,
                                        placeholder: "Waiting for acquisition.log")
    }

    private func readExploitLog(_ url: URL, limit: Int, placeholder: String) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return placeholder }
        defer { try? handle.close() }
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard ((attributes[.size] as? NSNumber)?.intValue ?? 0) <= limit * 8 else {
                return "Log exceeds the 8 MiB display limit."
            }
            let data = try handle.readToEnd() ?? Data()
            return String(data: data.suffix(limit), encoding: .utf8) ?? "Log is not valid UTF-8."
        } catch { return "Could not read log: \(error.localizedDescription)" }
    }

    func startOunceCakeFTP() {
        guard canSelectOunceCakeGame else { return }
        var session = ounceCakeSession
        guard session.select(titleId: selectedOunceCakeGame),
              sendHostControl(["action": "select-ouncecake-game", "titleId": selectedOunceCakeGame]),
              postRun.selectHomebrew() else { return }
        ounceCakeSession = session
        homebrewMessage = "Preparing the selected game. This can take several minutes."
        presentPostRunState()
    }

    func copyOunceCakeAddress() {
        guard postRun.stage == .held, postRun.homebrewStage == .running,
              let endpoint = ounceCakeSession.endpoint else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(endpoint.address, forType: .string)
    }

    func copyRPCCommand() {
        guard !rpcCommand.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(rpcCommand, forType: .string)
    }

    func finishPostRun() {
        guard postRun.canFinish, sendHostControl(["action": "finish"]) else { return }
        postRun.finish()
        izlauncherPanelURL = nil; izlauncherPanelMessage = ""; izlauncherPanelChecking = false
        presentPostRunState()
    }

    func checkRPCStatus() {
        guard postRun.canCheckStatus, sendHostControl(["action": "rpc-status"]) else { return }
        postRun.checkStatus(); rpcStatus = "Checking RPC…"
    }

    func dumpSystemCode() {
        guard canDumpSystemCode, sendHostControl(["action": "dump-system-code"]),
              postRun.requestDump() else { return }
        status = postRun.homebrewStage == .running ? "Stopping \(homebrewTitle) for the system-code dump" : "Preparing system-code dump"
        detail = "Keep SmileBASIC and the held RPC session open. The dump will start after the current app stops safely."
        progress = nil; progressLabel = "Preparing the system-code dump"
    }

    private func sendHostControl(_ value: [String: Any]) -> Bool {
        guard let hostProcess, hostProcess.isRunning, let hostInput else {
            fail("The live host is no longer available. Keep the logs and restart the console before another attempt.")
            return false
        }
        do {
            var data = try JSONSerialization.data(withJSONObject: value)
            guard data.count <= 4 * 1024 * 1024 else {
                fail("The player configuration is too large. Reduce the imported library or add-on configuration.")
                return false
            }
            data.append(10)
            try hostInput.fileHandleForWriting.write(contentsOf: data)
            return true
        } catch {
            fail("Could not send the session action to the host: \(error.localizedDescription)")
            return false
        }
    }

    private func presentPostRunState() {
        isEnumerating = false
        let sessionReminder = "Keep SmileBASIC and mac2jb open, with both devices on the same network and the Switch on Ethernet."
        switch postRun.stage {
        case .held:
            switch postRun.homebrewStage {
            case .idle:
                phase = .rpcHeld; status = "Ready for homebrew"
                detail = "\(sessionReminder) Choose an app below, then finish the session when you’re done."
                progress = 1; progressLabel = isAttachedRPCSession ? "Existing RPC connected" : "4/4 complete · Switch connected"
            case .launching:
                phase = .launchingHomebrew; status = "Starting \(homebrewTitle)"
                detail = homebrewApp == .mintBrew
                    ? "You can safely disconnect the Switch from this Mac’s USB port. \(sessionReminder)"
                    : "\(sessionReminder) The app is starting."
                progress = nil; progressLabel = homebrewMessage
            case .selecting:
                phase = .launchingHomebrew; status = "Choose a game"
                detail = "Choose a game below, then start its read-only FTP server. \(sessionReminder)"
                progress = nil; progressLabel = "Game list ready"
            case .running:
                phase = .homebrewRunning; status = "\(homebrewTitle) is running"
                detail = isAttachedRPCSession
                    ? "\(sessionReminder) Keep the original host open. Choose Disconnect when you’re done."
                    : "\(sessionReminder) Choose Finish session when you’re done."
                progress = nil; progressLabel = homebrewMessage
            case .stopped, .failed:
                phase = .homebrewStopped; status = postRun.homebrewStage == .failed ? "\(homebrewTitle) needs attention" : "\(homebrewTitle) stopped"
                detail = "Keep the logs, finish this session, then restart the console before another attempt. The homebrew app cannot be retried in this session."
                progress = nil; progressLabel = homebrewMessage
            }
        case .dumping:
            phase = .dumpingFirmware; status = "Dumping system code"
            detail = "\(sessionReminder) The live session is reading installed system code; stopping may leave a partial dump."
            progress = nil; progressLabel = "System-code dump in progress"
        case .finishing:
            phase = .rpcFinishing; status = isAttachedRPCSession ? "Disconnecting from RPC" : "Finishing the session"
            detail = isAttachedRPCSession ? "Stopping this app’s homebrew workers. The original host keeps RPC open." : "Wait while the host releases the endpoint and verifies final cleanup. Keep SmileBASIC open."
            progress = nil; progressLabel = isAttachedRPCSession ? "Waiting for homebrew workers to stop" : "Waiting for final cleanup verification"
        case .blocked:
            phase = .homebrewStopped; status = "Restart the console"
            detail = "Cleanup could not be confirmed. Restart the console, then stop this session. Keep the logs."
            progress = nil; progressLabel = homebrewMessage
        default: break
        }
    }

    private func sessionURL(_ path: String?) -> URL? {
        guard let path, let runtime else { return nil }
        let url = Self.canonicalSessionURL(path)
        if isAttachedRPCSession, url == attachedRunDirectory { return url }
        guard url.path.hasPrefix(Self.canonicalSessionURL(runtime.root.path).path + "/") else { return nil }
        return url
    }

    private static func canonicalSessionURL(_ path: String) -> URL {
        var url = URL(fileURLWithPath: path).standardizedFileURL
        var suffix: [String] = []
        // Resolve existing parents as well, since a helper may report a log
        // folder just before creating it. Foundation preserves /var aliases.
        while true {
            if let canonical = realpath(url.path, nil) {
                defer { free(canonical) }
                return suffix.reversed().reduce(URL(fileURLWithPath: String(cString: canonical))) {
                    $0.appendingPathComponent($1)
                }
            }
            let parent = url.deletingLastPathComponent()
            guard parent.path != url.path else { break }
            suffix.append(url.lastPathComponent); url = parent
        }
        return suffix.reversed().reduce(url) { $0.appendingPathComponent($1) }
    }

    func clearLog() { log = "" }

    func recordDiagnostic(_ message: String) { append(message) }

    private func startHost(root: URL) {
        guard let arguments = activeRunMode.hostArguments(address: activeAddress) else {
            fail("Choose an exploit mode to start a host session.")
            return
        }
        phase = .hostStarting; status = "Starting ns2jb host…"
        detail = "The Mac and Switch must be on the same local network, and the Switch must use Ethernet. Allow incoming connections if macOS asks."
        progress = nil
        progressLabel = "Starting the host on \(activeAddress)"; isEnumerating = false
        launch(arguments: arguments, role: "host", root: root)
    }

    private func startHID(_ kind: String, root: URL) {
        phase = kind == "bootstrap" ? .bootstrap : kind == "save-bootstrap" ? .savingBootstrap : .commands
        status = kind == "bootstrap" ? "Connecting the USB keyboard" : "Waiting for USB keyboard…"
        detail = kind == "bootstrap" ? "Keep Make a Program open until the entire bootstrap has finished typing. Using \(keyDelayMs) ms per key." : "Keep the command screen focused. The expected Out of memory message after REMOVE is normal."
        progress = 0; progressLabel = "Waiting for the USB keyboard"; isEnumerating = true
        var arguments = ["hid", kind, controller, String(keyDelayMs),
            "--enumeration-timeout", String(enumerationTimeoutSeconds),
            "--load-wait-ms", String(loadWaitMs), "--run-wait-ms", String(runWaitMs),
            "--remove-wait-ms", String(removeWaitMs), "--load-confirm-wait-ms",
            String(loadConfirmWaitMs)]
        if kind == "commands-only" {
            guard let selection = activeCommandSelection else { fail("Choose at least one command before typing."); return }
            arguments += selection.arguments
            detail = "Sending only your selected commands. No host will be started or verified."
        }
        if kind == "save-bootstrap" {
            detail = "Keep the empty Direct-mode command prompt focused. The app will type the save command and press Enter once."
        }
        if kind == "commands" || kind == "commands-only" || kind == "save-bootstrap" {
            arguments += activeEdition.commandArguments
        }
        arguments += preferredControllerArguments
        launch(arguments: arguments, role: "hid", root: root)
    }

    private var preferredControllerArguments: [String] {
        guard controller == "auto", let successful = lastSuccessfulController else { return [] }
        return ["--preferred-controller", successful]
    }

    private func rememberSuccessfulController(_ value: String?) {
        guard let value, value.hasPrefix("usb-drd"), let number = Int(value.dropFirst(7)),
              (0...15).contains(number), value == "usb-drd\(number)",
              controller == "auto" || controller == value else { return }
        if lastSuccessfulController != value {
            lastSuccessfulController = value
            append("Remembered \(value) for automatic USB selection.", channel: .usb)
        }
    }

    private func launch(arguments: [String], role: String, root: URL) {
        let process = Process()
        process.executableURL = root.appendingPathComponent("node")
        let keyboard = arguments.first == "keyboard"
        let attachment = arguments.first == "attach"
        let script = keyboard ? "scripts/gui-keyboard.cjs" : attachment ? "scripts/gui-attach.cjs" : "scripts/gui-host.cjs"
        process.arguments = [root.appendingPathComponent(script).path] + (keyboard || attachment ? Array(arguments.dropFirst()) : arguments)
        process.currentDirectoryURL = root
        if role == "host" {
            let input = Pipe()
            _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
            hostInput = input; process.standardInput = input
        } else if keyboard && arguments.dropFirst().first == "live" {
            let input = Pipe(); _ = fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1)
            keyboardInput = input; process.standardInput = input
        } else { process.standardInput = FileHandle.nullDevice }
        let output = Pipe(); let stderr = Pipe()
        process.standardOutput = output; process.standardError = stderr
        let currentGeneration = generation
        if role == "host" { hostProcess = process }
        else {
            hidProcess = process; hidPurpose = arguments[1]; hidCompletionReceived = false
            currentUSBStepHasProof = false; safeBootstrapRetryAfterUSBFailure = false
        }
        do { try process.run() }
        catch {
            if role == "host" { hostProcess = nil; hostInput = nil } else { hidProcess = nil; try? keyboardInput?.fileHandleForWriting.close(); keyboardInput = nil }
            fail("Could not launch the bundled tool: \(error.localizedDescription)")
            return
        }
        // drain pipe events before processing exit, without blocking the cooperative executor.
        Task.detached(priority: .userInitiated) { [weak self] in
            let stderrTask = Task.detached { await Self.readPipe(stderr.fileHandleForReading, toEnd: true) }
            var pending = Data()
            while true {
                let chunk = await Self.readPipe(output.fileHandleForReading)
                if chunk.isEmpty { break }
                pending.append(chunk)
                while let newline = pending.firstIndex(of: 10) {
                    let line = pending[..<newline]
                    pending.removeSubrange(...newline)
                    if let event = try? JSONDecoder().decode(GUIEvent.self, from: Data(line)) {
                        await self?.receive(event, role: role, generation: currentGeneration)
                    }
                }
                if pending.count > 1024 * 1024 { pending.removeAll() }
            }
            if !pending.isEmpty, let event = try? JSONDecoder().decode(GUIEvent.self, from: pending) {
                await self?.receive(event, role: role, generation: currentGeneration)
            }
            await Self.waitForExit(process)
            let diagnostic = await stderrTask.value
            await self?.workerExited(role: role, process: process, diagnostic: diagnostic, generation: currentGeneration)
        }
    }

    nonisolated private static func readPipe(_ handle: FileHandle, toEnd: Bool = false) async -> Data {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: toEnd ? handle.readDataToEndOfFile() : handle.availableData)
            }
        }
    }

    nonisolated private static func waitForExit(_ process: Process) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                process.waitUntilExit()
                continuation.resume()
            }
        }
    }

    private func receive(_ event: GUIEvent, role: String, generation expected: UUID) {
        guard expected == generation else { return }
        if event.type.hasPrefix("keyboard-text-") {
            receiveKeyboardText(event, role: role)
            return
        }
        if role == "host", event.type == "cleanup-blocked" || event.cleanupBlocked == true {
            guard postRun.receive("cleanup-blocked") else { return }
            if ounceCakeSession.hasStarted { ounceCakeSession.stop(cleanupBlocked: true) }
            if let folder = sessionURL(event.path) { homebrewFolder = folder }
            homebrewMessage = event.message ?? "The tool could not confirm that its server stopped safely."
            append(homebrewMessage, channel: .host)
            presentPostRunState()
            return
        }
        if event.type == "account-progress" {
            guard role == "host", postRun.homebrewAttempted,
                  homebrewApp == .mintBrew,
                  let update = event.watchProgress else { return }
            accountProgressHandler?(update)
            return
        }
        if role == "hid", event.partial == true || ["typing", "keyboard-ready", "line-start", "line-complete", "command-start",
            "command-complete", "command-prefix-complete", "transfer-complete"].contains(event.type) {
            currentUSBStepHasProof = true
            safeBootstrapRetryAfterUSBFailure = false
        }
        if event.type != "host-stage" && event.type != "izlauncher-panel", let message = event.message {
            append(message, channel: role == "host" ? .host : .usb)
        }
        if phase == .cancelled || phase == .failed || phase == .verified || phase == .rpcDetached { return }
        if role == "hid", hidPurpose == "save-bootstrap",
           ["typing", "command-start", "command-complete", "transfer-complete"].contains(event.type) {
            receiveBootstrapSave(event)
            return
        }
        switch event.type {
        case "rpc-attached":
            guard role == "host", isAttachedRPCSession, phase == .rpcAttaching,
                  let directory = sessionURL(event.path), directory == attachedRunDirectory,
                  event.sourceSession == directory.lastPathComponent else { return }
            guard postRun.ready(), postRun.choose(keepRPC: true, dumpFirmware: false), postRun.receive("rpc-held") else { return }
            runFolder = directory
            hostReadyReceived = true
            presentPostRunState()
            requestIZlauncherModules()
        case "rpc-detached":
            guard role == "host", isAttachedRPCSession,
                  phase == .rpcFinishing, !postRun.cleanupBlocked, event.cleanupBlocked != true,
                  let directory = sessionURL(event.path), directory == attachedRunDirectory,
                  event.sourceSession == directory.lastPathComponent else { return }
            postRun.stop(); hostCompleted = true; endSessionActivity()
            phase = .rpcDetached; status = "Disconnected from RPC"
            detail = "This app’s homebrew workers have stopped. The original host still owns the open RPC session."
            progress = nil; progressLabel = ""
        case "keyboard-ready":
            guard role == "hid", event.mode == nil || event.mode == hidPurpose else { return }
            if hidPurpose == "live", hostOnlyKeyboardRunning, phase == .waitingForConsole,
               !keyboardStopRequested {
                rememberSuccessfulController(event.controller)
                hostOnlyKeyboardReady = true
                keyboardStatus = event.message ?? "Keyboard connected. Click the typing area to begin."
            } else if hidPurpose == "live", phase == .keyboardConnecting, !keyboardStopRequested {
                rememberSuccessfulController(event.controller)
                phase = .keyboardForwarding
                keyboardStatus = completingStartWithKeyboard
                    ? activeHost.startArgumentCount == 9
                        ? "Click the typing area. Enter the host IP as four comma-separated numbers, then the host’s four token numbers, add ), then press Enter."
                        : "Click the typing area. Enter the host IP as four comma-separated numbers, add ), then press Enter."
                    : event.message ?? "Keyboard connected. Click the typing area to begin."
                detail = completingStartWithKeyboard ? keyboardStatus : "Click the typing area to type on your Switch. Escape stops forwarding."
                status = "Keyboard connected"; progress = nil; isEnumerating = false
            }
        case "keyboard-stopped":
            guard role == "hid", hidPurpose == "live" else { return }
            resetKeyboardTextTransfer(message: keyboardTextSending ? "Text sending stopped. Check the Switch before sending again." : keyboardTextStatus)
            hidCompletionReceived = true
            keyboardStatus = event.message ?? "Keyboard disconnected."
            if hostOnlyKeyboardRunning {
                hostOnlyKeyboardRunning = false; hostOnlyKeyboardReady = false
                if phase == .waitingForConsole {
                    status = hostStageLabel
                    detail = "The host is still waiting. Enter the console commands manually, then keep SmileBASIC open."
                }
            } else if phase != .cancelled && phase != .failed {
                phase = .ready; status = "Keyboard disconnected"; progress = nil; isEnumerating = false
            }
        case "host-ready":
            guard role == "host", !isAttachedRPCSession, phase == .hostStarting, let runtime else { return }
            hostReadyReceived = true
            if let start = event.startCommand, PostBootstrapCommandSelection.validStartCommand(start, host: activeHost),
               start.dropFirst(8).dropLast().split(separator: ",").dropFirst().prefix(4).joined(separator: ".") == activeAddress {
                hostStartCommand = start
            }
            if activeRunMode.isHostOnly {
                phase = .waitingForConsole; status = "Host ready — enter the commands on your Switch"
                detail = "The host is waiting. Enter LOAD, RUN, REMOVE and START yourself, or send them over USB below."
                progress = nil; progressLabel = "Waiting for your console commands"
            } else {
                startHID("commands", root: runtime.root)
            }
        case "network-unavailable":
            guard role == "host" else { return }
            let message = event.message ?? "This Mac’s selected network address is no longer available. Review the current address before starting again."
            if !handleNetworkUnavailable(message, retrySafe: event.retrySafe == true) { fail(message) }
        case "run-folder":
            guard !isAttachedRPCSession else { return }
            if let path = event.path { runFolder = URL(fileURLWithPath: path) }
        case "post-run-ready":
            guard role == "host", !isAttachedRPCSession else { return }
            if hostOnlyKeyboardRunning { stopKeyboardForwarding() }
            guard let action = activeRunMode.postRunAction,
                  let command = event.rpcCommand, !command.isEmpty else {
                fail("The host offered a live endpoint that does not match the selected run mode.")
                return
            }
            guard postRun.ready() else { return }
            hostIsExploiting = false
            if let folder = sessionURL(event.path) { runFolder = folder }
            rpcCommand = command
            guard sendHostControl(action.control) else { return }
            postRun.choose(keepRPC: action.keepRPC, dumpFirmware: action.dumpFirmware)
            presentPostRunState()
        case "rpc-held":
            guard role == "host", let folder = sessionURL(event.path), postRun.receive(event.type) else { return }
            hostIsExploiting = false
            if let command = event.rpcCommand { rpcCommand = command }
            runFolder = folder
            presentPostRunState()
            if activeRunMode == .heldRPC {
                let account = mintBrewAccountProvider?()
                launchMintBrew(accountAddons: account?.addonURLs ?? [],
                               libraryItems: account?.libraryItems ?? [])
                if !postRun.homebrewAttempted { requestIZlauncherModules() }
            } else {
                requestIZlauncherModules()
            }
        case "izlauncher-catalog":
            guard role == "host", postRun.stage == .held,
                  let modules = event.modules, modules.count <= 64,
                  Set(modules.map(\.id)).count == modules.count else { return }
            let previous = selectedIZlauncherModuleIDs
            izlauncherModules = modules
            selectedIZlauncherModuleIDs = izlauncherCatalogLoaded
                ? previous.intersection(Set(modules.map(\.id))) : []
            izlauncherCatalogLoaded = true
            izlauncherModuleMessage = modules.isEmpty ? "No compatible IZlauncher modules are installed on this Mac." :
                "Standard modules load automatically. Select up to 15 to load a specific set."
        case "izlauncher-panel":
            guard role == "host", postRun.stage == .held,
                  [.launching, .running].contains(postRun.homebrewStage), homebrewApp == .izlauncher,
                  let folder = sessionURL(event.path), folder == homebrewFolder,
                  let rawURL = event.url, let url = IZlauncherPanelAddress.parse(rawURL) else { return }
            izlauncherPanelURL = url
            izlauncherPanelMessage = ""
            izlauncherPanelChecking = false
        case "homebrew-accepted":
            guard role == "host", let action = event.action, action == pendingHomebrewAction else { return }
            let customOunceCake = action == "launch-custom-homebrew" &&
                event.customHomebrewKind == "rpc-app" && event.adapter == "ouncecake"
            var compatibleSession: OunceCakeSession?
            if customOunceCake {
                var session = OunceCakeSession()
                guard let address = pendingCustomConsoleAddress, session.begin(consoleAddress: address) else {
                    pendingHomebrewAction = nil
                    pendingCustomConsoleAddress = nil
                    fail("Enter your Switch IP address before starting this OunceCake-compatible package.")
                    return
                }
                compatibleSession = session
            }
            guard postRun.launchHomebrew() else { return }
            pendingHomebrewAction = nil
            pendingCustomConsoleAddress = nil
            if let session = compatibleSession {
                ounceCakeSession = session
                selectedOunceCakeGame = ""
            }
            homebrewMessage = event.message ?? "Opening the selected app in the console launcher…"
            presentPostRunState()
        case "homebrew-started", "homebrew-running", "homebrew-stopped", "homebrew-failed":
            let preserveFailure = postRun.homebrewStage == .failed && event.type == "homebrew-stopped"
            if role == "host", event.type == "homebrew-running", ounceCakeSession.hasStarted {
                guard postRun.stage == .held, postRun.homebrewStage == .launching,
                      ounceCakeSession.stage == .preparing else { return }
                guard ounceCakeSession.receiveEndpoint(host: event.host, port: event.port, ftpURL: event.ftpURL) else {
                    postRun.receive("homebrew-failed"); ounceCakeSession.stop(failed: true)
                    homebrewMessage = "The game server did not confirm a valid FTP address. Finish the session and keep the logs."
                    presentPostRunState()
                    return
                }
            }
            guard role == "host", postRun.receive(event.type, retrySafe: event.retrySafe == true) else { return }
            if let folder = sessionURL(event.path) { homebrewFolder = folder }
            if event.type == "homebrew-stopped" || event.type == "homebrew-failed" {
                izlauncherPanelURL = nil; izlauncherPanelMessage = ""; izlauncherPanelChecking = false
            }
            if !preserveFailure { homebrewMessage = event.message ?? "\(homebrewTitle) session changed." }
            if ounceCakeSession.hasStarted, !preserveFailure, ["homebrew-stopped", "homebrew-failed"].contains(event.type) {
                ounceCakeSession.stop(failed: event.type == "homebrew-failed")
            }
            presentPostRunState()
            if event.type == "homebrew-failed", event.retrySafe == true, postRun.canLaunchHomebrew {
                detail = homebrewMessage
            }
        case "homebrew-catalog":
            guard role == "host", postRun.stage == .held, postRun.homebrewStage == .launching,
                  ounceCakeSession.stage == .discovering else { return }
            var session = ounceCakeSession
            guard let games = event.games, session.receiveCatalog(games) else {
                postRun.receive("homebrew-failed"); ounceCakeSession.stop(failed: true)
                homebrewMessage = "The game list was invalid. Finish this session and keep the logs."
                presentPostRunState()
                return
            }
            guard postRun.receive(event.type) else { return }
            ounceCakeSession = session; selectedOunceCakeGame = session.games.first?.titleId ?? ""
            if let folder = sessionURL(event.path) { homebrewFolder = folder }
            homebrewMessage = "Choose a game to make its files available over FTP."
            presentPostRunState()
        case "homebrew-progress":
            guard role == "host", phase == .launchingHomebrew || phase == .homebrewRunning else { return }
            homebrewMessage = event.message ?? "\(homebrewTitle) is working…"
            progressLabel = homebrewMessage
        case "izlauncher-module-progress":
            guard role == "host", phase == .homebrewRunning, homebrewApp == .izlauncher,
                  let message = event.message, !message.isEmpty, message.utf8.count <= 512 else { return }
            izlauncherModuleMessage = message
        case "action-rejected":
            if role == "host", event.action == "dump-system-code" {
                postRun.cancelDumpRequest()
                presentPostRunState()
                detail = event.message ?? "The system-code dump could not start in this held session."
                return
            }
            if role == "host", event.action == "list-izlauncher-modules" {
                izlauncherModuleMessage = event.message ?? "Could not read IZlauncher modules."
                return
            }
            if role == "host", event.action == "load-izlauncher-modules" {
                izlauncherModuleMessage = event.message ?? "Could not load IZlauncher modules."
                return
            }
            if role == "host", let action = event.action, action == pendingHomebrewAction {
                pendingHomebrewAction = nil
                pendingCustomConsoleAddress = nil
                homebrewMessage = event.message ?? "The selected app folder is invalid. Choose another folder."
                presentPostRunState()
                status = "Choose another app folder"
                detail = homebrewMessage
                return
            }
            if role == "host", postRun.homebrewStage == .launching {
                postRun.receive("homebrew-failed")
                homebrewMessage = event.message ?? "The host could not start \(homebrewTitle) in this session."
                if ounceCakeSession.hasStarted { ounceCakeSession.stop(failed: true) }
                presentPostRunState()
            }
        case "dump-started", "dump-complete":
            guard role == "host", postRun.receive(event.type) else { return }
            if let folder = sessionURL(event.path) { dumpFolder = folder }
            presentPostRunState()
        case "dump-progress":
            guard role == "host", phase == .dumpingFirmware else { return }
            progressLabel = event.message ?? "Reading system code…"
        case "rpc-finishing":
            guard role == "host", postRun.receive(event.type) else { return }
            pendingHomebrewAction = nil
            pendingCustomConsoleAddress = nil
            izlauncherPanelURL = nil; izlauncherPanelMessage = ""; izlauncherPanelChecking = false
            hostIsExploiting = false
            presentPostRunState()
        case "rpc-status-started", "rpc-status":
            guard role == "host", postRun.receive(event.type) else { return }
            rpcStatus = event.message ?? (event.type == "rpc-status-started" ? "Checking RPC…" : "RPC check finished.")
        case "controller":
            if role == "hid" {
                status = keyboardIsLoading ? "Loading…" : event.message ?? "Connecting the USB keyboard"
                isEnumerating = true; progress = 0
            }
        case "enumeration-progress":
            if role == "hid" {
                isEnumerating = true
                if let done = event.completed, let total = event.total, total > 0 { progress = min(1, max(0, done / total)) }
                if let remaining = event.remainingMs {
                    progressLabel = String(format: "USB enumeration · %.1f seconds remaining", max(0, remaining) / 1000)
                }
            }
        case "typing":
            guard role == "hid", event.kind == hidPurpose,
                  phase == .bootstrap && hidPurpose == "bootstrap" ||
                  phase == .commands && hidPurpose == (activeRunMode == .commandsOnly ? "commands-only" : "commands") &&
                  event.total == Double(activeCommandCount) else { return }
            hasHIDEvidence = true
            rememberSuccessfulController(event.controller)
            isEnumerating = false; progress = 0
            if phase == .bootstrap {
                hasEnumeratedSuccessfully = true
                startBootstrapTimingIfNeeded()
            }
            if phase == .bootstrap { status = "Typing the SmileBASIC bootstrap"; progressLabel = "Typing bootstrap lines" }
            else if phase == .commands {
                status = "Preparing \((activeCommandSelection?.commands.first ?? .load).label)…"
                progressLabel = "0 of \(activeCommandCount) commands sent"
            }
        case "progress":
            guard role == "hid", phase == .bootstrap,
                  let lineProgress = BootstrapLineProgress(type: event.type, line: event.line,
                    completed: event.completed, total: event.total) else { return }
            progress = lineProgress.fraction
            progressLabel = lineProgress.label
            updateBootstrapEstimate(completed: Double(lineProgress.completed), total: Double(lineProgress.total))
        case "line-start", "line-complete":
            guard role == "hid", phase == .bootstrap,
                  let lineProgress = BootstrapLineProgress(type: event.type, line: event.line,
                    completed: event.completed, total: event.total) else { return }
            isEnumerating = false
            progress = lineProgress.fraction
            progressLabel = lineProgress.label
            if let remaining = event.remainingMs { setBootstrapRemaining(remaining / 1000) }
        case "command-start":
            guard let count = commandProgressCount(event, role: role) else { return }
            isEnumerating = false
            if let done = event.completed { progress = min(1, max(0, done / Double(count))) }
            let step = event.step ?? 1, label = event.label ?? "command"
            status = activeCommandSelection?.startPrefix == true && label == "START" ? "Sending START prefix…" : "Sending \(label)…"
            progressLabel = "\(max(0, step - 1)) of \(count) commands sent"
        case "command-complete":
            guard let count = commandProgressCount(event, role: role) else { return }
            isEnumerating = false
            if let done = event.completed { progress = min(1, max(0, done / Double(count))) }
            let step = event.step ?? 1
            progressLabel = "\(step) of \(count) commands sent"
            status = "\(event.label ?? "Command") sent"
        case "command-prefix-complete":
            guard role == "hid", phase == .commands, hidPurpose == "commands-only", event.kind == "commands-only",
                  let selection = activeCommandSelection, selection.startPrefix,
                  event.step == selection.commands.count, event.total == Double(selection.commands.count),
                  event.completed == Double(selection.commands.count - 1), event.label == "START", event.startPending == true else { return }
            startPrefixCompleted = true; isEnumerating = false
            progress = Double(selection.commands.count - 1) / Double(selection.commands.count)
            status = "START prefix typed — wait for the keyboard"
            progressLabel = "\(selection.commands.count - 1) command\(selection.commands.count == 2 ? "" : "s") sent · START is unfinished"
        case "wait":
            guard let count = commandProgressCount(event, role: role) else { return }
            isEnumerating = false
            if let done = event.completed { progress = min(1, max(0, done / Double(count))) }
            let label = event.label ?? "command"
            status = label == "LOAD confirmation"
                ? (activeEdition == .demo ? "Waiting to confirm LOADV (OK)…" : "Waiting to confirm LOAD (YES)…")
                : "Waiting after \(label)…"
            if let remaining = event.remainingMs {
                progressLabel = String(format: "%.1f seconds remaining · %d of %d commands sent", max(0, remaining) / 1000, Int(event.completed ?? 0), count)
            }
        case "host-stage":
            guard role == "host", hostProcess != nil else { return }
            if hostOnlyKeyboardRunning, event.stage == "connected" || event.stage == "pipeline" {
                stopKeyboardForwarding()
            }
            if [.hostStarting, .commands, .waitingForConsole].contains(phase) {
                if event.stage == "connected" || event.stage == "pipeline" && event.total == 4 &&
                    event.completed.map({ $0.isFinite && (0...3).contains($0) && $0.rounded(.towardZero) == $0 }) == true {
                    hostIsExploiting = true
                } else if event.stage == "waiting" { hostIsExploiting = false }
            }
            hostStageLabel = event.message ?? hostStageLabel
            // Stage events update the status only. The adapter also emits the
            // original line as a log event, which owns the activity/log entry.
            if let done = event.completed, let total = event.total, total > 0 { hostStageProgress = min(1, max(0, done / total)) }
            else { hostStageProgress = nil }
            if phase == .waitingForConsole || phase == .hostStarting {
                status = hostStageLabel; progressLabel = hostStageLabel; progress = hostStageProgress
            }
        case "transfer-complete":
            guard role == "hid" else { return }
            if activeRunMode == .commandsOnly {
                guard phase == .commands, hidPurpose == "commands-only", event.kind == "commands-only",
                      event.total == Double(activeCommandCount),
                      event.completed == Double(activeCommandCount - (activeCommandSelection?.startPrefix == true ? 1 : 0)) else { return }
                if activeCommandSelection?.startPrefix == true {
                    guard startPrefixCompleted, event.startPending == true else { return }
                    keyboardHandoffPending = true
                } else if event.startPending == true { return }
                hidCompletionReceived = true; isEnumerating = false
                workflowProgress.commandsOnlySent()
                endSessionActivity()
                phase = .commandsSent; status = "Commands sent — check your Switch"
                detail = "No ns2jb host was started. Execution, restoration and cleanup have not been verified by this app."
                progress = 1; progressLabel = "\(activeCommandCount) command\(activeCommandCount == 1 ? "" : "s") sent · host not verified"
                if keyboardHandoffPending {
                    status = "Loading…"; keyboardStatus = "Loading…"
                    detail = "The START prefix is unfinished. Wait for the live keyboard to connect before typing."
                    progress = Double(activeCommandCount - 1) / Double(activeCommandCount)
                    progressLabel = "\(activeCommandCount - 1) command\(activeCommandCount == 2 ? "" : "s") sent · START is unfinished"
                }
                return
            }
            hidCompletionReceived = true
            isEnumerating = false
            if event.kind == "bootstrap" {
                appendBootstrapDuration(outcome: "completed")
                workflowProgress.bootstrapTransferred()
                phase = .awaitingSave
                status = "Ready to save \(activeHost.saveName)"
                detail = "Press X on the Switch to enter Direct mode, then let mac2jb type the save command below."
                progress = 1; progressLabel = "Bootstrap transfer complete"
            } else if !hostCompleted && !postRun.isActive {
                phase = .waitingForConsole; status = hostStageLabel
                detail = activeHost == .izmysh
                    ? "Keyboard delivery is complete. IZMYSH must independently verify its native session and restore temporary memory."
                    : "Keyboard delivery is complete. The host must independently verify FS execution and cleanup."
                progress = hostStageProgress; progressLabel = hostStageLabel
            }
        case "verified":
            guard role == "host", activeRunMode != .commandsOnly, !isAttachedRPCSession, !postRun.cleanupBlocked else { return }
            if hostOnlyKeyboardRunning { stopKeyboardForwarding() }
            hostIsExploiting = false
            postRun.receive(event.type)
            endSessionActivity()
            workflowProgress.complete()
            hostCompleted = true
            phase = .verified
            if activeHost == .izmysh {
                status = "IZMYSH native session verified"
                detail = "IZMYSH verified its native session and restored scratch memory and its import. The app closed RPC. Restart the console when finished."
                progressLabel = "Native session, scratch and import verified"
            } else {
                status = "FS execution verified"
                detail = "The host verified execution, restored the original instructions, and cleaned up scratch space. Restart the console when finished."
                progressLabel = "Execution, restoration and cleanup verified"
            }
            progress = 1; isEnumerating = false
        case "failed":
            if role == "hid", hostOnlyKeyboardRunning {
                let message = event.message ?? "The live keyboard stopped. Inspect the Switch before trying again."
                stopKeyboardForwarding()
                keyboardStatus = message
                return
            }
            let safeBootstrapRetry = role == "hid" && event.retrySafe == true && !currentUSBStepHasProof &&
                activeRunMode == .bootstrapOnly && hidPurpose == "bootstrap"
            fail(event.message ?? "The session did not finish. Inspect the Switch before retrying.", safeBootstrapRetry: safeBootstrapRetry)
        case "cancelled":
            hostIsExploiting = false
            if hostProcess == nil { endSessionActivity() }
            detail = SessionRecovery.message(event.message ?? "Session stopped.", interruptedPhase: phase)
            postRun.stop()
            if ounceCakeSession.hasStarted { ounceCakeSession.stop() }
            workflowProgress.cancel()
            phase = .cancelled; status = "Session stopped"; progress = nil; progressLabel = ""; isEnumerating = false
        default: break
        }
    }

    private func receiveBootstrapSave(_ event: GUIEvent) {
        guard phase == .savingBootstrap, event.kind == "save-bootstrap", event.total == 1,
              !hidCompletionReceived else { return }
        switch event.type {
        case "typing":
            guard event.completed == 0, !saveCommandStarted else { return }
            saveTypingStarted = true
            hasHIDEvidence = true
            rememberSuccessfulController(event.controller)
            isEnumerating = false; progress = 0
            status = "Typing the save command"
            progressLabel = "Saving \(activeHost.saveName) · check your Switch when typing finishes"
        case "command-start":
            guard event.step == 1, event.completed == 0, event.label == "SAVE", saveTypingStarted, !saveCommandStarted else { return }
            saveCommandStarted = true; isEnumerating = false; progress = 0
            status = "Typing the save command"
        case "command-complete":
            guard event.step == 1, event.completed == 1, event.label == "SAVE",
                  saveCommandStarted, !saveCommandCompleted else { return }
            saveCommandCompleted = true; progress = 1
            status = "Save command typed"
            progressLabel = "Waiting for the keyboard to disconnect"
        case "transfer-complete":
            guard event.completed == 1, event.startPending != true, saveCommandStarted, saveCommandCompleted else { return }
            hidCompletionReceived = true; isEnumerating = false
        default: break
        }
    }

    private func workerExited(role: String, process: Process, diagnostic: Data, generation expected: UUID) {
        guard expected == generation else { return }
        if role == "host", hostProcess === process {
            hostIsExploiting = false
            try? hostInput?.fileHandleForWriting.close()
            hostInput = nil; hostProcess = nil
            if phase == .cancelled || phase == .failed { endSessionActivity() }
        }
        if role == "hid", hidProcess === process {
            if hidPurpose == "live", keyboardTextSending {
                resetKeyboardTextTransfer(message: "Text sending stopped. Check the Switch before sending again.")
            }
            hidProcess = nil; try? keyboardInput?.fileHandleForWriting.close(); keyboardInput = nil
            if process.terminationReason != .exit || process.terminationStatus != 1 {
                safeBootstrapRetryAfterUSBFailure = false
            }
        }
        if !diagnostic.isEmpty, let text = String(data: diagnostic, encoding: .utf8) { append(text, channel: role == "host" ? .host : .usb) }
        if role == "host", preflightNetworkFailureHandled { endSessionActivity(); return }
        guard phase != .cancelled, phase != .failed, phase != .verified else { return }
        if role == "hid", hidPurpose == "live", hostOnlyKeyboardRunning {
            hostOnlyKeyboardRunning = false; hostOnlyKeyboardReady = false
            if !hidCompletionReceived {
                keyboardStatus = "Live keyboard ended without confirming key release. Inspect the Switch before typing again."
            }
            if phase == .waitingForConsole { status = hostStageLabel }
            return
        }
        if role == "hid", keyboardStopRequested, hidPurpose == "live", hidCompletionReceived { return }
        if process.terminationStatus != 0 {
            fail("The \(role == "host" ? "host" : "USB transfer") stopped unexpectedly. Inspect the Switch before retrying.")
        } else if role == "host" && !hostCompleted {
            fail(isAttachedRPCSession
                 ? "The RPC connection helper ended without confirming disconnection. Keep the logs and inspect the original host."
                 : "The host ended without final cleanup verification. Keep the logs and restart the console before another attempt.")
        } else if role == "hid" && !hidCompletionReceived {
            fail("The keyboard helper ended without confirming completion. Inspect the Switch before trying again.")
        } else if role == "hid", hidPurpose == "save-bootstrap", phase == .savingBootstrap {
            bootstrapSaveCommandSent = true
            phase = .awaitingSave; status = "Save command typed — check your Switch"
            detail = "Confirm saving on the Switch. Overwrite the existing \(activeHost.saveName) file if prompted, then wait for saving to finish and confirm below."
            progress = nil; progressLabel = "Save command sent · save confirmation required"
        } else if role == "hid", hidPurpose == "commands-only", keyboardHandoffPending,
                  phase == .commandsSent, hidCompletionReceived, startPrefixCompleted {
            keyboardHandoffPending = false
            guard runtime != nil, driverLoaded, !driverSetupRunning else {
                fail("The START prefix is unfinished and the live keyboard could not start. Check the USB driver before continuing.")
                return
            }
            beginKeyboardForwarding(completingStart: true)
        }
    }

    private func commandProgressCount(_ event: GUIEvent, role: String) -> Int? {
        let purpose = activeRunMode == .commandsOnly ? "commands-only" : "commands"
        let commands = activeCommandSelection?.commands ?? PostBootstrapCommand.allCases
        guard role == "hid", phase == .commands, hidPurpose == purpose, event.kind == purpose,
              event.total == Double(commands.count),
              let completed = event.completed, completed.isFinite,
              completed.rounded(.towardZero) == completed, (0...Double(commands.count)).contains(completed) else { return nil }
        if event.type == "wait" {
            guard let label = event.label, commands.map(\.label).contains(label) ||
                  label == "LOAD confirmation" && commands.contains(.load) else { return nil }
        } else {
            guard let step = event.step, (1...commands.count).contains(step),
                  event.label == commands[step - 1].label,
                  !(activeCommandSelection?.startPrefix == true && commands[step - 1] == .start && event.type == "command-complete"),
                  completed == Double(step - (event.type == "command-start" ? 1 : 0)) else { return nil }
        }
        return commands.count
    }

    private func stopWorkers() {
        resetKeyboardTextTransfer(message: keyboardTextSending ? "Text sending stopped. Check the Switch before sending again." : keyboardTextStatus)
        try? keyboardInput?.fileHandleForWriting.close(); keyboardInput = nil
        for worker in [hostProcess, hidProcess].compactMap({ $0 }) where worker.isRunning { worker.terminate() }
    }

    private func fail(_ message: String, safeBootstrapRetry: Bool = false) {
        // Capture the failed stage atomically on the model's main actor. A
        // later cancellation/exit callback must not infer it from .failed.
        let recovery = recoveryMessage(message)
        hostIsExploiting = false
        keyboardHandoffPending = false
        safeBootstrapRetryAfterUSBFailure = safeBootstrapRetry && !currentUSBStepHasProof
        workflowProgress.fail()
        if hostProcess == nil { endSessionActivity() }
        ensureFallbackLog()
        postRun.stop()
        izlauncherPanelURL = nil; izlauncherPanelMessage = ""; izlauncherPanelChecking = false
        if ounceCakeSession.hasStarted { ounceCakeSession.stop(failed: true) }
        error = recovery; detail = recovery
        phase = .failed; status = "The session needs attention"
        progress = nil; progressLabel = ""; isEnumerating = false
        append(recovery)
        appendBootstrapDuration(outcome: "failed")
        // A conclusive pre-enumeration failure is emitted only after the USB
        // child has closed. Let its adapter exit normally before offering Skip.
        if !safeBootstrapRetryAfterUSBFailure { stopWorkers() }
    }

    private func recoveryMessage(_ message: String) -> String {
        guard isAttachedRPCSession else { return SessionRecovery.message(message, interruptedPhase: phase) }
        let originalHost = "The original host owns the RPC session and has not been stopped by this app."
        if postRun.homebrewAttempted || postRun.cleanupBlocked {
            return message + " " + originalHost + " Keep the homebrew logs and restart the console before another app attempt."
        }
        return message + " " + originalHost + " Check that it is still open before reconnecting."
    }

    private func resetBootstrapTiming() {
        bootstrapTimer?.invalidate(); bootstrapTimer = nil
        bootstrapStartedAt = nil
        bootstrapFinishAt = nil
        bootstrapElapsedSeconds = 0
        bootstrapEstimatedRemainingSeconds = nil
    }

    private func startBootstrapTimingIfNeeded() {
        guard bootstrapStartedAt == nil else { return }
        bootstrapStartedAt = Date()
        bootstrapTimer?.invalidate()
        bootstrapTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let started = self.bootstrapStartedAt else { return }
                self.bootstrapElapsedSeconds = Date().timeIntervalSince(started)
                if let finish = self.bootstrapFinishAt { self.bootstrapEstimatedRemainingSeconds = max(0, finish.timeIntervalSinceNow) }
            }
        }
    }

    private func updateBootstrapEstimate(completed: Double, total: Double) {
        guard total > 0, let started = bootstrapStartedAt else { return }
        let elapsed = Date().timeIntervalSince(started)
        bootstrapElapsedSeconds = elapsed
        let fraction = min(1, max(0, completed / total))
        if fraction > 0.01 { setBootstrapRemaining(elapsed / fraction - elapsed) }
    }

    private func setBootstrapRemaining(_ seconds: Double) {
        guard bootstrapStartedAt != nil, seconds.isFinite, seconds >= 0, seconds <= 7 * 24 * 60 * 60 else { return }
        bootstrapFinishAt = Date().addingTimeInterval(seconds)
        bootstrapEstimatedRemainingSeconds = seconds
    }

    private func appendBootstrapDuration(outcome: String) {
        guard let started = bootstrapStartedAt else { return }
        let elapsed = Date().timeIntervalSince(started)
        bootstrapElapsedSeconds = elapsed
        bootstrapTimer?.invalidate(); bootstrapTimer = nil
        bootstrapFinishAt = nil
        bootstrapEstimatedRemainingSeconds = outcome == "completed" ? 0 : bootstrapEstimatedRemainingSeconds
        append(String(format: "Bootstrap typing %@ after %.1f seconds.", outcome, elapsed))
        bootstrapStartedAt = nil
    }

    private func endSessionActivity() {
        if let activity = sessionActivity {
            ProcessInfo.processInfo.endActivity(activity)
            sessionActivity = nil
        }
    }

    private enum LogChannel { case host, usb }

    private func append(_ message: String, channel: LogChannel? = nil) {
        let line = message + "\n"
        log += line
        if let bytes = line.data(using: .utf8) { try? sessionLog?.write(contentsOf: bytes) }
        if let channel {
            switch channel {
            case .host:
                hostLog += line; try? hostSessionLog?.write(contentsOf: line.data(using: .utf8)!)
            case .usb:
                usbLog += line; try? usbSessionLog?.write(contentsOf: line.data(using: .utf8)!)
            }
        }
        if log.utf8.count > 50000 { log = String(log.suffix(40000)) }
    }

    private func openSessionLog(in root: URL) {
        let file = root.appendingPathComponent("gui-session.log")
        let descriptor = open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        if descriptor >= 0 {
            sessionLog = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            diagnosticLogURL = file
            hostSessionLog = makeChannelLog(in: root, name: "host-session.log")
            usbSessionLog = makeChannelLog(in: root, name: "usb-session.log")
            if let history = log.data(using: .utf8), !history.isEmpty { try? sessionLog?.write(contentsOf: history) }
        }
        else { error = "The private diagnostic log could not be created. Session logs may be incomplete." }
    }

    private func makeChannelLog(in root: URL, name: String) -> FileHandle? {
        let file = root.appendingPathComponent(name)
        let descriptor = open(file.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        return descriptor >= 0 ? FileHandle(fileDescriptor: descriptor, closeOnDealloc: true) : nil
    }

    private func ensureFallbackLog() {
        guard sessionLog == nil else { return }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("mac2jb-gui-error-" + UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false,
                                                    attributes: [.posixPermissions: 0o700])
            openSessionLog(in: folder)
            append("\(AppBuildIdentity.diagnosticLabel): runtime preparation diagnostic log.")
        } catch { diagnosticLogURL = nil }
    }

    nonisolated static func isIPv4(_ address: String) -> Bool {
        NetworkSelection.isIPv4(address)
    }

    nonisolated private static func capture(_ executable: String, _ arguments: [String]) -> (Int32, String) {
        let process = Process(); let output = Pipe()
        process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
        process.standardOutput = output; process.standardError = output; process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return (1, error.localizedDescription) }
        let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
