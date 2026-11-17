const crypto = require('node:crypto');
const domain = require('../civswitch/fs-kit/port/engine/shared/domain.cjs');
const {pathPacket} = require('./clone-transport.cjs');
const {matchingBoot, validateEvidence} = require('./clone-control.cjs');
const {inspectSessionPool} = require('./session-pool.cjs');

const MANAGER_BYTES = 0x800;
const SLOT_BYTES = 0x800;
const PATH_BYTES = 0x304;

function absentPath(nonce) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '')) {
    throw new TypeError('Balatro borrowed-domain path needs a fresh owner nonce');
  }
  return `/bal-domain-${nonce}.bin`;
}

function domainAbsentPacket(objectId, address) {
  if (!Number.isInteger(objectId) || objectId < 1 || objectId > 65535 ||
      !Number.isSafeInteger(address) || address < 4096 || address >= 2 ** 39) {
    throw new TypeError('Balatro borrowed-domain packet needs a pinned object and path address');
  }
  const descriptor = pathPacket(7, Buffer.alloc(0), address).subarray(8, 16);
  const bytes = domain.domain(objectId, 7);
  bytes.writeUInt32LE(4 | 1 << 16);
  descriptor.copy(bytes, 8);
  if (bytes.readUInt32LE() !== 0x10004 ||
      bytes.readUInt32LE(20) !== objectId ||
      bytes.toString('ascii', 32, 36) !== 'SFCI' ||
      bytes.readUInt32LE(40) !== 7) {
    throw Error('Balatro domain path packet differs from the pinned CMIF layout');
  }
  return bytes;
}

function pathBuffer(nonce) {
  const value = absentPath(nonce);
  const bytes = Buffer.alloc(PATH_BYTES);
  bytes.write(value, 'utf8');
  return bytes;
}

function hex(value) {return `0x${value.toString(16)}`;}

async function managerSnapshot(native, evidence) {
  validateEvidence(evidence);
  if (!native || typeof native.read !== 'function') {
    throw new TypeError('Balatro manager snapshot needs native read access');
  }
  const managerAddress = Number(BigInt(evidence.mount.manager));
  const manager = await native.read(managerAddress, MANAGER_BYTES);
  if (!Buffer.isBuffer(manager) || manager.length !== MANAGER_BYTES ||
      manager.readUInt32LE(8) !== evidence.sessionManager.stateSize ||
      manager.readUInt32LE(92) !== evidence.sessionManager.stateValue) {
    throw Error('Balatro manager state changed or was not read completely');
  }
  const slotAddress = Number(manager.readBigUInt64LE(16));
  if (!Number.isSafeInteger(slotAddress) || slotAddress < 4096 ||
      slotAddress >= 2 ** 39 || hex(slotAddress) !== evidence.sessionManager.slot) {
    throw Error('Balatro manager slot pointer changed');
  }
  const slots = await native.read(slotAddress, SLOT_BYTES);
  if (!Buffer.isBuffer(slots) || slots.length !== SLOT_BYTES) {
    throw Error('Balatro session pool was not read completely');
  }
  const pool = inspectSessionPool(manager, slots, managerAddress);
  if (pool.nextBorrowable.address !== evidence.sessionManager.selectedNode ||
      pool.nextBorrowable.handle !== evidence.sessionManager.borrowedHandle ||
      pool.idleCount !== evidence.sessionManager.idleCount) {
    throw Error('Balatro selected idle session changed');
  }
  return {manager, slots, managerAddress, slotAddress,
    borrowedHandle: pool.nextBorrowable.handle, selectedNode: pool.nextBorrowable.address,
    idleCount: pool.idleCount};
}

function snapshotSummary(snapshot) {
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  return {managerAddress: hex(snapshot.managerAddress),
    slotAddress: hex(snapshot.slotAddress), borrowedHandle: snapshot.borrowedHandle,
    selectedNode: snapshot.selectedNode, idleCount: snapshot.idleCount,
    managerSha256: hash(snapshot.manager), slotTableSha256: hash(snapshot.slots)};
}

function requireUnchanged(before, after, phase) {
  if (!before.manager.equals(after.manager) || !before.slots.equals(after.slots)) {
    const changedOffset = (a, b) => a.findIndex((byte, index) => byte !== b[index]);
    const error = Error(`Balatro manager or borrowed slots changed ${phase}`);
    error.managerChangeOffset = changedOffset(before.manager, after.manager);
    error.slotChangeOffset = changedOffset(before.slots, after.slots);
    throw error;
  }
}

function parseAbsentReply(bytes, evidence) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 256) {
    throw Error('Balatro borrowed-domain reply was not complete');
  }
  const parsed = domain.response(bytes, {domain: true, dataSize: 4});
  const expected = Number.parseInt(evidence.absentPathResult, 16);
  if (parsed.result !== expected || parsed.moves.length ||
      parsed.copies.length || parsed.objects.length) {
    throw Error('Balatro borrowed-domain absent-path result or handle ownership changed');
  }
  return {result: parsed.result, movedHandles: 0, copiedHandles: 0,
    domainObjects: 0};
}

async function runBorrowedDomainDiscriminator({evidence, transport, inspectDomain,
  onPhase = () => {}}) {
  validateEvidence(evidence);
  if (!transport || !transport.native ||
      typeof transport.native.write !== 'function' ||
      typeof transport.sendPacket !== 'function' ||
      typeof inspectDomain !== 'function' || typeof onPhase !== 'function' ||
      !(transport.ownedHandles instanceof Set) || transport.ownedHandles.size) {
    throw new TypeError('Balatro borrowed-domain test needs an idle, handle-free native transport');
  }
  const path = absentPath(evidence.nonce);
  const before = await managerSnapshot(transport.native, evidence);
  onPhase('verify direct SDK absent path and full manager table before IPC');
  matchingBoot(evidence, await inspectDomain());
  const afterDirect = await managerSnapshot(transport.native, evidence);
  requireUnchanged(before, afterDirect, 'during the direct SDK control');

  const packet = domainAbsentPacket(evidence.mount.objectId, transport.pathAddress);
  await transport.native.write(transport.pathAddress, pathBuffer(evidence.nonce));
  onPhase('send one borrowed-domain GetEntryType request');
  let reply;
  let sendError;
  try {
    reply = await transport.sendPacket(evidence.sessionManager.borrowedHandle, packet);
  } catch (error) {sendError = error;}

  let after;
  let postError;
  try {
    after = await managerSnapshot(transport.native, evidence);
    requireUnchanged(afterDirect, after, 'after the one borrowed-domain send');
    matchingBoot(evidence, await inspectDomain());
  } catch (error) {postError = error;}
  const result = reply ? parseAbsentReply(reply, evidence) : null;
  if (sendError || postError) {
    const errors = [sendError, postError].filter(Boolean);
    const error = new AggregateError(errors,
      'Balatro borrowed-domain one-send discriminator did not verify');
    error.diagnostic = {sendAttempted: true,
      before: snapshotSummary(before), afterDirect: snapshotSummary(afterDirect),
      after: after && snapshotSummary(after), rawReply: result};
    throw error;
  }
  if (transport.ownedHandles.size) {
    throw Error('Balatro borrowed-domain request unexpectedly acquired an owned handle');
  }
  return {path, command: 7, objectId: evidence.mount.objectId,
    borrowedHandle: evidence.sessionManager.borrowedHandle,
    sendCount: 1, ...result, before: snapshotSummary(before),
    afterDirect: snapshotSummary(afterDirect), after: snapshotSummary(after),
    explicitSaveWrites: 0, domainClones: 0, markerWrites: 0,
    status: 'borrowed-domain absent-path IPC diagnostic only; FS marker and 2/4 unverified'};
}

module.exports = {MANAGER_BYTES, SLOT_BYTES, PATH_BYTES, absentPath,
  domainAbsentPacket, pathBuffer, managerSnapshot, snapshotSummary,
  requireUnchanged, parseAbsentReply, runBorrowedDomainDiscriminator};
