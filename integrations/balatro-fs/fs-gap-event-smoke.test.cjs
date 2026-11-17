'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {FRAME_BASE_OFFSET} = require('./fs-gap-port-layout.cjs');
const {RESULT_OFFSETS} = require('./fs-gap-event-frame.cjs');
const {PACKET_OFFSET} = require('./fs-counter-overlap.cjs');
const {runGapEventSmoke} = require('./fs-gap-event-smoke.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'aabbccddeeff0011';
const frame = arena + FRAME_BASE_OFFSET + 12 * 0x4000;

function evidence() {
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

function paths() {
  const marker = {result: 0, type: 1, bytes: content(markerNonce)};
  const absent = {result: 0x202, type: null, bytes: null};
  return {original: {marker, absent}, cloned: {marker, absent},
    padded: {marker, absent}, explicitSaveWrites: 0};
}

function fixture({workerError = false, movedReply = false} = {}) {
  const memory = Buffer.alloc(0x200000);
  const scratch = arena + 0x10000;
  const native = {addresses: {sdk, scratch},
    async write(address, bytes) {
      assert.ok(address >= arena &&
        address + bytes.length <= arena + memory.length);
      bytes.copy(memory, address - arena);
    },
    async read(address, length) {
      assert.ok(address >= arena &&
        address + length <= arena + memory.length);
      return Buffer.from(memory.subarray(address - arena,
        address - arena + length));
    },
    callAddress() {}, callAddress6() {}, exchange() {}, verifyFunction() {}};
  const transport = new BalatroCloneTransport({native,
    evidence: evidence(), inspectLive() {}});
  transport.ownedHandles.add(311);
  transport.ownedHandles.add(312);
  const preflight = {gameProfile: profile.gameProfile,
    arenaBase: `0x${arena.toString(16)}`,
    sdkBase: `0x${sdk.toString(16)}`,
    arenaNonce, markerNonce, exactAllocationBytes: null,
    markerHitVerified: false, fsStageVerified: false};
  const prepared = {arenaNonce, markerNonce, sdkBase: preflight.sdkBase,
    markerWrittenAndVerified: true, borrowedSession: 'preserved',
    ownedHandlesOpen: true, explicitSaveWrites: 1,
    root: {role: 'root', handle: 321, closed: false},
    clone: {handle: 311}, file: {handle: 312}, transport,
    context: {arena: BigInt(arena), sdk: BigInt(sdk),
      scratch: BigInt(scratch), nonce: arenaNonce},
    pathAddress: transport.pathAddress,
    receiveAddress: transport.dataAddress};
  const sample = Array(16).fill(0);
  sample[5] = 100000;
  let cleanupCount = 0;
  let workerCallCount = 0;
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
    auditDetails() {return {coverage: 'bounded-cloned-save-tree',
      completeSaveTreeVerified: true, logPrefixVerified: true,
      logState: 'append-only', changed: []};},
    async cleanup(input) {
      assert.equal(input, prepared);
      cleanupCount++;
      return {ownedHandlesClosed: true, markerNeutralized: true,
        markerRemoved: false,
        borrowedSession: 'preserved', arena: 'released'};
    },
  };
  const executeSource = async ({source}) => {
    workerCallCount++;
    assert.match(source, /WaitLightEvent|frame-call/);
    if (workerError) throw Error('unknown REPL response');
    memory.writeBigUInt64LE(100n, frame - arena + RESULT_OFFSETS.startTick);
    memory.writeBigUInt64LE(0n, frame - arena + RESULT_OFFSETS.transportResult);
    memory.writeBigUInt64LE(200n, frame - arena + RESULT_OFFSETS.endTick);
    const packet = Buffer.alloc(256);
    packet.writeUInt32LE(4);
    packet.writeUInt32LE(movedReply ? 0x80000004 : 4, 4);
    if (movedReply) {
      packet.writeUInt32LE(1 << 5, 8);
      packet.writeUInt32LE(500, 12);
    }
    packet.write('SFCO', 16);
    packet.writeUInt32LE(0, 24);
    for (let i = 0; i < sample.length; i++) {
      packet.writeBigUInt64LE(BigInt(sample[i]), 32 + i * 8);
    }
    packet.copy(memory, frame - arena + PACKET_OFFSET);
    return `-> BAL_GAP_EVENT_WORKER_V1\tfs-gap-event-worker\tok\t${arenaNonce}\t${waveId}\t${preflight.arenaBase}\t${preflight.sdkBase}\tevent-smoke\tjoined-closed\t1\t0000000000000001,0000000000000064,00000000000000c8,0\tevent-finalized\tarena-retained\n`;
  };
  return {preflight, adapter, executeSource,
    counts: () => ({cleanupCount, workerCallCount})};
}

test('one owned event-gated request retains raw counters and cleans once', async () => {
  const data = fixture();
  const result = await runGapEventSmoke({...data, host: '10.0.0.189',
    macIp: '10.0.0.205', port: 39381,
    mainBase: '0x5a00000000', waveId});
  assert.equal(result.nativeEventLifecycleVerified, true);
  assert.equal(result.eventGate, 'initialized-signaled-finalized');
  assert.equal(result.counterReply.counterCount, 16);
  assert.equal(result.counterReply.nativeCounterRow[5], 100000);
  assert.equal(result.completeSaveAuditVerified, true);
  assert.equal(result.cleanup, 'verified');
  assert.equal(result.markerNeutralized, true);
  assert.equal(result.markerRemoved, false);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
  assert.deepEqual(data.counts(), {cleanupCount: 1, workerCallCount: 1});
});

test('unknown worker reply retains exact owner without retry', async () => {
  const data = fixture({workerError: true});
  await assert.rejects(runGapEventSmoke({...data, host: '10.0.0.189',
    macIp: '10.0.0.205', port: 39381,
    mainBase: '0x5a00000000', waveId}), error => {
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.workerRequestSent, true);
    assert.equal(error.diagnostic.workerReleased, false);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    return true;
  });
  assert.deepEqual(data.counts(), {cleanupCount: 0, workerCallCount: 1});
});

test('unexpected transferred counter handle retains owner for inspection', async () => {
  const data = fixture({movedReply: true});
  await assert.rejects(runGapEventSmoke({...data, host: '10.0.0.189',
    macIp: '10.0.0.205', port: 39381,
    mainBase: '0x5a00000000', waveId}), error => {
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.workerReleased, true);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    return true;
  });
  assert.deepEqual(data.counts(), {cleanupCount: 0, workerCallCount: 1});
});
