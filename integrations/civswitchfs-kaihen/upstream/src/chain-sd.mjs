// Split persistent chain — part 1 (save-resident). Runs the CivSwitchFS
// promotion; on success reads part 2 — the kaiHEN bundle — from
// /kaihen/payload.js on the SD card through the promoted session and
// evals it in one piece. Part 2 is staged by tools/kaihen.mjs like the
// other ship files, so kaiHEN-side updates are an SD file copy and the
// save image stays roughly CivSwitchFS-sized no matter how the kaiHEN
// half grows.
//
// Presence-only gate on part 2 (user decision 2026-11-16): no digest
// check — a torn copy almost always fails to parse inside its own
// try/catch, and the one-launch guard (inside part 2) keeps a parse
// failure from consuming the boot.

import coreRuntime from "./core/runtime.mjs";
import {run as runPromotion} from "./core.js";
import {SD_MANIFEST, ensureArena, arenaSlots} from "./kaihen/state.mjs";
import {openSdCard, sdGetEntryType, sdReadFile} from "./kaihen/sdcard.mjs";

const {log} = coreRuntime;

const PART2_PATH = "/kaihen/payload.js";
const PART2_MAX = 512 * 1024;

function bytesToSource(bytes) {
    // Chunked conversion: String.fromCharCode.apply has an argument
    // limit far below payload sizes.
    let out = "";
    for (let at = 0; at < bytes.length; at += 8192)
        out += String.fromCharCode.apply(null,
            bytes.slice(at, Math.min(at + 8192, bytes.length)));
    return out;
}

export async function run() {
    await runPromotion();

    // Gate on the retained-boot snapshot the chain re-derives from. A
    // promotion lottery loss ends here, cleanly: restart the game and the
    // whole sequence runs again.
    const state = globalThis.fsKaihen;
    if (!state || !state.domainSession) {
        await log("CHAIN: promotion did not retain a session — " +
            "kaiHEN not started; restart the game to retry");
        return;
    }

    await log("CHAIN: promotion retained a session — " +
        "loading kaiHEN from " + PART2_PATH);
    // The status-mode context shape: the promoted session plus the IPC
    // arena, exactly what the sdcard helpers need (proven by status mode).
    const context = {state,
        fspSrv: {handle: state.domainSession.handle,
            rootObj: state.domainSession.rootObj},
        candidateHandle: state.candidateHandle, handles: []};
    ensureArena(context);
    arenaSlots(context);
    const sd = openSdCard(context);
    const entry = sdGetEntryType(context, sd, PART2_PATH);
    if (!(entry.transport === 0 && entry.result === 0))
        throw Error(PART2_PATH + " is missing — run the kaiHEN launcher " +
            "once to stage it, then restart the game");
    const payload = sdReadFile(context, sd, PART2_PATH, PART2_MAX);
    await log("CHAIN: part 2 loaded (" + payload.size + " bytes) — eval");

    // Same prelude the launcher sends before src/kaihen.js: run mode,
    // the safe default skips (dx/probes close the loader session copy),
    // and the version-pinned SD manifest.
    globalThis.__KH_MODE = "run";
    globalThis.__KH_SKIP = ["dx", "probes"];
    globalThis.__KH_MANIFEST = SD_MANIFEST;
    // DIRECT eval on purpose: the save stage evaluates part 1 itself in
    // a direct eval, and environment names (log, read64, malloc, …) live
    // in that closure — an indirect eval would drop them. Part 2 gets
    // this scope chain; the bundle is self-contained and strict-mode
    // clean, so the extra scope is inert.
    const result = eval(bytesToSource(payload.bytes));
    if (result && typeof result.then === "function") await result;
}
