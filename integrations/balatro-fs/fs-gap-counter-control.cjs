'use strict';

// Thirteen distinct, owned fsp-srv roots each send only command 1009. This
// qualifies the event worker's role count and cleanup; it never stages a
// path descriptor, storage read, canary request, or positive wave.
const {createHash, randomBytes} = require('node:crypto');
const net = require('node:net');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');
const {packet} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {openQualifiedRoot, closeQualifiedRoot} =
  require('./fs-owned-prep.cjs');
const {makeIpcPacket} = require('./fs-counter-probe.cjs');
const {parseCounterReply} = require('./fs-abort-adapter.cjs');
const {checkIdentity, checkPaths} = require('./fs-abort-control.cjs');
const {assessNoStorageControls} = require('./canary-geometry-plan.cjs');
const {ROLES, planGapPortLayout} = require('./fs-gap-port-layout.cjs');
const {buildGapEventFrame, RESULT_OFFSETS} =
  require('./fs-gap-event-frame.cjs');
const {stageGapEventFrames, makeGapEventWorkerSource,
  parseGapEventWorkerReply} = require('./fs-gap-event-worker.cjs');
const {PACKET_OFFSET} = require('./fs-counter-overlap.cjs');

const REQUEST = packet(1009);
const REQUEST_SHA256 = createHash('sha256').update(REQUEST).digest('hex');

function check(value, reason) {
  if (!value) throw Error(`Balatro gap counter control: ${reason}`);
}

function uncertain(cause, reason, diagnostic = {}) {
  const error = Error(`Balatro gap counter control: ${reason}; retain resources`,
    {cause});
  error.resourceStateUncertain = true;
  error.diagnostic = {...(cause?.diagnostic || {}), ...diagnostic};
  return error;
}

function rootIds(roots) {
  return roots.map(root => root.handle);
}

function checkRootLedger(prepared, roots) {
  const borrowed = prepared.transport.evidence.sessionManager.borrowedHandle;
  const forbidden = new Set([borrowed,
    prepared.clone.handle, prepared.file.handle]);
  check(Array.isArray(roots) && roots.length === ROLES.length &&
    roots[0] === prepared.root &&
    roots.every(root => root?.role === 'root' && root.closed === false &&
      Number.isInteger(root.handle) && root.handle > 0 &&
      root.handle < 0xffff8000 && !forbidden.has(root.handle) &&
      !prepared.transport.ownedHandles.has(root.handle)) &&
    new Set(rootIds(roots)).size === ROLES.length,
  'thirteen distinct owned root handles are required');
  for (const root of roots) {
    // makeIpcPacket checks the unforgeable qualified-context ownership token.
    makeIpcPacket(prepared.context, root, 'counters');
  }
  return roots;
}

async function openCounterRoots(prepared, onPhase = () => {}) {
  check(prepared?.root?.role === 'root' &&
    prepared.root.closed === false &&
    prepared?.transport && prepared?.context &&
    typeof onPhase === 'function',
  'fresh prepared owner and root are required');
  const roots = [prepared.root];
  let attempted = 0;
  try {
    while (roots.length < ROLES.length) {
      attempted++;
      onPhase(`open-owned-counter-root-${attempted}`);
      const root = await openQualifiedRoot({transport: prepared.transport,
        context: prepared.context,
        onPhase: label => onPhase(`counter-root-${attempted}:${label}`)});
      roots.push(root);
      checkRootPrefix(prepared, roots);
    }
    return checkRootLedger(prepared, roots);
  } catch (cause) {
    throw uncertain(cause, 'extra-root open or identity is ambiguous',
      {attempted, knownHandles: rootIds(roots),
        knownClosed: roots.map(root => root.closed === true)});
  }
}

function checkRootPrefix(prepared, roots) {
  const borrowed = prepared.transport.evidence.sessionManager.borrowedHandle;
  const forbidden = new Set([borrowed,
    prepared.clone.handle, prepared.file.handle]);
  check(roots[0] === prepared.root &&
    roots.every(root => root?.role === 'root' && root.closed === false &&
      Number.isInteger(root.handle) && root.handle > 0 &&
      root.handle < 0xffff8000 && !forbidden.has(root.handle) &&
      !prepared.transport.ownedHandles.has(root.handle)) &&
    new Set(rootIds(roots)).size === roots.length,
  'opened root aliases another owned or borrowed handle');
  for (const root of roots) {
    makeIpcPacket(prepared.context, root, 'counters');
  }
}

async function closeCounterRoots(prepared, roots, onPhase = () => {}) {
  check(typeof onPhase === 'function',
    'phase callback is required for exact root close');
  checkRootLedger(prepared, roots);
  let attempted = 0;
  for (let index = roots.length - 1; index >= 1; index--) {
    const root = roots[index];
    attempted++;
    onPhase(`close-owned-counter-root-${index}`);
    try {
      const result = await closeQualifiedRoot({transport: prepared.transport,
        root});
      check(result?.closed === true && root.closed === true,
      `root ${index} close did not verify`);
    } catch (cause) {
      throw uncertain(cause, 'extra-root close is ambiguous',
        {attempted, knownHandles: rootIds(roots),
          knownClosed: roots.map(row => row.closed === true)});
    }
  }
  check(roots[0] === prepared.root && roots[0].closed === false &&
    roots.slice(1).every(root => root.closed === true),
  'counter root ledger did not close exactly once');
  return {closed: true, extraRootsClosed: ROLES.length - 1,
    rootHandles: rootIds(roots)};
}

function buildCounterFrames({preflight, prepared, layout, roots, waveId}) {
  check(layout?.owner?.arenaNonce === preflight?.arenaNonce &&
    layout.owner.markerNonce === preflight.markerNonce &&
    /^[0-9a-f]{16}$/.test(waveId || '') &&
    new Set([waveId, preflight.arenaNonce,
      preflight.markerNonce]).size === 3 &&
    REQUEST.length === 256,
  'same-owner counter wave or exact packet changed');
  checkRootLedger(prepared, roots);
  const frames = ROLES.map((role, index) =>
    buildGapEventFrame({layout, role,
      handle: roots[index].handle, request: REQUEST}));
  check(frames.every((frame, index) =>
    frame.role === ROLES[index] &&
    frame.requestSha256 === REQUEST_SHA256),
  'counter-only role frames changed');
  return Object.freeze({workerKind: 'balatro-gap-event-frames',
    mode: 'gap-counter-control', arenaNonce: preflight.arenaNonce,
    waveId, arenaBase: layout.owner.arenaBase,
    sdkBase: layout.owner.sdkBase, layout, frames,
    requestSha256: REQUEST_SHA256,
    counterOnly: true, markerAttempted: false,
    fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false});
}

async function readCounterReplies(native, staged, worker) {
  check(native && typeof native.read === 'function' &&
    native.addresses?.scratch === staged?.arenaBase + 0x10000 &&
    native.addresses?.sdk === staged?.sdkBase &&
    staged?.mode === 'gap-counter-control' &&
    staged.counterOnly === true &&
    staged.frames?.length === ROLES.length &&
    worker?.eventGate === 'initialized-signaled-finalized' &&
    worker.workerState === 'joined-closed' &&
    worker.threadHandles === 'closed' &&
    worker.rows?.length === ROLES.length,
  'joined thirteen-worker counter control is required');
  const replies = [];
  for (let index = 0; index < ROLES.length; index++) {
    const frame = staged.frames[index];
    const row = worker.rows[index];
    check(frame.role === ROLES[index] && row.role === frame.role &&
      row.handle === frame.handle && row.transportResult === 0,
    `role ${index} native transport identity changed`);
    const start = await native.read(frame.address + RESULT_OFFSETS.startTick, 8);
    const sent = await native.read(frame.address + RESULT_OFFSETS.transportResult, 8);
    const end = await native.read(frame.address + RESULT_OFFSETS.endTick, 8);
    check([start, sent, end].every(bytes =>
      Buffer.isBuffer(bytes) && bytes.length === 8) &&
      start.readBigUInt64LE(0) === BigInt(row.startTick) &&
      sent.readBigUInt64LE(0) === 0n &&
      end.readBigUInt64LE(0) === BigInt(row.endTick),
    `${frame.role} native tick or send result changed`);
    const bytes = await native.read(frame.address + PACKET_OFFSET, 256);
    check(Buffer.isBuffer(bytes) && bytes.length === 256,
      `${frame.role} reply buffer did not read back`);
    const counters = parseCounterReply(bytes);
    replies.push({role: frame.role, handle: frame.handle,
      threadId: row.threadId, rawStartTick: row.rawStartTick,
      rawEndTick: row.rawEndTick, transportResult: 0,
      ipcResult: 0, counterCount: counters.length,
      counters, requestSha256: staged.requestSha256,
      replyHex: bytes.toString('hex'),
      replySha256: createHash('sha256').update(bytes).digest('hex')});
  }
  return replies;
}

function assessCounterControl({preflight, staged, worker, replies, roots,
  rootClosure, phases, pathBefore, pathAfter, changedPaths,
  saveAudit, cleanup}) {
  check(staged?.mode === 'gap-counter-control' &&
    staged.counterOnly === true && staged.markerAttempted === false &&
    staged.arenaNonce === preflight?.arenaNonce &&
    staged.layout.owner.markerNonce === preflight.markerNonce &&
    worker?.workerState === 'joined-closed' &&
    worker.eventGate === 'initialized-signaled-finalized' &&
    worker.threadHandles === 'closed' &&
    worker.parentOwnedServiceHandles === 'preserved' &&
    worker.rows?.length === ROLES.length &&
    Array.isArray(replies) && replies.length === ROLES.length &&
    replies.every((row, index) =>
      row.role === ROLES[index] &&
      row.handle === staged.frames[index].handle &&
      row.threadId === worker.rows[index].threadId &&
      row.transportResult === 0 && row.ipcResult === 0 &&
      row.counterCount === 16 &&
      Array.isArray(row.counters) && row.counters.length === 16 &&
      row.counters.every(value =>
        Number.isSafeInteger(value) && value >= 0) &&
      row.requestSha256 === REQUEST_SHA256 &&
      /^[0-9a-f]{512}$/.test(row.replyHex || '') &&
      createHash('sha256').update(Buffer.from(row.replyHex, 'hex'))
        .digest('hex') === row.replySha256 &&
      JSON.stringify(parseCounterReply(Buffer.from(row.replyHex, 'hex'))) ===
        JSON.stringify(row.counters) &&
      /^[0-9a-f]{64}$/.test(row.replySha256 || '')) &&
    roots?.length === ROLES.length &&
    roots[0].closed === true &&
    roots.slice(1).every(root => root.closed === true) &&
    rootClosure?.closed === true &&
    rootClosure.extraRootsClosed === ROLES.length - 1 &&
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
  'counter-only replies, stable save tree, or one-shot cleanup missing');
  checkPaths(pathBefore, preflight.markerNonce);
  checkPaths(pathAfter, preflight.markerNonce);
  assessNoStorageControls(phases);
  return {gameProfile: profile.gameProfile,
    arenaNonce: preflight.arenaNonce,
    markerNonce: preflight.markerNonce, waveId: staged.waveId,
    workerKind: 'balatro-gap-counter-control',
    roles: [...ROLES], roleSemantics: 'counter-only-slots',
    rootHandles: rootIds(roots),
    extraRootsClosed: rootClosure.extraRootsClosed,
    waveRows: worker.rows, counterReplies: replies,
    counterPhases: phases, pathBefore, pathAfter,
    changedPaths, saveTreeAudit: saveAudit,
    eventGate: worker.eventGate,
    preparationMarkerSaveWrites: 1, counterControlSaveWrites: 0,
    completeSaveAuditVerified: true, counterBaselineRestored: true,
    cleanup: 'verified', ...markerCleanupSummary(cleanup),
    nativeThirteenWorkerControlVerified: true,
    markerAttempted: false, fsHandlerOverlapMeasured: false,
    fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false,
    status: 'thirteen distinct owned counter requests passed native event gate; FS canary and 2/4 unverified'};
}

async function runGapCounterControl({preflight, adapter, executeSource,
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
    new Set([waveId, preflight?.arenaNonce,
      preflight?.markerNonce]).size === 3,
  'fresh owner, exact transport, and distinct wave are required');
  checkIdentity(await adapter.inspect(), preflight);
  let prepared, roots, rootClosure, staged, worker, replies, phases;
  let pathBefore, pathAfter, changedPaths, saveAudit;
  let rootOpenAttempted = false;
  let workerRequestSent = false;
  let workerReleased = false;
  let rootsCloseAttempted = false;
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
      rootOpenAttempted,
      rootHandles: roots ? rootIds(roots) : null,
      rootsClosed: roots?.map(root => root.closed === true) ?? null,
      rootsCloseAttempted,
      rootClosure: rootClosure ?? null,
      workerRequestSent, workerReleased,
      workerState: worker?.workerState ?? null,
      eventGate: worker?.eventGate ?? null,
      waveRows: worker?.rows ?? null,
      counterReplies: replies ?? null,
      counterPhases: phases ?? null,
      pathBefore: pathBefore ?? null,
      pathAfter: pathAfter ?? null,
      changedPaths: changedPaths ?? null,
      saveTreeAudit: saveAudit ?? null,
      ownedCleanupAttempted, ownedCleanupVerified,
      ownedCleanupResult: ownedCleanupResult ?? null,
      resourceStateUncertain,
      markerAttempted: false,
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
    phases = {before: await counterPair('gap-counter-before'),
      noStorageBefore: await counterPair('gap-counter-no-storage-before')};
    onPhase('open-thirteen-distinct-owned-counter-roots');
    rootOpenAttempted = true;
    roots = await openCounterRoots(prepared, onPhase);
    const layout = planGapPortLayout({preflight, prepared});
    staged = buildCounterFrames({preflight, prepared,
      layout, roots, waveId});
    const stageReceipt = await stageGapEventFrames(
      prepared.transport.native, staged);
    const options = {nonce: preflight.arenaNonce,
      arenaBase: preflight.arenaBase, sdkBase: preflight.sdkBase,
      mainBase, waveId, hostIp: macIp, port, staged, stageReceipt};
    const source = makeGapEventWorkerSource(options);
    onPhase('run-thirteen-gated-owned-counter-workers');
    workerRequestSent = true;
    worker = parseGapEventWorkerReply(await executeSource({host,
      port: 9026, source, timeoutMs: 15000}), options);
    workerReleased = worker.workerState === 'joined-closed' &&
      worker.eventGate === 'initialized-signaled-finalized';
    onPhase('read-thirteen-exact-counter-replies');
    replies = await readCounterReplies(prepared.transport.native,
      staged, worker);
    rootsCloseAttempted = true;
    rootClosure = await closeCounterRoots(prepared, roots, onPhase);
    phases.after = await counterPair('gap-counter-after');
    phases.noStorageAfter = await counterPair('gap-counter-no-storage-after');
    pathAfter = await adapter.readPaths(prepared);
    checkPaths(pathAfter, preflight.markerNonce);
    changedPaths = await adapter.auditPaths(prepared);
    saveAudit = adapter.auditDetails();
    check(Array.isArray(changedPaths) && changedPaths.length === 0,
      `save audit changed paths: ${JSON.stringify(changedPaths)}`);
  } catch (error) {
    failure = error;
    resourceStateUncertain = error?.resourceStateUncertain === true ||
      rootOpenAttempted && !roots ||
      workerRequestSent && (!workerReleased || !replies) ||
      rootsCloseAttempted && !rootClosure;
  }
  if (prepared && !resourceStateUncertain) {
    try {
      if (roots && !rootClosure) {
        rootsCloseAttempted = true;
        rootClosure = await closeCounterRoots(prepared, roots, onPhase);
      }
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
          'counter control and cleanup failed') : cause,
      'extra-root or final owner cleanup is unknown'));
    }
  }
  if (failure) {
    if (resourceStateUncertain) {
      throw diagnostic(uncertain(failure,
        'root, worker, or counter reply outcome is unknown'));
    }
    throw diagnostic(failure);
  }
  try {
    check(prepared && roots && rootClosure && staged &&
      workerReleased && replies && ownedCleanupVerified,
    'thirteen-worker counter control did not finish its owner');
    return assessCounterControl({preflight, staged, worker, replies,
      roots, rootClosure, phases, pathBefore, pathAfter,
      changedPaths, saveAudit, cleanup: ownedCleanupResult});
  } catch (error) {throw diagnostic(error);}
}

module.exports = {ROLES, REQUEST_SHA256,
  checkRootLedger, openCounterRoots, closeCounterRoots,
  buildCounterFrames, readCounterReplies,
  assessCounterControl, runGapCounterControl};
