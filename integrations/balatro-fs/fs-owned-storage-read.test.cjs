'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {requestCommand} = require('./fs-abort-frames.cjs');
const {READ_BYTES, OUTPUT_OFFSETS, storageReadPacket,
  runOwnedStorageRead} = require('./fs-owned-storage-read.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const ordinary = Buffer.alloc(READ_BYTES);
for (let index = 0; index < ordinary.length; index++) ordinary[index] = index % 251;

function validEvidence() {
  const manager = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
  return {gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    nonce: arenaNonce, sdkBase: `0x${sdk.toString(16)}`,
    mount: {name: 'save', accessor: '0x49646472a0',
      implementation: '0x4964689680', service: '0x49646896a0',
      serviceVtable: `0x${(sdk + 0xcec000).toString(16)}`,
      serviceVtableOffset: '0xcec000', manager: `0x${manager.toString(16)}`,
      objectId: 412},
    proxy: {object: `0x${(sdk + Number(BigInt(captured.fsProxy.objectSdkOffset))).toString(16)}`,
      manager: `0x${manager.toString(16)}`, objectId: 153},
    sessionManager: {stateSize: 2048, stateValue: 3,
      slot: '0x4964a0a000', borrowedHandle: 118},
    absentPathResult: '0x00000202',
    status: 'read-only; mounted domain not cloned'};
}

function cmif(result, move, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(move ? 0x80000004 : 4, 4);
  if (move) {
    bytes.writeUInt32LE(1 << 5, 8);
    bytes.writeUInt32LE(move, 12);
  }
  bytes.write('SFCO', 16);
  bytes.writeUInt32LE(result, 24);
  data.copy(bytes, 32);
  return bytes;
}

function paths() {
  const marker = {result: 0, type: 1, bytes: content(markerNonce)};
  const absent = {result: 0x202, type: null, bytes: null};
  return {original: {marker, absent}, cloned: {marker, absent},
    padded: {marker, absent}, explicitSaveWrites: 0};
}

function audit() {
  return {coverage: 'bounded-cloned-save-tree',
    completeSaveTreeVerified: true, logPrefixVerified: true,
    logState: 'append-only', changed: []};
}

function fixture({differentSecond = false, failOpen = false,
  moveOnRead = false} = {}) {
  const scratch = arena + 0x10000;
  const memory = Buffer.alloc(0x80000);
  const events = [];
  const native = {addresses: {sdk, scratch},
    async write(address, bytes) {
      assert.ok(address >= scratch && address + bytes.length <= scratch + memory.length);
      bytes.copy(memory, address - scratch);
    },
    async read(address, length) {
      assert.ok(address >= scratch && address + length <= scratch + memory.length);
      return Buffer.from(memory.subarray(address - scratch,
        address - scratch + length));
    },
    callAddress() {}, callAddress6() {}, exchange() {}, verifyFunction() {}};
  const transport = new BalatroCloneTransport({native,
    evidence: validEvidence(), inspectLive() {}});
  transport.ownedHandles.add(311);
  transport.ownedHandles.add(312);
  const preflight = {gameProfile: profile.gameProfile,
    arenaBase: `0x${arena.toString(16)}`,
    sdkBase: `0x${sdk.toString(16)}`, arenaNonce, markerNonce,
    exactAllocationBytes: null, markerHitVerified: false,
    fsStageVerified: false};
  const prepared = {arenaNonce, markerNonce, sdkBase: preflight.sdkBase,
    ownedHandlesOpen: true, markerWrittenAndVerified: true,
    borrowedSession: 'preserved', explicitSaveWrites: 1,
    root: {handle: 321, role: 'root', closed: false},
    clone: {handle: 311}, file: {handle: 312}, transport,
    pathAddress: transport.pathAddress,
    receiveAddress: transport.dataAddress};
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(0x120000n);
  let readCount = 0;
  let cleanupCount = 0;
  let closeCount = 0;
  transport.sendPacket = async (handle, bytes) => {
    events.push(`open:${handle}:${requestCommand(bytes)}`);
    assert.equal(handle, 321);
    assert.equal(requestCommand(bytes), 200);
    if (failOpen) throw Error('unknown transport');
    return cmif(0, 450);
  };
  transport.sendOwned = async (handle, bytes) => {
    assert.equal(handle, 450);
    assert.equal(transport.ownedHandles.has(handle), true);
    const command = requestCommand(bytes);
    events.push(`storage:${command}`);
    if (command === 4) return {result: 0, copies: [], moves: [], data: size};
    assert.equal(command, 0);
    if (moveOnRead) return {result: 0, copies: [], moves: [451],
      data: Buffer.alloc(0)};
    assert.equal(bytes.readBigUInt64LE(48), 0n);
    assert.equal(bytes.readBigUInt64LE(56), BigInt(READ_BYTES));
    const address = scratch + OUTPUT_OFFSETS[readCount];
    assert.equal(bytes.readUInt32LE(12), address >>> 0);
    const output = Buffer.from(ordinary);
    if (differentSecond && readCount === 1) output[100] ^= 0x55;
    output.copy(memory, address - scratch);
    readCount++;
    return {result: 0, copies: [], moves: [], data: Buffer.alloc(0)};
  };
  transport.closeOwned = async handle => {
    assert.equal(handle, 450);
    assert.equal(transport.ownedHandles.delete(handle), true);
    events.push(`close:${handle}`);
    closeCount++;
    return {closed: true};
  };
  const sample = Array(16).fill(0);
  sample[5] = 100000;
  const adapter = {
    async inspect() {return {state: 'serving',
      gameProfile: profile.gameProfile,
      runtimeVersion: profile.runtimeVersion,
      codeHeadProfile: '1.0.1f', sdkBase: preflight.sdkBase,
      arenaBase: preflight.arenaBase, arenaNonce,
      ownerState: 'ready', workers: 0, ownedHandles: 0};},
    async prepare(input) {assert.equal(input, preflight); return prepared;},
    async readPaths(input) {assert.equal(input, prepared); return paths();},
    async counterPair() {return {samples: [sample.slice(), sample.slice()]};},
    async auditPaths(input) {assert.equal(input, prepared); return [];},
    auditDetails() {return audit();},
    async cleanup(input) {
      assert.equal(input, prepared);
      assert.equal(transport.ownedHandles.has(450), false);
      cleanupCount++;
      events.push('cleanup');
      prepared.root.closed = true;
      transport.ownedHandles.delete(311);
      transport.ownedHandles.delete(312);
      return {ownedHandlesClosed: true, markerNeutralized: true,
        markerRemoved: false,
        borrowedSession: 'preserved', arena: 'released'};
    },
  };
  return {preflight, adapter, events,
    counts: () => ({reads: readCount, closes: closeCount,
      cleanups: cleanupCount})};
}

test('storage cmd0 uses two exact u64s and a 64 KiB receive descriptor', () => {
  const address = arena + 0x10000 + OUTPUT_OFFSETS[0];
  const bytes = storageReadPacket(address);
  assert.equal(bytes.length, 256);
  assert.equal(requestCommand(bytes), 0);
  assert.equal(bytes.readBigUInt64LE(48), 0n);
  assert.equal(bytes.readBigUInt64LE(56), BigInt(READ_BYTES));
  assert.equal(bytes.readUInt32LE(12), address >>> 0);
  assert.throws(() => storageReadPacket(address + 1), /page-aligned/);
});

test('two poisoned owned-storage reads produce one ordinary content baseline and clean once', async () => {
  const value = fixture();
  const result = await runOwnedStorageRead(value);
  const expectedHash = createHash('sha256').update(ordinary).digest('hex');
  assert.equal(result.ordinaryContentSha256, expectedHash);
  assert.deepEqual(result.readSha256, [expectedHash, expectedHash]);
  assert.deepEqual(result.outputPoisons, [0xa5, 0x5a]);
  assert.equal(result.outputGuardsIntact, true);
  assert.equal(result.markerBytesAbsentFromOrdinaryContent, true);
  assert.equal(result.completeSaveAuditVerified, true);
  assert.equal(result.counterBaselineRestored, true);
  assert.equal(result.markerNeutralized, true);
  assert.equal(result.markerRemoved, false);
  assert.equal(result.storageHandleClosed, true);
  assert.equal(result.fsSideAliasVerified, false);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
  assert.deepEqual(value.counts(), {reads: 2, closes: 1, cleanups: 1});
  assert.ok(value.events.indexOf('close:450') < value.events.indexOf('cleanup'));
});

test('changed ordinary content rejects and still closes exact storage and owner', async () => {
  const value = fixture({differentSecond: true});
  await assert.rejects(runOwnedStorageRead(value), error => {
    assert.match(error.message, /serial content-storage reads differed/);
    assert.equal(error.diagnostic.storageHandleClosed, true);
    assert.equal(error.diagnostic.ownedCleanupVerified, true);
    assert.equal(error.diagnostic.markerHitVerified, false);
    return true;
  });
  assert.deepEqual(value.counts(), {reads: 2, closes: 1, cleanups: 1});
});

test('unknown content-storage open outcome retains owner and never retries', async () => {
  const value = fixture({failOpen: true});
  await assert.rejects(runOwnedStorageRead(value), error => {
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.storageOpenAttempted, true);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    assert.equal(error.diagnostic.fsSideAliasVerified, false);
    return true;
  });
  assert.deepEqual(value.counts(), {reads: 0, closes: 0, cleanups: 0});
  assert.equal(value.events.filter(row => row.startsWith('open:')).length, 1);
});

test('unexpected transferred read handle retains owner for exact recovery', async () => {
  const value = fixture({moveOnRead: true});
  await assert.rejects(runOwnedStorageRead(value), error => {
    assert.equal(error.resourceStateUncertain, true);
    assert.match(error.message, /storage read or owned handle state is unknown/);
    assert.equal(error.diagnostic.storageHandleClosed, false);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    return true;
  });
  assert.deepEqual(value.counts(), {reads: 0, closes: 0, cleanups: 0});
});
