import coreRuntime from "../runtime.mjs";
import {log, verboseLog} from "../logger.mjs";

const {
  allocPage,
  call_rop,
  closeHandle,
  GADGET_MEMSET,
  hex32,
  ipcCommitChecked,
  ipcDeleteDirectoryRecursivelyChecked,
  ipcDeleteFileChecked,
  ipcGetEntryTypeChecked,
  ipcFileInvalidate,
  ipcStorageInvalidate,
  ipcStorageGetSize,
  ipcStorageRead,
  openContentStorage
} = coreRuntime;

// kaiHEN's donor pair sits at the root of the game's save: /main (the RO
// image) and /main.npdm (the captured policy). It is deliberately KEPT —
// the next kaiHEN run reuses it by hash instead of rewriting the save, so
// this every-boot cleanup must not wipe it (see kaihen/donor.mjs). Only the
// kaiHEN donor stage may remove the pair, and only when its content no
// longer matches. Put the names back in this list to restore the wipe.
const DONOR_LEFTOVER_FILES = [];

// ── Cleanup and retirement (S19–S21) ────────────────────────────────────────
//
// Safety model — two states, two recovery paths:
//
// State A (alias only, no IStorage::Write done):
//   The cache entry is CLEAN from fsp-srv's perspective. The race wrote
//   bytes into the entry's header via path normalization, but fsp-srv's
//   internal dirty tracking was never updated.
//   → Recovery: invalidate the full storage range, then verify the original
//     bytes on a fresh IStorage handle before allowing retry or restart.
//
// State B (retained endpoint active, IStorage::Write done):
//   The IStorage::Write calls for PID promotion went through fsp-srv's
//   normal write path, which marks the entry as dirty internally.
//   → Recovery: verify the retained endpoint's zero-count layout and close
//     its candidate storage handle. Do not invalidate this dirty entry.
//   → If endpoint retirement fails: STOP. Do NOT retry; its state is unknown.
//
// The retainedEndpointActive flag distinguishes the two states.

// Canonical unsafe-state verdict. Every site prints the same action
// block so the instruction is identical wherever the warning appears.
export function formatUnsafeState(reason) {
    const detail = String(reason || "retained endpoint may be active")
        .replace(/[.!]+$/, "");
    return "STATE IS UNSAFE - " + detail +
        ". Do not close the game or reboot normally; hard reboot now " +
        "(hold Power for 15 seconds).";
}

function readStorageHex(storageHandle, offset, helpers) {
    try {
        var buffer = allocPage(0x1000);
        call_rop(GADGET_MEMSET, buffer, 0xA5n, 16n);
        var read = ipcStorageRead(storageHandle, offset, 16, buffer);
        if (!read || read.error !== 0) {
            return {ok: false, error: read?.error ?? null,
                transport: read?.transport ?? null};
        }

        return {ok: true, error: read.error, transport: read.transport,
            hex: helpers.readHexBytes(buffer, 16)};
    } catch (error) {
        return {ok: false, error: null, transport: null,
            detail: String(error?.message || error)};
    }
}

async function verifyInvalidatedCandidateCache({
  candidateHandle,
  helpers,
  addressCopy,
  rootSession
}) {
    var expectedPrefix = addressCopy?.primeHex;
    var expectedAlias = addressCopy?.aliasControlHex;
    var aliasOffset = addressCopy?.config?.ALIAS_OFFSET;
    var hasBaseline = typeof expectedPrefix === "string" &&
        /^[0-9a-f]{32}$/i.test(expectedPrefix) &&
        typeof expectedAlias === "string" &&
        /^[0-9a-f]{32}$/i.test(expectedAlias) &&
        expectedPrefix !== expectedAlias &&
        Number.isSafeInteger(aliasOffset) && aliasOffset >= 0 &&
        rootSession && typeof helpers?.inspectCandidateCacheAlias === "function";

    if (!hasBaseline) {
        return {ok: false, candidateHandle,
            stage: "verification-baseline-unavailable"};
    }

    var candidatePrefix = readStorageHex(candidateHandle, 0, helpers);
    if (!candidatePrefix.ok || candidatePrefix.hex !== expectedPrefix) {
        return {ok: false, candidateHandle,
            stage: "candidate-prefix-mismatch", candidatePrefix};
    }

    var candidateCloseResult = null;
    try {
        candidateCloseResult = Number(closeHandle(candidateHandle)) >>> 0;
    } catch (error) {
        return {ok: false, candidateHandle,
            stage: "candidate-close-failed",
            detail: String(error?.message || error)};
    }
    if (candidateCloseResult !== 0) {
        return {ok: false, candidateHandle,
            stage: "candidate-close-failed", candidateCloseResult};
    }

    var freshHandle = 0;
    try {
        freshHandle = Number(openContentStorage(rootSession)) >>> 0;
    } catch (error) {
        return {ok: false, candidateHandle: 0,
            stage: "fresh-storage-open-failed",
            detail: String(error?.message || error)};
    }
    if (!freshHandle) {
        return {ok: false, candidateHandle: 0,
            stage: "fresh-storage-open-failed"};
    }

    var freshReadback = null;
    var freshCloseResult = null;
    var freshCloseError = null;
    try {
        var freshPrefix = readStorageHex(freshHandle, 0, helpers);
        var freshAlias = null;
        try {
            freshAlias = helpers.inspectCandidateCacheAlias(
                freshHandle, addressCopy);
        } catch (error) {
            freshAlias = {state: "unavailable",
                detail: String(error?.message || error)};
        }

        var readbackMatches = freshPrefix.ok &&
            freshPrefix.hex === expectedPrefix &&
            freshAlias?.state === "original";
        freshReadback = readbackMatches
            ? {ok: true, freshPrefix, freshAlias}
            : {ok: false, stage: "fresh-storage-readback-mismatch",
                freshPrefix, freshAlias};
    } catch (error) {
        freshReadback = {ok: false, stage: "fresh-storage-readback-threw",
            detail: String(error?.message || error)};
    } finally {
        try {
            freshCloseResult = Number(closeHandle(freshHandle)) >>> 0;
        } catch (error) {
            freshCloseError = String(error?.message || error);
        }
    }

    if (freshCloseError || freshCloseResult !== 0) {
        return {ok: false, candidateHandle: freshHandle,
            stage: "fresh-storage-close-failed", freshReadback,
            freshCloseResult, detail: freshCloseError};
    }

    if (!freshReadback.ok) {
        return {...freshReadback, candidateHandle: 0};
    }

    return {ok: true, candidateHandle: 0, candidatePrefix,
        freshPrefix: freshReadback.freshPrefix,
        freshAlias: freshReadback.freshAlias};
}

export async function retireCandidateCacheAndClose({
  helpers,
  addressCopy,
  candidateCacheNeedsRetirement,
  candidateHandle,
  rootSession,
  retireRetainedEndpoint,
  workerStateSafe,
}) {
    // S21: Verify the synthetic cache entry and retire the retained endpoint.
    let candidateCacheRetired = false;
    var candidateCloseSafe = workerStateSafe;
    var workersQuiesced = workerStateSafe === true;
    var stateSafe = workerStateSafe === true;
    var candidateCloseResult = null;
    var retirementFailureReason = null;
    if (addressCopy && addressCopy.retainedEndpointActive) {
        if (!candidateCloseSafe || !candidateHandle ||
            typeof retireRetainedEndpoint !== "function") {
            addressCopy = {...addressCopy, retainedEndpointUnsafe: true,
                workerStateSafe: false};
            await log(formatUnsafeState(
                "Retained endpoint cannot be retired."));

            return {ok: false, addressCopy, candidateCacheRetired,
                candidateHandle, workerStateSafe: false,
                workersQuiesced,
                failureReason: "retained-endpoint-state-unsafe"};
        }
        try {
            var retainedRetirement = await retireRetainedEndpoint();
            if (!retainedRetirement || !retainedRetirement.retired)
                throw new Error("retained endpoint did not confirm retirement");
            addressCopy = retainedRetirement.addressCopy || addressCopy;
        } catch (retirementError) {
            addressCopy = {...addressCopy, retainedEndpointUnsafe: true,
                workerStateSafe: false};
            await log(formatUnsafeState(
                "Retained endpoint retirement failed: " +
                retirementError.message));
            return {ok: false, addressCopy, candidateCacheRetired,
                candidateHandle, workerStateSafe: false,
                workersQuiesced,
                failureReason: "retained-endpoint-retirement-failed: " +
                    retirementError.message};
        }

        try {
            candidateCloseResult = Number(closeHandle(candidateHandle)) >>> 0;
            if (candidateCloseResult !== 0) {
                addressCopy = {...addressCopy, retainedEndpointUnsafe: true,
                    workerStateSafe: false};
                return {ok: false, addressCopy, candidateCacheRetired,
                    candidateHandle, workerStateSafe: false,
                    workersQuiesced,
                    candidateCloseResult,
                    failureReason: "retained-candidate-close-failed"};
            }
            candidateHandle = 0;
            candidateCacheRetired = true;
            addressCopy = {...addressCopy, retainedEndpointActive: false,
                retainedEndpointRetired: true, candidateCacheRetired: true};
        } catch (closeError) {
            addressCopy = {...addressCopy, retainedEndpointUnsafe: true,
                workerStateSafe: false};
            return {ok: false, addressCopy, candidateCacheRetired,
                candidateHandle, workerStateSafe: false,
                workersQuiesced,
                candidateCloseResult,
                failureReason: "retained-candidate-close-threw: " +
                    closeError.message};
        }
        return {ok: true, addressCopy, candidateCacheRetired,
            candidateHandle, candidateCloseResult,
            workerStateSafe: stateSafe, workersQuiesced};
    }
    // State A: alias installed, no IStorage::Write done through it.
    // The entry is clean from fsp-srv's perspective, so invalidation is the
    // only cleanup operation authorized for this state. A successful IPC
    // result still needs the fresh-storage readback below.
    if (candidateHandle && candidateCacheNeedsRetirement && candidateCloseSafe) {
        var storageInvalidated = false;

        var storageSize = ipcStorageGetSize(candidateHandle);
        if (storageSize.error === 0 &&
            Number.isSafeInteger(storageSize.size) && storageSize.size > 0) {
            var invalidation = ipcStorageInvalidate(
                candidateHandle, 0, storageSize.size);
            storageInvalidated = invalidation.error === 0;
            await verboseLog("CLEANUP: storage cache invalidate" +
                " result=" + hex32(invalidation.error) +
                " transport=" + hex32(invalidation.transport));
        }

        if (storageInvalidated) {
            var verification = await verifyInvalidatedCandidateCache({
                candidateHandle, helpers, addressCopy, rootSession
            });
            candidateHandle = verification.candidateHandle;

            if (verification.ok) {
                candidateCacheRetired = true;
                addressCopy = {...addressCopy, candidateCacheRetired,
                    candidateCacheVerification: "fresh-readback-original"};
                await verboseLog("CLEANUP: cache readback prefix=" +
                    verification.freshPrefix.hex + " · alias=" +
                    verification.freshAlias.readbackHex);
                await log("Candidate cache readback passed on a fresh " +
                    "storage.");
            } else {
                candidateCloseSafe = false;
                retirementFailureReason =
                    "candidate-cache-verification-unconfirmed";
                addressCopy = {...addressCopy, candidateCacheRetired: false,
                    candidateCacheVerification: verification.stage};
                await verboseLog("CLEANUP: cache readback=" +
                    verification.stage +
                    (verification.freshAlias?.state
                        ? " · alias=" + verification.freshAlias.state : "") +
                    (verification.detail ? " · " + verification.detail : ""));
                await log("Candidate cache readback was not confirmed.");
            }
        } else {
            candidateCloseSafe = false;
            retirementFailureReason =
                "candidate-cache-invalidation-unconfirmed";
            addressCopy = {...addressCopy, candidateCacheRetired: false,
                candidateCacheVerification: "invalidation-unconfirmed"};
            await log("Candidate cache invalidation was not confirmed.");
        }
    }

    if (candidateHandle && candidateCloseSafe) {
        try {
            candidateCloseResult = Number(closeHandle(candidateHandle)) >>> 0;
            candidateHandle = 0;
            if (candidateCloseResult !== 0)
                retirementFailureReason = "candidate-close-failed";
        } catch (closeError) {
            candidateHandle = 0;
            retirementFailureReason = "candidate-close-threw: " +
                closeError.message;
        }
    } else if (candidateHandle) {
        retirementFailureReason = retirementFailureReason ||
            "candidate-close-skipped-unsafe-state";
    }

  return {ok: true, addressCopy, candidateCacheRetired, candidateHandle,
      workerStateSafe: stateSafe, workersQuiesced, candidateCloseResult,
      failureReason: retirementFailureReason};
}

export async function cleanupScratchAndHandles({
  SCRATCH_DIR,
  auxiliaryStorageHandle,
  candidateCacheNeedsRetirement,
  candidateCacheRetired,
  candidateHandle,
  retainedEndpointActive,
  domainSession,
  extentTriggerHandle,
  extraStorages,
  pinHandle,
  rootClones,
  rootSession,
  saveClones,
  savedHandle,
  storageHandle,
  temporaryHandle,
  triggerHandle,
  workerStateSafe,
  keepDomainSessionOpen = false,
  dirtyFileSize = 0,
  dirtyFilePath = ""
}) {
    // S22: Cleanup. Report a failed or skipped cleanup as unsafe to retry.
    var cleanupAttempted = false;
    var cleanupDeleteTransport = null;
    var cleanupRemoveResult = null;
    var cleanupCommitTransport = null;
    var cleanupCommitResult = null;
    var cleanupDonorWiped = 0;
    var cleanupHandlesClosed = 0;
    var cleanupExpectedHandles = 0;
    var cleanupCloseFailures = [];
    var cleanupErrors = [];
    var cleanupAllowed = workerStateSafe && (retainedEndpointActive ||
        !candidateCacheNeedsRetirement || candidateCacheRetired);
    var cleanupSkipReason = workerStateSafe
        ? "candidate-cache-not-retired" : "worker-state-unsafe";

    if (cleanupAllowed) {
        var countExpectedHandle = function(handle) {
            if (handle) cleanupExpectedHandles++;
        };
        for (var ci = 0; ci < saveClones.length; ci++)
            countExpectedHandle(saveClones[ci]);
        for (var ci = 0; ci < rootClones.length; ci++)
            countExpectedHandle(rootClones[ci]);
        countExpectedHandle(triggerHandle);
        countExpectedHandle(extentTriggerHandle);
        countExpectedHandle(savedHandle);
        countExpectedHandle(temporaryHandle);
        countExpectedHandle(storageHandle);
        countExpectedHandle(auxiliaryStorageHandle);
        countExpectedHandle(pinHandle);
        for (var cei = 0; cei < extraStorages.length; cei++)
            countExpectedHandle(extraStorages[cei]);
        if (domainSession && !keepDomainSessionOpen)
            countExpectedHandle(domainSession.handle);
        countExpectedHandle(rootSession);
        cleanupAttempted = true;
        var cacheInvalidateResult = null;
        if (dirtyFileSize > 0 && dirtyFilePath) {
            try {
                cacheInvalidateResult = ipcFileInvalidate(
                    savedHandle, dirtyFilePath, dirtyFileSize);
            } catch (error) {
                cacheInvalidateResult = "throw:" + String(error);
            }
            await verboseLog("CLEANUP: cache invalidate " + dirtyFilePath +
                " result=" + (typeof cacheInvalidateResult === "number"
                    ? hex32(cacheInvalidateResult) : cacheInvalidateResult));
        }
        // Donor leftovers would ride the same commit: absent files are
        // skipped silently, and a present file that fails to delete is a
        // real cleanup failure. The list is empty by default because the
        // donor pair is kept on purpose (DONOR_LEFTOVER_FILES above).
        for (var di = 0; di < DONOR_LEFTOVER_FILES.length; di++) {
            var donorFile = DONOR_LEFTOVER_FILES[di];
            try {
                var donorEntry = ipcGetEntryTypeChecked(savedHandle, donorFile);
                if (donorEntry.transport !== 0 || donorEntry.result !== 0)
                    continue;
                var donorDelete = ipcDeleteFileChecked(savedHandle, donorFile);
                if (donorDelete.transport === 0 && donorDelete.result === 0) {
                    cleanupDonorWiped++;
                    continue;
                }
                cleanupErrors.push("donor-" + donorFile + "-delete=" +
                    (donorDelete.transport !== 0
                        ? hex32(donorDelete.transport) : hex32(donorDelete.result)));
            } catch (donorError) {
                cleanupErrors.push("donor-" + donorFile + "=" + String(donorError));
            }
        }
        try {
            var deleteStatus = ipcDeleteDirectoryRecursivelyChecked(
                savedHandle, SCRATCH_DIR);
            cleanupDeleteTransport = deleteStatus.transport;
            cleanupRemoveResult = deleteStatus.result;
        } catch (error) {
            cleanupErrors.push("delete=" + String(error));
        }
        try {
            var commitStatus = ipcCommitChecked(savedHandle);
            cleanupCommitTransport = commitStatus.transport;
            cleanupCommitResult = commitStatus.result;
        } catch (error) {
            cleanupErrors.push("commit=" + String(error));
        }

        var closeForCleanup = function(handle, label) {
            if (!handle) return;
            try {
                var result = Number(closeHandle(handle)) >>> 0;
                if (result !== 0) {
                    cleanupCloseFailures.push(label + "=" + hex32(result));
                } else {
                    cleanupHandlesClosed++;
                }
            } catch (error) {
                cleanupCloseFailures.push(label + "=throw:" + String(error));
            }
        };

        for (var i = 0; i < saveClones.length; i++)
            closeForCleanup(saveClones[i], "save-clone-" + i);
        for (var i = 0; i < rootClones.length; i++)
            closeForCleanup(rootClones[i], "root-clone-" + i);
        closeForCleanup(triggerHandle, "trigger");
        closeForCleanup(extentTriggerHandle, "extent-trigger");
        closeForCleanup(savedHandle, "save-fs");
        closeForCleanup(temporaryHandle, "temporary-fs");
        closeForCleanup(storageHandle, "storage");
        closeForCleanup(auxiliaryStorageHandle, "aux-storage");
        closeForCleanup(pinHandle, "pin");
        for (var ei = 0; ei < extraStorages.length; ei++)
            closeForCleanup(extraStorages[ei], "extra-storage-" + ei);
        if (domainSession && !keepDomainSessionOpen) {
            closeForCleanup(domainSession.handle, "identity-domain-session");
            domainSession = null;
        }
        closeForCleanup(rootSession, "fsp-session");
    }

    var cleanupOk = cleanupAttempted && cleanupDeleteTransport === 0 &&
        cleanupRemoveResult === 0 && cleanupCommitTransport === 0 &&
        cleanupCommitResult === 0 &&
        cleanupHandlesClosed === cleanupExpectedHandles &&
        cleanupCloseFailures.length === 0 && cleanupErrors.length === 0;
    return {
        // Preserve the legacy `ok` contract for callers outside this workflow;
        // the payload consumes cleanupVerified for its explicit status line.
        ok: true,
        cleanupVerified: cleanupOk,
        attempted: cleanupAttempted,
        skipped: !cleanupAttempted,
        workerStateSafe: Boolean(workerStateSafe),
        skipReason: cleanupAttempted ? null : cleanupSkipReason,
        deleteTransport: cleanupDeleteTransport,
        deleteResult: cleanupRemoveResult,
        commitTransport: cleanupCommitTransport,
        commitResult: cleanupCommitResult,
        donorFilesWiped: cleanupDonorWiped,
        handlesClosed: cleanupHandlesClosed,
        expectedHandles: cleanupExpectedHandles,
        closeErrors: cleanupCloseFailures,
        errors: cleanupErrors,
        domainSession
    };
}

