'use strict';

// Offline contract for a bounded four-request timing diagnostic. A successful
// marker GetEntryType is an owned-clone path control, never an FS-side readback.
const {createHash} = require('node:crypto');
const {response} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {paths} = require('./marker-path-control.cjs');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');
const {LOG_PATH} = require('./fs-save-tree-audit.cjs');
const {buildFrame, FRAME_SPACING, PACKET_OFFSET, PACKET_BYTES,
  SERVICE_HANDLE_OFFSET} = require('./fs-counter-overlap.cjs');
const {makePinRequest, makeTriggerRequest, descriptorInput,
  belongsToTransport} = require('./fs-attempt-packets.cjs');
const {readPacket, READ_BYTES, parseReadReply} = require('./fs-receive-window.cjs');
const {requestCommand} = require('./fs-abort-frames.cjs');
const {checkPaths} = require('./fs-abort-control.cjs');
const {assessNoStorageControls} = require('./canary-geometry-plan.cjs');

const ROLES = Object.freeze(['canary', 'pin', 'receive', 'trigger']);
const CANARY_DESCRIPTOR_OFFSET = 0x34000;
const FRAME_BYTES = PACKET_OFFSET + PACKET_BYTES;
const MAX_TICKS = 19200000 * 2;

function check(condition, reason) {
  if (!condition) throw Error(`Balatro protected canary: ${reason}`);
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function buildProtectedCanaryPlan({preflight, prepared, log, protectedClone,
  waveId}) {
  check(preflight?.gameProfile === profile.gameProfile &&
    preflight.markerHitVerified === false &&
    preflight.fsStageVerified === false &&
    preflight.exactAllocationBytes === null &&
    /^[0-9a-f]{16}$/.test(preflight.arenaNonce || '') &&
    /^[0-9a-f]{16}$/.test(preflight.markerNonce || '') &&
    /^[0-9a-f]{16}$/.test(waveId || '') &&
    new Set([preflight.arenaNonce, preflight.markerNonce, waveId]).size === 3,
  'fresh unverified owner and distinct wave identities are required');
  const transport = prepared?.transport;
  check(prepared?.arenaNonce === preflight.arenaNonce &&
    prepared.markerNonce === preflight.markerNonce &&
    prepared.sdkBase === preflight.sdkBase &&
    prepared.markerPath === paths(preflight.markerNonce).marker &&
    prepared.absentPath === paths(preflight.markerNonce).absent &&
    prepared.markerWrittenAndVerified === true &&
    prepared.borrowedSession === 'preserved' &&
    prepared.ownedHandlesOpen === true &&
    prepared.explicitSaveWrites === 1 &&
    transport?.evidence?.sdkBase === preflight.sdkBase &&
    prepared.context?.arena === BigInt(preflight.arenaBase) &&
    prepared.context.sdk === BigInt(preflight.sdkBase) &&
    prepared.context.scratch === BigInt(transport.scratch) &&
    prepared.context.nonce === preflight.arenaNonce &&
    transport.scratch === Number(BigInt(preflight.arenaBase) + 0x10000n) &&
    prepared.pathAddress === transport.pathAddress &&
    prepared.receiveAddress === transport.dataAddress &&
    belongsToTransport(prepared.clone, transport, 'clone') &&
    belongsToTransport(protectedClone, transport, 'clone'),
  'owned marker, clones, or pinned native owner changed');
  check(log?.path === LOG_PATH && log.closed === false &&
    log.receiveAddress === prepared.receiveAddress &&
    Buffer.isBuffer(log.prefix) && log.prefix.length === READ_BYTES &&
    transport.ownedHandles.has(log.handle),
  'owned 64 KiB serial log prefix is required');

  const arena = Number(BigInt(preflight.arenaBase));
  const sdk = Number(BigInt(preflight.sdkBase));
  check(Number.isSafeInteger(arena) && Number.isSafeInteger(sdk) &&
    arena >= 0x1000 && sdk >= 0x1000 &&
    arena % 0x1000 === 0 && sdk % 0x1000 === 0 &&
    arena + 0x200000 < 2 ** 39 && sdk + profile.sdkCode.size < 2 ** 39 &&
    (ROLES.length - 1) * FRAME_SPACING + FRAME_BYTES < 0x10000,
  'four native frames exceed the pinned owner boundary');
  const canaryAddress = transport.scratch + CANARY_DESCRIPTOR_OFFSET;
  check(prepared.pathAddress === transport.scratch + 0x20000 &&
    log.receiveAddress === transport.scratch + 0x22000 &&
    log.receiveAddress + READ_BYTES <= transport.scratch + 0x32000 &&
    canaryAddress >= transport.scratch + 0x34000 &&
    canaryAddress + 0x800 <= transport.scratch + 0x40000,
  'descriptor and receive buffers overlap native scratch');

  const requests = {
    canary: makeTriggerRequest({clone: protectedClone,
      nonce: preflight.markerNonce, which: 'marker',
      pathAddress: canaryAddress}),
    pin: makePinRequest({context: prepared.context, root: prepared.root}),
    receive: {requestKind: 'receive-buffer-request', handle: log.handle,
      packet: readPacket(log.receiveAddress)},
    trigger: makeTriggerRequest({clone: prepared.clone,
      nonce: preflight.markerNonce, which: 'absent',
      pathAddress: prepared.pathAddress}),
  };
  const expected = {canary: ['cloned-save-entry-type', 7],
    pin: ['owned-storage-open', 200],
    receive: ['receive-buffer-request', 0],
    trigger: ['cloned-save-entry-type', 7]};
  const handles = new Set();
  const frames = ROLES.map((role, index) => {
    const request = requests[role];
    const [kind, command] = expected[role];
    check(request.requestKind === kind &&
      Number.isInteger(request.handle) && request.handle > 0 &&
      request.handle < 0xffff8000 && !handles.has(request.handle) &&
      request.handle !== transport.evidence.sessionManager.borrowedHandle &&
      Buffer.isBuffer(request.packet) && request.packet.length === 256 &&
      requestCommand(request.packet) === command,
    `${role} needs a distinct owned exact CMIF request`);
    handles.add(request.handle);
    const address = arena + index * FRAME_SPACING;
    const bytes = buildFrame({base: address, sdk, handle: request.handle});
    bytes.fill(0, PACKET_OFFSET, PACKET_OFFSET + PACKET_BYTES);
    request.packet.copy(bytes, PACKET_OFFSET);
    check(bytes.length === FRAME_BYTES &&
      bytes.readBigUInt64LE(SERVICE_HANDLE_OFFSET) ===
        BigInt(request.handle), `${role} frame ABI changed`);
    return Object.freeze({role, address, handle: request.handle,
      bytes, sha256: sha(bytes), requestSha256: sha(request.packet),
      requestKind: kind, command});
  });
  check(requests.canary.aborted === false &&
    requests.trigger.aborted === false &&
    requests.canary.pathAddress === canaryAddress &&
    requests.trigger.pathAddress === prepared.pathAddress &&
    requests.canary.descriptorInput.equals(
      descriptorInput(preflight.markerNonce, 'marker')) &&
    requests.trigger.descriptorInput.equals(
      descriptorInput(preflight.markerNonce, 'absent')) &&
    !requests.canary.descriptorInput.equals(requests.trigger.descriptorInput) &&
    requests.canary.descriptorInput[0x7ff] === 0 &&
    requests.trigger.descriptorInput[0x7ff] === 0,
  'nonce-bound marker and absent descriptors changed');
  const descriptors = Object.freeze({
    canary: Object.freeze({address: canaryAddress,
      bytes: Buffer.from(requests.canary.descriptorInput),
      sha256: sha(requests.canary.descriptorInput)}),
    trigger: Object.freeze({address: prepared.pathAddress,
      bytes: Buffer.from(requests.trigger.descriptorInput),
      sha256: sha(requests.trigger.descriptorInput)}),
  });
  return Object.freeze({arenaNonce: preflight.arenaNonce,
    markerNonce: preflight.markerNonce, waveId,
    workerKind: 'protected-canary-window',
    arenaBase: arena, sdkBase: sdk, frames, descriptors,
    receiveAddress: log.receiveAddress, receiveBytes: READ_BYTES,
    logPath: LOG_PATH, prefixSha256: sha(log.prefix),
    protectedControl: 'owned-clone-marker-entry-type',
    triggerControl: 'nonce-bound-absent-path',
    preparationMarkerSaveWrites: 1, nativeWindowSaveWrites: 0,
    fsHandlerOverlapMeasured: false, fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false});
}

function parseProtectedReplies(staged, worker, replies, receiveBuffer,
  expectedPrefix) {
  check(staged?.workerKind === 'protected-canary-window' &&
    worker?.waveId === staged.waveId &&
    worker.arenaNonce === staged.arenaNonce &&
    worker.workerState === 'joined-closed' &&
    worker.serviceHandles === 'closed' &&
    Array.isArray(worker.rows) && worker.rows.length === ROLES.length &&
    Array.isArray(replies) && replies.length === ROLES.length &&
    Buffer.isBuffer(receiveBuffer) && receiveBuffer.length === READ_BYTES &&
    Buffer.isBuffer(expectedPrefix) && expectedPrefix.length === READ_BYTES &&
    sha(expectedPrefix) === staged.prefixSha256 &&
    receiveBuffer.equals(expectedPrefix),
  'joined worker or exact serial log prefix is missing');
  const used = new Set(staged.frames.map(frame => frame.handle));
  let movedStorageHandle;
  const rows = ROLES.map((role, index) => {
    const frame = staged.frames[index];
    const source = worker.rows[index];
    const bytes = replies[index];
    check(frame.role === role && source?.role === role &&
      source.handle === frame.handle && source.transportResult === 0 &&
      Buffer.isBuffer(bytes) && bytes.length === 256,
    `${role} native transport or reply changed`);
    const parsed = response(bytes);
    if (role === 'canary') {
      check(parsed.result === 0 && parsed.copies.length === 0 &&
        parsed.moves.length === 0 && parsed.data.length >= 4 &&
        parsed.data.readUInt32LE(0) === 1,
      'owned-clone marker path control changed');
    } else if (role === 'pin') {
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
      entryTypeControl: role === 'canary' ? 1 : undefined,
      receiveBytesVerified: role === 'receive' ? READ_BYTES : undefined};
  });
  return {rows, movedStorageHandle, receiveBufferVerified: true,
    receivedPrefixSha256: sha(receiveBuffer),
    protectedControl: 'owned-clone-marker-entry-type',
    triggerControl: 'nonce-bound-absent-path'};
}

function assessProtectedCanary({staged, worker, parsed, phases, changedPaths,
  saveAudit, pathBefore, pathAfter, cleanup}) {
  check(staged?.workerKind === 'protected-canary-window' &&
    staged.protectedControl === 'owned-clone-marker-entry-type' &&
    staged.triggerControl === 'nonce-bound-absent-path' &&
    worker?.waveId === staged.waveId &&
    worker.arenaNonce === staged.arenaNonce &&
    worker?.workerState === 'joined-closed' &&
    worker.serviceHandles === 'closed' &&
    parsed?.protectedControl === staged.protectedControl &&
    parsed.triggerControl === staged.triggerControl &&
    parsed.receiveBufferVerified === true &&
    parsed.receivedPrefixSha256 === staged.prefixSha256 &&
    Number.isInteger(parsed.movedStorageHandle) &&
    Array.isArray(changedPaths) && changedPaths.length === 0 &&
    saveAudit?.coverage === 'bounded-cloned-save-tree' &&
    saveAudit.completeSaveTreeVerified === true &&
    saveAudit.logPrefixVerified === true &&
    saveAudit.logState === 'append-only' &&
    Array.isArray(saveAudit.changed) && saveAudit.changed.length === 0 &&
    cleanup?.movedStorageClosed === true &&
    cleanup.logHandleClosed === true &&
    cleanup.protectedCloneClosed === true &&
    cleanup.ownedHandlesClosed === true &&
    markerCleanupVerified(cleanup) &&
    cleanup.borrowedSession === 'preserved' &&
    cleanup.arena === 'released',
  'worker, controls, complete save audit, or owned cleanup is missing');
  checkPaths(pathBefore, staged.markerNonce);
  checkPaths(pathAfter, staged.markerNonce);
  assessNoStorageControls(phases);
  const rows = Object.fromEntries(parsed.rows.map(row => [row.role, row]));
  const ids = new Set();
  const threads = new Set();
  check(parsed.rows.length === ROLES.length &&
    ROLES.every((role, index) => {
      const row = rows[role];
      const frame = staged.frames[index];
      if (!row || frame.role !== role || row.handle !== frame.handle ||
          !Number.isSafeInteger(row.startTick) ||
          !Number.isSafeInteger(row.endTick) ||
          row.startTick <= 0 || row.startTick >= row.endTick ||
          row.endTick - row.startTick > MAX_TICKS ||
          !/^[0-9a-f]{16}$/.test(row.requestId || '') ||
          !/^[0-9a-f]{16}$/.test(row.threadId || '') ||
          row.threadId === '0000000000000000' ||
          ids.has(row.requestId) || threads.has(row.threadId) ||
          row.transportResult !== 0 ||
          row.ipcResult !== (role === 'trigger' ? 0x202 : 0)) return false;
      ids.add(row.requestId);
      threads.add(row.threadId);
      return role !== 'canary' || row.entryTypeControl === 1;
    }),
  'four independent exact native timing rows are missing');
  const latestStart = Math.max(...ROLES.map(role => rows[role].startTick));
  const earliestEnd = Math.min(...ROLES.map(role => rows[role].endTick));
  const commonTicks = Math.max(0, earliestEnd - latestStart);
  const canary = rows.canary;
  const pin = rows.pin;
  const trigger = rows.trigger;
  const receive = rows.receive;
  return {waveId: staged.waveId, arenaNonce: staged.arenaNonce,
    markerNonce: staged.markerNonce, logPath: LOG_PATH,
    logReadBytes: READ_BYTES, logPrefixSha256: staged.prefixSha256,
    frameProvenance: staged.frames.map(frame => ({role: frame.role,
      handle: frame.handle, frameSha256: frame.sha256,
      requestSha256: frame.requestSha256, command: frame.command})),
    descriptorProvenance: {
      canary: {address: staged.descriptors.canary.address,
        sha256: staged.descriptors.canary.sha256},
      trigger: {address: staged.descriptors.trigger.address,
        sha256: staged.descriptors.trigger.sha256}},
    counterPhases: phases, waveRows: parsed.rows,
    saveTreeAudit: saveAudit, changedPaths,
    preparationMarkerSaveWrites: 1, nativeWindowSaveWrites: 0,
    protectedControl: 'owned-clone-marker-entry-type-0/type1',
    triggerControl: 'nonce-bound-absent-path-0x202',
    clientIpcCommonOverlapTicks: commonTicks,
    clientIpcCommonOverlapMeasured: commonTicks > 0,
    clientCanarySpansTrigger: canary.startTick <= trigger.startTick &&
      canary.endTick >= trigger.endTick,
    clientPinSpansTrigger: pin.startTick <= trigger.startTick &&
      pin.endTick >= trigger.endTick,
    clientReceiveSpansTrigger: receive.startTick <= trigger.startTick &&
      receive.endTick >= trigger.endTick,
    clientCanaryAfterTriggerTicks: canary.endTick - trigger.endTick,
    counterBaselineRestored: true, completeSaveAuditVerified: true,
    cleanup: 'verified', ...markerCleanupSummary(cleanup),
    protectedCloneClosed: true,
    exactAllocationBytes: null, pinAddress: null,
    fsHandlerOverlapMeasured: false,
    fsSideMarkerReadbackVerified: false, markerHitVerified: false,
    fsStageVerified: false,
    status: 'owned-clone marker control and client timing measured; FS-side marker and 2/4 unverified'};
}

module.exports = {ROLES, CANARY_DESCRIPTOR_OFFSET,
  buildProtectedCanaryPlan, parseProtectedReplies, assessProtectedCanary};
