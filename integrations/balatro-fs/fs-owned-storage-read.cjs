'use strict';

// Serial, ordinary IStorage content baseline. This does not acquire FS memory.
const {createHash} = require('node:crypto');
const {packet, response} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {checkIdentity, checkPaths} = require('./fs-abort-control.cjs');
const {assessNoStorageControls} = require('./canary-geometry-plan.cjs');

const READ_BYTES = 0x10000;
const GUARD_BYTES = 64;
const OUTPUT_OFFSETS = Object.freeze([0x22000, 0x50000]);
const POISONS = Object.freeze([0xa5, 0x5a]);

function check(condition, reason) {
  if (!condition) throw Error(`Balatro owned storage read: ${reason}`);
}

function uncertain(cause, reason) {
  const error = Error(`Balatro owned storage read: ${reason}; retain resources`,
    {cause});
  error.resourceStateUncertain = true;
  return error;
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function storageReadPacket(address, bytes = READ_BYTES) {
  check(Number.isSafeInteger(address) && address > 0 &&
    address % 0x1000 === 0 && address + bytes < 2 ** 39 &&
    bytes === READ_BYTES,
  'receive descriptor needs one page-aligned 64 KiB app buffer');
  return packet(0, Buffer.concat([u64(0), u64(bytes)]),
    {receive: [{address, size: bytes, mode: 1}]});
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
    prepared.ownedHandlesOpen === true &&
    prepared.markerWrittenAndVerified === true &&
    prepared.borrowedSession === 'preserved' &&
    prepared.explicitSaveWrites === 1 &&
    prepared.root?.role === 'root' &&
    prepared.root.closed === false &&
    transport instanceof BalatroCloneTransport &&
    transport.evidence.sdkBase === preflight.sdkBase &&
    transport.scratch === Number(BigInt(preflight.arenaBase) + 0x10000n) &&
    transport.native.addresses?.scratch === transport.scratch &&
    transport.native.addresses?.sdk === Number(BigInt(preflight.sdkBase)) &&
    prepared.receiveAddress === transport.dataAddress &&
    prepared.pathAddress === transport.pathAddress &&
    transport.ownedHandles.has(prepared.clone?.handle) &&
    transport.ownedHandles.has(prepared.file?.handle),
  'fresh owned marker, root, or native transport changed');
  const first = transport.scratch + OUTPUT_OFFSETS[0];
  const second = transport.scratch + OUTPUT_OFFSETS[1];
  check(first === prepared.receiveAddress &&
    first - GUARD_BYTES > transport.scratch + 0x21000 &&
    first + READ_BYTES + GUARD_BYTES < transport.scratch + 0x40000 &&
    second - GUARD_BYTES > transport.scratch + 0x48080 &&
    second + READ_BYTES + GUARD_BYTES < transport.scratch + 0x80000,
  'serial output buffers overlap the native IPC workspace');
  return transport;
}

async function openOwnedStorage(prepared) {
  const transport = prepared.transport;
  let reply;
  try {reply = response(await transport.sendPacket(prepared.root.handle,
    packet(200)));}
  catch (cause) {throw uncertain(cause, 'content-storage open outcome is unknown');}
  check(reply.result === 0 && reply.copies.length === 0 &&
    reply.moves.length === 1,
  'content-storage open did not move one handle');
  const handle = reply.moves[0];
  check(Number.isInteger(handle) && handle > 0 &&
    handle < 0xffff8000 && handle !== prepared.root.handle &&
    handle !== prepared.clone.handle && handle !== prepared.file.handle &&
    handle !== transport.evidence.sessionManager.borrowedHandle &&
    !transport.ownedHandles.has(handle),
  'content-storage handle ownership is ambiguous');
  transport.ownedHandles.add(handle);
  return {handle, closed: false};
}

async function storageSize(prepared, storage) {
  check(storage?.closed === false &&
    prepared.transport.ownedHandles.has(storage.handle),
  'owned content-storage handle is absent');
  let reply;
  try {reply = await prepared.transport.sendOwned(storage.handle, packet(4));}
  catch (cause) {throw uncertain(cause, 'content-storage size outcome is unknown');}
  if (!Array.isArray(reply?.copies) || !Array.isArray(reply?.moves) ||
      reply.copies.length || reply.moves.length)
    throw uncertain(null, 'content-storage size transferred unexpected handles');
  check(reply.result === 0 && Buffer.isBuffer(reply.data) &&
    reply.data.length >= 8 &&
    reply.data.readBigUInt64LE(0) >= BigInt(READ_BYTES) &&
    reply.data.readBigUInt64LE(0) < 1n << 39n,
  'owned content storage is shorter than the bounded read');
  return Number(reply.data.readBigUInt64LE(0));
}

async function closeOwnedStorage(prepared, storage) {
  check(storage?.closed === false &&
    prepared?.transport?.ownedHandles?.has(storage.handle),
  'owned content storage is missing or already closed');
  try {
    const result = await prepared.transport.closeOwned(storage.handle);
    check(result?.closed === true, 'content-storage close did not verify');
    storage.closed = true;
    return {closed: true, handle: storage.handle};
  } catch (cause) {throw uncertain(cause, 'content-storage close outcome is unknown');}
}

async function readOrdinaryContent(prepared, storage) {
  const transport = prepared.transport;
  const native = transport.native;
  const addresses = OUTPUT_OFFSETS.map(offset => transport.scratch + offset);
  const guards = addresses.map((_, index) =>
    Buffer.alloc(GUARD_BYTES, index === 0 ? 0x37 : 0xc8));
  for (let index = 0; index < addresses.length; index++) {
    const address = addresses[index];
    await native.write(address - GUARD_BYTES, guards[index]);
    await native.write(address, Buffer.alloc(READ_BYTES, POISONS[index]));
    await native.write(address + READ_BYTES, guards[index]);
  }
  const outputs = [];
  const requests = [];
  for (let index = 0; index < addresses.length; index++) {
    const address = addresses[index];
    const request = storageReadPacket(address);
    requests.push(sha(request));
    let reply;
    try {reply = await transport.sendOwned(storage.handle,
      request);}
    catch (cause) {throw uncertain(cause,
      `content-storage read ${index + 1} outcome is unknown`);}
    if (!Array.isArray(reply?.copies) || !Array.isArray(reply?.moves) ||
        reply.copies.length || reply.moves.length)
      throw uncertain(null,
        `content-storage read ${index + 1} transferred unexpected handles`);
    check(reply.result === 0,
    `content-storage read ${index + 1} result changed`);
    const bytes = await native.read(address, READ_BYTES);
    check(Buffer.isBuffer(bytes) && bytes.length === READ_BYTES &&
      !bytes.equals(Buffer.alloc(READ_BYTES, POISONS[index])),
    `content-storage read ${index + 1} returned no exact bytes`);
    outputs.push(bytes);
    if (index === 0) {
      const untouched = await native.read(addresses[1], READ_BYTES);
      check(Buffer.isBuffer(untouched) &&
        untouched.equals(Buffer.alloc(READ_BYTES, POISONS[1])),
      'second output changed before its storage read');
    }
  }
  for (let index = 0; index < addresses.length; index++) {
    const address = addresses[index];
    const before = await native.read(address - GUARD_BYTES, GUARD_BYTES);
    const after = await native.read(address + READ_BYTES, GUARD_BYTES);
    check(Buffer.isBuffer(before) && before.equals(guards[index]) &&
      Buffer.isBuffer(after) && after.equals(guards[index]),
    `content-storage output ${index + 1} guard changed`);
  }
  const firstAfterSecond = await native.read(addresses[0], READ_BYTES);
  if (!Buffer.isBuffer(firstAfterSecond) ||
      !firstAfterSecond.equals(outputs[0]) ||
      !outputs[0].equals(outputs[1])) {
    const error = Error('Balatro owned storage read: two serial content-storage reads differed');
    error.diagnostic = {readSha256: outputs.map(sha),
      requestSha256: requests,
      first64Hex: outputs.map(bytes => bytes.subarray(0, 64).toString('hex'))};
    throw error;
  }
  const marker = content(prepared.markerNonce);
  check(outputs[0].indexOf(marker) === -1,
    'ordinary content contains the nonce marker; alias control is ambiguous');
  return {readBytes: READ_BYTES, offset: 0, addresses,
    poisons: [...POISONS], outputGuardsIntact: true,
    requestSha256: requests,
    ordinaryContentSha256: sha(outputs[0]),
    readSha256: outputs.map(sha), exactRepeatVerified: true,
    markerBytesAbsentFromOrdinaryContent: true};
}

function assessOwnedStorageRead({preflight, prepared, storage, size, readings,
  phases, pathBefore, pathAfter, changedPaths, saveAudit, cleanup}) {
  check(storage?.closed === true &&
    Number.isInteger(size) && size >= READ_BYTES && size < 2 ** 39 &&
    readings?.readBytes === READ_BYTES && readings.offset === 0 &&
    readings.outputGuardsIntact === true &&
    readings.exactRepeatVerified === true &&
    readings.markerBytesAbsentFromOrdinaryContent === true &&
    Array.isArray(readings.addresses) &&
    readings.addresses.length === 2 &&
    readings.addresses.every((address, index) =>
      address === prepared.transport.scratch + OUTPUT_OFFSETS[index]) &&
    Array.isArray(readings.poisons) &&
    readings.poisons.length === 2 &&
    readings.poisons.every((poison, index) => poison === POISONS[index]) &&
    Array.isArray(readings.requestSha256) &&
    readings.requestSha256.length === 2 &&
    readings.requestSha256.every((hash, index) =>
      hash === sha(storageReadPacket(readings.addresses[index]))) &&
    /^[0-9a-f]{64}$/.test(readings.ordinaryContentSha256 || '') &&
    Array.isArray(readings.readSha256) &&
    readings.readSha256.length === 2 &&
    readings.readSha256.every(hash =>
      hash === readings.ordinaryContentSha256) &&
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
  'exact ordinary content, full save audit, or cleanup is missing');
  checkPaths(pathBefore, preflight.markerNonce);
  checkPaths(pathAfter, preflight.markerNonce);
  assessNoStorageControls(phases);
  check(preflight?.gameProfile === profile.gameProfile &&
    prepared?.arenaNonce === preflight.arenaNonce &&
    prepared.markerNonce === preflight.markerNonce &&
    prepared.sdkBase === preflight.sdkBase,
  'completed read belongs to a different native owner');
  return {gameProfile: profile.gameProfile,
    arenaNonce: preflight.arenaNonce,
    markerNonce: preflight.markerNonce,
    storageHandle: storage.handle, storageHandleClosed: true,
    storageBytes: size, storageReadOffset: 0,
    storageReadBytes: READ_BYTES,
    outputAddresses: readings.addresses,
    outputPoisons: readings.poisons,
    requestSha256: readings.requestSha256,
    outputGuardsIntact: true,
    ordinaryContentSha256: readings.ordinaryContentSha256,
    readSha256: readings.readSha256,
    exactRepeatVerified: true,
    markerBytesAbsentFromOrdinaryContent: true,
    counterPhases: phases,
    pathBefore, pathAfter, saveTreeAudit: saveAudit, changedPaths,
    preparationMarkerSaveWrites: 1, serialReadSaveWrites: 0,
    counterBaselineRestored: true, completeSaveAuditVerified: true,
    cleanup: 'verified', ...markerCleanupSummary(cleanup),
    exactAllocationBytes: null, pinAddress: null,
    fsSideAliasVerified: false, fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false,
    status: 'ordinary owned content-storage read control; FS-side alias and 2/4 unverified'};
}

async function runOwnedStorageRead({preflight, adapter,
  onPhase = () => {}}) {
  check(adapter && ['inspect', 'prepare', 'readPaths', 'counterPair',
    'auditPaths', 'auditDetails', 'cleanup'].every(name =>
      typeof adapter[name] === 'function') &&
    typeof onPhase === 'function',
  'same-owner adapter and phase callback are required');
  checkIdentity(await adapter.inspect(), preflight);
  let prepared, storage, size, readings, phases;
  let pathBefore, pathAfter, changedPaths, saveAudit;
  let storageOpenAttempted = false;
  let storageCloseAttempted = false;
  let ownedCleanupAttempted = false;
  let ownedCleanupVerified = false;
  let ownedCleanupResult;
  let failure;
  let resourceStateUncertain = false;
  const diagnostic = error => {
    error.diagnostic = {
      ...(error.diagnostic && typeof error.diagnostic === 'object' ?
        error.diagnostic : {}),
      arenaNonce: preflight.arenaNonce,
      storageOpenAttempted,
      storageHandle: storage?.handle ?? null,
      storageCloseAttempted,
      storageHandleClosed: storage?.closed === true,
      storageSize: size ?? null,
      readings: readings ?? null,
      counterPhases: phases ?? null,
      pathBefore: pathBefore ?? null, pathAfter: pathAfter ?? null,
      saveTreeAudit: saveAudit ?? null,
      changedPaths: changedPaths ?? null,
      ownedCleanupAttempted, ownedCleanupVerified,
      ownedCleanupResult: ownedCleanupResult ?? null,
      resourceStateUncertain,
      fsSideAliasVerified: false,
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
    checkPrepared(preflight, prepared);
    pathBefore = await adapter.readPaths(prepared);
    checkPaths(pathBefore, preflight.markerNonce);
    phases = {before: await counterPair('storage-before'),
      noStorageBefore: await counterPair('storage-no-storage-before')};
    onPhase('open-owned-content-storage');
    storageOpenAttempted = true;
    storage = await openOwnedStorage(prepared);
    size = await storageSize(prepared, storage);
    onPhase('read-two-poisoned-ordinary-content-buffers');
    readings = await readOrdinaryContent(prepared, storage);
    storageCloseAttempted = true;
    await closeOwnedStorage(prepared, storage);
    phases.after = await counterPair('storage-after');
    phases.noStorageAfter = await counterPair('storage-no-storage-after');
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
    'complete cloned save audit did not verify');
  } catch (error) {
    failure = error;
    resourceStateUncertain = error?.resourceStateUncertain === true ||
      storageOpenAttempted && !storage ||
      storageCloseAttempted && storage?.closed !== true;
  }
  if (prepared && !resourceStateUncertain) {
    try {
      if (storage && !storage.closed) {
        storageCloseAttempted = true;
        await closeOwnedStorage(prepared, storage);
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
          'storage read and cleanup failed') : cause,
      'final owned cleanup outcome is unknown'));
    }
  }
  if (failure) {
    if (resourceStateUncertain) throw diagnostic(uncertain(failure,
      'storage read or owned handle state is unknown'));
    throw diagnostic(failure);
  }
  try {
    check(prepared && storage?.closed === true && ownedCleanupVerified,
      'serial owned storage lease did not finish');
    return assessOwnedStorageRead({preflight, prepared, storage, size,
      readings, phases, pathBefore, pathAfter, changedPaths, saveAudit,
      cleanup: ownedCleanupResult});
  } catch (error) {throw diagnostic(error);}
}

module.exports = {READ_BYTES, GUARD_BYTES, OUTPUT_OFFSETS, POISONS,
  storageReadPacket, openOwnedStorage, storageSize, closeOwnedStorage,
  readOrdinaryContent, assessOwnedStorageRead, runOwnedStorageRead};
