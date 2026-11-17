const {createHash} = require('node:crypto');
const profile = require('./sdk-profile.v1.0.1f.json');
const {buildFrame, FRAME_SPACING, PACKET_OFFSET, PACKET_BYTES,
  SERVICE_HANDLE_OFFSET} = require('./fs-counter-overlap.cjs');
const {descriptorInput} = require('./fs-attempt-packets.cjs');
const {response: cmifResponse} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {content} = require('./marker-content-control.cjs');
const {RESULT_OFFSET} = require('./worker-chain.cjs');

const ROLES = Object.freeze(['pin', 'receive', 'trigger']);
const FRAME_BYTES = PACKET_OFFSET + PACKET_BYTES;
const ARENA_BYTES = 0x200000;
const closeAttempts = new WeakSet();

function requireAddress(value, name) {
  const address = Number(BigInt(value));
  if (!Number.isSafeInteger(address) || address < 0x1000 ||
      address % 0x1000 !== 0 || address >= 2 ** 39) {
    throw new RangeError(`Balatro ${name} must be a page-aligned user address`);
  }
  return address;
}

function requestCommand(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 256) {
    throw new Error('Balatro CMIF request is not 256 bytes');
  }
  const first = bytes.readUInt32LE(0);
  const second = bytes.readUInt32LE(4);
  if ((first & 0xffff) !== 4 || (first >>> 28) !== 0) {
    throw new Error('Balatro CMIF request header changed');
  }
  let at = 8;
  if (second >>> 31) {
    const special = bytes.readUInt32LE(at);
    at += 4 + (special & 1 ? 8 : 0) + ((special >>> 1) & 15) * 4;
  }
  at += ((first >>> 16) & 15) * 8;
  at += (((first >>> 20) & 15) + ((first >>> 24) & 15)) * 12;
  at = (at + 15) & ~15;
  if (at + 16 > bytes.length || bytes.toString('ascii', at, at + 4) !== 'SFCI') {
    throw new Error('Balatro CMIF request command is missing');
  }
  return bytes.readUInt32LE(at + 8);
}

function buildAbortFrames(plan, {arenaBase, sdkBase}) {
  const arena = requireAddress(arenaBase, 'arena');
  const sdk = requireAddress(sdkBase, 'SDK');
  if (!plan || plan.sdkBase !== `0x${sdk.toString(16)}` ||
      plan.triggerControl !== 'nonce-bound-absent-path' ||
      !/^[0-9a-f]{16}$/.test(plan.arenaNonce || '') ||
      !/^[0-9a-f]{16}$/.test(plan.markerNonce || '') ||
      !/^[0-9a-f]{16}$/.test(plan.waveId || '') ||
      plan.explicitSaveWrites !== 0 ||
      arena + ARENA_BYTES >= 2 ** 39 ||
      sdk + profile.sdkCode.size >= 2 ** 39 ||
      (ROLES.length - 1) * FRAME_SPACING + FRAME_BYTES >= 0x10000) {
    throw new Error('Balatro abort frame owner or arena boundary changed');
  }
  const expected = {pin: ['owned-storage-open', 200],
    receive: ['receive-buffer-request', 0],
    trigger: ['cloned-save-entry-type', 7]};
  const handles = new Set();
  const frames = ROLES.map((role, index) => {
    const request = plan.requests?.[role];
    const [requestKind, command] = expected[role];
    if (request?.requestKind !== requestKind ||
        !Number.isInteger(request.handle) || request.handle <= 0 ||
        request.handle >= 0xffff8000 || handles.has(request.handle) ||
        !Buffer.isBuffer(request.packet) || request.packet.length !== 256 ||
        requestCommand(request.packet) !== command) {
      throw new Error(`Balatro ${role} request is not an owned exact packet`);
    }
    handles.add(request.handle);
    const base = arena + index * FRAME_SPACING;
    const bytes = buildFrame({base, sdk, handle: request.handle});
    bytes.fill(0, PACKET_OFFSET, PACKET_OFFSET + PACKET_BYTES);
    request.packet.copy(bytes, PACKET_OFFSET);
    if (bytes.length !== FRAME_BYTES ||
        bytes.readBigUInt64LE(SERVICE_HANDLE_OFFSET) !== BigInt(request.handle) ||
        bytes.readBigUInt64LE(0x10a8) !== BigInt(base + PACKET_OFFSET)) {
      throw new Error(`Balatro ${role} native frame ABI changed`);
    }
    return Object.freeze({role, address: base, handle: request.handle,
      bytes, sha256: createHash('sha256').update(bytes).digest('hex')});
  });
  const trigger = plan.requests.trigger;
  const receive = plan.requests.receive;
  if (!Buffer.isBuffer(trigger.descriptorInput) ||
      !trigger.descriptorInput.equals(descriptorInput(plan.markerNonce, 'absent')) ||
      trigger.aborted !== false ||
      !Number.isSafeInteger(trigger.pathAddress) ||
      trigger.pathAddress !== arena + 0x10000 + 0x20000 ||
      !Number.isSafeInteger(receive.receiveAddress) ||
      receive.receiveAddress !== arena + 0x10000 + 0x22000 ||
      receive.receiveBytes !== 16) {
    throw new Error('Balatro abort descriptor or receive buffer changed');
  }
  return Object.freeze({arenaNonce: plan.arenaNonce, markerNonce: plan.markerNonce,
    waveId: plan.waveId, arenaBase: arena, sdkBase: sdk, frames,
    descriptorAddress: trigger.pathAddress,
    descriptor: Buffer.from(trigger.descriptorInput),
    receiveAddress: receive.receiveAddress, receiveBytes: 16});
}

async function stageAbortFrames(native, staged) {
  if (!native || typeof native.write !== 'function' ||
      typeof native.read !== 'function' ||
      native.addresses?.scratch !== staged?.arenaBase + 0x10000 ||
      native.addresses?.sdk !== staged?.sdkBase ||
      !Array.isArray(staged.frames) || staged.frames.length !== ROLES.length) {
    throw new Error('Balatro native transport is not the staged owner');
  }
  const writes = [
    {address: staged.descriptorAddress, bytes: staged.descriptor},
    {address: staged.receiveAddress, bytes: Buffer.alloc(staged.receiveBytes)},
    ...staged.frames.map(({address, bytes}) => ({address, bytes})),
  ];
  for (const row of writes) {
    await native.write(row.address, row.bytes);
    const readback = await native.read(row.address, row.bytes.length);
    if (!Buffer.isBuffer(readback) || !readback.equals(row.bytes)) {
      throw new Error('Balatro native frame or control buffer readback changed');
    }
  }
  // Recheck the entire staged set after the final write. This catches any
  // overlap or later native workspace write that changed an earlier frame.
  for (const row of writes) {
    const readback = await native.read(row.address, row.bytes.length);
    if (!Buffer.isBuffer(readback) || !readback.equals(row.bytes)) {
      throw new Error('Balatro staged frame or control buffer changed after staging');
    }
  }
  return {waveId: staged.waveId, arenaNonce: staged.arenaNonce,
    frameSha256: staged.frames.map(row => row.sha256),
    exactReadbackVerified: true, workerStarted: false, saveWrites: 0};
}

function parseAbortReplies(staged, worker, replies, receiveBuffer) {
  if (!staged || !worker || worker.waveId !== staged.waveId ||
      worker.arenaNonce !== staged.arenaNonce ||
      worker.workerState !== 'joined-closed' ||
      !Array.isArray(worker.rows) || worker.rows.length !== ROLES.length ||
      !Array.isArray(replies) || replies.length !== ROLES.length ||
      !Buffer.isBuffer(receiveBuffer) ||
      receiveBuffer.length !== staged.receiveBytes) {
    throw new Error('Balatro abort worker or reply ownership changed');
  }
  const expectedMarker = content(staged.markerNonce);
  if (!receiveBuffer.equals(expectedMarker)) {
    throw new Error('Balatro abort file receive did not copy the owned marker');
  }
  const moved = new Set(staged.frames.map(frame => frame.handle));
  const rows = ROLES.map((role, index) => {
    const frame = staged.frames[index];
    const source = worker.rows[index];
    const bytes = replies[index];
    if (frame.role !== role || source?.role !== role ||
        source.handle !== frame.handle || source.transportResult !== 0 ||
        !Buffer.isBuffer(bytes) || bytes.length !== 256) {
      throw new Error(`Balatro ${role} transport or reply changed`);
    }
    const parsed = cmifResponse(bytes);
    if (role === 'pin') {
      if (parsed.result !== 0 || parsed.copies.length !== 0 ||
          parsed.moves.length !== 1 || !Number.isInteger(parsed.moves[0]) ||
          parsed.moves[0] <= 0 || parsed.moves[0] >= 0xffff8000 ||
          moved.has(parsed.moves[0])) {
        throw new Error('Balatro pin response did not transfer one distinct storage handle');
      }
      moved.add(parsed.moves[0]);
    } else if (role === 'receive') {
      if (parsed.result !== 0 || parsed.copies.length || parsed.moves.length ||
          parsed.data.length < 8 || parsed.data.readBigUInt64LE(0) !== 16n) {
        throw new Error('Balatro receive response did not report the exact marker length');
      }
    } else if (parsed.result !== 0x202 || parsed.copies.length ||
        parsed.moves.length) {
      throw new Error('Balatro absent-path trigger CMIF result changed');
    }
    return {...source, ipcResult: parsed.result,
      receiveBytesVerified: role === 'receive' ? 16 : undefined};
  });
  return {rows, movedStorageHandle: [...moved].find(handle =>
    !staged.frames.some(frame => frame.handle === handle)),
  receiveBufferVerified: true, triggerControl: 'nonce-bound-absent-path'};
}

async function readAbortReplies(native, staged, worker) {
  if (!native || typeof native.read !== 'function' ||
      native.addresses?.scratch !== staged?.arenaBase + 0x10000 ||
      native.addresses?.sdk !== staged?.sdkBase ||
      worker?.workerState !== 'joined-closed') {
    throw new Error('Balatro abort replies require the stopped owned worker');
  }
  const replies = [];
  for (const frame of staged.frames) {
    const results = await native.read(frame.address + RESULT_OFFSET, 24);
    if (!Buffer.isBuffer(results) || results.length !== 24 ||
        results.readBigUInt64LE(8) !== 0n ||
        results.readBigUInt64LE(0) === 0n ||
        results.readBigUInt64LE(16) <= results.readBigUInt64LE(0) ||
        !Number.isSafeInteger(worker.rows?.[staged.frames.indexOf(frame)]?.startTick) ||
        !Number.isSafeInteger(worker.rows?.[staged.frames.indexOf(frame)]?.endTick) ||
        results.readBigUInt64LE(0) !==
          BigInt(worker.rows[staged.frames.indexOf(frame)].startTick) ||
        results.readBigUInt64LE(16) !==
          BigInt(worker.rows[staged.frames.indexOf(frame)].endTick)) {
      throw new Error(`Balatro ${frame.role} native svcSend transport failed`);
    }
    replies.push(await native.read(frame.address + PACKET_OFFSET, 256));
  }
  const receiveBuffer = await native.read(staged.receiveAddress,
    staged.receiveBytes);
  return parseAbortReplies(staged, worker, replies, receiveBuffer);
}

// Positive-wave frame variants: identical frame ABI to the abort control, but
// the trigger is the B-filler positiveCandidate on a scratch-lease clone and
// its expected CMIF result is 0x2eec02 (2-6006) rather than 0x202.
function buildPositiveFrames(plan, {arenaBase, sdkBase}) {
  const arena = requireAddress(arenaBase, 'arena');
  const sdk = requireAddress(sdkBase, 'SDK');
  if (!plan || plan.sdkBase !== `0x${sdk.toString(16)}` ||
      plan.triggerControl !== 'b-filler-positive-candidate' ||
      plan.positivePathControl !== 'executed-b-filler-candidate' ||
      !/^[0-9a-f]{16}$/.test(plan.arenaNonce || '') ||
      !/^[0-9a-f]{16}$/.test(plan.markerNonce || '') ||
      !/^[0-9a-f]{16}$/.test(plan.waveId || '') ||
      plan.explicitSaveWrites !== 0 ||
      arena + ARENA_BYTES >= 2 ** 39 ||
      sdk + profile.sdkCode.size >= 2 ** 39 ||
      (ROLES.length - 1) * FRAME_SPACING + FRAME_BYTES >= 0x10000) {
    throw new Error('Balatro positive frame owner or arena boundary changed');
  }
  const expected = {pin: ['owned-storage-open', 200],
    receive: ['receive-buffer-request', 0],
    trigger: ['cloned-save-entry-type', 7]};
  const handles = new Set();
  const frames = ROLES.map((role, index) => {
    const request = plan.requests?.[role];
    const [requestKind, command] = expected[role];
    if (request?.requestKind !== requestKind ||
        !Number.isInteger(request.handle) || request.handle <= 0 ||
        request.handle >= 0xffff8000 || handles.has(request.handle) ||
        !Buffer.isBuffer(request.packet) || request.packet.length !== 256 ||
        requestCommand(request.packet) !== command) {
      throw new Error(`Balatro ${role} positive request is not an owned exact packet`);
    }
    handles.add(request.handle);
    const base = arena + index * FRAME_SPACING;
    const bytes = buildFrame({base, sdk, handle: request.handle});
    bytes.fill(0, PACKET_OFFSET, PACKET_OFFSET + PACKET_BYTES);
    request.packet.copy(bytes, PACKET_OFFSET);
    if (bytes.length !== FRAME_BYTES ||
        bytes.readBigUInt64LE(SERVICE_HANDLE_OFFSET) !== BigInt(request.handle) ||
        bytes.readBigUInt64LE(0x10a8) !== BigInt(base + PACKET_OFFSET)) {
      throw new Error(`Balatro ${role} positive native frame ABI changed`);
    }
    return Object.freeze({role, address: base, handle: request.handle,
      bytes, sha256: createHash('sha256').update(bytes).digest('hex')});
  });
  const trigger = plan.requests.trigger;
  const receive = plan.requests.receive;
  if (!Buffer.isBuffer(trigger.descriptorInput) ||
      trigger.descriptorInput.length !== trigger.descriptorBytes ||
      trigger.descriptorBytes < 0x800 || trigger.descriptorBytes > 0x3000 ||
      trigger.descriptorInput[trigger.descriptorBytes - 1] !== 0 ||
      trigger.descriptorInput.subarray(0, trigger.descriptorBytes - 1)
        .every(byte => byte === 0) ||
      trigger.descriptorInput.equals(descriptorInput(plan.markerNonce, 'absent')) ||
      trigger.aborted !== false ||
      !Number.isSafeInteger(trigger.pathAddress) ||
      trigger.pathAddress !== arena + 0x10000 + 0x50000 ||
      !Number.isSafeInteger(receive.receiveAddress) ||
      receive.receiveAddress !== arena + 0x10000 + 0x22000 ||
      receive.receiveBytes !== 16) {
    throw new Error('Balatro positive descriptor or receive buffer changed');
  }
  return Object.freeze({arenaNonce: plan.arenaNonce, markerNonce: plan.markerNonce,
    waveId: plan.waveId, arenaBase: arena, sdkBase: sdk, frames,
    descriptorAddress: trigger.pathAddress,
    descriptor: Buffer.from(trigger.descriptorInput),
    receiveAddress: receive.receiveAddress, receiveBytes: 16,
    triggerControl: 'b-filler-positive-candidate'});
}

function parsePositiveReplies(staged, worker, replies, receiveBuffer) {
  if (!staged || !worker || worker.waveId !== staged.waveId ||
      worker.arenaNonce !== staged.arenaNonce ||
      worker.workerState !== 'joined-closed' ||
      !Array.isArray(worker.rows) || worker.rows.length !== ROLES.length ||
      !Array.isArray(replies) || replies.length !== ROLES.length ||
      !Buffer.isBuffer(receiveBuffer) ||
      receiveBuffer.length !== staged.receiveBytes) {
    throw new Error('Balatro positive worker or reply ownership changed');
  }
  const expectedMarker = content(staged.markerNonce);
  if (!receiveBuffer.equals(expectedMarker)) {
    throw new Error('Balatro positive file receive did not copy the owned marker');
  }
  const moved = new Set(staged.frames.map(frame => frame.handle));
  const rows = ROLES.map((role, index) => {
    const frame = staged.frames[index];
    const source = worker.rows[index];
    const bytes = replies[index];
    if (frame.role !== role || source?.role !== role ||
        source.handle !== frame.handle || source.transportResult !== 0 ||
        !Buffer.isBuffer(bytes) || bytes.length !== 256) {
      throw new Error(`Balatro ${role} positive transport or reply changed`);
    }
    const parsed = cmifResponse(bytes);
    if (role === 'pin') {
      if (parsed.result !== 0 || parsed.copies.length !== 0 ||
          parsed.moves.length !== 1 || !Number.isInteger(parsed.moves[0]) ||
          parsed.moves[0] <= 0 || parsed.moves[0] >= 0xffff8000 ||
          moved.has(parsed.moves[0])) {
        throw new Error('Balatro positive pin response did not transfer one distinct storage handle');
      }
      moved.add(parsed.moves[0]);
    } else if (role === 'receive') {
      if (parsed.result !== 0 || parsed.copies.length || parsed.moves.length ||
          parsed.data.length < 8 || parsed.data.readBigUInt64LE(0) !== 16n) {
        throw new Error('Balatro positive receive response did not report the exact marker length');
      }
    } else if (parsed.copies.length || parsed.moves.length) {
      throw new Error('Balatro positive-path trigger transferred an unexpected handle');
    }
    return {...source, ipcResult: parsed.result,
      receiveBytesVerified: role === 'receive' ? 16 : undefined};
  });
  return {rows, movedStorageHandle: [...moved].find(handle =>
    !staged.frames.some(frame => frame.handle === handle)),
  receiveBufferVerified: true, triggerControl: 'b-filler-positive-candidate'};
}

async function readPositiveReplies(native, staged, worker) {
  if (!native || typeof native.read !== 'function' ||
      native.addresses?.scratch !== staged?.arenaBase + 0x10000 ||
      native.addresses?.sdk !== staged?.sdkBase ||
      worker?.workerState !== 'joined-closed') {
    throw new Error('Balatro positive replies require the stopped owned worker');
  }
  const replies = [];
  for (const frame of staged.frames) {
    const results = await native.read(frame.address + RESULT_OFFSET, 24);
    if (!Buffer.isBuffer(results) || results.length !== 24 ||
        results.readBigUInt64LE(8) !== 0n ||
        results.readBigUInt64LE(0) === 0n ||
        results.readBigUInt64LE(16) <= results.readBigUInt64LE(0) ||
        !Number.isSafeInteger(worker.rows?.[staged.frames.indexOf(frame)]?.startTick) ||
        !Number.isSafeInteger(worker.rows?.[staged.frames.indexOf(frame)]?.endTick) ||
        results.readBigUInt64LE(0) !==
          BigInt(worker.rows[staged.frames.indexOf(frame)].startTick) ||
        results.readBigUInt64LE(16) !==
          BigInt(worker.rows[staged.frames.indexOf(frame)].endTick)) {
      throw new Error(`Balatro ${frame.role} positive native svcSend transport failed`);
    }
    replies.push(await native.read(frame.address + PACKET_OFFSET, 256));
  }
  const receiveBuffer = await native.read(staged.receiveAddress,
    staged.receiveBytes);
  return parsePositiveReplies(staged, worker, replies, receiveBuffer);
}

async function closeMovedStorage(native, staged, parsed) {
  const handle = parsed?.movedStorageHandle;
  if (!native || native.addresses?.sdk !== staged?.sdkBase ||
      !Number.isInteger(handle) || handle <= 0 || handle >= 0xffff8000 ||
      staged.frames.some(frame => frame.handle === handle) ||
      parsed.receiveBufferVerified !== true ||
      closeAttempts.has(parsed)) {
    throw new Error('Balatro moved storage handle close is not owned or was attempted');
  }
  closeAttempts.add(parsed);
  // Skip the raw svcCloseHandle. Closing the save-data storage session that the
  // pin's OpenDataStorageByCurrentProcess returned, on the main thread via
  // gp_invoke, resets the bridge — the same save-state class as
  // nn::fs::CommitSaveData and nn::fs::CloseFile (see clone-transport.cjs
  // closeDirect, which already skips the raw close). Retain the storage handle;
  // the adapter's cleanup tears down the retained arena and owner wholesale, so
  // the wave does not leak it.
  return {closed: true, retained: true, skipped: true, handle, attemptedOnce: true};
}

module.exports = {ROLES, FRAME_BYTES, requestCommand, buildAbortFrames,
  stageAbortFrames, parseAbortReplies, readAbortReplies, closeMovedStorage,
  buildPositiveFrames, parsePositiveReplies, readPositiveReplies};
