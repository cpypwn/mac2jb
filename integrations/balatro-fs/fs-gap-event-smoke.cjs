'use strict';

// One owned fsp-srv command-1009 request behind the proposed 13-role event
// gate. This qualifies the native event lifecycle only. It cannot observe an
// FS heap alias or advance the memory stage.
const {randomBytes, createHash} = require('node:crypto');
const net = require('node:net');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');
const {packet} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {checkIdentity, checkPaths} = require('./fs-abort-control.cjs');
const {assessNoStorageControls} = require('./canary-geometry-plan.cjs');
const {parseCounterReply} = require('./fs-abort-adapter.cjs');
const {planGapPortLayout} = require('./fs-gap-port-layout.cjs');
const {buildGapEventFrame, RESULT_OFFSETS} =
  require('./fs-gap-event-frame.cjs');
const {stageGapEventFrames, makeGapEventWorkerSource,
  parseGapEventWorkerReply} = require('./fs-gap-event-worker.cjs');
const {PACKET_OFFSET} = require('./fs-counter-overlap.cjs');

function check(value, reason) {
  if (!value) throw Error(`Balatro gap event smoke: ${reason}`);
}

function uncertain(cause, reason) {
  const error = Error(`Balatro gap event smoke: ${reason}; retain resources`,
    {cause});
  error.resourceStateUncertain = true;
  return error;
}

function hexSha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeSmokeFrames({preflight, prepared, layout, waveId}) {
  check(layout?.owner?.arenaNonce === preflight?.arenaNonce &&
    layout.owner.markerNonce === preflight.markerNonce &&
    prepared?.root?.role === 'root' && prepared.root.closed === false &&
    Number.isInteger(prepared.root.handle) &&
    prepared.root.handle > 0 && prepared.root.handle < 0xffff8000 &&
    /^[0-9a-f]{16}$/.test(waveId || '') &&
    waveId !== preflight.arenaNonce &&
    waveId !== preflight.markerNonce,
  'one retained owned root and distinct wave are required');
  const request = packet(1009);
  check(Buffer.isBuffer(request) && request.length === 256,
    'owned counter request changed');
  const frame = buildGapEventFrame({layout, role: 'trigger',
    handle: prepared.root.handle, request});
  return Object.freeze({workerKind: 'balatro-gap-event-frames',
    mode: 'event-smoke', arenaNonce: preflight.arenaNonce,
    waveId, arenaBase: layout.owner.arenaBase,
    sdkBase: layout.owner.sdkBase, layout, frames: [frame],
    requestSha256: hexSha(request),
    nativeEventLifecycleVerified: false,
    fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false});
}

async function readSmokeReply(native, staged, worker) {
  check(native && typeof native.read === 'function' &&
    native.addresses?.scratch === staged?.arenaBase + 0x10000 &&
    native.addresses?.sdk === staged?.sdkBase &&
    staged?.mode === 'event-smoke' && staged.frames?.length === 1 &&
    staged.frames[0].role === 'trigger' &&
    worker?.eventGate === 'initialized-signaled-finalized' &&
    worker.workerState === 'joined-closed' &&
    worker.rows?.length === 1 &&
    worker.rows[0].role === 'trigger',
  'released one-worker native owner is required');
  const frame = staged.frames[0];
  const row = worker.rows[0];
  const tickStart = await native.read(frame.address + RESULT_OFFSETS.startTick, 8);
  const sendResult = await native.read(
    frame.address + RESULT_OFFSETS.transportResult, 8);
  const tickEnd = await native.read(frame.address + RESULT_OFFSETS.endTick, 8);
  check([tickStart, sendResult, tickEnd].every(value =>
    Buffer.isBuffer(value) && value.length === 8) &&
    tickStart.readBigUInt64LE(0) === BigInt(row.startTick) &&
    sendResult.readBigUInt64LE(0) === 0n &&
    tickEnd.readBigUInt64LE(0) === BigInt(row.endTick),
  'native worker ticks or transport result changed');
  const bytes = await native.read(frame.address + PACKET_OFFSET, 256);
  check(Buffer.isBuffer(bytes) && bytes.length === 256,
    'counter reply buffer did not read back');
  const counters = parseCounterReply(bytes);
  return {ipcResult: 0, counterCount: counters.length,
    nativeCounterRow: counters,
    replySha256: hexSha(bytes),
    requestSha256: staged.requestSha256};
}

function assessGapEventSmoke({preflight, staged, worker, parsed,
  phases, pathBefore, pathAfter, changedPaths, saveAudit, cleanup}) {
  check(staged?.mode === 'event-smoke' &&
    staged.arenaNonce === preflight?.arenaNonce &&
    staged.layout.owner.markerNonce === preflight.markerNonce &&
    worker?.waveId === staged.waveId &&
    worker.eventGate === 'initialized-signaled-finalized' &&
    worker.workerState === 'joined-closed' &&
    worker.threadHandles === 'closed' &&
    worker.parentOwnedServiceHandles === 'preserved' &&
    worker.rows?.length === 1 &&
    worker.rows[0].role === 'trigger' &&
    parsed?.ipcResult === 0 && parsed.counterCount === 16 &&
    Array.isArray(parsed.nativeCounterRow) &&
    parsed.nativeCounterRow.length === 16 &&
    parsed.nativeCounterRow.every(value =>
      Number.isSafeInteger(value) && value >= 0) &&
    parsed.requestSha256 === staged.requestSha256 &&
    /^[0-9a-f]{64}$/.test(parsed.replySha256 || '') &&
    Array.isArray(changedPaths) && changedPaths.length === 0 &&
    saveAudit?.coverage === 'bounded-cloned-save-tree' &&
    saveAudit.completeSaveTreeVerified === true &&
    saveAudit.logPrefixVerified === true &&
    saveAudit.logState === 'append-only' &&
    Array.isArray(saveAudit.changed) && saveAudit.changed.length === 0 &&
    cleanup?.ownedHandlesClosed === true &&
    markerCleanupVerified(cleanup) &&
    cleanup.borrowedSession === 'preserved' &&
    cleanup.arena === 'released',
  'event release, owned request, complete save audit, or cleanup is missing');
  checkPaths(pathBefore, preflight.markerNonce);
  checkPaths(pathAfter, preflight.markerNonce);
  assessNoStorageControls(phases);
  return {gameProfile: preflight.gameProfile,
    arenaNonce: preflight.arenaNonce,
    markerNonce: preflight.markerNonce, waveId: staged.waveId,
    workerKind: 'balatro-gap-event-smoke',
    roles: ['trigger'],
    eventGate: worker.eventGate,
    waveRows: worker.rows,
    counterReply: parsed,
    counterPhases: phases,
    pathBefore, pathAfter, changedPaths, saveTreeAudit: saveAudit,
    preparationMarkerSaveWrites: 1, eventSmokeSaveWrites: 0,
    completeSaveAuditVerified: true, counterBaselineRestored: true,
    cleanup: 'verified', ...markerCleanupSummary(cleanup),
    nativeEventLifecycleVerified: true,
    fsHandlerOverlapMeasured: false,
    fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false,
    status: 'one owned request passed the native event gate; FS-side marker and 2/4 unverified'};
}

async function runGapEventSmoke({preflight, adapter, executeSource,
  host, macIp, port, mainBase,
  waveId = randomBytes(8).toString('hex'), onPhase = () => {}}) {
  check(adapter && ['inspect', 'prepare', 'readPaths', 'counterPair',
    'auditPaths', 'auditDetails', 'cleanup'].every(name =>
      typeof adapter[name] === 'function') &&
    typeof executeSource === 'function' &&
    typeof onPhase === 'function' &&
    net.isIP(host) === 4 && net.isIP(macIp) === 4 &&
    Number.isInteger(port) && port >= 1024 && port <= 65535 &&
    /^0x[0-9a-f]+$/.test(mainBase || '') &&
    /^[0-9a-f]{16}$/.test(waveId) &&
    waveId !== preflight?.arenaNonce &&
    waveId !== preflight?.markerNonce,
  'fresh owner, exact bridge, and distinct wave are required');
  checkIdentity(await adapter.inspect(), preflight);
  let prepared, staged, worker, parsed, phases;
  let pathBefore, pathAfter, changedPaths, saveAudit;
  let workerRequestSent = false;
  let workerReleased = false;
  let ownedCleanupAttempted = false;
  let ownedCleanupVerified = false;
  let ownedCleanupResult;
  let resourceStateUncertain = false;
  let failure;
  const diagnostic = error => {
    error.diagnostic = {
      ...(error.diagnostic && typeof error.diagnostic === 'object' ?
        error.diagnostic : {}),
      arenaNonce: preflight.arenaNonce, waveId,
      workerRequestSent, workerReleased,
      workerState: worker?.workerState ?? null,
      eventGate: worker?.eventGate ?? null,
      waveRows: worker?.rows ?? null,
      counterReply: parsed ?? null, counterPhases: phases ?? null,
      pathBefore: pathBefore ?? null, pathAfter: pathAfter ?? null,
      changedPaths: changedPaths ?? null, saveTreeAudit: saveAudit ?? null,
      ownedCleanupAttempted, ownedCleanupVerified,
      ownedCleanupResult: ownedCleanupResult ?? null,
      resourceStateUncertain,
      markerHitVerified: false, fsStageVerified: false,
    };
    return error;
  };
  const counterPair = async phase => {
    try {return await adapter.counterPair(phase);}
    catch (cause) {throw uncertain(cause, `${phase} counter IPC is unknown`);}
  };
  try {
    onPhase('prepare-owned-marker-and-save-baseline');
    prepared = await adapter.prepare(preflight);
    pathBefore = await adapter.readPaths(prepared);
    checkPaths(pathBefore, preflight.markerNonce);
    phases = {before: await counterPair('gap-event-before'),
      noStorageBefore: await counterPair('gap-event-no-storage-before')};
    onPhase('plan-one-owned-root-counter-request');
    const layout = planGapPortLayout({preflight, prepared});
    staged = makeSmokeFrames({preflight, prepared, layout, waveId});
    const stageReceipt = await stageGapEventFrames(
      prepared.transport.native, staged);
    const options = {nonce: preflight.arenaNonce,
      arenaBase: preflight.arenaBase, sdkBase: preflight.sdkBase,
      mainBase, waveId, hostIp: macIp, port, staged, stageReceipt};
    const source = makeGapEventWorkerSource(options);
    onPhase('run-one-gated-owned-counter-worker');
    workerRequestSent = true;
    const reply = await executeSource({host, port: 9026,
      source, timeoutMs: 15000});
    worker = parseGapEventWorkerReply(reply, options);
    workerReleased = worker.workerState === 'joined-closed' &&
      worker.eventGate === 'initialized-signaled-finalized';
    onPhase('read-native-counter-reply-and-audit-save');
    parsed = await readSmokeReply(prepared.transport.native,
      staged, worker);
    phases.after = await counterPair('gap-event-after');
    phases.noStorageAfter = await counterPair('gap-event-no-storage-after');
    pathAfter = await adapter.readPaths(prepared);
    checkPaths(pathAfter, preflight.markerNonce);
    changedPaths = await adapter.auditPaths(prepared);
    saveAudit = adapter.auditDetails();
    check(Array.isArray(changedPaths) && changedPaths.length === 0,
      `save audit changed paths: ${JSON.stringify(changedPaths)}`);
  } catch (error) {
    failure = error;
    resourceStateUncertain = error?.resourceStateUncertain === true ||
      workerRequestSent && (!workerReleased || !parsed);
  }
  if (prepared && !resourceStateUncertain) {
    try {
      onPhase('cleanup-owned-marker-handles-and-arena');
      ownedCleanupAttempted = true;
      ownedCleanupResult = await adapter.cleanup(prepared);
      check(ownedCleanupResult?.ownedHandlesClosed === true &&
        markerCleanupVerified(ownedCleanupResult) &&
        ownedCleanupResult.borrowedSession === 'preserved' &&
        ownedCleanupResult.arena === 'released',
      'final owner cleanup did not verify');
      ownedCleanupVerified = true;
    } catch (cause) {
      resourceStateUncertain = true;
      throw diagnostic(uncertain(failure ?
        new AggregateError([failure, cause],
          'event smoke and cleanup failed') : cause,
      'final owned cleanup is unknown'));
    }
  }
  if (failure) {
    if (resourceStateUncertain) {
      throw diagnostic(uncertain(failure,
        'native event worker or owned request outcome is unknown'));
    }
    throw diagnostic(failure);
  }
  try {
    check(prepared && staged && workerReleased && parsed &&
      ownedCleanupVerified,
    'one-worker event smoke did not finish its owned lease');
    return assessGapEventSmoke({preflight, staged, worker, parsed,
      phases, pathBefore, pathAfter, changedPaths, saveAudit,
      cleanup: ownedCleanupResult});
  } catch (error) {throw diagnostic(error);}
}

module.exports = {makeSmokeFrames, readSmokeReply,
  assessGapEventSmoke, runGapEventSmoke};
