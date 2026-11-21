import coreRuntime from "../runtime.mjs";

const {
  closeHandle,
  hex32,
  ipcCommitChecked,
  ipcDeleteDirectoryRecursivelyChecked,
  log
} = coreRuntime;

// ── Cleanup and retirement (S19–S21) ────────────────────────────────────────

export async function retireCandidateCacheAndClose({
  helpers,
  addressCopy,
  candidateCacheNeedsRetirement,
  candidateHandle,
  retireRetainedEndpoint,
  workerStateSafe,
}) {
    // S21: Retire the synthetic cache entry before closing the candidate.
    let candidateCacheRetired = false;
    var candidateCloseSafe = workerStateSafe;
    var workersQuiesced = workerStateSafe === true;
    var stateSafe = workerStateSafe === true;
    var candidateCloseResult = null;
    var retirementFailureReason = null;
    if (addressCopy && addressCopy.retainedEndpointActive) {
        if (!candidateCloseSafe || !candidateHandle ||
            typeof retireRetainedEndpoint !== "function") {
            await log("CACHE: retained endpoint retirement or candidate close " +
                "skipped (restoration/handle state is unsafe)");
            addressCopy = {...addressCopy, retainedEndpointUnsafe: true,
                workerStateSafe: false};
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
            await log("CACHE: retained endpoint retirement failed: " +
                retirementError.message);
            addressCopy = {...addressCopy, retainedEndpointUnsafe: true,
                workerStateSafe: false};
            return {ok: false, addressCopy, candidateCacheRetired,
                candidateHandle, workerStateSafe: false,
                workersQuiesced,
                failureReason: "retained-endpoint-retirement-failed: " +
                    retirementError.message};
        }

        try {
            candidateCloseResult = Number(closeHandle(candidateHandle)) >>> 0;
            await log("CACHE: retained candidate closed rc=" +
                hex32(candidateCloseResult));
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
            await log("CACHE: retained candidate close threw: " +
                closeError.message);
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
    if (candidateHandle && candidateCacheNeedsRetirement && candidateCloseSafe) {
        var retirement = await helpers.retireCandidateCache({
            candidateHandle, candidateCacheNeedsRetirement,
            candidateCacheRetired, addressCopy
        });
        workersQuiesced = retirement.addressCopy?.workerStateSafe !== false &&
            workersQuiesced;
        stateSafe = workersQuiesced;
        candidateCloseSafe = retirement.ok && workersQuiesced;
        candidateCacheRetired = retirement.candidateCacheRetired;
        if (!retirement.ok)
            retirementFailureReason = "candidate-cache-retirement-failed";
        addressCopy = {...retirement.addressCopy, candidateCacheRetired};
    }

    if (candidateHandle && candidateCloseSafe) {
        try {
            candidateCloseResult = Number(closeHandle(candidateHandle)) >>> 0;
            candidateHandle = 0;
            await log("CACHE: candidate closed rc=" + hex32(candidateCloseResult));
            if (candidateCloseResult !== 0)
                retirementFailureReason = "candidate-close-failed";
        } catch (closeError) {
            // The cache entry is already retired. A failed close leaks the
            // service handle, but does not leave a live cache alias behind.
            candidateHandle = 0;
            retirementFailureReason = "candidate-close-threw: " +
                closeError.message;
            await log("CACHE: candidate close threw: " + closeError.message);
        }
    } else if (candidateHandle) {
        retirementFailureReason = retirementFailureReason ||
            "candidate-close-skipped-unsafe-state";
        await log("CACHE: candidate close skipped (worker/cache state unsafe)");
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
  keepDomainSessionOpen = false
}) {
    // S22: Cleanup. Report a failed or skipped cleanup as unsafe to retry.
    var cleanupAttempted = false;
    var cleanupDeleteTransport = null;
    var cleanupRemoveResult = null;
    var cleanupCommitTransport = null;
    var cleanupCommitResult = null;
    var cleanupHandlesClosed = 0;
    var cleanupExpectedHandles = 0;
    var cleanupCloseFailures = [];
    var cleanupErrors = [];
    var cleanupAllowed = workerStateSafe && (retainedEndpointActive ||
        !candidateCacheNeedsRetirement || candidateCacheRetired || !candidateHandle);
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
        await log("CLEANUP: removing " + SCRATCH_DIR + " and committing");
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

        var cleanupDeleteTxText = cleanupDeleteTransport === null
            ? "THREW" : hex32(cleanupDeleteTransport);
        var cleanupDeleteText = cleanupRemoveResult === null
            ? "NA" : hex32(cleanupRemoveResult);
        var cleanupCommitTxText = cleanupCommitTransport === null
            ? "THREW" : hex32(cleanupCommitTransport);
        var cleanupCommitText = cleanupCommitResult === null
            ? "NA" : hex32(cleanupCommitResult);
        await log("CLEANUP: " + SCRATCH_DIR +
            " deleteTx=" + cleanupDeleteTxText + " delete=" + cleanupDeleteText +
            " commitTx=" + cleanupCommitTxText + " commit=" + cleanupCommitText +
            " handlesClosed=" + cleanupHandlesClosed +
            "/" + cleanupExpectedHandles +
            " closeErrors=" + (cleanupCloseFailures.join(",") || "none") +
            " errors=" + (cleanupErrors.join(",") || "none"));
    } else {
        await log("CLEANUP: skipped (" + cleanupSkipReason + ")");
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
        handlesClosed: cleanupHandlesClosed,
        expectedHandles: cleanupExpectedHandles,
        closeErrors: cleanupCloseFailures,
        errors: cleanupErrors,
        domainSession
    };
}

