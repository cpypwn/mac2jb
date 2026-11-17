'use strict';

// One initialized owned-root CloneCurrentObject control. It never converts a
// session to a domain, opens storage, launches workers, or tests a marker wave.
const {createHash} = require('node:crypto');
const domain = require('../civswitch/fs-kit/port/engine/shared/domain.cjs');
const {packet} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {paths} = require('./marker-path-control.cjs');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');
const {belongsToTransport} = require('./fs-attempt-packets.cjs');
const {claimOpenedService, makeIpcPacket} =
  require('./fs-counter-probe.cjs');
const {sampleCounterPair, parseCounterReply} =
  require('./fs-abort-adapter.cjs');
const {checkIdentity, checkPaths} = require('./fs-abort-control.cjs');
const {assessNoStorageControls} = require('./canary-geometry-plan.cjs');

const MODE = 'root-clone-control';
const CLONE_REQUEST = domain.control(2);
const COUNTER_REQUEST = packet(1009);
const closeAttempts = new WeakSet();

function check(value, reason) {
  if (!value) throw Error(`Balatro root clone control: ${reason}`);
}

function uncertain(cause, reason, detail = {}) {
  const error = Error(`Balatro root clone control: ${reason}; retain resources`,
    {cause});
  error.resourceStateUncertain = true;
  error.diagnostic = {...(cause?.diagnostic || {}), ...detail};
  return error;
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkPrepared(preflight, prepared) {
  const transport = prepared?.transport;
  check(preflight?.gameProfile === profile.gameProfile &&
    preflight.markerHitVerified === false &&
    preflight.fsStageVerified === false &&
    preflight.exactAllocationBytes === null &&
    /^[0-9a-f]{16}$/.test(preflight.arenaNonce || '') &&
    /^[0-9a-f]{16}$/.test(preflight.markerNonce || '') &&
    prepared?.arenaNonce === preflight.arenaNonce &&
    prepared.markerNonce === preflight.markerNonce &&
    prepared.sdkBase === preflight.sdkBase &&
    prepared.markerPath === paths(preflight.markerNonce).marker &&
    prepared.absentPath === paths(preflight.markerNonce).absent &&
    prepared.markerWrittenAndVerified === true &&
    prepared.ownedHandlesOpen === true &&
    prepared.borrowedSession === 'preserved' &&
    prepared.explicitSaveWrites === 1 &&
    prepared.root?.role === 'root' && prepared.root.closed === false &&
    transport?.evidence?.sdkBase === preflight.sdkBase &&
    transport.native?.addresses?.sdk === Number(BigInt(preflight.sdkBase)) &&
    transport.native.addresses.scratch ===
      Number(BigInt(preflight.arenaBase) + 0x10000n) &&
    transport.scratch === transport.native.addresses.scratch &&
    prepared.context?.arena === BigInt(preflight.arenaBase) &&
    prepared.context.sdk === BigInt(preflight.sdkBase) &&
    prepared.context.scratch === BigInt(transport.scratch) &&
    prepared.context.nonce === preflight.arenaNonce &&
    !transport.ownedHandles.has(prepared.root.handle) &&
    transport.ownedHandles.size === 2 &&
    transport.ownedHandles.has(prepared.clone?.handle) &&
    transport.ownedHandles.has(prepared.file?.handle) &&
    prepared.clone.handle !== prepared.file.handle &&
    prepared.root.handle !== prepared.clone.handle &&
    prepared.root.handle !== prepared.file.handle &&
    !transport.ownedHandles.has(
      transport.evidence.sessionManager.borrowedHandle),
  'fresh prepared root and exact two-handle lease are required');
  belongsToTransport(prepared.clone, transport, 'clone');
  belongsToTransport(prepared.file, transport, 'file');
  const native = makeIpcPacket(prepared.context, prepared.root, 'counters');
  check(native.subarray(0x1000, 0x1100).equals(COUNTER_REQUEST) &&
    CLONE_REQUEST.length === 256 &&
    CLONE_REQUEST.readUInt32LE(0) === 5 &&
    CLONE_REQUEST.readUInt32LE(domain.dataStart(CLONE_REQUEST) + 8) === 2,
  'owned root context or exact control packet changed');
  return transport;
}

async function openOneRootClone(preflight, prepared) {
  const transport = checkPrepared(preflight, prepared);
  let raw;
  try {raw = await transport.sendPacket(prepared.root.handle,
    CLONE_REQUEST);}
  catch (cause) {throw uncertain(cause, 'root control(2) outcome is unknown');}
  let parsed;
  try {
    check(Buffer.isBuffer(raw) && raw.length === 256,
      'root control(2) raw reply is missing');
    parsed = domain.response(raw);
  } catch (cause) {
    throw uncertain(cause, 'root control(2) reply framing is unknown',
      {cloneReplyHex: Buffer.isBuffer(raw) ? raw.toString('hex') : null});
  }
  const handle = parsed.moves?.[0];
  const forbidden = new Set([prepared.root.handle,
    prepared.clone.handle, prepared.file.handle,
    transport.evidence.sessionManager.borrowedHandle,
    ...transport.ownedHandles]);
  if (parsed.result !== 0 || parsed.moves.length !== 1 ||
      parsed.copies.length !== 0 || parsed.objects.length !== 0 ||
      !Number.isInteger(handle) || handle <= 0 ||
      handle >= 0xffff8000 || forbidden.has(handle))
    throw uncertain(null, 'root control(2) transfer is ambiguous',
      {cloneReplyHex: raw.toString('hex'),
        parsedResult: parsed.result,
        movedHandles: parsed.moves, copiedHandles: parsed.copies,
        domainObjects: parsed.objects});
  transport.ownedHandles.add(handle);
  const capability = claimOpenedService(prepared.context, 0n, handle);
  const native = makeIpcPacket(prepared.context, capability, 'counters');
  check(native.subarray(0x1000, 0x1100).equals(COUNTER_REQUEST),
    'cloned root did not bind to the same qualified owner context');
  return {owner: preflight.arenaNonce,
    parentRootHandle: prepared.root.handle,
    handle, capability, closed: false,
    open: {requestHex: CLONE_REQUEST.toString('hex'),
      requestSha256: sha(CLONE_REQUEST),
      replyHex: raw.toString('hex'), replySha256: sha(raw),
      movedHandle: handle}, close: null};
}

async function stableRootCounters(prepared, root, phase) {
  const transport = prepared?.transport;
  check(root?.role === 'root' && root.closed === false &&
    Number.isInteger(root.handle) &&
    (root === prepared.root || transport.ownedHandles.has(root.handle)) &&
    typeof phase === 'string' && /^[a-z-]+$/.test(phase),
  'same-owner open root and bounded counter phase are required');
  const native = makeIpcPacket(prepared.context, root, 'counters');
  check(native.subarray(0x1000, 0x1100).equals(COUNTER_REQUEST),
    'cloned root counter packet differs from the owned root');
  const rawReplies = [];
  let samples;
  try {
    samples = await sampleCounterPair(async () => {
      let raw;
      try {raw = await transport.sendPacket(root.handle,
        COUNTER_REQUEST);}
      catch (cause) {throw uncertain(cause,
        `${phase} counter IPC outcome is unknown`);}
      if (!Buffer.isBuffer(raw) || raw.length !== 256)
        throw uncertain(null, `${phase} counter reply is truncated`,
          {rawReplyHex: Buffer.isBuffer(raw) ? raw.toString('hex') : null});
      rawReplies.push({requestHex: COUNTER_REQUEST.toString('hex'),
        requestSha256: sha(COUNTER_REQUEST),
        replyHex: raw.toString('hex'), replySha256: sha(raw)});
      let parsed;
      try {parsed = domain.response(raw);}
      catch (cause) {throw uncertain(cause,
        `${phase} counter reply framing is unknown`);}
      if (parsed.moves.length || parsed.copies.length ||
          parsed.objects.length)
        throw uncertain(null, `${phase} counter reply transferred a handle`,
          {movedHandles: parsed.moves,
            copiedHandles: parsed.copies,
            domainObjects: parsed.objects});
      return parseCounterReply(raw);
    }, phase);
  } catch (cause) {
    cause.diagnostic = {...(cause.diagnostic || {}),
      phase, rawReplies, rawSamples: cause.rawSamples || null,
      observedGeneralHeap: cause.observedGeneralHeap || null};
    throw cause;
  }
  return {...samples, rootHandle: root.handle,
    requestSha256: sha(COUNTER_REQUEST), rawReplies};
}

async function closeOneRootClone(prepared, clone) {
  const transport = prepared?.transport;
  check(clone?.owner === prepared.arenaNonce &&
    clone.closed === false && clone.capability?.role === 'root' &&
    clone.capability.closed === false &&
    clone.capability.handle === clone.handle &&
    clone.parentRootHandle === prepared.root.handle &&
    clone.open?.movedHandle === clone.handle &&
    clone.handle !== prepared.root.handle &&
    clone.handle !== prepared.clone.handle &&
    clone.handle !== prepared.file.handle &&
    clone.handle !== transport.evidence.sessionManager.borrowedHandle &&
    transport.ownedHandles.has(clone.handle) &&
    !closeAttempts.has(clone),
  'same-owner cloned root is absent or already closing');
  makeIpcPacket(prepared.context, clone.capability, 'counters');
  closeAttempts.add(clone);
  let reply;
  try {reply = await transport.closeOwned(clone.handle);}
  catch (cause) {throw uncertain(cause, 'cloned root close outcome is unknown');}
  if (reply?.closed !== true || reply.closeResult !== 0)
    throw uncertain(null, 'cloned root close did not verify');
  clone.capability.closed = true;
  clone.closed = true;
  clone.close = {handle: clone.handle,
    sdkOffset: profile.symbols.svcCloseHandle.offset,
    method: 'worker-svcCloseHandle', resultHex: '0x0', attemptedOnce: true};
  return clone.close;
}

function assessRootCloneControl({preflight, prepared, clone, phases,
  pathBefore, pathAfter, changedPaths, saveAudit, cleanup}) {
  const rows = ['before', 'noStorageBefore', 'cloneHeld',
    'originalHeld', 'after', 'noStorageAfter'];
  check(preflight?.gameProfile === profile.gameProfile &&
    prepared?.arenaNonce === preflight.arenaNonce &&
    prepared.markerNonce === preflight.markerNonce &&
    clone?.owner === preflight.arenaNonce &&
    clone.parentRootHandle === prepared.root.handle &&
    clone.closed === true && clone.capability.closed === true &&
    clone.close?.resultHex === '0x0' &&
    clone.close.attemptedOnce === true &&
    clone.open?.movedHandle === clone.handle &&
    clone.open.requestHex === CLONE_REQUEST.toString('hex') &&
    clone.open.requestSha256 === sha(CLONE_REQUEST) &&
    clone.open.replyHex?.length === 512 &&
    rows.every(name => phases?.[name]?.samples?.length === 2 &&
      phases[name].rawReplies?.length >= 3 &&
      phases[name].rawReplies.length <= 8 &&
      phases[name].rawReplies.every(row =>
        row.requestHex === COUNTER_REQUEST.toString('hex') &&
        row.requestSha256 === sha(COUNTER_REQUEST) &&
        row.replyHex?.length === 512)) &&
    phases.cloneHeld.rootHandle === clone.handle &&
    phases.originalHeld.rootHandle === prepared.root.handle &&
    phases.before.rootHandle === prepared.root.handle &&
    phases.after.rootHandle === prepared.root.handle &&
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
  'exact cloned root, stable counters, save audit, or cleanup is missing');
  checkPaths(pathBefore, preflight.markerNonce);
  checkPaths(pathAfter, preflight.markerNonce);
  assessNoStorageControls(phases);
  return {gameProfile: profile.gameProfile,
    arenaNonce: preflight.arenaNonce,
    markerNonce: preflight.markerNonce,
    parentRootHandle: prepared.root.handle,
    clonedRootHandle: clone.handle,
    cloneRequest: clone.open, cloneClose: clone.close,
    counterPhases: phases,
    heldGeneralHeapDelta: phases.before.samples[1][5] -
      phases.cloneHeld.samples[1][5],
    cloneCounterVerified: true,
    originalRootPreserved: true,
    counterBaselineRestored: true,
    completeSaveAuditVerified: true,
    saveTreeAudit: saveAudit, changedPaths,
    preparationMarkerSaveWrites: 1,
    controlSaveWrites: 0,
    clonedRootClosed: true, cleanup: 'verified',
    ...markerCleanupSummary(cleanup),
    rootClonesOpened: 1, rootClonesClosed: 1,
    domainConverted: false, groupObjectsOpened: 0,
    storageHandlesOpened: 0, workerStarted: false,
    markerAttempted: false, fsHandlerOverlapMeasured: false,
    fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false,
    status: 'one initialized owned-root clone and counters verified; domain group and 2/4 unverified'};
}

async function runRootCloneControl({preflight, adapter,
  onPhase = () => {}}) {
  check(adapter && ['inspect', 'prepare', 'readPaths', 'auditPaths',
    'auditDetails', 'cleanup'].every(name =>
      typeof adapter[name] === 'function') &&
    typeof onPhase === 'function',
  'one qualified owner adapter is required');
  checkIdentity(await adapter.inspect(), preflight);
  let prepared, clone, phases, pathBefore, pathAfter;
  let changedPaths, saveAudit;
  let cloneOpenAttempted = false;
  let cloneCloseAttempted = false;
  let cloneClosed = false;
  let ownedCleanupAttempted = false;
  let ownedCleanupVerified = false;
  let ownedCleanupResult;
  let resourceStateUncertain = false;
  let failure;
  const diagnostic = error => {
    error.diagnostic = {
      ...(error.diagnostic && typeof error.diagnostic === 'object' ?
        error.diagnostic : {}),
      arenaNonce: preflight.arenaNonce,
      cloneOpenAttempted,
      cloneHandle: clone?.handle ?? null,
      cloneRequest: clone?.open ?? null,
      cloneCloseAttempted, cloneClosed,
      cloneClose: clone?.close ?? null,
      counterPhases: phases ?? null,
      pathBefore: pathBefore ?? null,
      pathAfter: pathAfter ?? null,
      saveTreeAudit: saveAudit ?? null,
      changedPaths: changedPaths ?? null,
      ownedCleanupAttempted, ownedCleanupVerified,
      ownedCleanupResult: ownedCleanupResult ?? null,
      resourceStateUncertain,
      rootClonesOpened: clone ? 1 : 0,
      domainConverted: false, groupObjectsOpened: 0,
      storageHandlesOpened: 0, workerStarted: false,
      markerAttempted: false,
      fsSideMarkerReadbackVerified: false,
      markerHitVerified: false, fsStageVerified: false};
    return error;
  };
  try {
    onPhase('prepare-one-owned-root-and-save-baseline');
    prepared = await adapter.prepare(preflight);
    checkPrepared(preflight, prepared);
    pathBefore = await adapter.readPaths(prepared);
    checkPaths(pathBefore, preflight.markerNonce);
    phases = {};
    phases.before = await stableRootCounters(prepared,
      prepared.root, 'root-clone-before');
    phases.noStorageBefore = await stableRootCounters(prepared,
      prepared.root, 'root-clone-no-storage-before');
    onPhase('clone-initialized-owned-root-once');
    cloneOpenAttempted = true;
    clone = await openOneRootClone(preflight, prepared);
    onPhase('sample-cloned-root-command-1009');
    phases.cloneHeld = await stableRootCounters(prepared,
      clone.capability, 'root-clone-held');
    phases.originalHeld = await stableRootCounters(prepared,
      prepared.root, 'root-clone-original-held');
    onPhase('close-cloned-root-once');
    cloneCloseAttempted = true;
    await closeOneRootClone(prepared, clone);
    cloneClosed = clone.closed === true;
    phases.after = await stableRootCounters(prepared,
      prepared.root, 'root-clone-after');
    phases.noStorageAfter = await stableRootCounters(prepared,
      prepared.root, 'root-clone-no-storage-after');
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
    'complete cloned save audit changed');
  } catch (error) {
    failure = error;
    resourceStateUncertain = error?.resourceStateUncertain === true ||
      cloneOpenAttempted && !clone ||
      cloneCloseAttempted && !cloneClosed;
  }
  if (prepared && !resourceStateUncertain) {
    try {
      if (clone && !clone.closed) {
        cloneCloseAttempted = true;
        await closeOneRootClone(prepared, clone);
        cloneClosed = clone.closed === true;
      }
      check(prepared.transport.ownedHandles.size === 2 &&
        prepared.transport.ownedHandles.has(prepared.clone.handle) &&
        prepared.transport.ownedHandles.has(prepared.file.handle) &&
        (!clone || !prepared.transport.ownedHandles.has(clone.handle)),
      'cloned-root ledger did not return to the prepared two handles');
      onPhase('cleanup-marker-handles-root-bridge-and-arena');
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
          'root clone control and cleanup failed') : cause,
      'final owner cleanup outcome is unknown'));
    }
  }
  if (failure) {
    if (resourceStateUncertain) throw diagnostic(uncertain(failure,
      'clone transfer, counters, or close outcome is unknown'));
    throw diagnostic(failure);
  }
  try {
    check(cloneClosed && ownedCleanupVerified,
      'root clone and owner were not fully released');
    return assessRootCloneControl({preflight, prepared, clone, phases,
      pathBefore, pathAfter, changedPaths, saveAudit,
      cleanup: ownedCleanupResult});
  } catch (error) {throw diagnostic(error);}
}

module.exports = {MODE, CLONE_REQUEST, COUNTER_REQUEST,
  checkPrepared, openOneRootClone, stableRootCounters,
  closeOneRootClone, assessRootCloneControl, runRootCloneControl};
