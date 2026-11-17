'use strict';

// Serial ordinary-content qualification on the exact IStorage handle moved by
// the four-role negative event pin. This is a client-owned storage read, not
// FS heap acquisition or a marker hit.
const {createHash} = require('node:crypto');
const {packet, response} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {checkPaths} = require('./fs-abort-control.cjs');
const {READ_BYTES, GUARD_BYTES, OUTPUT_OFFSETS, POISONS,
  storageReadPacket, closeOwnedStorage} =
  require('./fs-owned-storage-read.cjs');

function check(value, reason) {
  if (!value) throw Error(`Balatro event pinned storage read: ${reason}`);
}

function uncertain(cause, reason) {
  const error = Error(`Balatro event pinned storage read: ${reason}; retain resources`,
    {cause});
  error.resourceStateUncertain = true;
  return error;
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function restoredPathStates(states) {
  const restored = {...states};
  for (const role of ['original', 'cloned', 'padded']) {
    const source = states?.[role];
    const marker = source?.marker;
    const value = marker?.bytes;
    const bytes = Buffer.isBuffer(value) ? value :
      value?.type === 'Buffer' && Array.isArray(value.data) &&
      value.data.length === 16 && value.data.every(byte =>
        Number.isInteger(byte) && byte >= 0 && byte <= 255) ?
        Buffer.from(value.data) : null;
    restored[role] = {...source, marker: {...marker, bytes}};
  }
  return restored;
}

function validateOrdinaryBaseline(report, currentOwner = null) {
  const baseline = report?.ownedStorageRead;
  check(report?.gameProfile === profile.gameProfile &&
    /^[0-9a-f]{16}$/.test(report.owner || '') &&
    /^[0-9a-f]{16}$/.test(report.markerNonce || '') &&
    (currentOwner === null || report.owner !== currentOwner) &&
    report.arena === 'detached' && report.nativeBridge === 'closed' &&
    report.listener === 'closed' &&
    report.markerHitVerified === false && report.fsStageVerified === false &&
    baseline?.gameProfile === profile.gameProfile &&
    baseline?.arenaNonce === report.owner &&
    baseline.markerNonce === report.markerNonce &&
    baseline.cleanup === 'verified' &&
    baseline.storageHandleClosed === true &&
    baseline.counterBaselineRestored === true &&
    Array.isArray(baseline.changedPaths) &&
    baseline.changedPaths.length === 0 &&
    baseline.completeSaveAuditVerified === true &&
    baseline.exactRepeatVerified === true &&
    baseline.markerBytesAbsentFromOrdinaryContent === true &&
    baseline.outputGuardsIntact === true &&
    baseline.storageReadOffset === 0 &&
    baseline.storageReadBytes === READ_BYTES &&
    Number.isSafeInteger(baseline.storageBytes) &&
    baseline.storageBytes >= READ_BYTES &&
    baseline.storageBytes < 2 ** 39 &&
    /^[0-9a-f]{64}$/.test(baseline.ordinaryContentSha256 || '') &&
    Array.isArray(baseline.readSha256) &&
    baseline.readSha256.length === 2 &&
    baseline.readSha256.every(hash =>
      hash === baseline.ordinaryContentSha256) &&
    JSON.stringify(baseline.outputPoisons) === JSON.stringify(POISONS) &&
    baseline.saveTreeAudit?.coverage === 'bounded-cloned-save-tree' &&
    baseline.saveTreeAudit.completeSaveTreeVerified === true &&
    baseline.saveTreeAudit.logPrefixVerified === true &&
    baseline.saveTreeAudit.logState === 'append-only' &&
    Array.isArray(baseline.saveTreeAudit.changed) &&
    baseline.saveTreeAudit.changed.length === 0 &&
    baseline.fsSideAliasVerified === false &&
    baseline.fsSideMarkerReadbackVerified === false &&
    baseline.markerHitVerified === false &&
    baseline.fsStageVerified === false,
  'independent completed ordinary IStorage baseline is required');
  try {
    checkPaths(restoredPathStates(baseline.pathBefore), report.markerNonce);
    checkPaths(restoredPathStates(baseline.pathAfter), report.markerNonce);
  } catch (cause) {
    throw Error('Balatro event pinned storage read: baseline path controls differ',
      {cause});
  }
  return Object.freeze({owner: report.owner,
    storageBytes: baseline.storageBytes,
    ordinaryContentSha256: baseline.ordinaryContentSha256,
    readBytes: READ_BYTES});
}

function adoptEventPinStorage({preflight, prepared, staged, worker, observed}) {
  const transport = prepared?.transport;
  const handle = observed?.parsed?.movedStorageHandle;
  const raw = observed?.rawReplies?.[1];
  const request = staged?.frames?.[1]?.bytes?.subarray(0x2000, 0x2100);
  const existing = [prepared?.clone?.handle, prepared?.file?.handle,
    staged?.frames?.[0]?.handle, staged?.frames?.[2]?.handle];
  check(preflight?.gameProfile === profile.gameProfile &&
    prepared?.arenaNonce === preflight.arenaNonce &&
    prepared.markerNonce === preflight.markerNonce &&
    staged?.arenaNonce === preflight.arenaNonce &&
    staged.markerNonce === preflight.markerNonce &&
    staged.mode === 'protected-event-control' &&
    /^[0-9a-f]{16}$/.test(staged.waveId || '') &&
    worker?.waveId === staged.waveId &&
    worker.arenaNonce === staged.arenaNonce &&
    worker.workerState === 'joined-closed' &&
    worker.threadHandles === 'closed' &&
    worker.eventGate === 'initialized-signaled-finalized' &&
    observed?.parsed?.receiveBufferVerified === true &&
    staged.frames.length === 4 &&
    staged.frames[1].role === 'pin' &&
    staged.frames[1].handle === prepared.root.handle &&
    Buffer.isBuffer(request) && request.length === 256 &&
    request.equals(packet(200)) &&
    staged.frames[1].requestSha256 === sha(request) &&
    Buffer.isBuffer(raw) && raw.length === 256 &&
    Number.isInteger(handle) && handle > 0 && handle < 0xffff8000 &&
    handle !== prepared.root.handle &&
    handle !== transport.evidence.sessionManager.borrowedHandle &&
    !existing.includes(handle) &&
    transport.ownedHandles instanceof Set &&
    transport.ownedHandles.size === 4 &&
    existing.every(id => transport.ownedHandles.has(id)) &&
    !transport.ownedHandles.has(handle),
  'joined same-owner pin reply or distinct moved storage is missing');
  let parsed;
  try {parsed = response(raw);} catch (cause) {
    throw uncertain(cause, 'pin CMIF reply cannot be parsed');
  }
  check(parsed.result === 0 && parsed.copies.length === 0 &&
    parsed.moves.length === 1 && parsed.moves[0] === handle,
  'pin CMIF reply does not bind one exact moved handle');
  transport.ownedHandles.add(handle);
  return {handle, closed: false, owner: preflight.arenaNonce,
    waveId: staged.waveId, pin: {requestHex: request.toString('hex'),
      requestSha256: sha(request), replyHex: raw.toString('hex'),
      replySha256: sha(raw), movedHandle: handle,
      eventFrameSha256: staged.frames[1].sha256,
      nativeStartTick: worker.rows[1].startTick,
      nativeEndTick: worker.rows[1].endTick}};
}

function exactReply(raw, command) {
  if (!Buffer.isBuffer(raw) || raw.length !== 256)
    throw uncertain(null, `${command} CMIF reply bytes are missing`);
  let parsed;
  try {parsed = response(raw);} catch (cause) {
    throw uncertain(cause, `${command} CMIF reply cannot be parsed`);
  }
  if (!Array.isArray(parsed.moves) || !Array.isArray(parsed.copies) ||
      parsed.moves.length || parsed.copies.length)
    throw uncertain(null, `${command} CMIF reply transferred an unexpected handle`);
  check(parsed.result === 0,
    `${command} CMIF reply returned 0x${parsed.result.toString(16)}`);
  return parsed;
}

async function readEventPinnedStorage({preflight, prepared, staged, worker,
  observed, storage, baseline}) {
  const expected = validateOrdinaryBaseline(baseline, preflight?.arenaNonce);
  const transport = prepared?.transport;
  const native = transport?.native;
  check(storage?.closed === false &&
    storage.owner === preflight.arenaNonce &&
    storage.waveId === staged?.waveId &&
    storage.handle === observed?.parsed?.movedStorageHandle &&
    storage.pin?.movedHandle === storage.handle &&
    transport.ownedHandles.has(storage.handle) &&
    worker?.workerState === 'joined-closed' &&
    worker.eventGate === 'initialized-signaled-finalized' &&
    native?.addresses?.scratch === transport.scratch &&
    native.addresses.sdk === Number(BigInt(preflight.sdkBase)),
  'same-owner adopted storage and joined event worker are required');
  const addresses = OUTPUT_OFFSETS.map(offset => transport.scratch + offset);
  check(addresses[0] === prepared.receiveAddress &&
    addresses[0] - GUARD_BYTES > transport.scratch + 0x21000 &&
    addresses[0] + READ_BYTES + GUARD_BYTES < transport.scratch + 0x40000 &&
    addresses[1] - GUARD_BYTES > transport.scratch + 0x48080 &&
    addresses[1] + READ_BYTES + GUARD_BYTES < transport.scratch + 0x80000,
  'guarded output buffers overlap the native IPC workspace');
  const diagnostic = {owner: storage.owner, waveId: storage.waveId,
    handle: storage.handle, pin: storage.pin,
    baseline: expected, size: null, reads: []};
  try {
    const sizeRequest = packet(4);
    let sizeReply;
    try {sizeReply = await transport.sendPacket(storage.handle, sizeRequest);}
    catch (cause) {throw uncertain(cause, 'size IPC outcome is unknown');}
    diagnostic.size = {requestHex: sizeRequest.toString('hex'),
      requestSha256: sha(sizeRequest),
      replyHex: Buffer.isBuffer(sizeReply) ? sizeReply.toString('hex') : null,
      replySha256: Buffer.isBuffer(sizeReply) ? sha(sizeReply) : null};
    const sizeParsed = exactReply(sizeReply, 'size');
    check(Buffer.isBuffer(sizeParsed.data) && sizeParsed.data.length >= 8,
      'size CMIF reply lacks its exact value');
    const sizeValue = sizeParsed.data.readBigUInt64LE(0);
    check(sizeValue >= BigInt(READ_BYTES) && sizeValue < 1n << 39n,
      'IStorage size is outside bounded ordinary read');
    diagnostic.size.storageBytes = Number(sizeValue);
    const guards = addresses.map((_, index) =>
      Buffer.alloc(GUARD_BYTES, index === 0 ? 0x37 : 0xc8));
    try {
      for (let index = 0; index < addresses.length; index++) {
        const address = addresses[index];
        await native.write(address - GUARD_BYTES, guards[index]);
        await native.write(address, Buffer.alloc(READ_BYTES, POISONS[index]));
        await native.write(address + READ_BYTES, guards[index]);
      }
    } catch (cause) {throw uncertain(cause,
      'two guarded output buffers could not be staged');}
    const outputs = [];
    for (let index = 0; index < addresses.length; index++) {
      const address = addresses[index];
      const request = storageReadPacket(address);
      let reply;
      try {reply = await transport.sendPacket(storage.handle, request);}
      catch (cause) {throw uncertain(cause,
        `read ${index + 1} IPC outcome is unknown`);}
      const row = {index: index + 1, command: 0, handle: storage.handle,
        offset: 0, bytes: READ_BYTES, address, poison: POISONS[index],
        requestHex: request.toString('hex'), requestSha256: sha(request),
        replyHex: Buffer.isBuffer(reply) ? reply.toString('hex') : null,
        replySha256: Buffer.isBuffer(reply) ? sha(reply) : null,
        outputSha256: null, first64Hex: null, guardsIntact: false};
      diagnostic.reads.push(row);
      exactReply(reply, `read ${index + 1}`);
      let output, before, after;
      try {
        output = await native.read(address, READ_BYTES);
        before = await native.read(address - GUARD_BYTES, GUARD_BYTES);
        after = await native.read(address + READ_BYTES, GUARD_BYTES);
      } catch (cause) {throw uncertain(cause,
        `read ${index + 1} output readback is unknown`);}
      if (!Buffer.isBuffer(output) || output.length !== READ_BYTES ||
          !Buffer.isBuffer(before) || !Buffer.isBuffer(after) ||
          !before.equals(guards[index]) || !after.equals(guards[index]))
        throw uncertain(null, `read ${index + 1} output guard changed`);
      row.guardsIntact = true;
      row.outputSha256 = sha(output);
      row.first64Hex = output.subarray(0, 64).toString('hex');
      outputs.push(output);
      if (index === 0) {
        let untouched;
        try {untouched = await native.read(addresses[1], READ_BYTES);}
        catch (cause) {throw uncertain(cause,
          'second output pre-read state is unknown');}
        if (!Buffer.isBuffer(untouched) ||
            !untouched.equals(Buffer.alloc(READ_BYTES, POISONS[1])))
          throw uncertain(null, 'second output changed before its read');
      }
    }
    let firstAfterSecond;
    try {firstAfterSecond = await native.read(addresses[0], READ_BYTES);}
    catch (cause) {throw uncertain(cause, 'first output retention is unknown');}
    if (!Buffer.isBuffer(firstAfterSecond) ||
        !firstAfterSecond.equals(outputs[0]))
      throw uncertain(null, 'first output changed after the second read');
    const marker = content(preflight.markerNonce);
    const exactRepeat = outputs[0].equals(outputs[1]);
    const markerAbsent = outputs.every(bytes => bytes.indexOf(marker) === -1);
    const baselineMatch = diagnostic.size.storageBytes === expected.storageBytes &&
      exactRepeat &&
      outputs.every(bytes => sha(bytes) === expected.ordinaryContentSha256) &&
      markerAbsent &&
      outputs.every((bytes, index) =>
        !bytes.equals(Buffer.alloc(READ_BYTES, POISONS[index])));
    return {...diagnostic, outputGuardsIntact: true,
      firstOutputRetained: true, exactRepeatVerified: exactRepeat,
      markerBytesAbsentFromOrdinaryContent: markerAbsent,
      baselineMatched: baselineMatch,
      fsSideAliasVerified: false, fsSideMarkerReadbackVerified: false,
      markerHitVerified: false, fsStageVerified: false};
  } catch (error) {
    error.readerDiagnostic = diagnostic;
    throw error;
  }
}

async function closeEventPinnedStorage(prepared, storage) {
  check(storage?.closed === false &&
    prepared?.arenaNonce === storage.owner &&
    prepared.transport.ownedHandles.has(storage.handle),
  'same-owner adopted storage is missing or already closed');
  try {return await closeOwnedStorage(prepared, storage);}
  catch (cause) {throw uncertain(cause, 'adopted storage close outcome is unknown');}
}

module.exports = {validateOrdinaryBaseline, adoptEventPinStorage,
  readEventPinnedStorage, closeEventPinnedStorage};
