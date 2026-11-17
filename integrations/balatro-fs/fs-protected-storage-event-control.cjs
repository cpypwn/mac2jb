'use strict';

// Four-role negative event control with an ordinary IStorage receive. The
// receive child is opened from the already prepared root; no extra root is
// opened. All timings below are client svcSend timings, not FS handler times.
const {createHash, randomBytes} = require('node:crypto');
const net = require('node:net');
const {packet, response} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');
const {paths} = require('./marker-path-control.cjs');
const {makePinRequest, makeTriggerRequest, descriptorInput,
  belongsToTransport} = require('./fs-attempt-packets.cjs');
const {storageReadPacket, READ_BYTES, GUARD_BYTES} =
  require('./fs-owned-storage-read.cjs');
const {validateOrdinaryBaseline} =
  require('./fs-event-pinned-storage-read.cjs');
const {openProtectedClone, closeProtectedClone} =
  require('./fs-protected-canary-window.cjs');
const {planProtectedEventLayout} =
  require('./fs-protected-event-layout.cjs');
const {buildGapEventFrame, RESULT_OFFSETS} =
  require('./fs-gap-event-frame.cjs');
const {stageGapEventFrames, makeGapEventWorkerSource,
  parseGapEventWorkerReply} = require('./fs-gap-event-worker.cjs');
const {checkIdentity, checkPaths} = require('./fs-abort-control.cjs');
const {assessNoStorageControls} = require('./canary-geometry-plan.cjs');
const {PACKET_OFFSET} = require('./fs-counter-overlap.cjs');
const {requestCommand} = require('./fs-abort-frames.cjs');

const MODE = 'protected-storage-event-control';
const ROLES = Object.freeze(['canary', 'pin', 'receive', 'trigger']);
const SERIAL_OFFSET = 0x50000;
const RECEIVE_OFFSET = 0x22000;
const CANARY_OFFSET = 0x34000;
const GUARD_BEFORE = 0x37;
const GUARD_AFTER = 0xc8;
const SERIAL_POISON = 0x5a;
const EVENT_POISON = 0xa5;
const MAX_TICKS = 19200000 * 2;
const closeAttempts = new WeakSet();

function check(value, reason) {
  if (!value) throw Error(`Balatro storage event control: ${reason}`);
}

function uncertain(cause, reason) {
  const error = Error(`Balatro storage event control: ${reason}; retain resources`,
    {cause});
  error.resourceStateUncertain = true;
  if (cause?.diagnostic && typeof cause.diagnostic === 'object')
    error.diagnostic = {...cause.diagnostic};
  return error;
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function rawCmif(bytes, name) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 256)
    throw uncertain(null, `${name} raw CMIF reply is missing`);
  try {return response(bytes);}
  catch (cause) {throw uncertain(cause, `${name} raw CMIF reply is malformed`);}
}

function noTransfers(reply, name) {
  if (!Array.isArray(reply?.moves) || !Array.isArray(reply?.copies) ||
      reply.moves.length || reply.copies.length)
    throw uncertain(null, `${name} transferred an unexpected handle`);
  check(reply.result === 0, `${name} returned 0x${reply.result.toString(16)}`);
  return reply;
}

function exactOwner(preflight, prepared, protectedClone = null) {
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
    prepared.pathAddress === transport.pathAddress &&
    prepared.receiveAddress === transport.dataAddress &&
    !transport.ownedHandles.has(prepared.root.handle) &&
    transport.rawOwnedHandles?.has(prepared.root.handle) &&
    transport.ownedHandles.has(prepared.clone?.handle) &&
    transport.ownedHandles.has(prepared.file?.handle),
  'fresh prepared root, marker, or native owner changed');
  belongsToTransport(prepared.clone, transport, 'clone');
  if (protectedClone) {
    belongsToTransport(protectedClone.capability, transport, 'clone');
    check(protectedClone.closed === false &&
      protectedClone.handle === protectedClone.capability.handle &&
      transport.ownedHandles.has(protectedClone.handle),
    'distinct protected clone is missing');
  }
  return transport;
}

async function openReceiveStorage(preflight, prepared, protectedClone) {
  const transport = exactOwner(preflight, prepared, protectedClone);
  const request = packet(200);
  let raw;
  try {raw = await transport.sendPacket(prepared.root.handle, request);}
  catch (cause) {throw uncertain(cause, 'receive storage open outcome is unknown');}
  const parsed = rawCmif(raw, 'receive storage open');
  if (parsed.result !== 0 || !Array.isArray(parsed.moves) ||
      !Array.isArray(parsed.copies) || parsed.moves.length !== 1 ||
      parsed.copies.length !== 0)
    throw uncertain(null, 'receive storage open did not move one exact handle');
  const handle = parsed.moves[0];
  const forbidden = new Set([prepared.root.handle, prepared.clone.handle,
    prepared.file.handle, protectedClone.handle,
    transport.evidence.sessionManager.borrowedHandle]);
  if (!Number.isInteger(handle) || handle <= 0 || handle >= 0xffff8000 ||
      forbidden.has(handle) || transport.ownedHandles.has(handle))
    throw uncertain(null, 'receive storage child aliases an existing handle');
  transport.ownedHandles.add(handle);
  return {owner: preflight.arenaNonce, handle, closed: false,
    open: {parentRootHandle: prepared.root.handle,
      requestHex: request.toString('hex'), requestSha256: sha(request),
      replyHex: raw.toString('hex'), replySha256: sha(raw),
      movedHandle: handle}, size: null, serial: null, close: null};
}

async function closeStorageHandle(prepared, storage, role) {
  const transport = prepared?.transport;
  const handle = storage?.handle;
  check(['receive', 'pin'].includes(role) && storage?.closed === false &&
    storage.owner === prepared.arenaNonce &&
    storage.open?.movedHandle === handle &&
    storage.open.parentRootHandle === prepared.root.handle &&
    Number.isInteger(handle) && handle > 0 && handle < 0xffff8000 &&
    !closeAttempts.has(storage) &&
    handle !== prepared.root.handle &&
    handle !== prepared.clone.handle &&
    handle !== prepared.file.handle &&
    handle !== transport.evidence.sessionManager.borrowedHandle &&
    (role !== 'receive' || transport.ownedHandles.has(handle)) &&
    (role !== 'pin' || !transport.ownedHandles.has(handle) &&
      transport.rawOwnedHandles?.has(handle)),
  `${role} storage handle is absent, aliased, or already closing`);
  closeAttempts.add(storage);
  let reply;
  try {reply = role === 'receive' ?
    await transport.closeOwned(handle) : await transport.closeRawOwned(handle);}
  catch (cause) {
    const error = uncertain(cause, `${role} storage worker close outcome is unknown`);
    error.diagnostic = {storageClosePhase: `close-${role}-storage`,
      storageCloseHandle: handle};
    throw error;
  }
  if (reply?.closed !== true || reply.closeResult !== 0) {
    const error = uncertain(null, `${role} storage worker close did not verify`);
    error.diagnostic = {storageClosePhase: `close-${role}-storage`,
      storageCloseHandle: handle};
    throw error;
  }
  storage.closed = true;
  storage.close = {handle, sdkOffset: profile.symbols.svcCloseHandle.offset,
    method: 'worker-svcCloseHandle', resultHex: '0x0', attemptedOnce: true};
  return storage.close;
}

async function qualifyReceiveStorage(preflight, prepared, storage, baseline) {
  const transport = exactOwner(preflight, prepared);
  check(storage?.owner === preflight.arenaNonce &&
    storage.closed === false && transport.ownedHandles.has(storage.handle),
  'owned receive child is missing');
  const expected = validateOrdinaryBaseline(baseline, preflight.arenaNonce);
  const sizeRequest = packet(4);
  let sizeRaw;
  try {sizeRaw = await transport.sendPacket(storage.handle, sizeRequest);}
  catch (cause) {throw uncertain(cause, 'receive storage size outcome is unknown');}
  const size = noTransfers(rawCmif(sizeRaw, 'receive storage size'),
    'receive storage size');
  check(Buffer.isBuffer(size.data) && size.data.length >= 8,
    'receive storage size value is missing');
  const bytes = size.data.readBigUInt64LE(0);
  check(bytes === BigInt(expected.storageBytes) &&
    bytes >= BigInt(READ_BYTES) && bytes < 1n << 39n,
  'receive storage differs from the independent ordinary baseline');
  storage.size = {storageBytes: Number(bytes),
    requestHex: sizeRequest.toString('hex'), requestSha256: sha(sizeRequest),
    replyHex: sizeRaw.toString('hex'), replySha256: sha(sizeRaw)};
  const address = transport.scratch + SERIAL_OFFSET;
  const native = transport.native;
  check(address % 0x1000 === 0 &&
    address - GUARD_BYTES > transport.scratch + 0x48080 &&
    address + READ_BYTES + GUARD_BYTES < transport.scratch + 0x80000,
  'serial receive output overlaps native workspace');
  await native.write(address - GUARD_BYTES,
    Buffer.alloc(GUARD_BYTES, GUARD_BEFORE));
  await native.write(address, Buffer.alloc(READ_BYTES, SERIAL_POISON));
  await native.write(address + READ_BYTES,
    Buffer.alloc(GUARD_BYTES, GUARD_AFTER));
  const request = storageReadPacket(address);
  let raw;
  try {raw = await transport.sendPacket(storage.handle, request);}
  catch (cause) {throw uncertain(cause, 'serial receive storage read outcome is unknown');}
  noTransfers(rawCmif(raw, 'serial receive storage read'),
    'serial receive storage read');
  const output = await native.read(address, READ_BYTES);
  const before = await native.read(address - GUARD_BYTES, GUARD_BYTES);
  const after = await native.read(address + READ_BYTES, GUARD_BYTES);
  check(Buffer.isBuffer(output) && output.length === READ_BYTES &&
    Buffer.isBuffer(before) &&
    before.equals(Buffer.alloc(GUARD_BYTES, GUARD_BEFORE)) &&
    Buffer.isBuffer(after) &&
    after.equals(Buffer.alloc(GUARD_BYTES, GUARD_AFTER)) &&
    sha(output) === expected.ordinaryContentSha256 &&
    !output.equals(Buffer.alloc(READ_BYTES, SERIAL_POISON)) &&
    output.indexOf(content(preflight.markerNonce)) === -1,
  'serial receive child read differs from ordinary content');
  storage.serial = {address, output,
    outputSha256: sha(output), outputFirst64Hex:
      output.subarray(0, 64).toString('hex'),
    requestHex: request.toString('hex'), requestSha256: sha(request),
    replyHex: raw.toString('hex'), replySha256: sha(raw),
    guardsIntact: true, markerBytesAbsent: true};
  return storage;
}

function buildStorageEventControl({preflight, prepared, protectedClone,
  receiveStorage, baseline, waveId}) {
  const transport = exactOwner(preflight, prepared, protectedClone);
  const ordinary = validateOrdinaryBaseline(baseline, preflight.arenaNonce);
  check(/^[0-9a-f]{16}$/.test(waveId || '') &&
    new Set([waveId, preflight.arenaNonce,
      preflight.markerNonce]).size === 3 &&
    receiveStorage?.owner === preflight.arenaNonce &&
    receiveStorage.closed === false &&
    transport.ownedHandles.has(receiveStorage.handle) &&
    receiveStorage.open?.movedHandle === receiveStorage.handle &&
    receiveStorage.open.parentRootHandle === prepared.root.handle &&
    receiveStorage.size?.storageBytes === ordinary.storageBytes &&
    receiveStorage.serial?.guardsIntact === true &&
    receiveStorage.serial.markerBytesAbsent === true &&
    Buffer.isBuffer(receiveStorage.serial.output) &&
    receiveStorage.serial.output.length === READ_BYTES &&
    receiveStorage.serial.outputSha256 ===
      ordinary.ordinaryContentSha256,
  'distinct ordinary receive child or serial baseline is missing');
  const layout = planProtectedEventLayout({preflight, prepared});
  const canaryAddress = transport.scratch + CANARY_OFFSET;
  const receiveAddress = transport.scratch + RECEIVE_OFFSET;
  check(prepared.pathAddress === transport.scratch + 0x20000 &&
    prepared.receiveAddress === receiveAddress &&
    receiveAddress % 0x1000 === 0 &&
    receiveAddress - GUARD_BYTES > prepared.pathAddress + 0x800 &&
    receiveAddress + READ_BYTES + GUARD_BYTES < canaryAddress &&
    canaryAddress + 0x800 <= layout.scratch.end &&
    layout.scratch.end <= layout.frameBase,
  'storage receive or owned descriptors overlap');
  const requests = [
    makeTriggerRequest({clone: protectedClone.capability,
      nonce: preflight.markerNonce, which: 'marker',
      pathAddress: canaryAddress}),
    makePinRequest({context: prepared.context, root: prepared.root}),
    {requestKind: 'ordinary-storage-read', handle: receiveStorage.handle,
      packet: storageReadPacket(receiveAddress)},
    makeTriggerRequest({clone: prepared.clone,
      nonce: preflight.markerNonce, which: 'absent',
      pathAddress: prepared.pathAddress}),
  ];
  const kinds = ['cloned-save-entry-type', 'owned-storage-open',
    'ordinary-storage-read', 'cloned-save-entry-type'];
  const commands = [7, 200, 0, 7];
  const expectedHandles = [protectedClone.handle, prepared.root.handle,
    receiveStorage.handle, prepared.clone.handle];
  const used = new Set();
  const frames = requests.map((request, index) => {
    const role = ROLES[index];
    check(request.requestKind === kinds[index] &&
      request.handle === expectedHandles[index] &&
      Number.isInteger(request.handle) && request.handle > 0 &&
      request.handle < 0xffff8000 &&
      !used.has(request.handle) &&
      request.handle !== prepared.file.handle &&
      request.handle !== transport.evidence.sessionManager.borrowedHandle &&
      Buffer.isBuffer(request.packet) && request.packet.length === 256 &&
      requestCommand(request.packet) === commands[index],
    `${role} request or distinct owned handle changed`);
    used.add(request.handle);
    return buildGapEventFrame({layout, role,
      handle: request.handle, request: request.packet});
  });
  check(requests[0].aborted === false &&
    requests[3].aborted === false &&
    requests[0].descriptorInput.equals(
      descriptorInput(preflight.markerNonce, 'marker')) &&
    requests[3].descriptorInput.equals(
      descriptorInput(preflight.markerNonce, 'absent')) &&
    !requests[0].descriptorInput.equals(requests[3].descriptorInput) &&
    requests[0].descriptorInput[0x7ff] === 0 &&
    requests[3].descriptorInput[0x7ff] === 0,
  'negative marker and absent path descriptors changed');
  const descriptors = Object.freeze({
    canary: Object.freeze({address: canaryAddress,
      bytes: Buffer.from(requests[0].descriptorInput),
      sha256: sha(requests[0].descriptorInput)}),
    trigger: Object.freeze({address: prepared.pathAddress,
      bytes: Buffer.from(requests[3].descriptorInput),
      sha256: sha(requests[3].descriptorInput)}),
  });
  const protectedPlan = Object.freeze({
    workerKind: 'protected-storage-window',
    arenaNonce: preflight.arenaNonce, waveId,
    arenaBase: layout.owner.arenaBase, sdkBase: layout.owner.sdkBase,
    frames: frames.map((frame, index) => Object.freeze({
      ...frame, requestKind: kinds[index], command: commands[index]})),
    descriptors, receiveAddress, receiveBytes: READ_BYTES,
    receiveKind: 'ordinary-owned-storage',
    expectedContentSha256: ordinary.ordinaryContentSha256,
    fsSideMarkerReadbackVerified: false, markerHitVerified: false,
    fsStageVerified: false});
  return Object.freeze({workerKind: 'balatro-gap-event-frames',
    mode: MODE, arenaNonce: preflight.arenaNonce,
    markerNonce: preflight.markerNonce, waveId,
    arenaBase: layout.owner.arenaBase, sdkBase: layout.owner.sdkBase,
    layout, frames, protectedPlan, receiveHandle: receiveStorage.handle,
    receiveOpenSha256: receiveStorage.open.replySha256,
    markerAttempted: false, fsHandlerOverlapMeasured: false,
    fsSideMarkerReadbackVerified: false, markerHitVerified: false,
    fsStageVerified: false});
}

async function stageStorageEventControl(native, staged) {
  const plan = staged?.protectedPlan;
  check(staged?.mode === MODE &&
    plan?.workerKind === 'protected-storage-window' &&
    plan.receiveKind === 'ordinary-owned-storage' &&
    staged.frames?.length === ROLES.length &&
    plan.frames?.length === ROLES.length &&
    plan.receiveAddress === staged.arenaBase + 0x32000 &&
    plan.receiveBytes === READ_BYTES &&
    plan.descriptors?.trigger?.address === staged.arenaBase + 0x30000 &&
    plan.descriptors?.canary?.address === staged.arenaBase + 0x44000 &&
    Buffer.isBuffer(plan.descriptors.trigger.bytes) &&
    Buffer.isBuffer(plan.descriptors.canary.bytes) &&
    plan.descriptors.trigger.bytes.length === 0x800 &&
    plan.descriptors.canary.bytes.length === 0x800 &&
    plan.descriptors.trigger.sha256 === sha(plan.descriptors.trigger.bytes) &&
    plan.descriptors.canary.sha256 === sha(plan.descriptors.canary.bytes) &&
    plan.receiveAddress - GUARD_BYTES >
      plan.descriptors.trigger.address + 0x800 &&
    plan.receiveAddress + READ_BYTES + GUARD_BYTES <
      plan.descriptors.canary.address &&
    native?.addresses?.scratch === staged.arenaBase + 0x10000 &&
    native.addresses.sdk === staged.sdkBase &&
    typeof native.write === 'function' &&
    typeof native.read === 'function',
  'exact disjoint event storage stage is required');
  const writes = [
    {address: plan.descriptors.trigger.address,
      bytes: plan.descriptors.trigger.bytes},
    {address: plan.descriptors.canary.address,
      bytes: plan.descriptors.canary.bytes},
    {address: plan.receiveAddress - GUARD_BYTES,
      bytes: Buffer.alloc(GUARD_BYTES, GUARD_BEFORE)},
    {address: plan.receiveAddress,
      bytes: Buffer.alloc(READ_BYTES, EVENT_POISON)},
    {address: plan.receiveAddress + READ_BYTES,
      bytes: Buffer.alloc(GUARD_BYTES, GUARD_AFTER)},
  ];
  // The frame validator rejects changed handles and packets before a write.
  const receipt = await stageGapEventFrames(native, staged);
  for (const row of writes) {
    await native.write(row.address, row.bytes);
    const observed = await native.read(row.address, row.bytes.length);
    check(Buffer.isBuffer(observed) && observed.equals(row.bytes),
      'storage descriptor, poison, or guard immediate readback changed');
  }
  for (const row of writes) {
    const observed = await native.read(row.address, row.bytes.length);
    check(Buffer.isBuffer(observed) && observed.equals(row.bytes),
      'storage descriptor, poison, or guard final readback changed');
  }
  for (const frame of staged.frames) {
    const observed = await native.read(frame.address, frame.bytes.length);
    check(Buffer.isBuffer(observed) && observed.equals(frame.bytes),
      `${frame.role} event frame changed after storage staging`);
  }
  return {...receipt,
    descriptorSha256: [plan.descriptors.trigger.sha256,
      plan.descriptors.canary.sha256],
    receivePoisonSha256: sha(writes[3].bytes),
    receiveGuardsVerified: true};
}

async function readStorageEventReplies(native, staged, worker, prepared,
  receiveStorage) {
  const plan = staged?.protectedPlan;
  const transport = prepared?.transport;
  check(staged?.mode === MODE &&
    plan?.workerKind === 'protected-storage-window' &&
    worker?.mode === MODE && worker.waveId === staged.waveId &&
    worker.arenaNonce === staged.arenaNonce &&
    worker.eventGate === 'initialized-signaled-finalized' &&
    worker.workerState === 'joined-closed' &&
    worker.threadHandles === 'closed' &&
    worker.parentOwnedServiceHandles === 'preserved' &&
    Array.isArray(worker.rows) && worker.rows.length === ROLES.length &&
    receiveStorage?.handle === staged.receiveHandle &&
    receiveStorage.closed === false &&
    transport?.ownedHandles?.has(receiveStorage.handle) &&
    native?.addresses?.scratch === staged.arenaBase + 0x10000 &&
    native.addresses.sdk === staged.sdkBase &&
    typeof native.read === 'function',
  'joined four-role storage worker and exact receive owner are required');
  const replies = [];
  let output, pin;
  try {
    for (let index = 0; index < ROLES.length; index++) {
      const frame = staged.frames[index];
      const row = worker.rows[index];
      check(frame.role === ROLES[index] &&
        row.role === frame.role && row.handle === frame.handle &&
        row.transportResult === 0,
      `${frame.role} event worker identity changed`);
      const ticks = [];
      for (const offset of [RESULT_OFFSETS.startTick,
        RESULT_OFFSETS.transportResult, RESULT_OFFSETS.endTick])
        ticks.push(await native.read(frame.address + offset, 8));
      check(ticks.every(bytes => Buffer.isBuffer(bytes) && bytes.length === 8) &&
        ticks[0].readBigUInt64LE(0) === BigInt(row.startTick) &&
        ticks[1].readBigUInt64LE(0) === 0n &&
        ticks[2].readBigUInt64LE(0) === BigInt(row.endTick),
      `${frame.role} native tick or transport readback changed`);
      replies.push(await native.read(frame.packetAddress, 256));
    }
    const parsed = replies.map((bytes, index) =>
      rawCmif(bytes, `${ROLES[index]} event`));
    const forbidden = new Set([prepared.root.handle,
      transport.evidence.sessionManager.borrowedHandle,
      ...transport.ownedHandles, ...transport.rawOwnedHandles,
      ...staged.frames.map(frame => frame.handle)]);
    const moved = parsed[1].moves;
    if (parsed[1].result !== 0 ||
        !Array.isArray(moved) || moved.length !== 1 ||
        !Array.isArray(parsed[1].copies) || parsed[1].copies.length !== 0 ||
        !Number.isInteger(moved[0]) || moved[0] <= 0 ||
        moved[0] >= 0xffff8000 || forbidden.has(moved[0]))
      throw uncertain(null, 'pin moved handle is missing or aliases an owner');
    pin = {owner: staged.arenaNonce, waveId: staged.waveId,
      handle: moved[0], closed: false,
      open: {parentRootHandle: prepared.root.handle,
        requestHex: staged.frames[1].bytes.subarray(PACKET_OFFSET,
          PACKET_OFFSET + 256).toString('hex'),
        requestSha256: staged.frames[1].requestSha256,
        replyHex: replies[1].toString('hex'),
        replySha256: sha(replies[1]), movedHandle: moved[0]},
      close: null};
    transport.registerRawOwned(pin.handle);
    for (const index of [0, 2, 3]) {
      if (!Array.isArray(parsed[index].moves) ||
          !Array.isArray(parsed[index].copies) ||
          parsed[index].moves.length || parsed[index].copies.length)
        throw uncertain(null, `${ROLES[index]} event transferred a handle`);
    }
    if (parsed[0].result !== 0 || parsed[0].data.length < 4 ||
        parsed[0].data.readUInt32LE(0) !== 1 ||
        parsed[2].result !== 0 || parsed[3].result !== 0x202)
      throw uncertain(null, 'negative marker, storage, or absent reply changed');
    output = await native.read(plan.receiveAddress, READ_BYTES);
    const before = await native.read(plan.receiveAddress - GUARD_BYTES,
      GUARD_BYTES);
    const after = await native.read(plan.receiveAddress + READ_BYTES,
      GUARD_BYTES);
    if (!Buffer.isBuffer(output) || output.length !== READ_BYTES ||
        !Buffer.isBuffer(before) ||
        !before.equals(Buffer.alloc(GUARD_BYTES, GUARD_BEFORE)) ||
        !Buffer.isBuffer(after) ||
        !after.equals(Buffer.alloc(GUARD_BYTES, GUARD_AFTER)) ||
        output.equals(Buffer.alloc(READ_BYTES, EVENT_POISON)) ||
        !output.equals(receiveStorage.serial?.output) ||
        sha(output) !== plan.expectedContentSha256 ||
        output.indexOf(content(staged.markerNonce)) !== -1)
      throw uncertain(null, 'event storage output differs from ordinary baseline');
    const rows = worker.rows.map((row, index) => ({...row,
      requestKind: plan.frames[index].requestKind,
      requestId: sha(Buffer.from(`${staged.waveId}:${row.role}`))
        .slice(0, 16), requestIdSource: 'host-wave-role-hash',
      ipcResult: parsed[index].result,
      entryTypeControl: index === 0 ? 1 : undefined,
      receiveBytesVerified: index === 2 ? READ_BYTES : undefined}));
    return {rows, pinStorage: pin,
      eventRead: {handle: receiveStorage.handle,
        requestHex: staged.frames[2].bytes.subarray(PACKET_OFFSET,
          PACKET_OFFSET + 256).toString('hex'),
        requestSha256: staged.frames[2].requestSha256,
        replyHex: replies[2].toString('hex'),
        replySha256: sha(replies[2]),
        outputSha256: sha(output),
        outputFirst64Hex: output.subarray(0, 64).toString('hex'),
        outputGuardsIntact: true, ordinaryBaselineMatched: true},
      rawReplies: replies.map((bytes, index) => ({role: ROLES[index],
        hex: bytes.toString('hex'), sha256: sha(bytes)}))};
  } catch (cause) {
    const error = cause?.resourceStateUncertain ? cause :
      uncertain(cause, 'event reply or moved-handle state is unknown');
    error.diagnostic = {...(error.diagnostic || {}),
      rawReplies: replies.map((bytes, index) => ({role: ROLES[index],
        hex: Buffer.isBuffer(bytes) ? bytes.toString('hex') : null})),
      pinMovedHandle: pin?.handle ?? null,
      eventOutputSha256: Buffer.isBuffer(output) ? sha(output) : null};
    throw error;
  }
}

function assessStorageEventControl({preflight, staged, worker, observed,
  receiveStorage, phases, pathBefore, pathAfter, changedPaths,
  saveAudit, cleanup}) {
  check(staged?.mode === MODE &&
    staged.markerAttempted === false &&
    worker?.eventGate === 'initialized-signaled-finalized' &&
    worker.workerState === 'joined-closed' &&
    worker.threadHandles === 'closed' &&
    observed?.pinStorage?.closed === true &&
    receiveStorage?.closed === true &&
    observed.eventRead?.ordinaryBaselineMatched === true &&
    observed.eventRead.outputGuardsIntact === true &&
    observed.eventRead.outputSha256 ===
      staged.protectedPlan.expectedContentSha256 &&
    cleanup?.pinStorageClosed === true &&
    cleanup.receiveStorageClosed === true &&
    cleanup.protectedCloneClosed === true &&
    cleanup.ownedHandlesClosed === true &&
    markerCleanupVerified(cleanup) &&
    cleanup.borrowedSession === 'preserved' &&
    cleanup.arena === 'released' &&
    Array.isArray(changedPaths) &&
    changedPaths.filter(path => !/(?:canary|filler0|filler1)/.test(path))
      .length === 0 &&
    saveAudit?.coverage === 'bounded-cloned-save-tree' &&
    saveAudit.completeSaveTreeVerified === true &&
    saveAudit.logPrefixVerified === true &&
    saveAudit.logState === 'append-only' &&
    Array.isArray(saveAudit.changed) && saveAudit.changed.length === 0,
  'four negative replies, exact storage, save audit, or cleanup is missing');
  checkPaths(pathBefore, staged.markerNonce);
  checkPaths(pathAfter, staged.markerNonce);
  assessNoStorageControls(phases);
  const ids = new Set();
  const threads = new Set();
  const rows = observed.rows;
  check(Array.isArray(rows) && rows.length === ROLES.length &&
    rows.every((row, index) => {
      const role = ROLES[index];
      const valid = row.role === role &&
        row.handle === staged.frames[index].handle &&
        Number.isSafeInteger(row.startTick) &&
        Number.isSafeInteger(row.endTick) &&
        row.startTick > 0 && row.startTick < row.endTick &&
        row.endTick - row.startTick <= MAX_TICKS &&
        /^[0-9a-f]{16}$/.test(row.requestId || '') &&
        /^[0-9a-f]{16}$/.test(row.threadId || '') &&
        row.threadId !== '0000000000000000' &&
        row.requestIdSource === 'host-wave-role-hash' &&
        !ids.has(row.requestId) && !threads.has(row.threadId) &&
        row.transportResult === 0 &&
        row.ipcResult === (role === 'trigger' ? 0x202 : 0) &&
        (role !== 'canary' || row.entryTypeControl === 1) &&
        (role !== 'receive' || row.receiveBytesVerified === READ_BYTES);
      ids.add(row.requestId);
      threads.add(row.threadId);
      return valid;
    }),
  'four independent native client timing rows are missing');
  const byRole = Object.fromEntries(rows.map(row => [row.role, row]));
  const trigger = byRole.trigger;
  const latestStart = Math.max(...rows.map(row => row.startTick));
  const earliestEnd = Math.min(...rows.map(row => row.endTick));
  const reportStorage = storage => ({handle: storage.handle,
    open: storage.open, size: storage.size,
    ...(storage.serial ? {serial: {
      ...storage.serial, output: undefined}} : {}),
    close: storage.close});
  return {gameProfile: profile.gameProfile,
    workerKind: MODE, waveId: staged.waveId,
    arenaNonce: preflight.arenaNonce,
    markerNonce: preflight.markerNonce,
    eventGate: worker.eventGate, waveRows: rows,
    frameProvenance: staged.frames.map(frame => ({role: frame.role,
      handle: frame.handle, frameSha256: frame.sha256,
      requestSha256: frame.requestSha256})),
    rawReplies: observed.rawReplies,
    receiveStorage: reportStorage(receiveStorage),
    pinStorage: reportStorage(observed.pinStorage),
    eventRead: observed.eventRead,
    counterPhases: phases, saveTreeAudit: saveAudit, changedPaths,
    preparationMarkerSaveWrites: 1, nativeWindowSaveWrites: 0,
    clientIpcCommonOverlapTicks: Math.max(0, earliestEnd - latestStart),
    clientIpcCommonOverlapMeasured: earliestEnd > latestStart,
    clientCanarySpansTrigger: byRole.canary.startTick <= trigger.startTick &&
      byRole.canary.endTick >= trigger.endTick,
    clientPinSpansTrigger: byRole.pin.startTick <= trigger.startTick &&
      byRole.pin.endTick >= trigger.endTick,
    clientReceiveSpansTrigger:
      byRole.receive.startTick <= trigger.startTick &&
      byRole.receive.endTick >= trigger.endTick,
    counterBaselineRestored: true, completeSaveAuditVerified: true,
    independentOrdinaryBaselineMatched: true,
    cleanup: 'verified', ...markerCleanupSummary(cleanup),
    receiveStorageClosed: true,
    pinStorageClosed: true, protectedCloneClosed: true,
    requestIdsHostDerived: true,
    exactAllocationBytes: null, pinAddress: null,
    markerAttempted: false, fsHandlerOverlapMeasured: false,
    fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false,
    status: 'four negative event requests and ordinary IStorage receive verified; client timing only'};
}

async function runProtectedStorageEventControl({preflight, adapter,
  executeSource, host, macIp, port, mainBase, ordinaryBaseline,
  waveId = randomBytes(8).toString('hex'), onPhase = () => {}}) {
  check(adapter && ['inspect', 'prepare', 'readPaths', 'counterPair',
    'auditPaths', 'auditDetails', 'cleanup'].every(name =>
      typeof adapter[name] === 'function') &&
    typeof executeSource === 'function' && typeof onPhase === 'function' &&
    net.isIP(host) === 4 && net.isIP(macIp) === 4 &&
    Number.isInteger(port) && port >= 1024 && port <= 65535 &&
    /^0x[0-9a-f]+$/.test(mainBase || '') &&
    /^[0-9a-f]{16}$/.test(waveId) &&
    waveId !== preflight?.arenaNonce &&
    waveId !== preflight?.markerNonce,
  'fresh owner, bounded transport, or distinct wave is missing');
  // Validate the independent, previously cleaned baseline before the first
  // live identity request. It is never generated by this wave.
  validateOrdinaryBaseline(ordinaryBaseline, preflight.arenaNonce);
  checkIdentity(await adapter.inspect(), preflight);
  let prepared, protectedClone, receiveStorage, staged, worker, observed;
  let phases, pathBefore, pathAfter, changedPaths, saveAudit;
  let receiveOpenAttempted = false;
  let workerRequestSent = false;
  let workerReleased = false;
  let pinCloseAttempted = false;
  let pinClosed = false;
  let receiveCloseAttempted = false;
  let receiveClosed = false;
  let ownedCleanupAttempted = false;
  let ownedCleanupVerified = false;
  let ownedCleanupResult;
  let resourceStateUncertain = false;
  let failure;
  const storageProof = storage => storage ? {
    handle: storage.handle ?? null, closed: storage.closed === true,
    open: storage.open ?? null, size: storage.size ?? null,
    serial: storage.serial ? {
      address: storage.serial.address,
      outputSha256: storage.serial.outputSha256,
      outputFirst64Hex: storage.serial.outputFirst64Hex,
      requestHex: storage.serial.requestHex,
      requestSha256: storage.serial.requestSha256,
      replyHex: storage.serial.replyHex,
      replySha256: storage.serial.replySha256,
      guardsIntact: storage.serial.guardsIntact,
      markerBytesAbsent: storage.serial.markerBytesAbsent} : null,
    close: storage.close ?? null} : null;
  const diagnostic = error => {
    error.diagnostic = {
      ...(error.diagnostic && typeof error.diagnostic === 'object' ?
        error.diagnostic : {}),
      arenaNonce: preflight.arenaNonce, waveId,
      receiveOpenAttempted, receiveStorage: storageProof(receiveStorage),
      pinStorage: storageProof(observed?.pinStorage),
      protectedCloneHandle: protectedClone?.handle ?? null,
      protectedCloneClosed: protectedClone?.closed === true,
      workerRequestSent, workerReleased,
      workerState: worker?.workerState ?? null,
      eventGate: worker?.eventGate ?? null,
      waveRows: observed?.rows ?? worker?.rows ?? null,
      rawReplies: observed?.rawReplies ?? error.diagnostic?.rawReplies ?? null,
      eventRead: observed?.eventRead ?? null,
      pinCloseAttempted, pinClosed,
      receiveCloseAttempted, receiveClosed,
      counterPhases: phases ?? null,
      pathBefore: pathBefore ?? null, pathAfter: pathAfter ?? null,
      saveTreeAudit: saveAudit ?? null,
      changedPaths: changedPaths ?? null,
      ownedCleanupAttempted, ownedCleanupVerified,
      ownedCleanupResult: ownedCleanupResult ?? null,
      resourceStateUncertain,
      markerAttempted: false, fsHandlerOverlapMeasured: false,
      fsSideMarkerReadbackVerified: false,
      markerHitVerified: false, fsStageVerified: false};
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
    phases = {before: await counterPair('protected-storage-before'),
      noStorageBefore: await counterPair('protected-storage-no-storage-before')};
    onPhase('copy-distinct-protected-save-clone');
    protectedClone = await openProtectedClone(prepared);
    onPhase('open-one-distinct-owned-receive-storage-child');
    receiveOpenAttempted = true;
    receiveStorage = await openReceiveStorage(preflight, prepared,
      protectedClone);
    onPhase('qualify-ordinary-storage-size-and-serial-content');
    await qualifyReceiveStorage(preflight, prepared, receiveStorage,
      ordinaryBaseline);
    staged = buildStorageEventControl({preflight, prepared,
      protectedClone, receiveStorage, baseline: ordinaryBaseline, waveId});
    const stageReceipt = await stageStorageEventControl(
      prepared.transport.native, staged);
    const options = {nonce: preflight.arenaNonce,
      arenaBase: preflight.arenaBase, sdkBase: preflight.sdkBase,
      mainBase, waveId, hostIp: macIp, port, staged, stageReceipt};
    const source = makeGapEventWorkerSource(options);
    onPhase('run-four-event-gated-negative-requests');
    workerRequestSent = true;
    worker = parseGapEventWorkerReply(await executeSource({host,
      port: 9026, source, timeoutMs: 3600000}), options);
    workerReleased = worker.workerState === 'joined-closed' &&
      worker.threadHandles === 'closed' &&
      worker.eventGate === 'initialized-signaled-finalized';
    observed = await readStorageEventReplies(prepared.transport.native,
      staged, worker, prepared, receiveStorage);
    onPhase('close-event-pin-storage-once');
    pinCloseAttempted = true;
    await closeStorageHandle(prepared, observed.pinStorage, 'pin');
    pinClosed = observed.pinStorage.closed === true;
    onPhase('close-preopened-receive-storage-once');
    receiveCloseAttempted = true;
    await closeStorageHandle(prepared, receiveStorage, 'receive');
    receiveClosed = receiveStorage.closed === true;
    onPhase('close-protected-save-clone');
    await closeProtectedClone(prepared, protectedClone);
    phases.after = await counterPair('protected-storage-after');
    phases.noStorageAfter = await counterPair('protected-storage-no-storage-after');
    pathAfter = await adapter.readPaths(prepared);
    checkPaths(pathAfter, preflight.markerNonce);
    changedPaths = await adapter.auditPaths(prepared);
    saveAudit = adapter.auditDetails();
    check(Array.isArray(changedPaths) &&
      changedPaths.filter(path => !/(?:canary|filler0|filler1)/.test(path))
        .length === 0 &&
      saveAudit?.coverage === 'bounded-cloned-save-tree' &&
      saveAudit.completeSaveTreeVerified === true &&
      saveAudit.logPrefixVerified === true &&
      saveAudit.logState === 'append-only' &&
      Array.isArray(saveAudit.changed) && saveAudit.changed.length === 0,
    'complete cloned save audit or log prefix changed');
  } catch (error) {
    failure = error;
    resourceStateUncertain = error?.resourceStateUncertain === true ||
      receiveOpenAttempted && !receiveStorage ||
      workerRequestSent && (!workerReleased || !observed || !pinClosed) ||
      receiveCloseAttempted && !receiveClosed;
  }
  if (prepared && !resourceStateUncertain) {
    try {
      if (observed?.pinStorage && !observed.pinStorage.closed) {
        pinCloseAttempted = true;
        await closeStorageHandle(prepared, observed.pinStorage, 'pin');
        pinClosed = observed.pinStorage.closed === true;
      }
      if (receiveStorage && !receiveStorage.closed) {
        receiveCloseAttempted = true;
        await closeStorageHandle(prepared, receiveStorage, 'receive');
        receiveClosed = receiveStorage.closed === true;
      }
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
          'storage event control and cleanup failed') : cause,
      'final owned cleanup is unknown'));
    }
  }
  if (failure) {
    if (resourceStateUncertain) throw diagnostic(uncertain(failure,
      'event worker, storage reply, or owned handle state is unknown'));
    throw diagnostic(failure);
  }
  try {
    check(prepared && observed && receiveClosed && pinClosed &&
      protectedClone?.closed === true && ownedCleanupVerified,
    'storage event control did not finish its owned lease');
    return assessStorageEventControl({preflight, staged, worker, observed,
      receiveStorage, phases, pathBefore, pathAfter, changedPaths,
      saveAudit, cleanup: {pinStorageClosed: pinClosed,
        receiveStorageClosed: receiveClosed,
        protectedCloneClosed: protectedClone.closed,
        ...ownedCleanupResult}});
  } catch (error) {throw diagnostic(error);}
}

module.exports = {MODE, ROLES, openReceiveStorage,
  qualifyReceiveStorage, closeStorageHandle,
  buildStorageEventControl, stageStorageEventControl,
  readStorageEventReplies, assessStorageEventControl,
  runProtectedStorageEventControl};
