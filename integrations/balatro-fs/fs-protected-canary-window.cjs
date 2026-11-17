'use strict';

const {createHash, randomBytes} = require('node:crypto');
const net = require('node:net');
const {copyRequest, copiedHandle, relativePath} = require('./clone-control.cjs');
const {claimClone, belongsToTransport} = require('./fs-attempt-packets.cjs');
const {content} = require('./marker-content-control.cjs');
const {isExact, isAbsent} = require('./fs-owned-prep.cjs');
const {markerCleanupVerified} = require('./fs-marker-cleanup.cjs');
const {openLogRead, closeLogRead, READ_BYTES} =
  require('./fs-receive-window.cjs');
const {buildProtectedCanaryPlan, parseProtectedReplies,
  assessProtectedCanary} = require('./fs-protected-canary-plan.cjs');
const {closeMovedStorage} = require('./fs-abort-frames.cjs');
const {makeAbortGuardSource, parseAbortGuardReply,
  makeAbortWorkerSource, parseAbortWorkerReply} =
  require('./fs-abort-worker.cjs');
const {checkIdentity, checkPaths} = require('./fs-abort-control.cjs');
const {PACKET_OFFSET} = require('./fs-counter-overlap.cjs');
const {RESULT_OFFSET} = require('./worker-chain.cjs');

const ROLES = Object.freeze(['canary', 'pin', 'receive', 'trigger']);

function check(value, reason) {
  if (!value) throw Error(`Balatro protected window: ${reason}`);
}

function uncertain(cause, reason) {
  const error = Error(`Balatro protected window: ${reason}; retain resources`,
    {cause});
  error.resourceStateUncertain = true;
  return error;
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function openProtectedClone(prepared) {
  const {transport, clone, file, root, markerNonce, markerPath,
    absentPath} = prepared || {};
  check(transport && transport.ownedHandles?.has(clone?.handle) &&
    transport.ownedHandles.has(file?.handle) &&
    root?.closed === false &&
    /^[0-9a-f]{16}$/.test(markerNonce || '') &&
    typeof transport.sendControl === 'function' &&
    typeof transport.readClone === 'function',
  'owned marker and original clone are missing');
  belongsToTransport(clone, transport, 'clone');
  const copied = copyRequest(transport.evidence);
  let handle, capability;
  try {
    const reply = await transport.sendControl(copied.borrowedHandle,
      copied.packet);
    handle = copiedHandle(reply, copied.borrowedHandle);
    check(handle !== clone.handle && handle !== file.handle &&
      handle !== root.handle && transport.ownedHandles.has(handle),
    'second copy did not transfer a distinct owned clone');
    capability = claimClone({transport, controlReply: reply});
    const expected = content(markerNonce);
    const missing = Number.parseInt(transport.evidence.absentPathResult, 16);
    check(isExact(await transport.readClone(handle,
      relativePath(markerPath)), expected) &&
      isAbsent(await transport.readClone(handle,
        relativePath(absentPath)), missing),
    'protected clone serial marker and absent controls changed');
  } catch (cause) {
    throw uncertain(cause, 'second clone copy or readback state is unknown');
  }
  return {handle, capability, closed: false,
    markerVerified: true, absentVerified: true};
}

async function closeProtectedClone(prepared, protectedClone) {
  check(protectedClone?.closed === false &&
    protectedClone.handle !== prepared?.clone?.handle &&
    protectedClone.handle !== prepared?.file?.handle &&
    prepared?.transport?.ownedHandles?.has(protectedClone.handle),
  'second owned clone is missing or already closed');
  belongsToTransport(protectedClone.capability, prepared.transport, 'clone');
  try {
    const result = await prepared.transport.closeOwned(protectedClone.handle);
    check(result?.closed === true, 'second owned clone close did not verify');
    protectedClone.closed = true;
    return {closed: true, handle: protectedClone.handle};
  } catch (cause) {
    throw uncertain(cause, 'second owned clone close is unknown');
  }
}

async function stageProtectedFrames(native, staged) {
  const scratch = staged?.arenaBase + 0x10000;
  check(native && typeof native.write === 'function' &&
    typeof native.read === 'function' &&
    native.addresses?.scratch === scratch &&
    native.addresses?.sdk === staged?.sdkBase &&
    staged?.workerKind === 'protected-canary-window' &&
    Array.isArray(staged.frames) && staged.frames.length === ROLES.length &&
    staged.descriptors?.trigger?.address === scratch + 0x20000 &&
    staged.receiveAddress === scratch + 0x22000 &&
    staged.receiveBytes === READ_BYTES &&
    staged.descriptors?.canary?.address === scratch + 0x34000 &&
    staged.frames.every((frame, index) => frame.role === ROLES[index] &&
      frame.address === staged.arenaBase + index * 0x4000 &&
      Buffer.isBuffer(frame.bytes) && frame.bytes.length === 0x3000 &&
      frame.sha256 === sha(frame.bytes)) &&
    Buffer.isBuffer(staged.descriptors.trigger.bytes) &&
    Buffer.isBuffer(staged.descriptors.canary.bytes) &&
    staged.descriptors.trigger.sha256 ===
      sha(staged.descriptors.trigger.bytes) &&
    staged.descriptors.canary.sha256 ===
      sha(staged.descriptors.canary.bytes),
  'four exact owned frames and disjoint buffers are required');
  const writes = [
    {name: 'trigger-descriptor', address: staged.descriptors.trigger.address,
      bytes: staged.descriptors.trigger.bytes},
    {name: 'canary-descriptor', address: staged.descriptors.canary.address,
      bytes: staged.descriptors.canary.bytes},
    {name: 'log-receive', address: staged.receiveAddress,
      bytes: Buffer.alloc(staged.receiveBytes)},
    ...staged.frames.map(frame => ({name: frame.role,
      address: frame.address, bytes: frame.bytes})),
  ];
  check(writes[0].bytes.length === 0x800 &&
    writes[1].bytes.length === 0x800 &&
    writes[0].address + 0x800 <= writes[2].address &&
    writes[2].address + READ_BYTES <= writes[1].address &&
    writes[1].address + 0x800 <= scratch + 0x40000 &&
    staged.frames.at(-1).address + 0x3000 < scratch,
  'protected descriptors overlap receive or native packet workspace');
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
  return {arenaNonce: staged.arenaNonce, waveId: staged.waveId,
    frameSha256: staged.frames.map(frame => frame.sha256),
    exactReadbackVerified: true, workerStarted: false, saveWrites: 0};
}

async function readProtectedReplies(native, staged, worker, prefix) {
  check(native && typeof native.read === 'function' &&
    native.addresses?.scratch === staged?.arenaBase + 0x10000 &&
    native.addresses?.sdk === staged?.sdkBase &&
    worker?.workerState === 'joined-closed' &&
    worker.serviceHandles === 'closed' &&
    Array.isArray(worker.rows) && worker.rows.length === ROLES.length,
  'stopped owned worker and native transport are required');
  const replies = [];
  let received;
  try {
    for (let i = 0; i < ROLES.length; i++) {
      const frame = staged.frames[i];
      const row = worker.rows[i];
      const ticks = await native.read(frame.address + RESULT_OFFSET, 24);
      check(frame.role === ROLES[i] && row.role === ROLES[i] &&
        Buffer.isBuffer(ticks) && ticks.length === 24 &&
        ticks.readBigUInt64LE(0) === BigInt(row.startTick) &&
        ticks.readBigUInt64LE(8) === 0n &&
        ticks.readBigUInt64LE(16) === BigInt(row.endTick),
      `${frame.role} native ticks or transport changed`);
      replies.push(await native.read(frame.address + PACKET_OFFSET, 256));
    }
    received = await native.read(staged.receiveAddress,
      staged.receiveBytes);
    return parseProtectedReplies(staged, worker, replies, received, prefix);
  } catch (error) {
    error.nativeRepliesHex = replies.map(value =>
      Buffer.isBuffer(value) ? value.toString('hex') : null);
    error.nativeReceiveSha256 = Buffer.isBuffer(received) ? sha(received) : null;
    throw error;
  }
}

async function runProtectedCanaryWindow({preflight, adapter, executeSource,
  host, macIp, port, mainBase,
  waveId = randomBytes(8).toString('hex'), onPhase = () => {}}) {
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
  checkIdentity(await adapter.inspect(), preflight);
  let prepared, protectedClone, log, staged, worker, parsed, phases;
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
  const withDiagnostic = (error, uncertainState = resourceStateUncertain) => {
    error.diagnostic = {
      ...(error.diagnostic && typeof error.diagnostic === 'object' ?
        error.diagnostic : {}),
      arenaNonce: preflight.arenaNonce, waveId,
      counterPhases: phases ?? null,
      waveRows: parsed?.rows ?? worker?.rows ?? null,
      saveTreeAudit: saveAudit ?? null,
      changedPaths: changedPaths ?? null,
      pathBefore: pathBefore ?? null, pathAfter: pathAfter ?? null,
      protectedCloneHandle: protectedClone?.handle ?? null,
      protectedCloneClosed: protectedClone?.closed === true,
      logPath: log?.path ?? null, logHandle: log?.handle ?? null,
      logHandleClosed: log?.closed === true,
      workerRequestSent, workerReleased,
      workerState: worker?.workerState ?? null,
      serviceHandles: worker?.serviceHandles ?? null,
      movedStorageCloseAttempted, movedStorageClosed,
      ownedCleanupAttempted, ownedCleanupVerified,
      ownedCleanupResult: ownedCleanupResult ?? null,
      resourceStateUncertain: uncertainState,
      receivedPrefixSha256: parsed?.receivedPrefixSha256 ?? null,
      nativeRepliesHex: error.nativeRepliesHex ??
        error.cause?.nativeRepliesHex ?? null,
      nativeReceiveSha256: error.nativeReceiveSha256 ??
        error.cause?.nativeReceiveSha256 ?? null,
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
    phases = {before: await counterPair('protected-before'),
      noStorageBefore: await counterPair('protected-no-storage-before')};
    onPhase('copy-distinct-protected-save-clone');
    protectedClone = await openProtectedClone(prepared);
    onPhase('open-read-only-log-and-anchor-prefix');
    log = await openLogRead({prepared});
    staged = buildProtectedCanaryPlan({preflight, prepared, log,
      protectedClone: protectedClone.capability, waveId});
    const stageReceipt = await stageProtectedFrames(
      prepared.transport.native, staged);
    const options = {nonce: preflight.arenaNonce,
      arenaBase: preflight.arenaBase, sdkBase: preflight.sdkBase,
      mainBase, waveId, hostIp: macIp, port, staged, stageReceipt};
    onPhase('verify-four-staged-native-frames');
    parseAbortGuardReply(await executeSource({host, port: 9026,
      source: makeAbortGuardSource(options), timeoutMs: 15000}), options);
    onPhase('run-single-protected-client-window');
    workerRequestSent = true;
    worker = parseAbortWorkerReply(await executeSource({host, port: 9026,
      source: makeAbortWorkerSource(options), timeoutMs: 15000}), options);
    workerReleased = worker.workerState === 'joined-closed' &&
      worker.serviceHandles === 'closed';
    parsed = await readProtectedReplies(prepared.transport.native,
      staged, worker, log.prefix);
    movedStorageCloseAttempted = true;
    const moved = await closeMovedStorage(prepared.transport.native,
      staged, parsed);
    movedStorageClosed = moved?.closed === true;
    check(movedStorageClosed, 'owned moved storage close did not verify');
    onPhase('close-owned-log-and-protected-clone');
    await closeLogRead(prepared, log);
    await closeProtectedClone(prepared, protectedClone);
    phases.after = await counterPair('protected-after');
    phases.noStorageAfter = await counterPair('protected-no-storage-after');
    pathAfter = await adapter.readPaths(prepared);
    checkPaths(pathAfter, preflight.markerNonce);
    changedPaths = await adapter.auditPaths(prepared);
    saveAudit = adapter.auditDetails();
    check(Array.isArray(changedPaths) && changedPaths.length === 0,
      `save audit changed paths: ${JSON.stringify(changedPaths)}`);
    check(saveAudit?.coverage === 'bounded-cloned-save-tree' &&
      saveAudit.completeSaveTreeVerified === true &&
      saveAudit.logPrefixVerified === true &&
      saveAudit.logState === 'append-only' &&
      Array.isArray(saveAudit.changed) && saveAudit.changed.length === 0,
    'complete cloned save audit did not verify the log prefix');
  } catch (error) {
    failure = error;
    resourceStateUncertain = error?.resourceStateUncertain === true ||
      workerRequestSent && (!workerReleased || !parsed || !movedStorageClosed);
  }
  if (prepared && !resourceStateUncertain) {
    try {
      if (log && !log.closed) await closeLogRead(prepared, log);
      if (protectedClone && !protectedClone.closed) {
        await closeProtectedClone(prepared, protectedClone);
      }
      onPhase('cleanup-owned-marker-handles-and-arena');
      ownedCleanupAttempted = true;
      ownedCleanupResult = await adapter.cleanup(prepared);
      check(ownedCleanupResult?.ownedHandlesClosed === true &&
        markerCleanupVerified(ownedCleanupResult) &&
        ownedCleanupResult.borrowedSession === 'preserved' &&
        ownedCleanupResult.arena === 'released',
      'final owned cleanup did not verify');
      ownedCleanupVerified = true;
    } catch (cleanupError) {
      throw withDiagnostic(uncertain(failure ?
        new AggregateError([failure, cleanupError],
          'protected window and cleanup failed') : cleanupError,
      'final owned cleanup is unknown'), true);
    }
  }
  if (failure) {
    if (resourceStateUncertain) throw withDiagnostic(uncertain(failure,
      'native wave or owned handle state is unknown'), true);
    throw withDiagnostic(failure);
  }
  try {
    check(prepared && parsed && log?.closed === true &&
      protectedClone?.closed === true && movedStorageClosed &&
      ownedCleanupVerified,
    'protected client window did not finish its owned lease');
    return assessProtectedCanary({staged, worker, parsed, phases,
      changedPaths, saveAudit, pathBefore, pathAfter,
      cleanup: {movedStorageClosed,
        logHandleClosed: log.closed,
        protectedCloneClosed: protectedClone.closed,
        ...ownedCleanupResult}});
  } catch (error) {throw withDiagnostic(error);}
}

module.exports = {ROLES, openProtectedClone, closeProtectedClone,
  stageProtectedFrames, readProtectedReplies, runProtectedCanaryWindow};
