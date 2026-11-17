'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {NativeClient} = require('../civswitch/fs-kit/port/engine/lib/native.cjs');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {identify} = require('./identify-image-readonly.cjs');
const {checkArena} = require('./ffi-arena-live.cjs');
const {probeDomainLive} = require('./probe-domain-live.cjs');
const {matchingBoot} = require('./clone-control.cjs');
const {runWorkerRepeatability} = require('./worker-repeatability.cjs');
const {runStaircaseLive} = require('./fs-pinning-staircase-live.cjs');
const {runCloneLive, balatroTarget} = require('./clone-control-live.cjs');
const {assessPreflight} = require('./canary-geometry-plan.cjs');
const {qualifyNativeCrc} = require('./qualify-native-crc.cjs');
const {stageNativeBridge} = require('./native-bridge.cjs');
const {openConnection} = require('./native-readonly-smoke.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {createQualifiedContext} = require('./fs-counter-probe.cjs');
const {createAbortAdapter} = require('./fs-abort-adapter.cjs');
const {runAbortControl, runPositiveWave, checkIdentity} =
  require('./fs-abort-control.cjs');
const {buildGapFirstXInput} = require('./fs-gap-first-x-input.cjs');
const {prepareGapScratchLease, cleanupGapScratchLease, FILE_BYTES} =
  require('./fs-gap-scratch-lease.cjs');
const {assessPositiveWaveReadiness} =
  require('./canary-attempt-readiness.cjs');
const {runWriteSize} = require('./fs-write-size.cjs');
const {runPathSemantics} = require('./fs-path-semantics.cjs');
const {runAbortPair} = require('./fs-abort-pair.cjs');
const {runReceiveWindow} = require('./fs-receive-window.cjs');
const {runProtectedCanaryWindow} =
  require('./fs-protected-canary-window.cjs');
const {runProtectedEventControl} =
  require('./fs-protected-event-control.cjs');
const {runProtectedStorageEventControl} =
  require('./fs-protected-storage-event-control.cjs');
const {validateOrdinaryBaseline} =
  require('./fs-event-pinned-storage-read.cjs');
const {runOwnedStorageRead} = require('./fs-owned-storage-read.cjs');
const {runGapEventSmoke} = require('./fs-gap-event-smoke.cjs');
const {inspectRootState} = require('./fs-root-state-live.cjs');
const {makeIdleSource, parseIdleReply, makeReleaseSource,
  parseReleaseReply} = require('./native-counter-overlap.cjs');
const {sameImage} = require('./fs-root-batch-live.cjs');
const bridge = require('./transport-probe.cjs');
const {runMarkerLocalization} = require('./marker-localization-live.cjs');
const {buildFirstDescriptor, assemblePositiveEvidence,
  runReadinessControl} = require('./fs-readiness-live.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const REPL_PORT = 9026;
const ARENA_BYTES = 0x200000;
// The scratch commit write needs a large page-aligned source buffer. Match the
// write-size probe's 36 MiB app allocation so the 7 MiB commit never straddles
// the app's own heap object.
const POSITIVE_BUFFER_BYTES = 0x2400000;

function requireExact(value, label) {
  if (!value) throw Error(`Balatro abort live: ${label} did not verify`);
}

async function allocatePositiveScratch(execute, host) {
  const source = [
    'local ffi=require(\'ffi\')',
    `local buf=ffi.new('uint8_t[?]',${POSITIVE_BUFFER_BYTES})`,
    'local raw=tonumber(ffi.cast(\'uintptr_t\',buf))',
    'local aligned=raw+0x100+(0x1000-(raw+0x100)%0x1000)%0x1000',
    'return string.format(\'0x%x\',aligned)',
  ].join('\n');
  const reply = await execute({host, port: REPL_PORT, source, timeoutMs: 30000});
  const line = reply.trimEnd().split('\n').map(item => item.trim())
    .find(item => /^->\s*0x[0-9a-f]+$/.test(item));
  requireExact(line, 'positive scratch buffer allocation address');
  const address = Number.parseInt(line.replace(/^->\s*/, ''), 16);
  requireExact(Number.isSafeInteger(address) && address % 0x1000 === 0 &&
    address >= 0x1000 && address + POSITIVE_BUFFER_BYTES < 2 ** 39 &&
    address + FILE_BYTES < 2 ** 39,
  'positive scratch buffer address bounds');
  return address;
}

function verifyProtectedStorageResult(control) {
  requireExact(control?.cleanup === 'verified' &&
    control.completeSaveAuditVerified === true &&
    control.eventGate === 'initialized-signaled-finalized' &&
    control.waveRows?.length === 4 &&
    control.receiveStorageClosed === true &&
    control.pinStorageClosed === true &&
    control.protectedCloneClosed === true &&
    control.independentOrdinaryBaselineMatched === true &&
    control.receiveStorage?.open?.requestHex?.length === 512 &&
    control.receiveStorage.open.replyHex?.length === 512 &&
    control.receiveStorage.size?.replyHex?.length === 512 &&
    control.receiveStorage.serial?.replyHex?.length === 512 &&
    control.receiveStorage.close?.resultHex === '0x0' &&
    control.pinStorage?.open?.replyHex?.length === 512 &&
    control.pinStorage.close?.resultHex === '0x0' &&
    control.eventRead?.replyHex?.length === 512 &&
    typeof control.clientReceiveSpansTrigger === 'boolean' &&
    control.markerAttempted === false &&
    control.fsHandlerOverlapMeasured === false &&
    control.fsSideMarkerReadbackVerified === false &&
    control.markerHitVerified === false &&
    control.fsStageVerified === false,
  'distinct-child storage receive and exact cleanup');
  return true;
}

function formatFailure(error, seen = new Set()) {
  if (!error || seen.has(error)) return '';
  seen.add(error);
  const lines = [error.stack || error.message || String(error)];
  if (error.cause) lines.push(`cause: ${formatFailure(error.cause, seen)}`);
  for (const child of error.errors || []) {
    lines.push(`cause: ${formatFailure(child, seen)}`);
  }
  return lines.join('\n');
}

async function runOneAbortLive({host, macIp,
  nonce = crypto.randomBytes(8).toString('hex'),
  mode = 'one-abort', execute = executeLua,
  ordinaryBaseline = null,
  positiveEvidence = null,
  image = identify, reserve = checkArena, domain = probeDomainLive,
  worker = runWorkerRepeatability, staircase = runStaircaseLive,
  clone = runCloneLive, localize = runMarkerLocalization,
  qualifyCrc = qualifyNativeCrc,
  stage = stageNativeBridge, connect = openConnection,
  makeNative = (connection, addresses) =>
    new NativeClient(connection, addresses, balatroTarget()),
  makeTransport = options => new BalatroCloneTransport(options),
  runAbort = runAbortControl, runPair = runAbortPair,
  runWindow = runReceiveWindow,
  runProtected = runProtectedCanaryWindow,
  runProtectedEvent = runProtectedEventControl,
  runProtectedStorageEvent = runProtectedStorageEventControl,
  runStorageRead = runOwnedStorageRead,
  runEventSmoke = runGapEventSmoke,
  runWrite = runWriteSize,
  runPathSem = runPathSemantics,
  onPhase = () => {}}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !/^[0-9a-f]{16}$/.test(nonce) ||
      !['preflight-only', 'one-abort', 'two-aborts',
        'receive-window', 'protected-canary-window',
        'protected-event-control', 'protected-event-reader',
        'protected-storage-event-control',
        'owned-storage-read', 'gap-event-smoke', 'positive',
        'readiness', 'write-size', 'path-semantics'].includes(mode) ||
      [execute, image, reserve, domain, worker, staircase, clone, localize,
        qualifyCrc, stage, connect, makeNative, makeTransport, runAbort,
        runPair, runWindow, runProtected, runProtectedEvent,
        runProtectedStorageEvent,
        runStorageRead, runEventSmoke, runWrite,
        runPathSem,
        onPhase].some(item => typeof item !== 'function')) {
    throw new TypeError('Balatro abort live needs two IPv4 addresses and one fresh owner');
  }
  const needsOrdinaryBaseline = mode === 'protected-event-reader' ||
    mode === 'protected-storage-event-control';
  if (needsOrdinaryBaseline !== (ordinaryBaseline !== null)) {
    throw new TypeError('Balatro event storage control needs one independent ordinary baseline');
  }
  if (needsOrdinaryBaseline)
    validateOrdinaryBaseline(ordinaryBaseline);
  let positiveReadiness = null;
  if (mode === 'positive') {
    if (!positiveEvidence)
      throw Error('Balatro positive wave is disabled before live setup: same-session abort and path-control readiness evidence is missing');
    positiveReadiness = assessPositiveWaveReadiness(positiveEvidence);
    requireExact(positiveReadiness.positiveWaveAllowed === true &&
      positiveReadiness.phase === 'single-matched-comparison' &&
      positiveReadiness.arenaNonce === nonce,
    'same-session positive readiness belongs to this retained owner');
    // The readiness gate is pure and runs before device contact. The positive
    // wave itself only fires after the scratch canary is established, bound to
    // this boot's retained owner, and the trigger/post-trigger read is complete.
  }
  let phase = 'identify';
  const step = label => {phase = label; onPhase(label, nonce);};
  const inspectDomain = evidence => domain({host,
    nonceBytes: () => Buffer.from(evidence.nonce, 'hex')});
  let arena;
  let staged;
  let connection;
  let native;
  let nativeStopped = false;
  let listenerClosed = false;
  let arenaReleased = false;
  let adapterStarted = false;
  let failure;
  try {
    step('identify-pinned-image-and-idle-state');
    const before = await image(host, execute);
    sameImage(before, before, before.sdkBase);
    const idle = () => execute({host, port: REPL_PORT,
      source: makeIdleSource({nonce, mainBase: before.mainBase,
        sdkBase: before.sdkBase}), timeoutMs: 10000});
    parseIdleReply(await idle(), nonce);
    const evidence = await domain({host, execute});
    requireExact(evidence.sdkBase === before.sdkBase &&
      evidence.sdkCrc32 === profile.sdkCode.offlineCrc32,
    'mounted domain and image');

    step('reserve-owned-arena');
    arena = await reserve({host, phase: 'reserve', nonce, execute,
      skipMountCheck: true, sdkBase: before.sdkBase});
    requireExact(arena.nonce === nonce && arena.bytes === ARENA_BYTES &&
      arena.phase === 'reserve', 'owned arena');

    let localization = null;
    if (mode === 'readiness') {
      step('qualify-same-boot-marker-localization');
      localization = await localize({host, macIp, nonce, execute,
        onPhase: name => onPhase(`localization:${name}`, nonce)});
      requireExact(localization?.gameProfile === profile.gameProfile &&
        localization.sdkBase === before.sdkBase &&
        localization.arenaBase === arena.base &&
        localization.arenaNonce === nonce,
      'same-session marker localization belongs to this retained owner');
    }

    step('qualify-same-boot-worker');
    const workerResult = await worker({host, macIp, nonce, execute});
    requireExact(workerResult.sdkBase === before.sdkBase &&
      workerResult.arenaBase === arena.base, 'worker owner');
    step('qualify-same-boot-storage-staircase');
    const staircaseResult = await staircase({host, macIp, nonce, execute,
      onPhase: name => onPhase(`staircase:${name}`, nonce)});
    requireExact(staircaseResult.arenaBase === arena.base &&
      staircaseResult.repeatabilityVerified === true,
    'staircase repeatability');
    step('qualify-same-boot-cloned-marker');
    const cloneResult = await clone({host, macIp, arenaNonce: nonce,
      evidence, execute, onPhase: name => onPhase(`clone:${name}`, nonce)});
    const preflight = assessPreflight({worker: workerResult,
      staircase: staircaseResult, clone: cloneResult});
    requireExact(preflight.arenaBase === arena.base &&
      preflight.sdkBase === before.sdkBase, 'conservative preflight');
    matchingBoot(evidence, await inspectDomain(evidence));
    sameImage(before, await image(host, execute), evidence.sdkBase);
    if (mode === 'preflight-only') {
      step('detach-preflight-owner');
      const released = parseReleaseReply(await execute({host, port: REPL_PORT,
        source: makeReleaseSource({nonce, arenaBase: arena.base,
          sdkBase: before.sdkBase}), timeoutMs: 10000}),
      {nonce, arenaBase: arena.base});
      arenaReleased = released.arena === 'detached';
      requireExact(arenaReleased, 'preflight owner detach');
      parseIdleReply(await idle(), nonce);
      return {gameProfile: profile.gameProfile, sdkBase: before.sdkBase,
        owner: nonce, arenaBase: arena.base,
        markerNonce: preflight.markerNonce,
        workerRepeatabilityVerified: true,
        staircaseRepeatabilityVerified: true,
        clonedMarkerControlVerified: true,
        arena: 'detached', markerAttempted: false,
        markerHitVerified: false, fsStageVerified: false,
        status: 'same-boot abort preflight verified; no native abort sent'};
    }

    step('verify-native-sdk-crc');
    const crc = await qualifyCrc({host, macIp, nonce,
      port: bridge.PORT, execute});
    requireExact(crc.sdkBase === before.sdkBase &&
      crc.sdkCrc32 === evidence.sdkCrc32, 'full SDK CRC');
    step('stage-owned-bridge');
    staged = await stage({host, macIp, nonce, port: bridge.PORT,
      execute, onPhase: name => onPhase(`stage:${name}`, nonce)});
    requireExact(staged.stage === 'ready' &&
      staged.arenaBase === arena.base, 'fresh native bridge');
    step('connect-owned-bridge');
    connection = await connect(host, bridge.PORT, 15000);
    const hello = bridge.parseHello(await connection.read(128),
      {arenaBase: arena.base});
    requireExact(hello.sdkBase === evidence.sdkBase &&
      hello.mainBase === before.mainBase &&
      hello.sdkCrc32 === Number.parseInt(evidence.sdkCrc32, 16),
    'native bridge greeting');
    const context = createQualifiedContext({arenaBase: arena.base,
      hello, crc, nonce, port: bridge.PORT});
    native = makeNative(connection, {sdk: Number(BigInt(hello.sdkBase)),
      scratch: Number(BigInt(hello.scratch))});
    const transport = makeTransport({native, evidence,
      inspectLive: () => inspectDomain(evidence)});
    await transport.initialize();
    const reconnectNative = async () => {
      onPhase('reconnect-native-bridge', nonce);
      try {connection.close();} catch { /* stale socket */ }
      connection = await connect(host, bridge.PORT, 15000);
      const hello2 = bridge.parseHello(await connection.read(128),
        {arenaBase: arena.base});
      requireExact(hello2.sdkBase === evidence.sdkBase &&
        hello2.scratch === hello.scratch, 'reconnected bridge greeting');
      native = makeNative(connection, {
        sdk: Number(BigInt(hello2.sdkBase)),
        scratch: Number(BigInt(hello2.scratch))});
      transport.native = native;
      transport.initialized = false;
      await transport.initialize();
    };
    const inspectIdentity = async () => {
      const current = await image(host, execute);
      sameImage(before, current, evidence.sdkBase);
      const state = await inspectRootState({host, nonce,
        mainBase: before.mainBase, sdkBase: before.sdkBase,
        arenaBase: arena.base, execute});
      requireExact(state.arenaStage === 'ready' &&
        state.transportStage === 'read-request' &&
        state.worker === 'worker-absent' &&
        transport.ownedHandles.size === 0,
      'pre-wave owner idle state');
      return {state: current.state, gameProfile: profile.gameProfile,
        runtimeVersion: profile.runtimeVersion,
        codeHeadProfile: current.codeHeadProfile,
        mainBase: current.mainBase, sdkBase: current.sdkBase,
        sdkCodeSha256: profile.sdkCode.sha256,
        arenaBase: arena.base, arenaNonce: nonce,
        ownerState: state.arenaStage, workers: 0, ownedHandles: 0};
    };
    const adapter = createAbortAdapter({preflight, evidence, transport,
      context, host, macIp, port: bridge.PORT,
      mainBase: before.mainBase, inspectIdentity,
      executeSource: execute, reconnectNative,
      stopNative: async () => {await native.stop(); nativeStopped = true;},
      closeTransport: async () => {
        bridge.parseCloseReply(await execute({host, port: REPL_PORT,
          source: bridge.makeCloseSource({nonce, hostIp: macIp,
            port: bridge.PORT}), timeoutMs: 15000}), {port: bridge.PORT});
        listenerClosed = true;
      },
      releaseArena: async () => {
        const released = parseReleaseReply(await execute({host, port: REPL_PORT,
          source: makeReleaseSource({nonce, arenaBase: arena.base,
            sdkBase: before.sdkBase}), timeoutMs: 10000}),
        {nonce, arenaBase: arena.base});
        arenaReleased = released.arena === 'detached';
        return {arena: arenaReleased ? 'released' : 'unknown'};
      },
      onPhase: name => onPhase(`adapter:${name}`, nonce)});
    if (mode === 'readiness') {
      requireExact(localization?.gameProfile === profile.gameProfile &&
        localization.sdkBase === before.sdkBase &&
        localization.arenaBase === arena.base &&
        localization.arenaNonce === nonce,
      'same-session marker localization belongs to this retained owner');
      step('run-same-session-readiness-control');
      adapterStarted = true;
      const readinessControl = await runReadinessControl({preflight, adapter,
        onPhase: name => onPhase(`readiness:${name}`, nonce)});
      const firstDescriptor = buildFirstDescriptor(preflight.markerNonce);
      const positiveEvidence = assemblePositiveEvidence({
        localization, worker: workerResult, staircase: staircaseResult,
        clone: cloneResult, fsWorker: readinessControl.fsWorker,
        trace: readinessControl.trace, firstDescriptor,
        abortRuns: readinessControl.abortRuns,
        pathStates: readinessControl.pathStates,
        markerRetained: readinessControl.markerRetained,
        ownedHandlesClosed: readinessControl.ownedHandlesClosed},
        () => Buffer.from(preflight.markerNonce, 'hex'));
      requireExact(nativeStopped && listenerClosed && arenaReleased,
        'native, listener, and arena cleanup');
      matchingBoot(evidence, await inspectDomain(evidence));
      sameImage(before, await image(host, execute), evidence.sdkBase);
      parseIdleReply(await idle(), nonce);
      return {gameProfile: profile.gameProfile, sdkBase: before.sdkBase,
        owner: nonce, arenaBase: arena.base,
        markerNonce: preflight.markerNonce,
        arena: 'detached', nativeBridge: 'closed', listener: 'closed',
        markerHitVerified: false, fsStageVerified: false,
        readiness: readinessControl.status,
        positiveEvidence, status: readinessControl.status};
    }
    if (mode === 'positive') {
      requireExact(positiveReadiness?.positiveWaveAllowed === true &&
        positiveReadiness.phase === 'single-matched-comparison' &&
        positiveReadiness.arenaNonce === nonce &&
        positiveReadiness.sdkBase === before.sdkBase &&
        positiveReadiness.arenaBase === arena.base &&
        positiveReadiness.markerNonce === preflight.markerNonce,
      'same-session positive readiness belongs to this retained owner');
      step('prepare-owned-marker-and-scratch-canary');
      adapterStarted = true;
      checkIdentity(await adapter.inspect(), preflight);
      const prepared = await adapter.prepare(preflight);
      const firstX = buildGapFirstXInput({preflight});
      const scratchAddress = await allocatePositiveScratch(execute, host);
      const scratchLease = await prepareGapScratchLease({preflight, prepared,
        plan: firstX, writeBufferAddress: scratchAddress,
        reconnect: reconnectNative,
        onPhase: name => onPhase(`scratch:${name}`, nonce)});
      const positiveControl = await runPositiveWave({preflight, adapter,
        positiveDescriptor: firstX.descriptors.positiveCandidate,
        scratchClone: scratchLease.clone, prepared, positiveReadiness,
        readCanary: scratchLease.readCanary,
        canaryAfterCommit: scratchLease.canaryAfterCommit,
        cleanupScratch: ({workerState, serviceHandles,
          movedStorageHandleClosed}) => cleanupGapScratchLease({
          lease: scratchLease,
          quiescent: {workerState, serviceHandles, movedStorageHandleClosed},
          onPhase: name => onPhase(`scratch-cleanup:${name}`, nonce)}),
        waveId: crypto.randomBytes(8).toString('hex'),
        onPhase: name => onPhase(`positive:${name}`, nonce)});
      requireExact(nativeStopped && listenerClosed && arenaReleased,
        'native, listener, and arena cleanup');
      matchingBoot(evidence, await inspectDomain(evidence));
      sameImage(before, await image(host, execute), evidence.sdkBase);
      parseIdleReply(await idle(), nonce);
      return {gameProfile: profile.gameProfile, sdkBase: before.sdkBase,
        owner: nonce, arenaBase: arena.base,
        markerNonce: preflight.markerNonce,
        arena: 'detached', nativeBridge: 'closed', listener: 'closed',
        markerHitVerified: false, fsStageVerified: false,
        fsSideMarkerReadbackVerified: false,
        appSideCanaryFlipObserved: positiveControl.appSideCanaryFlipObserved,
        canaryType: positiveControl.canaryType,
        triggerResult: positiveControl.triggerResult,
        positiveWaveAllowed: true, scratchCleanupVerified: true,
        positiveWave: positiveControl,
        status: positiveControl.status};
    }
    step(mode === 'path-semantics' ? 'run-save-path-semantics-probe' :
      mode === 'write-size' ? 'run-write-size-cap-probe' :
      mode === 'two-aborts' ? 'run-two-native-abort-controls' :
      mode === 'receive-window' ? 'run-native-receive-window' :
        mode === 'protected-canary-window' ?
          'run-protected-client-canary-window' :
          mode === 'protected-event-control' ?
            'run-four-owned-event-gated-negative-requests' :
            mode === 'protected-event-reader' ?
              'run-four-event-requests-and-same-handle-ordinary-read' :
            mode === 'protected-storage-event-control' ?
              'run-four-event-requests-with-distinct-storage-receive' :
          mode === 'owned-storage-read' ?
            'run-serial-owned-content-storage-read' :
          mode === 'gap-event-smoke' ?
            'run-one-owned-event-gated-counter-request' :
        'run-one-native-abort-control');
    adapterStarted = true;
    const reportPhase = name => onPhase(`control:${name}`, nonce);
    const control = mode === 'path-semantics' ?
      await runPathSem({preflight, adapter, onPhase: reportPhase}) :
      mode === 'write-size' ?
      await runWrite({preflight, adapter, executeSource: execute, host,
        onPhase: reportPhase}) :
      mode === 'owned-storage-read' ?
      await runStorageRead({preflight, adapter, onPhase: reportPhase}) :
      mode === 'gap-event-smoke' ?
      await runEventSmoke({preflight, adapter, executeSource: execute,
        host, macIp, port: bridge.PORT, mainBase: before.mainBase,
        onPhase: reportPhase}) :
      mode === 'protected-canary-window' ?
      await runProtected({preflight, adapter, executeSource: execute,
        host, macIp, port: bridge.PORT, mainBase: before.mainBase,
        onPhase: reportPhase}) :
      ['protected-event-control', 'protected-event-reader'].includes(mode) ?
      await runProtectedEvent({preflight, adapter, executeSource: execute,
        host, macIp, port: bridge.PORT, mainBase: before.mainBase,
        ordinaryBaseline,
        onPhase: reportPhase}) :
      mode === 'protected-storage-event-control' ?
      await runProtectedStorageEvent({preflight, adapter,
        executeSource: execute, host, macIp, port: bridge.PORT,
        mainBase: before.mainBase, ordinaryBaseline,
        onPhase: reportPhase}) : mode === 'receive-window' ?
      await runWindow({preflight, adapter, executeSource: execute,
        host, macIp, port: bridge.PORT, mainBase: before.mainBase,
        onPhase: reportPhase}) :
      await (mode === 'two-aborts' ? runPair : runAbort)({
        preflight, adapter, onPhase: reportPhase});
    requireExact(nativeStopped && listenerClosed && arenaReleased,
      'native, listener, and arena cleanup');
    matchingBoot(evidence, await inspectDomain(evidence));
    sameImage(before, await image(host, execute), evidence.sdkBase);
    parseIdleReply(await idle(), nonce);
    const common = {gameProfile: profile.gameProfile, sdkBase: before.sdkBase,
      owner: nonce, arenaBase: arena.base,
      markerNonce: preflight.markerNonce,
      arena: 'detached', nativeBridge: 'closed', listener: 'closed',
      markerHitVerified: false, fsStageVerified: false,
      status: control.status};
    if (mode === 'two-aborts') {
      requireExact(control.abortControlsVerified === true &&
        control.count === 2 && control.cleanup === 'verified' &&
        control.runs?.length === 2,
      'two same-owner abort controls');
      return {...common, abortControlsVerified: true,
        count: control.count, waveIds: control.waveIds,
        controls: control.runs.map(run => ({waveId: run.waveId,
          counterPhases: run.phases, overlap: run.overlap,
          waveRows: run.waveRows, saveTreeAudit: run.saveTreeAudit,
          changedPaths: run.changedPaths}))};
    }
    if (mode === 'path-semantics') {
      requireExact(control.cleanup === 'verified' &&
        Array.isArray(control.pathResults) &&
        control.pathResults.length === 6,
      'Balatro save-path semantics probe and cleanup');
      return {...common, pathResults: control.pathResults};
    }
    if (mode === 'write-size') {
      requireExact(control.cleanup === 'verified' &&
        Array.isArray(control.writeSizeResults) &&
        control.writeSizeResults.length === 5,
      'Balatro write-size cap probe and cleanup');
      return {...common,
        writeSizeResults: control.writeSizeResults,
        maxAcceptedSize: control.maxAcceptedSize,
        status: control.status};
    }
    if (mode === 'receive-window') {
      requireExact(control.cleanup === 'verified' &&
        control.completeSaveAuditVerified === true &&
        control.logReadBytes === 0x10000 &&
        control.markerHitVerified === false &&
        control.fsStageVerified === false,
      'bounded receive window and cleanup');
      return {...common, receiveWindow: control};
    }
    if (mode === 'protected-canary-window') {
      requireExact(control.cleanup === 'verified' &&
        control.completeSaveAuditVerified === true &&
        control.protectedCloneClosed === true &&
        control.logReadBytes === 0x10000 &&
        control.protectedControl ===
          'owned-clone-marker-entry-type-0/type1' &&
        control.fsHandlerOverlapMeasured === false &&
        control.fsSideMarkerReadbackVerified === false &&
        control.markerHitVerified === false &&
        control.fsStageVerified === false,
      'bounded protected client window and cleanup');
      return {...common, protectedCanaryWindow: control};
    }
    if (mode === 'protected-event-control') {
      requireExact(control.cleanup === 'verified' &&
        control.nativeFourWorkerEventControlVerified === true &&
        control.completeSaveAuditVerified === true &&
        control.eventGate === 'initialized-signaled-finalized' &&
        control.waveRows?.length === 4 &&
        control.protectedCloneClosed === true &&
        control.logReadBytes === 0x10000 &&
        control.protectedControl ===
          'owned-clone-marker-entry-type-0/type1' &&
        control.markerAttempted === false &&
        control.fsHandlerOverlapMeasured === false &&
        control.fsSideMarkerReadbackVerified === false &&
        control.markerHitVerified === false &&
        control.fsStageVerified === false,
      'four owned event-gated negative requests and cleanup');
      return {...common, protectedEventControl: control};
    }
    if (mode === 'protected-event-reader') {
      requireExact(control.cleanup === 'verified' &&
        control.nativeFourWorkerEventControlVerified === true &&
        control.completeSaveAuditVerified === true &&
        control.eventGate === 'initialized-signaled-finalized' &&
        control.waveRows?.length === 4 &&
        control.eventPinnedStorageClosed === true &&
        control.independentOrdinaryBaselineMatched === true &&
        control.eventPinnedStorageRead?.baselineMatched === true &&
        control.eventPinnedStorageRead?.pin?.replyHex?.length === 512 &&
        control.eventPinnedStorageRead?.size?.replyHex?.length === 512 &&
        control.eventPinnedStorageRead?.reads?.length === 2 &&
        control.eventPinnedStorageRead.reads.every(row =>
          row.replyHex?.length === 512 && row.guardsIntact === true) &&
        control.markerAttempted === false &&
        control.fsHandlerOverlapMeasured === false &&
        control.fsSideMarkerReadbackVerified === false &&
        control.markerHitVerified === false &&
        control.fsStageVerified === false,
      'same-handle ordinary IStorage reader and exact cleanup');
      return {...common, protectedEventReader: control};
    }
    if (mode === 'protected-storage-event-control') {
      verifyProtectedStorageResult(control);
      return {...common, protectedStorageEventControl: control};
    }
    if (mode === 'owned-storage-read') {
      requireExact(control.cleanup === 'verified' &&
        control.completeSaveAuditVerified === true &&
        control.storageHandleClosed === true &&
        control.exactRepeatVerified === true &&
        control.markerBytesAbsentFromOrdinaryContent === true &&
        control.storageReadBytes === 0x10000 &&
        control.fsSideAliasVerified === false &&
        control.fsSideMarkerReadbackVerified === false &&
        control.markerHitVerified === false &&
        control.fsStageVerified === false,
      'serial owned content-storage baseline and cleanup');
      return {...common, ownedStorageRead: control};
    }
    if (mode === 'gap-event-smoke') {
      requireExact(control.cleanup === 'verified' &&
        control.nativeEventLifecycleVerified === true &&
        control.completeSaveAuditVerified === true &&
        control.eventGate === 'initialized-signaled-finalized' &&
        control.waveRows?.length === 1 &&
        control.fsSideMarkerReadbackVerified === false &&
        control.markerHitVerified === false &&
        control.fsStageVerified === false,
      'one owned event-gated counter request and cleanup');
      return {...common, gapEventSmoke: control};
    }
    return {...common,
      abortControlVerified: control.abortControlVerified,
      noStorageControls: control.noStorageControls,
      overlap: control.overlap, waveRows: control.waveRows,
      counterPhases: control.counterPhases,
      saveTreeAudit: control.saveTreeAudit, waveId: control.waveId,
    };
  } catch (error) {
    // A failed native call or a partial marker preparation may own resources.
    // Keep them intact for inspection; a generic finally block cannot prove
    // which handles the worker transferred or closed.
    error.diagnostic = {...error.diagnostic,
      owner: nonce, arenaBase: arena?.base || null,
      phase, bridgeStaged: staged?.stage === 'ready',
      nativeStopped, listenerClosed, arenaReleased, adapterStarted,
      markerHitVerified: false, fsStageVerified: false};
    failure = error;
    throw error;
  } finally {
    if (!arenaReleased && !adapterStarted && arena &&
        (!staged || staged.stage !== 'ready')) {
      // Preflight helpers close their own bridge. The release script itself
      // refuses to detach an active worker, listener, or changed owner.
      try {
        const reply = await execute({host, port: REPL_PORT,
          source: makeReleaseSource({nonce, arenaBase: arena.base,
            sdkBase: (await image(host, execute)).sdkBase}), timeoutMs: 10000});
        arenaReleased = parseReleaseReply(reply,
          {nonce, arenaBase: arena.base}).arena === 'detached';
      } catch { /* Preserve the original error and its owner diagnostic. */ }
    }
    // Closing the host socket never claims native or service-handle cleanup.
    // It lets a failed one-shot runner terminate instead of hanging in Node.
    if (!nativeStopped && connection) connection.close();
    if (failure?.diagnostic) failure.diagnostic.arenaReleased = arenaReleased;
  }
}

function reviveBuffers(key, value) {
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return value;
}

async function main(argv = process.argv.slice(2)) {
  const [host, macIp, flag = '--one-abort', baselineFile] = argv;
  const mode = flag === '--preflight-only' ? 'preflight-only' :
    flag === '--one-abort' ? 'one-abort' :
      flag === '--two-aborts' ? 'two-aborts' :
        flag === '--receive-window' ? 'receive-window' :
          flag === '--protected-canary-window' ?
            'protected-canary-window' :
            flag === '--protected-event-control' ?
              'protected-event-control' :
              flag === '--protected-event-reader' ?
                'protected-event-reader' :
              flag === '--protected-storage-event-control' ?
                'protected-storage-event-control' :
            flag === '--owned-storage-read' ?
              'owned-storage-read' :
              flag === '--gap-event-smoke' ?
                'gap-event-smoke' :
                flag === '--positive' ?
                  'positive' :
                  flag === '--readiness' ?
                    'readiness' :
                    flag === '--write-size' ?
                      'write-size' :
                      flag === '--path-semantics' ?
                        'path-semantics' : null;
  const needsEvidenceFile = ['protected-event-reader',
    'protected-storage-event-control', 'positive', 'readiness'].includes(mode);
  if (argv.length < 2 || argv.length > 4 || !mode ||
      (needsEvidenceFile ?
        argv.length !== 4 || !path.isAbsolute(baselineFile || '') :
        argv.length === 4)) {
    process.stderr.write('usage: node fs-abort-live.cjs <switch-ipv4> <mac-ipv4> [--preflight-only|--one-abort|--two-aborts|--receive-window|--protected-canary-window|--protected-event-control|--protected-event-reader <absolute-baseline-json>|--protected-storage-event-control <absolute-baseline-json>|--owned-storage-read|--gap-event-smoke|--positive <absolute-readiness-json>|--readiness <absolute-readiness-json>|--write-size|--path-semantics]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const ordinaryBaseline = ['protected-event-reader',
      'protected-storage-event-control'].includes(mode) ?
      JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : null;
    if (ordinaryBaseline) validateOrdinaryBaseline(ordinaryBaseline);
    const positiveEvidence = mode === 'positive' ?
      JSON.parse(fs.readFileSync(baselineFile, 'utf8'), reviveBuffers) : null;
    const result = await runOneAbortLive({host, macIp, mode,
      nonce: process.env.NS2_NONCE || undefined,
      ordinaryBaseline, positiveEvidence,
      onPhase: (label, owner) => process.stderr.write(`phase: ${label} owner=${owner}\n`)});
    if (mode === 'readiness') {
      fs.writeFileSync(baselineFile,
        `${JSON.stringify(result.positiveEvidence, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify({gameProfile: result.gameProfile,
        sdkBase: result.sdkBase, owner: result.owner,
        arenaBase: result.arenaBase, markerNonce: result.markerNonce,
        status: result.status, readinessWritten: baselineFile}, null, 2)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${formatFailure(error)}\nNo automatic retry or positive marker wave was attempted.\n`);
    if (error.diagnostic) process.stderr.write(`${JSON.stringify(error.diagnostic, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {formatFailure, verifyProtectedStorageResult,
  runOneAbortLive, main};
if (require.main === module) main();
