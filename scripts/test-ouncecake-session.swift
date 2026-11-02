import Foundation

@main struct OunceCakeSessionTests {
    static func main() {
        var checks = 0
        func check(_ condition: Bool, _ label: String) {
            precondition(condition, label); checks += 1
        }
        let game = OunceCakeGame(titleId: "0100ABCDEF123456", name: "Game\nname", storages: [5, 4])
        for bad in ["", "192.168.1", "192.168.1.999", "192.168.01.2", "ftp://192.168.1.2", "127.0.0.1:2121", "192.168.1.2\nother"] {
            check(OunceCakeSession.validConsoleAddress(bad) == nil, "reject invalid console address")
        }
        var session = OunceCakeSession()
        check(session.begin(consoleAddress: " 192.168.1.20 "), "capture explicit address")
        check(!session.begin(consoleAddress: "192.168.1.21") && session.consoleAddress == "192.168.1.20", "address remains captured")
        check(!session.receiveEndpoint(host: "192.168.1.20", port: 2121, httpURL: nil), "no endpoint before catalog/selection")
        for invalid in [[], [game, game], [OunceCakeGame(titleId: "not-a-title", name: "Game", storages: [4])],
                        [OunceCakeGame(titleId: game.titleId, name: "Game", storages: [9])],
                        [OunceCakeGame(titleId: game.titleId, name: String(repeating: "x", count: 161), storages: [4])]] {
            var invalidSession = session
            check(!invalidSession.receiveCatalog(invalid) && invalidSession.stage == .discovering, "reject invalid catalog atomically")
        }
        check(session.receiveCatalog([game]) && session.stage == .choosing, "valid catalog enables selection")
        check(session.games[0].titleId == "0100abcdef123456" && session.games[0].name == "Game name", "catalog labels sanitized")
        check(!session.receiveCatalog([game]), "duplicate catalog ignored")
        check(!session.select(titleId: "0100000000000000"), "forged selection rejected")
        check(session.select(titleId: "0100abcdef123456") && session.stage == .preparing, "one catalog member selected")
        check(!session.select(titleId: "0100abcdef123456"), "selection cannot replay")
        check(!session.receiveEndpoint(host: "192.168.1.21", port: 2121, httpURL: nil), "other console endpoint rejected")
        check(!session.receiveEndpoint(host: "192.168.1.20", port: 21, httpURL: nil), "unexpected WebDAV port rejected")
        check(!session.receiveEndpoint(host: "192.168.1.20", port: 2121, httpURL: "http://user:secret@192.168.1.20:2121/"), "credential URL rejected")
        check(!session.receiveEndpoint(host: "192.168.1.20", port: 2121, httpURL: "ftp://192.168.1.20:2121"), "FTP URL rejected")
        check(session.receiveEndpoint(host: "192.168.1.20", port: 2121, httpURL: "http://192.168.1.20:2121/"), "confirmed endpoint accepted")
        check(session.endpoint?.address == "http://192.168.1.20:2121/", "copy address uses console IP")
        session.stop(cleanupBlocked: true)
        check(session.endpoint == nil && session.stage == .cleanupBlocked, "uncertain cleanup hides endpoint")
        session.stop()
        check(session.stage == .cleanupBlocked && !session.begin(consoleAddress: "192.168.1.20"), "cleanup block cannot reset or relaunch")

        func held() -> PostRunSessionState {
            var state = PostRunSessionState()
            state.ready(); state.choose(keepRPC: true, dumpFirmware: false); state.receive("rpc-held")
            return state
        }
        var state = held()
        check(!state.receive("homebrew-catalog") && !state.canSelectHomebrew, "catalog requires an attempted tool")
        check(state.launchHomebrew() && !state.canFinish, "startup defers Finish")
        check(state.receive("homebrew-catalog") && state.canSelectHomebrew && state.canFinish, "catalog permits selection or Finish")
        check(!state.canLaunchHomebrew && !state.canCheckStatus, "catalog consumes one-tool gate")
        check(state.selectHomebrew() && !state.canSelectHomebrew && !state.canFinish, "mount preparation cannot replay selection")
        check(state.receive("homebrew-running") && state.canFinish, "ready WebDAV permits Finish")
        check(state.receive("cleanup-blocked") && state.cleanupBlocked && !state.canFinish, "uncertain native cleanup blocks Finish")
        check(!state.receive("verified") && !state.canLaunchHomebrew && !state.canSelectHomebrew, "uncertain cleanup cannot become verified")
        state.stop()
        check(!state.receive("verified") && state.cleanupBlocked, "Stop retains cleanup block")
        var choosing = held(); choosing.launchHomebrew(); choosing.receive("homebrew-catalog")
        check(choosing.finish() && !choosing.selectHomebrew(), "Finish closes catalog controls")
        check(choosing.receive("homebrew-stopped") && choosing.receive("verified"), "normal catalog cancellation verifies only final cleanup")
        var finishing = held(); finishing.launchHomebrew(); finishing.receive("homebrew-running"); finishing.finish()
        check(finishing.receive("cleanup-blocked") && finishing.stage == .blocked, "cleanup failure can arrive while finishing")
        check(!finishing.receive("homebrew-stopped") && !finishing.receive("verified"), "late stop cannot erase uncertain cleanup")
        check(!finishing.canFinish && !finishing.canLaunchHomebrew, "blocked finishing cannot restart cleanup or launch")
        print("OunceCake catalog, selection, endpoint and cleanup checks passed: \(checks). No console commands sent.")
    }
}
