'use strict';

// Event-gated repetition of the proven four-role negative path control. It
// measures client IPC scheduling only and cannot classify an FS-side marker.
const {createHash, randomBytes} = require('node:crypto');
const net = require('node:net');
const {markerCleanupVerified} = require('./fs-marker-cleanup.cjs');
const {ROLES, buildProtectedCanaryPlan, parseProtectedReplies,
  assessProtectedCanary} = require('./fs-protected-canary-plan.cjs');
const {planProtectedEventLayout} = require('./fs-protected-event-layout.cjs');
const {buildGapEventFrame, RESULT_OFFSETS} =
  require('./fs-gap-event-frame.cjs');
const {stageGapEventFrames, makeGapEventWorkerSource,
  parseGapEventWorkerReply} = require('./fs-gap-event-worker.cjs');
const {openProtectedClone, closeProtectedClone} =
  require('./fs-protected-canary-window.cjs');
const {openLogRead, closeLogRead, READ_BYTES} =
  require('./fs-receive-window.cjs');
const {closeMovedStorage} = require('./fs-abort-frames.cjs');
const {validateOrdinaryBaseline, adoptEventPinStorage,
  readEventPinnedStorage, closeEventPinnedStorage} =
  require('./fs-event-pinned-storage-read.cjs');
const {checkIdentity, checkPaths} = require('./fs-abort-control.cjs');
const {PACKET_OFFSET} = require('./fs-counter-overlap.cjs');

const MODE = 'protected-event-control';

function check(value, reason) {
  if (!value) throw Error(`Balatro protected event control: ${reason}`);
}

function uncertain(cause, reason) {
  const error = Error(`Balatro protected event control: ${reason}; retain resources`,
    {cause});
  error.resourceStateUncertain = true;
  return error;
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function buildProtectedEventControl({preflight, prepared, log,
  protectedClone, waveId}) {
  const protectedPlan = buildProtectedCanaryPlan({preflight, prepared, log,
    protectedClone, waveId});
  const layout = planProtectedEventLayout({preflight, prepared});
  const expectedHandles = [protectedClone.handle, prepared.root.handle,
    log.handle, prepared.clone.handle];
  check(protectedPlan.frames.length === ROLES.length &&
    protectedPlan.frames.every((frame, index) =>
      frame.role === ROLES[index] && frame.handle === expectedHandles[index]) &&
    new Set(expectedHandles).size === ROLES.length &&
    layout.frames.length === ROLES.length,
  'four exact existing owned handles are required');
  const frames = protectedPlan.frames.map((source, index) => {
    const request = source.bytes.subarray(PACKET_OFFSET,
      PACKET_OFFSET + 256);
    const frame = buildGapEventFrame({layout, role: ROLES[index],
      handle: source.handle, request});
    check(frame.requestSha256 === source.requestSha256 &&
      frame.index === index && frame.role === source.role,
    `${source.role} event request differs from the protected negative plan`);
    return frame;
  });
  return Object.freeze({workerKind: 'balatro-gap-event-frames', mode: MODE,
    arenaNonce: preflight.arenaNonce, markerNonce: preflight.markerNonce,
    waveId, arenaBase: layout.owner.arenaBase,
    sdkBase: layout.owner.sdkBase, layout, frames, protectedPlan,
    markerAttempted: false, fsHandlerOverlapMeasured: false,
    fsSideMarkerReadbackVerified: false, markerHitVerified: false,
    fsStageVerified: false});
}

async function stageProtectedEventControl(native, staged) {
  const plan = staged?.protectedPlan;
  check(staged?.mode === MODE &&
    plan?.workerKind === 'protected-canary-window' &&
    staged.frames?.length === ROLES.length &&
    plan.descriptors?.trigger?.address === staged.arenaBase + 0x30000 &&
    plan.descriptors?.canary?.address === staged.arenaBase + 0x44000 &&
    plan.receiveAddress === staged.arenaBase + 0x32000 &&
    plan.receiveBytes === READ_BYTES &&
    plan.receiveAddress + READ_BYTES <= plan.descriptors.canary.address &&
    plan.descriptors.canary.address + 0x800 <=
      staged.layout.scratch.end &&
    staged.layout.scratch.end <= staged.layout.frameBase &&
    Buffer.isBuffer(plan.descriptors.trigger.bytes) &&
    Buffer.isBuffer(plan.descriptors.canary.bytes) &&
    plan.descriptors.trigger.bytes.length === 0x800 &&
    plan.descriptors.canary.bytes.length === 0x800 &&
    plan.descriptors.trigger.sha256 === sha(plan.descriptors.trigger.bytes) &&
    plan.descriptors.canary.sha256 === sha(plan.descriptors.canary.bytes) &&
    typeof native?.write === 'function' &&
    typeof native?.read === 'function' &&
    native.addresses?.scratch === staged.arenaBase + 0x10000 &&
    native.addresses?.sdk === staged.sdkBase,
  'disjoint negative descriptors, receive buffer, and native owner are required');
  const writes = [
    {name: 'trigger-descriptor', address: plan.descriptors.trigger.address,
      bytes: plan.descriptors.trigger.bytes},
    {name: 'canary-descriptor', address: plan.descriptors.canary.address,
      bytes: plan.descriptors.canary.bytes},
    {name: 'log-receive', address: plan.receiveAddress,
      bytes: Buffer.alloc(READ_BYTES)},
  ];
  // Reject a changed role, handle, or CMIF packet before any descriptor or
  // receive-buffer write. The event frame stage also rereads every full frame.
  const frameReceipt = await stageGapEventFrames(native, staged);
  for (const row of writes) {
    await native.write(row.address, row.bytes);
    const observed = await native.read(row.address, row.bytes.length);
    check(Buffer.isBuffer(observed) && observed.equals(row.bytes),
      `${row.name} immediate native readback changed`);
  }
  for (const row of writes) {
    const observed = await native.read(row.address, row.bytes.length);
    check(Buffer.isBuffer(observed) && observed.equals(row.bytes),
      `${row.name} final native readback changed`);
  }
  for (const frame of staged.frames) {
    const observed = await native.read(frame.address, frame.bytes.length);
    check(Buffer.isBuffer(observed) && observed.equals(frame.bytes),
      `${frame.role} final event frame readback changed`);
  }
  return {...frameReceipt, descriptorSha256: writes.slice(0, 2)
    .map(row => sha(row.bytes)), receivePoisonSha256: sha(writes[2].bytes)};
}

function protectedWorkerView(staged, worker) {
  check(staged?.mode === MODE &&
    worker?.mode === MODE && worker.waveId === staged.waveId &&
    worker.arenaNonce === staged.arenaNonce &&
    worker.eventGate === 'initialized-signaled-finalized' &&
    worker.workerState === 'joined-closed' &&
    worker.threadHandles === 'closed' &&
    worker.parentOwnedServiceHandles === 'preserved' &&
    Array.isArray(worker.rows) && worker.rows.length === ROLES.length &&
    worker.rows.every((row, index) =>
      row.role === ROLES[index] &&
      row.handle === staged.frames[index].handle &&
      row.transportResult === 0),
  'four joined event workers and parent handles are required');
  const rows = worker.rows.map((row, index) => ({...row,
    requestKind: staged.protectedPlan.frames[index].requestKind,
    requestId: sha(Buffer.from(`${staged.waveId}:${row.role}`)).slice(0, 16),
    requestIdSource: 'host-wave-role-hash'}));
  return {...worker, rows, serviceHandles: 'closed',
    workerOwnedServiceHandles: 0, clock: 'native-counter',
    explicitSaveWrites: 0, arena: 'retained'};
}

async function readProtectedEventReplies(native, staged, worker, prefix) {
  const view = protectedWorkerView(staged, worker);
  check(native && typeof native.read === 'function' &&
    native.addresses?.scratch === staged.arenaBase + 0x10000 &&
    native.addresses?.sdk === staged.sdkBase &&
    Buffer.isBuffer(prefix) && prefix.length === READ_BYTES,
  'stopped owner and exact serial prefix are required');
  const replies = [];
  let received;
  try {
    for (let index = 0; index < ROLES.length; index++) {
      const frame = staged.frames[index];
      const row = view.rows[index];
      const ticks = [];
      for (const offset of [RESULT_OFFSETS.startTick,
        RESULT_OFFSETS.transportResult, RESULT_OFFSETS.endTick]) {
        ticks.push(await native.read(frame.address + offset, 8));
      }
      check(ticks.every(bytes => Buffer.isBuffer(bytes) && bytes.length === 8) &&
        ticks[0].readBigUInt64LE(0) === BigInt(row.startTick) &&
        ticks[1].readBigUInt64LE(0) === 0n &&
        ticks[2].readBigUInt64LE(0) === BigInt(row.endTick),
      `${frame.role} event ticks or native transport changed`);
      replies.push(await native.read(frame.packetAddress, 256));
    }
    received = await native.read(staged.protectedPlan.receiveAddress,
      READ_BYTES);
    const replyPlan = {...staged.protectedPlan,
      frames: staged.frames.map((frame, index) => ({...frame,
        command: staged.protectedPlan.frames[index].command,
        requestKind: staged.protectedPlan.frames[index].requestKind}))};
    const parsed = parseProtectedReplies(replyPlan, view, replies,
      received, prefix);
    return {replyPlan, workerView: view, parsed,
      rawReplies: replies.map(bytes => Buffer.from(bytes))};
  } catch (error) {
    error.nativeRepliesHex = replies.map(bytes =>
      Buffer.isBuffer(bytes) ? bytes.toString('hex') : null);
    error.nativeReceiveSha256 = Buffer.isBuffer(received) ? sha(received) : null;
    throw error;
  }
}

async function runProtectedEventControl({preflight, adapter, executeSource,
  host, macIp, port, mainBase,
  waveId = randomBytes(8).toString('hex'), ordinaryBaseline = null,
  onPhase = () => {}}) {
  check(adapter && ['inspect', 'prepare', 'readPaths', 'counterPair',
    'auditPaths', 'auditDetails', 'cleanup'].every(name =>
      typeof adapter[name] === 'function') &&
    typeof executeSource === 'function' && typeof onPhase === 'function' &&
    net.isIP(host) === 4 && net.isIP(macIp) === 4 &&
    Number.isInteger(port) && port >= 1024 && port <= 65535 &&
    /^0x[0-9a-f]+$/.test(mainBase || '') &&
    /^[0-9a-f]{16}$/.test(waveId) &&
    waveId !== preflight?.arenaNonce && waveId !== preflight?.markerNonce,
  'fresh owner, exact bridge, or distinct wave is missing');
  const readerRequested = ordinaryBaseline !== null;
  const baseline = readerRequested ?
    validateOrdinaryBaseline(ordinaryBaseline, preflight.arenaNonce) : null;
  checkIdentity(await adapter.inspect(), preflight);
  let prepared, protectedClone, log, staged, worker, observed, phases;
  let pinnedStorage, pinnedRead;
  let workerRequestSent = false;
  let workerReleased = false;
  let movedStorageCloseAttempted = false;
  let movedStorageClosed = false;
  let ownedCleanupAttempted = false;
  let ownedCleanupVerified = false;
  let ownedCleanupResult;
  let resourceStateUncertain = false;
  let failure;
  let pathBefore, pathAfter, changedPaths, saveAudit;
  const diagnostic = error => {
    error.diagnostic = {
      ...(error.diagnostic && typeof error.diagnostic === 'object' ?
        error.diagnostic : {}),
      arenaNonce: preflight.arenaNonce, waveId,
      eventGate: worker?.eventGate ?? null,
      counterPhases: phases ?? null,
      waveRows: observed?.parsed?.rows ?? worker?.rows ?? null,
      saveTreeAudit: saveAudit ?? null,
      changedPaths: changedPaths ?? null,
      pathBefore: pathBefore ?? null, pathAfter: pathAfter ?? null,
      protectedCloneHandle: protectedClone?.handle ?? null,
      protectedCloneClosed: protectedClone?.closed === true,
      logPath: log?.path ?? null, logHandle: log?.handle ?? null,
      logHandleClosed: log?.closed === true,
      workerRequestSent, workerReleased,
      workerState: worker?.workerState ?? null,
      threadHandles: worker?.threadHandles ?? null,
      movedStorageCloseAttempted, movedStorageClosed,
      pinnedStorageHandle: pinnedStorage?.handle ?? null,
      pinnedStorageClosed: pinnedStorage?.closed === true,
      pinnedStorageRead: pinnedRead ?? error.readerDiagnostic ??
        error.cause?.readerDiagnostic ?? null,
      independentOrdinaryBaseline: baseline,
      ownedCleanupAttempted, ownedCleanupVerified,
      ownedCleanupResult: ownedCleanupResult ?? null,
      resourceStateUncertain,
      nativeRepliesHex: error.nativeRepliesHex ??
        error.cause?.nativeRepliesHex ?? null,
      nativeReceiveSha256: error.nativeReceiveSha256 ??
        error.cause?.nativeReceiveSha256 ?? null,
      markerAttempted: false, fsHandlerOverlapMeasured: false,
      fsSideMarkerReadbackVerified: false,
      markerHitVerified: false, fsStageVerified: false,
    };
    return error;
  };
  const counterPair = async phase => {
    try {return await adapter.counterPair(phase);}
    catch (cause) {throw uncertain(cause, `${phase} counter IPC is unknown`);}
  };
  try {
    onPhase('prepare-owned-negative-marker-and-save-baseline');
    prepared = await adapter.prepare(preflight);
    pathBefore = await adapter.readPaths(prepared);
    checkPaths(pathBefore, preflight.markerNonce);
    phases = {before: await counterPair('protected-event-before'),
      noStorageBefore: await counterPair('protected-event-no-storage-before')};
    onPhase('copy-distinct-protected-save-clone');
    protectedClone = await openProtectedClone(prepared);
    onPhase('open-read-only-log-and-anchor-prefix');
    log = await openLogRead({prepared});
    staged = buildProtectedEventControl({preflight, prepared, log,
      protectedClone: protectedClone.capability, waveId});
    const stageReceipt = await stageProtectedEventControl(
      prepared.transport.native, staged);
    const options = {nonce: preflight.arenaNonce,
      arenaBase: preflight.arenaBase, sdkBase: preflight.sdkBase,
      mainBase, waveId, hostIp: macIp, port, staged, stageReceipt};
    const source = makeGapEventWorkerSource(options);
    onPhase('run-four-gated-negative-requests');
    workerRequestSent = true;
    worker = parseGapEventWorkerReply(await executeSource({host, port: 9026,
      source, timeoutMs: 15000}), options);
    workerReleased = worker.workerState === 'joined-closed' &&
      worker.threadHandles === 'closed' &&
      worker.eventGate === 'initialized-signaled-finalized';
    observed = await readProtectedEventReplies(prepared.transport.native,
      staged, worker, log.prefix);
    const movedHandle = observed.parsed.movedStorageHandle;
    check(Number.isInteger(movedHandle) &&
      movedHandle !== prepared.file.handle &&
      movedHandle !== prepared.transport.evidence.sessionManager.borrowedHandle &&
      !prepared.transport.ownedHandles.has(movedHandle),
    'moved storage aliases a preexisting owned or borrowed handle');
    if (readerRequested) {
      onPhase('adopt-exact-event-pin-storage');
      pinnedStorage = adoptEventPinStorage({preflight, prepared, staged,
        worker, observed});
      onPhase('read-two-guarded-ordinary-storage-buffers');
      pinnedRead = await readEventPinnedStorage({preflight, prepared,
        staged, worker, observed, storage: pinnedStorage,
        baseline: ordinaryBaseline});
      movedStorageCloseAttempted = true;
      const closed = await closeEventPinnedStorage(prepared, pinnedStorage);
      movedStorageClosed = closed?.closed === true;
    } else {
      movedStorageCloseAttempted = true;
      const moved = await closeMovedStorage(prepared.transport.native,
        observed.replyPlan, observed.parsed);
      movedStorageClosed = moved?.closed === true;
    }
    check(movedStorageClosed, 'owned moved storage close did not verify');
    onPhase('close-owned-log-and-protected-clone');
    await closeLogRead(prepared, log);
    await closeProtectedClone(prepared, protectedClone);
    phases.after = await counterPair('protected-event-after');
    phases.noStorageAfter = await counterPair('protected-event-no-storage-after');
    pathAfter = await adapter.readPaths(prepared);
    checkPaths(pathAfter, preflight.markerNonce);
    changedPaths = await adapter.auditPaths(prepared);
    saveAudit = adapter.auditDetails();
    check(Array.isArray(changedPaths) && changedPaths.length === 0 &&
      saveAudit?.coverage === 'bounded-cloned-save-tree' &&
      saveAudit.completeSaveTreeVerified === true &&
      saveAudit.logPrefixVerified === true &&
      saveAudit.logState === 'append-only' &&
      Array.isArray(saveAudit.changed) && saveAudit.changed.length === 0,
    'complete cloned save audit or log prefix changed');
  } catch (error) {
    failure = error;
    resourceStateUncertain = error?.resourceStateUncertain === true ||
      workerRequestSent && (!workerReleased || !observed ||
        !movedStorageClosed && (!readerRequested || !pinnedStorage));
  }
  if (prepared && !resourceStateUncertain) {
    try {
      if (pinnedStorage && !pinnedStorage.closed) {
        movedStorageCloseAttempted = true;
        const closed = await closeEventPinnedStorage(prepared, pinnedStorage);
        movedStorageClosed = closed?.closed === true;
        check(movedStorageClosed, 'adopted storage cleanup did not verify');
      }
      if (log && !log.closed) await closeLogRead(prepared, log);
      if (protectedClone && !protectedClone.closed)
        await closeProtectedClone(prepared, protectedClone);
      onPhase('cleanup-owned-marker-handles-and-arena');
      ownedCleanupAttempted = true;
      ownedCleanupResult = await adapter.cleanup(prepared);
      check(ownedCleanupResult?.ownedHandlesClosed === true &&
        markerCleanupVerified(ownedCleanupResult) &&
        ownedCleanupResult.borrowedSession === 'preserved' &&
        ownedCleanupResult.arena === 'released',
      'final owned cleanup did not verify');
      ownedCleanupVerified = true;
    } catch (cause) {
      resourceStateUncertain = true;
      throw diagnostic(uncertain(failure ?
        new AggregateError([failure, cause],
          'protected event control and cleanup failed') : cause,
      'final owned cleanup is unknown'));
    }
  }
  if (failure) {
    if (resourceStateUncertain) throw diagnostic(uncertain(failure,
      'event worker, reply, or owned handle state is unknown'));
    throw diagnostic(failure);
  }
  try {
    check(prepared && observed && log?.closed === true &&
      protectedClone?.closed === true && movedStorageClosed &&
      ownedCleanupVerified,
    'event control did not finish its owned lease');
    const result = assessProtectedCanary({staged: observed.replyPlan,
      worker: observed.workerView, parsed: observed.parsed,
      phases, changedPaths, saveAudit, pathBefore, pathAfter,
      cleanup: {movedStorageClosed, logHandleClosed: log.closed,
        protectedCloneClosed: protectedClone.closed,
        ...ownedCleanupResult}});
    if (readerRequested) check(pinnedRead?.baselineMatched === true &&
      pinnedStorage?.closed === true &&
      pinnedRead.outputGuardsIntact === true &&
      pinnedRead.firstOutputRetained === true &&
      pinnedRead.exactRepeatVerified === true &&
      pinnedRead.markerBytesAbsentFromOrdinaryContent === true,
    'event pin ordinary storage read differed from the independent baseline');
    return {...result, workerKind: MODE,
      eventGate: worker.eventGate,
      eventFrameProvenance: staged.frames.map(frame => ({role: frame.role,
        address: frame.address, handle: frame.handle,
        frameSha256: frame.sha256,
        requestSha256: frame.requestSha256})),
      nativeFourWorkerEventControlVerified: true,
      ...(readerRequested ? {eventPinnedStorageRead: pinnedRead,
        eventPinnedStorageClosed: true,
        independentOrdinaryBaselineMatched: true} : {}),
      requestIdsHostDerived: true,
      markerAttempted: false, fsHandlerOverlapMeasured: false,
      fsSideMarkerReadbackVerified: false,
      markerHitVerified: false, fsStageVerified: false,
      status: readerRequested ?
        'four negative event requests and same-handle ordinary storage read verified; FS-side marker and 2/4 unverified' :
        'four owned negative requests passed native event gate; FS-side marker and 2/4 unverified'};
  } catch (error) {throw diagnostic(error);}
}

module.exports = {MODE, buildProtectedEventControl,
  stageProtectedEventControl, protectedWorkerView,
  readProtectedEventReplies, runProtectedEventControl};
