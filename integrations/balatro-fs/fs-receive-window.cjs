'use strict';

const {createHash, randomBytes} = require('node:crypto');
const net = require('node:net');
const {packet, response} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {pathPacket} = require('./clone-transport.cjs');
const {LOG_PATH} = require('./fs-save-tree-audit.cjs');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');
const {buildFrame, FRAME_SPACING, PACKET_OFFSET, PACKET_BYTES,
  SERVICE_HANDLE_OFFSET} = require('./fs-counter-overlap.cjs');
const {makePinRequest, makeTriggerRequest, belongsToTransport} =
  require('./fs-attempt-packets.cjs');
const {checkIdentity, checkPaths} = require('./fs-abort-control.cjs');
const {assessNoStorageControls} = require('./canary-geometry-plan.cjs');
const {stageAbortFrames, closeMovedStorage, requestCommand} =
  require('./fs-abort-frames.cjs');
const {makeAbortGuardSource, parseAbortGuardReply,
  makeAbortWorkerSource, parseAbortWorkerReply} = require('./fs-abort-worker.cjs');
const {RESULT_OFFSET} = require('./worker-chain.cjs');

const READ_BYTES = 0x10000;
const ROLES = Object.freeze(['pin', 'receive', 'trigger']);
const MAX_TICKS = 19200000 * 2;

function check(condition, reason) {
  if (!condition) throw Error(`Balatro receive window: ${reason}`);
}

function uncertain(cause, reason) {
  const error = Error(`Balatro receive window: ${reason}; retain resources`, {cause});
  error.resourceStateUncertain = true;
  return error;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function readPacket(address) {
  check(Number.isSafeInteger(address) && address > 0 && address < 2 ** 39,
    'receive address is outside the user range');
  return packet(0, Buffer.concat([u64(0), u64(0), u64(READ_BYTES)]),
    {receive: [{address, size: READ_BYTES, mode: 1}]});
}

function parseReadReply(reply) {
  check(reply?.result === 0 && reply.copies?.length === 0 &&
    reply.moves?.length === 0 && Buffer.isBuffer(reply.data) &&
    reply.data.length >= 8 && reply.data.readBigUInt64LE(0) === BigInt(READ_BYTES),
  'log read did not return exactly 0x10000 bytes');
}

async function openLogRead({prepared}) {
  const {transport, clone} = prepared || {};
  belongsToTransport(clone, transport, 'clone');
  const address = transport.pathAddress;
  const receiveAddress = transport.dataAddress;
  check(receiveAddress === transport.scratch + 0x22000 &&
    address === transport.scratch + 0x20000 &&
    receiveAddress + READ_BYTES < transport.scratch + 0x40000,
  'log receive buffer overlaps native packet workspace');
  await transport.native.write(address, Buffer.from(LOG_PATH + '\0', 'ascii'));
  let opened;
  try {
    opened = await transport.sendOwned(clone.handle,
      pathPacket(8, u32(1), address));
  } catch (cause) {throw uncertain(cause, 'log open IPC outcome is unknown');}
  if (opened.result !== 0 || opened.copies.length !== 0 ||
      opened.moves.length !== 1) {
    throw uncertain(null, 'log open transferred an unexpected handle set');
  }
  const handle = opened.moves[0];
  if (!Number.isInteger(handle) || handle <= 0 || handle >= 0xffff8000 ||
      handle === clone.handle || handle === prepared.root.handle ||
      handle === prepared.file.handle ||
      handle === transport.evidence.sessionManager.borrowedHandle ||
      transport.ownedHandles.has(handle)) {
    throw uncertain(null, 'log open handle ownership is ambiguous');
  }
  transport.ownedHandles.add(handle);
  try {
    const size = await transport.sendOwned(handle, packet(4));
    check(size.result === 0 && size.copies.length === 0 &&
      size.moves.length === 0 && size.data.length >= 8 &&
      size.data.readBigUInt64LE(0) >= BigInt(READ_BYTES) &&
      size.data.readBigUInt64LE(0) <= 16n * 1024n * 1024n,
    'live log is shorter than the bounded receive');
    await transport.native.write(receiveAddress, Buffer.alloc(READ_BYTES));
    parseReadReply(await transport.sendOwned(handle, readPacket(receiveAddress)));
    const prefix = await transport.native.read(receiveAddress, READ_BYTES);
    check(Buffer.isBuffer(prefix) && prefix.length === READ_BYTES,
      'serial log prefix readback is incomplete');
    return {handle, prefix, size: Number(size.data.readBigUInt64LE(0)),
      receiveAddress, path: LOG_PATH, closed: false};
  } catch (cause) {throw uncertain(cause, 'log handle or prefix state is unknown');}
}

async function closeLogRead(prepared, log) {
  check(log && log.closed === false && log.path === LOG_PATH &&
    prepared?.transport?.ownedHandles?.has(log.handle),
  'owned log handle is missing or already closed');
  try {
    const result = await prepared.transport.closeOwned(log.handle);
    check(result?.closed === true, 'log handle close was not verified');
    log.closed = true;
  } catch (cause) {throw uncertain(cause, 'log handle close is unknown');}
}

function buildWindowFrames({preflight, prepared, log, waveId}) {
  check(/^[0-9a-f]{16}$/.test(waveId || '') &&
    waveId !== preflight?.arenaNonce && waveId !== preflight?.markerNonce &&
    prepared?.arenaNonce === preflight.arenaNonce &&
    prepared.markerNonce === preflight.markerNonce &&
    prepared.sdkBase === preflight.sdkBase &&
    prepared.ownedHandlesOpen === true &&
    prepared.explicitSaveWrites === 1 &&
    log?.path === LOG_PATH && log.closed === false &&
    log.receiveAddress === prepared.receiveAddress &&
    Buffer.isBuffer(log.prefix) && log.prefix.length === READ_BYTES &&
    prepared.transport.ownedHandles.has(log.handle),
  'fresh owner, retained marker, or exact log prefix is missing');
  const arena = Number(BigInt(preflight.arenaBase));
  const sdk = Number(BigInt(preflight.sdkBase));
  check(Number.isSafeInteger(arena) && Number.isSafeInteger(sdk) &&
    arena >= 0x1000 && sdk >= 0x1000 &&
    arena % 0x1000 === 0 && sdk % 0x1000 === 0 &&
    arena + 0x200000 < 2 ** 39 && sdk < 2 ** 39,
  'owner arena or SDK base is outside the pinned user range');
  const pin = makePinRequest({context: prepared.context, root: prepared.root});
  const trigger = makeTriggerRequest({clone: prepared.clone,
    nonce: preflight.markerNonce, which: 'absent',
    pathAddress: prepared.pathAddress});
  const receive = {requestKind: 'receive-buffer-request', handle: log.handle,
    packet: readPacket(log.receiveAddress)};
  const requests = {pin, receive, trigger};
  const handles = new Set();
  const frames = ROLES.map((role, index) => {
    const request = requests[role];
    const command = {pin: 200, receive: 0, trigger: 7}[role];
    check(Number.isInteger(request.handle) && request.handle > 0 &&
      request.handle < 0xffff8000 && !handles.has(request.handle) &&
      Buffer.isBuffer(request.packet) && request.packet.length === 256 &&
      requestCommand(request.packet) === command,
    `${role} needs a distinct owned exact CMIF request`);
    handles.add(request.handle);
    const address = arena + index * FRAME_SPACING;
    const bytes = buildFrame({base: address, sdk, handle: request.handle});
    bytes.fill(0, PACKET_OFFSET, PACKET_OFFSET + PACKET_BYTES);
    request.packet.copy(bytes, PACKET_OFFSET);
    check(bytes.readBigUInt64LE(SERVICE_HANDLE_OFFSET) ===
      BigInt(request.handle), 'native frame service handle changed');
    return Object.freeze({role, address, handle: request.handle,
      bytes, sha256: createHash('sha256').update(bytes).digest('hex')});
  });
  check(trigger.descriptorInput.length === 0x800 &&
    trigger.descriptorInput[0x7ff] === 0 && trigger.aborted === false &&
    prepared.pathAddress === prepared.transport.scratch + 0x20000 &&
    log.receiveAddress + READ_BYTES < prepared.transport.scratch + 0x40000,
  'bounded absent-path descriptor or buffer changed');
  return {arenaNonce: preflight.arenaNonce,
    markerNonce: preflight.markerNonce, waveId,
    arenaBase: arena, sdkBase: sdk, frames,
    descriptorAddress: trigger.pathAddress,
    descriptor: Buffer.from(trigger.descriptorInput),
    receiveAddress: log.receiveAddress, receiveBytes: READ_BYTES,
    prefixSha256: createHash('sha256').update(log.prefix).digest('hex')};
}

function parseWindowReplies(staged, worker, replies, receiveBuffer, expectedPrefix) {
  check(worker?.waveId === staged?.waveId &&
    worker.arenaNonce === staged.arenaNonce &&
    worker.workerState === 'joined-closed' &&
    worker.serviceHandles === 'closed' &&
    Array.isArray(worker.rows) && worker.rows.length === ROLES.length &&
    Array.isArray(replies) && replies.length === ROLES.length &&
    Buffer.isBuffer(receiveBuffer) && receiveBuffer.length === READ_BYTES &&
    Buffer.isBuffer(expectedPrefix) && expectedPrefix.length === READ_BYTES &&
    receiveBuffer.equals(expectedPrefix),
  'native log receive does not match its exact serial prefix');
  const used = new Set(staged.frames.map(frame => frame.handle));
  let movedStorageHandle;
  const rows = ROLES.map((role, index) => {
    const frame = staged.frames[index];
    const source = worker.rows[index];
    const bytes = replies[index];
    check(frame.role === role && source.role === role &&
      source.handle === frame.handle && source.transportResult === 0 &&
      Buffer.isBuffer(bytes) && bytes.length === 256,
    `${role} native reply or source changed`);
    const parsed = response(bytes);
    if (role === 'pin') {
      check(parsed.result === 0 && parsed.copies.length === 0 &&
        parsed.moves.length === 1 &&
        Number.isInteger(parsed.moves[0]) && parsed.moves[0] > 0 &&
        parsed.moves[0] < 0xffff8000 && !used.has(parsed.moves[0]),
      'pin did not move one distinct owned storage handle');
      movedStorageHandle = parsed.moves[0];
    } else if (role === 'receive') parseReadReply(parsed);
    else check(parsed.result === 0x202 && parsed.copies.length === 0 &&
      parsed.moves.length === 0,
    'absent-path trigger result changed');
    return {...source, ipcResult: parsed.result,
      receiveBytesVerified: role === 'receive' ? READ_BYTES : undefined};
  });
  check(Number.isInteger(movedStorageHandle), 'owned pin handle is missing');
  return {rows, movedStorageHandle, receiveBufferVerified: true,
    triggerControl: 'nonce-bound-absent-path',
    receivedPrefixSha256: createHash('sha256').update(receiveBuffer).digest('hex')};
}

async function readWindowReplies(native, staged, worker, prefix) {
  const replies = [];
  for (let i = 0; i < ROLES.length; i++) {
    const frame = staged.frames[i];
    const ticks = await native.read(frame.address + RESULT_OFFSET, 24);
    check(Buffer.isBuffer(ticks) && ticks.length === 24 &&
      ticks.readBigUInt64LE(0) === BigInt(worker.rows[i].startTick) &&
      ticks.readBigUInt64LE(8) === 0n &&
      ticks.readBigUInt64LE(16) === BigInt(worker.rows[i].endTick),
    `${frame.role} native tick or transport readback changed`);
    replies.push(await native.read(frame.address + PACKET_OFFSET, 256));
  }
  const copied = await native.read(staged.receiveAddress, READ_BYTES);
  return parseWindowReplies(staged, worker, replies, copied, prefix);
}

function assessReceiveWindow({staged, worker, parsed, phases,
  changedPaths, saveAudit, pathBefore, pathAfter, cleanup}) {
  check(staged && worker?.workerState === 'joined-closed' &&
    parsed?.receiveBufferVerified === true &&
    parsed.receivedPrefixSha256 === staged.prefixSha256 &&
    Array.isArray(parsed.rows) && parsed.rows.length === ROLES.length &&
    Array.isArray(changedPaths) && changedPaths.length === 0 &&
    saveAudit?.coverage === 'bounded-cloned-save-tree' &&
    saveAudit.completeSaveTreeVerified === true &&
    saveAudit.logPrefixVerified === true &&
    saveAudit.logState === 'append-only' &&
    saveAudit.changed?.length === 0 &&
    cleanup === 'verified',
  'worker, exact log prefix, save audit, or cleanup is missing');
  checkPaths(pathBefore, staged.markerNonce);
  checkPaths(pathAfter, staged.markerNonce);
  assessNoStorageControls(phases);
  const rows = Object.fromEntries(parsed.rows.map(row => [row.role, row]));
  check(ROLES.every(role => rows[role] &&
    Number.isSafeInteger(rows[role].startTick) &&
    Number.isSafeInteger(rows[role].endTick) &&
    rows[role].startTick < rows[role].endTick &&
    rows[role].endTick - rows[role].startTick <= MAX_TICKS &&
    rows[role].transportResult === 0 &&
    rows[role].ipcResult === (role === 'trigger' ? 0x202 : 0)),
  'native timing rows are incomplete');
  const trigger = rows.trigger;
  const latestStart = Math.max(...ROLES.map(role => rows[role].startTick));
  const earliestEnd = Math.min(...ROLES.map(role => rows[role].endTick));
  const commonTicks = Math.max(0, earliestEnd - latestStart);
  const receiveAfterTriggerTicks = rows.receive.endTick - trigger.endTick;
  return {waveId: staged.waveId, arenaNonce: staged.arenaNonce,
    logPath: LOG_PATH, logReadBytes: READ_BYTES,
    logPrefixSha256: staged.prefixSha256,
    counterPhases: phases, waveRows: parsed.rows,
    saveTreeAudit: saveAudit, changedPaths,
    preparationMarkerSaveWrites: 1, nativeWindowSaveWrites: 0,
    clientIpcCommonOverlapTicks: commonTicks,
    clientIpcReceiveAfterTriggerTicks: receiveAfterTriggerTicks,
    clientIpcRequestOverlapMeasured: commonTicks > 0,
    counterBaselineRestored: true, completeSaveAuditVerified: true,
    cleanup: 'verified', fsHandlerOverlapMeasured: false,
    fsSideMarkerReadbackVerified: false, markerHitVerified: false,
    fsStageVerified: false,
    status: 'bounded client IPC receive window measured; FS-side marker and 2/4 unverified'};
}

async function runReceiveWindow({preflight, adapter, executeSource,
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
  let prepared, log, staged, worker, parsed, phases;
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
    phases = {before: await counterPair('window-before'),
      noStorageBefore: await counterPair('window-no-storage-before')};
    onPhase('open-read-only-log-and-anchor-prefix');
    log = await openLogRead({prepared});
    staged = buildWindowFrames({preflight, prepared, log, waveId});
    const stageReceipt = await stageAbortFrames(prepared.transport.native, staged);
    const options = {nonce: preflight.arenaNonce,
      arenaBase: preflight.arenaBase, sdkBase: preflight.sdkBase,
      mainBase, waveId, hostIp: macIp, port, staged, stageReceipt};
    onPhase('verify-staged-native-frames');
    parseAbortGuardReply(await executeSource({host, port: 9026,
      source: makeAbortGuardSource(options), timeoutMs: 15000}), options);
    onPhase('run-single-native-receive-window');
    workerRequestSent = true;
    worker = parseAbortWorkerReply(await executeSource({host, port: 9026,
      source: makeAbortWorkerSource(options), timeoutMs: 15000}), options);
    workerReleased = worker.workerState === 'joined-closed' &&
      worker.serviceHandles === 'closed';
    parsed = await readWindowReplies(prepared.transport.native, staged,
      worker, log.prefix);
    movedStorageCloseAttempted = true;
    const movedClose = await closeMovedStorage(prepared.transport.native, staged, parsed);
    movedStorageClosed = movedClose?.closed === true;
    check(movedStorageClosed, 'owned moved storage close did not verify');
    onPhase('close-owned-log-handle');
    await closeLogRead(prepared, log);
    phases.after = await counterPair('window-after');
    phases.noStorageAfter = await counterPair('window-no-storage-after');
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
      workerRequestSent && !workerReleased ||
      workerRequestSent && !parsed ||
      workerRequestSent && parsed && log?.closed !== true;
  }
  if (prepared && !resourceStateUncertain) {
    try {
      if (log && !log.closed) await closeLogRead(prepared, log);
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
      throw withDiagnostic(uncertain(failure ? new AggregateError([failure, cleanupError],
        'receive window and cleanup failed') : cleanupError,
      'final owned cleanup is unknown'), true);
    }
  }
  if (failure) {
    if (resourceStateUncertain) throw withDiagnostic(uncertain(failure,
      'native wave or owned handle state is unknown'), true);
    throw withDiagnostic(failure);
  }
  try {
    check(prepared && parsed && log?.closed === true,
      'receive window did not finish its owned lease');
    return {...assessReceiveWindow({staged, worker, parsed, phases,
      changedPaths, saveAudit, pathBefore, pathAfter,
      cleanup: 'verified'}), ...markerCleanupSummary(ownedCleanupResult)};
  } catch (error) {throw withDiagnostic(error);}
}

module.exports = {LOG_PATH, READ_BYTES, ROLES, readPacket,
  parseReadReply, openLogRead, closeLogRead, buildWindowFrames,
  parseWindowReplies, readWindowReplies, assessReceiveWindow,
  runReceiveWindow};
