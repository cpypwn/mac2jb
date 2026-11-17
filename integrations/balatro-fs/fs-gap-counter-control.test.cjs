'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {packet} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {createQualifiedContext, claimOpenedService} =
  require('./fs-counter-probe.cjs');
const {ROLES, FRAME_BASE_OFFSET} = require('./fs-gap-port-layout.cjs');
const {RESULT_OFFSETS} = require('./fs-gap-event-frame.cjs');
const {PACKET_OFFSET} = require('./fs-counter-overlap.cjs');
const {STACK_OFFSET, CALL_STRIDE} = require('./worker-chain.cjs');
const {runGapCounterControl} =
  require('./fs-gap-counter-control.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'aabbccddeeff0011';
const scratch = arena + 0x10000;

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

function cmif(result = 0, moved = null, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(moved ? 0x80000004 : 4, 4);
  if (moved) {
    bytes.writeUInt32LE(1 << 5, 8);
    bytes.writeUInt32LE(moved, 12);
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

function fixture({failOpenAt = 0, failCloseHandle = 0,
  movedRole = -1, workerError = false} = {}) {
  const memory = Buffer.alloc(0x200000);
  const events = [];
  const stagedFrames = [];
  let opened = 0;
  let cleaned = 0;
  let workerCalls = 0;
  const native = {addresses: {sdk, scratch},
    async write(address, bytes) {
      assert.ok(address >= arena &&
        address + bytes.length <= arena + memory.length);
      if (address >= arena + FRAME_BASE_OFFSET) {
        assert.equal(opened, 12);
        assert.equal(bytes.length, 0x3000);
        assert.deepEqual(bytes.subarray(PACKET_OFFSET,
          PACKET_OFFSET + 256), packet(1009));
        stagedFrames.push({address,
          handle: Number(bytes.readBigUInt64LE(
            STACK_OFFSET + 0x30 + 2 * CALL_STRIDE + 0xf0))});
      }
      bytes.copy(memory, address - arena);
    },
    async read(address, length) {
      assert.ok(address >= arena &&
        address + length <= arena + memory.length);
      return Buffer.from(memory.subarray(address - arena,
        address - arena + length));
    },
    async verifyFunction() {},
    async call(offset, ...args) {
      if (offset === profile.symbols['nn::sm::GetServiceHandle'].offset) {
        opened++;
        const handle = 321 + opened;
        memory.writeUInt32LE(handle, args[0] - arena);
        events.push(`open:${handle}`);
        return {result: 0n};
      }
      assert.equal(offset, profile.symbols.svcCloseHandle.offset);
      const handle = args[0];
      events.push(`close-attempt:${handle}`);
      if (handle === failCloseHandle) throw Error('unknown native close');
      events.push(`closed:${handle}`);
      return {result: 0n};
    },
    callAddress() {}, callAddress6() {}, exchange() {}};
  const transport = new BalatroCloneTransport({native,
    evidence: evidence(), inspectLive() {}});
  transport.ownedHandles.add(311);
  transport.ownedHandles.add(312);
  transport.sendPacket = async (handle, bytes) => {
    assert.equal(bytes.length, 256);
    events.push(`initialize:${handle}`);
    if (handle === 321 + failOpenAt) throw Error('unknown initialization');
    return cmif();
  };
  transport.closeRawOwned = async handle => {
    assert.equal(transport.rawOwnedHandles.has(handle), true);
    events.push(`close-attempt:${handle}`);
    if (handle === failCloseHandle) throw Error('unknown native close');
    transport.rawOwnedHandles.delete(handle);
    events.push(`closed:${handle}`);
    return {closed: true, closeResult: 0, method: 'worker-svcCloseHandle'};
  };
  const hello = {status: 'read-only transport handshake verified',
    scratch: `0x${scratch.toString(16)}`,
    sdkBase: `0x${sdk.toString(16)}`,
    scratchBytes: 0x80000,
    sdkCrc32: Number.parseInt(profile.sdkCode.offlineCrc32, 16)};
  const crc = {gameProfile: profile.gameProfile, nonce: arenaNonce,
    port: 39381, sdkBase: hello.sdkBase,
    sdkCrc32: profile.sdkCode.offlineCrc32};
  const context = createQualifiedContext({arenaBase: `0x${arena.toString(16)}`,
    hello, crc, nonce: arenaNonce, port: 39381});
  const preflight = {gameProfile: profile.gameProfile,
    arenaBase: `0x${arena.toString(16)}`,
    sdkBase: hello.sdkBase, arenaNonce, markerNonce,
    exactAllocationBytes: null, markerHitVerified: false,
    fsStageVerified: false};
  const root = claimOpenedService(context, 0n, 321);
  const prepared = {arenaNonce, markerNonce, sdkBase: preflight.sdkBase,
    markerWrittenAndVerified: true,
    borrowedSession: 'preserved', ownedHandlesOpen: true,
    explicitSaveWrites: 1, root,
    clone: {handle: 311}, file: {handle: 312}, transport,
    context, pathAddress: transport.pathAddress,
    receiveAddress: transport.dataAddress};
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
    auditDetails() {return {coverage: 'bounded-cloned-save-tree',
      completeSaveTreeVerified: true, logPrefixVerified: true,
      logState: 'append-only', changed: []};},
    async cleanup(input) {
      assert.equal(input, prepared);
      assert.equal(events.filter(row => row.startsWith('closed:')).length, 12);
      cleaned++;
      events.push('cleanup');
      root.closed = true;
      return {ownedHandlesClosed: true, markerNeutralized: true,
        markerRemoved: false,
        borrowedSession: 'preserved', arena: 'released'};
    },
  };
  const executeSource = async ({source}) => {
    workerCalls++;
    assert.ok(Buffer.byteLength(source) <= 32768);
    assert.match(source, /gap-counter-control/);
    if (workerError) throw Error('unknown REPL response');
    const rows = [];
    for (let index = 0; index < ROLES.length; index++) {
      const frame = arena + FRAME_BASE_OFFSET + index * 0x4000;
      const start = BigInt(100 + index * 10);
      const end = BigInt(200 + index * 10);
      memory.writeBigUInt64LE(start,
        frame - arena + RESULT_OFFSETS.startTick);
      memory.writeBigUInt64LE(0n,
        frame - arena + RESULT_OFFSETS.transportResult);
      memory.writeBigUInt64LE(end,
        frame - arena + RESULT_OFFSETS.endTick);
      const data = Buffer.alloc(16 * 8);
      for (let i = 0; i < 16; i++) {
        data.writeBigUInt64LE(BigInt(sample[i]), i * 8);
      }
      cmif(0, index === movedRole ? 500 : null, data).copy(memory,
        frame - arena + PACKET_OFFSET);
      rows.push(`${(index + 1).toString(16).padStart(16, '0')},${start.toString(16).padStart(16, '0')},${end.toString(16).padStart(16, '0')},0`);
    }
    return `-> BAL_GAP_EVENT_WORKER_V1\tfs-gap-event-worker\tok\t${arenaNonce}\t${waveId}\t${preflight.arenaBase}\t${preflight.sdkBase}\tgap-counter-control\tjoined-closed\t13\t${rows.join(';')}\tevent-finalized\tarena-retained\n`;
  };
  return {preflight, adapter, executeSource, events, stagedFrames,
    counts: () => ({opened, cleaned, workerCalls})};
}

const args = {host: '10.0.0.189', macIp: '10.0.0.205',
  port: 39381, mainBase: '0x5a00000000', waveId};

test('thirteen distinct counter-only role slots close roots before owner once', async () => {
  const data = fixture();
  const result = await runGapCounterControl({...data, ...args});
  assert.equal(result.nativeThirteenWorkerControlVerified, true);
  assert.equal(result.roleSemantics, 'counter-only-slots');
  assert.equal(result.counterReplies.length, 13);
  assert.deepEqual(result.counterReplies.map(row => row.role), ROLES);
  assert.equal(new Set(result.rootHandles).size, 13);
  assert.deepEqual(data.stagedFrames.map(row => row.handle),
    result.rootHandles);
  assert.deepEqual(data.stagedFrames.map(row => row.address),
    ROLES.map((_, index) => arena + FRAME_BASE_OFFSET + index * 0x4000));
  assert.equal(result.extraRootsClosed, 12);
  assert.equal(result.counterReplies.every(row =>
    row.counterCount === 16 && row.replyHex.length === 512), true);
  assert.equal(result.markerAttempted, false);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
  assert.equal(result.cleanup, 'verified');
  assert.equal(result.markerNeutralized, true);
  assert.equal(result.markerRemoved, false);
  assert.deepEqual(data.counts(), {opened: 12, cleaned: 1, workerCalls: 1});
  assert.ok(data.events.lastIndexOf('closed:322') <
    data.events.indexOf('cleanup'));
});

test('ambiguous extra-root initialization retains owner and never launches worker', async () => {
  const data = fixture({failOpenAt: 5});
  await assert.rejects(runGapCounterControl({...data, ...args}), error => {
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.rootOpenAttempted, true);
    assert.equal(error.diagnostic.workerRequestSent, false);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    assert.equal(error.diagnostic.attempted, 5);
    return true;
  });
  assert.deepEqual(data.counts(), {opened: 5, cleaned: 0, workerCalls: 0});
});

test('unknown worker reply retains all roots and owner without replay', async () => {
  const data = fixture({workerError: true});
  await assert.rejects(runGapCounterControl({...data, ...args}), error => {
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.workerRequestSent, true);
    assert.equal(error.diagnostic.workerReleased, false);
    assert.equal(error.diagnostic.rootsCloseAttempted, false);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    return true;
  });
  assert.deepEqual(data.counts(), {opened: 12, cleaned: 0, workerCalls: 1});
});

test('unexpected transferred handle in one reply retains all roots', async () => {
  const data = fixture({movedRole: 6});
  await assert.rejects(runGapCounterControl({...data, ...args}), error => {
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.workerReleased, true);
    assert.equal(error.diagnostic.rootsCloseAttempted, false);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    return true;
  });
  assert.deepEqual(data.counts(), {opened: 12, cleaned: 0, workerCalls: 1});
});

test('ambiguous extra-root close retains owner and exact partial ledger', async () => {
  const data = fixture({failCloseHandle: 330});
  await assert.rejects(runGapCounterControl({...data, ...args}), error => {
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.workerReleased, true);
    assert.equal(error.diagnostic.rootsCloseAttempted, true);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    const states = new Map(error.diagnostic.knownHandles.map(
      (handle, index) => [handle, error.diagnostic.knownClosed[index]]));
    assert.equal(states.get(330), false);
    assert.equal(states.get(331), true);
    assert.equal(states.get(333), true);
    return true;
  });
  assert.deepEqual(data.counts(), {opened: 12, cleaned: 0, workerCalls: 1});
});
