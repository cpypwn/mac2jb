'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {createHash} = require('node:crypto');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {claimClone} = require('./fs-attempt-packets.cjs');
const {content} = require('./marker-content-control.cjs');
const {buildGapFirstXInput} = require('./fs-gap-first-x-input.cjs');
const {FILE_BYTES, CHUNK_BYTES, FILL_BYTE, quiescentVerified,
  prepareGapScratchLease, cleanupGapScratchLease} =
  require('./fs-gap-scratch-lease.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const owner = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';

function sha(bytes) {return createHash('sha256').update(bytes).digest('hex');}

function reply({result = 0, moves = [], data = Buffer.alloc(0)} = {}) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4, 0);
  bytes.writeUInt32LE(((4 + Math.ceil(data.length / 4)) |
    (moves.length ? 0x80000000 : 0)) >>> 0, 4);
  let at = 8;
  if (moves.length) {
    bytes.writeUInt32LE(moves.length << 5, at);
    at += 4;
    for (const handle of moves) {bytes.writeUInt32LE(handle, at); at += 4;}
  }
  at = (at + 15) & ~15;
  bytes.write('SFCO', at);
  bytes.writeUInt32LE(result, at + 8);
  data.copy(bytes, at + 16);
  return bytes;
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function evidence() {
  const manager = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
  return {gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    nonce: owner, sdkBase: `0x${sdk.toString(16)}`,
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

function fixture() {
  const writeBufferAddress = 0x1000000;
  const state = {directories: new Set(['/']),
    files: new Map([[`/bal-marker-${markerNonce}.bin`, content(markerNonce)]]),
    memory: new Map(), operations: [], commitCount: 0};
  const transport = Object.create(BalatroCloneTransport.prototype);
  transport.evidence = evidence();
  transport.initialized = true;
  transport.scratch = arena + 0x10000;
  transport.pathAddress = transport.scratch + 0x20000;
  transport.dataAddress = transport.scratch + 0x22000;
  transport.ownedHandles = new Set([311, 312]);
  transport.native = {addresses: {sdk, scratch: transport.scratch},
    async write(address, bytes) {state.memory.set(address, Buffer.from(bytes));}};
  transport.outputAddress = transport.scratch + 0x20800;
  transport.writeOutput = async (bytes) => {
    const buffer = Buffer.alloc(bytes + 8);
    buffer.writeUInt32LE(0x5a17eacc);
    buffer.writeUInt32LE(0x5a17eacc, bytes + 4);
    state.memory.set(transport.outputAddress, Buffer.from(buffer));
    return transport.outputAddress + 4;
  };
  transport.readOutput = async (bytes) => {
    const buffer = state.memory.get(transport.outputAddress) ?? Buffer.alloc(bytes + 8);
    return buffer.subarray(4, 4 + bytes);
  };
  transport.call = async (name, args) => {
    state.operations.push(`call:${name}`);
    if (name === 'freeSpace') {
      const buffer = state.memory.get(args[0] - 4) ?? Buffer.alloc(16);
      buffer.writeBigUInt64LE(0x1000000n, 4);
      state.memory.set(args[0] - 4, buffer);
      return 0;
    }
    return 0;
  };
  transport.inspectLive = async () => transport.evidence;
  transport.sendControl = async (handle) => {
    assert.equal(handle, 118);
    state.operations.push('copy:118');
    transport.ownedHandles.add(313);
    return reply({moves: [313]});
  };
  transport.closeOwned = async handle => {
    assert.notEqual(handle, 118);
    assert.equal(transport.ownedHandles.has(handle), true);
    state.operations.push(`close:${handle}`);
    transport.ownedHandles.delete(handle);
    return {closed: true};
  };
  transport.sendPacket = async (handle, request) => {
    const at = request.indexOf(Buffer.from('SFCI'));
    assert.ok(at >= 0);
    const command = request.readUInt32LE(at + 8);
    const pathname = state.memory.get(transport.pathAddress)?.toString('ascii')
      .split('\0')[0];
    state.operations.push(`${handle}:${command}:${pathname || ''}`);
    if (handle === 313) {
      if (command === 11) return reply({data: u64(0x1000000)});
      if (command === 7) {
        if (state.directories.has(pathname)) return reply({data: Buffer.from([0, 0, 0, 0])});
        if (state.files.has(pathname)) return reply({data: Buffer.from([1, 0, 0, 0])});
        return reply({result: 0x202});
      }
      if (command === 2) {
        assert.ok(!state.directories.has(pathname));
        const parent = pathname.slice(0, pathname.lastIndexOf('/')) || '/';
        assert.ok(state.directories.has(parent));
        state.directories.add(pathname);
        return reply();
      }
      if (command === 0) {
        const fileSize = Number(request.readBigUInt64LE(at + 24));
        state.files.set(pathname, Buffer.alloc(fileSize));
        return reply();
      }
      if (command === 8) {
        assert.equal(request.readUInt32LE(at + 16), 3);
        assert.ok(state.files.has(pathname));
        return reply({moves: [314]});
      }
      if (command === 1) {assert.ok(state.files.delete(pathname)); return reply();}
      if (command === 3) {
        assert.ok(state.directories.delete(pathname));
        return reply();
      }
      if (command === 10) {state.commitCount++; return reply();}
    }
    if (handle === 314 && command === 1) {
      const offset = Number(request.readBigUInt64LE(at + 24));
      const count = Number(request.readBigUInt64LE(at + 32));
      assert.equal(count, FILE_BYTES);
      state.memory.get(writeBufferAddress).copy(
        state.files.get(`/bal-gap-${owner}/commit_data`), offset);
      return reply();
    }
    throw Error(`unexpected fake command ${handle}:${command}`);
  };
  function snapshotTree({cloneHandle}) {
    assert.equal(cloneHandle, 313);
    const files = Object.create(null);
    for (const [name, bytes] of state.files) {
      files[name] = {size: bytes.length,
        prefixBytes: bytes.length, sha256: sha(bytes)};
    }
    return {coverage: 'bounded-cloned-save-tree', complete: true,
      directories: [...state.directories].sort(), files,
      totalBytes: [...state.files.values()].reduce((sum, bytes) =>
        sum + bytes.length, 0), entries: state.directories.size - 1 +
        state.files.size,
      logPath: '/.lovegame/bl_log.txt', logPresent: false};
  }
  const preflight = {gameProfile: profile.gameProfile,
    sdkBase: `0x${sdk.toString(16)}`,
    arenaBase: `0x${arena.toString(16)}`,
    arenaNonce: owner, markerNonce,
    exactAllocationBytes: null, markerHitVerified: false,
    fsStageVerified: false};
  const prepared = {transport, arenaNonce: owner, markerNonce,
    sdkBase: preflight.sdkBase, markerWrittenAndVerified: true,
    borrowedSession: 'preserved', ownedHandlesOpen: true,
    explicitSaveWrites: 1,
    context: {arena: BigInt(arena), sdk: BigInt(sdk),
      scratch: BigInt(transport.scratch), nonce: owner},
    root: {role: 'root', handle: 321, closed: false},
    clone: claimClone({transport, controlReply: reply({moves: [311]})}),
    file: {handle: 312}};
  const plan = buildGapFirstXInput({preflight});
  return {state, transport, preflight, prepared, plan, snapshotTree,
    writeBufferAddress};
}

test('quiescence accepts the positive 3-role abort worker shape and refuses partial closure', () => {
  assert.equal(quiescentVerified({workerState: 'joined-closed',
    serviceHandles: 'closed', movedStorageHandleClosed: true}), true);
  assert.equal(quiescentVerified({workerState: 'joined-closed',
    groupClosed: true, pinStorageClosed: true, candidateStorageClosed: true}), true);
  assert.equal(quiescentVerified({workerState: 'not-started',
    groupClosed: true, pinStorageClosed: true, candidateStorageClosed: true}), true);
  assert.equal(quiescentVerified({workerState: 'joined-closed',
    serviceHandles: 'closed', movedStorageHandleClosed: false}), false);
  assert.equal(quiescentVerified({workerState: 'joined-closed'}), false);
  assert.equal(quiescentVerified({groupClosed: true,
    pinStorageClosed: true, candidateStorageClosed: true}), false);
});

test('distinct owned clone creates dirty scratch, audits exact delta, then restores', async () => {
  const f = fixture();
  const lease = await prepareGapScratchLease(f);
  assert.equal(lease.cloneHandle, 313);
  assert.equal(lease.commitFileHandleClosed, true);
  assert.equal(lease.selectedDirectoryCreatedAndVerified, true);
  assert.equal(lease.positiveAttemptAllowed, false);
  assert.deepEqual(lease.canaryBeforeCommit, {result: 0, type: 1});
  assert.deepEqual(lease.canaryAfterCommit, {result: 0, type: 1});
  assert.deepEqual(await lease.readCanary(), {result: 0, type: 1});
  assert.equal(lease.markerHitVerified, false);
  assert.deepEqual(lease.stageAudit.changedPaths, lease.expectedDelta);
  assert.deepEqual(f.state.files.get(lease.paths.file),
    Buffer.alloc(FILE_BYTES, FILL_BYTE));
  assert.equal(f.state.commitCount, 0);
  assert.deepEqual([...f.transport.ownedHandles].sort(), [311, 312, 313]);
  const cleanup = await cleanupGapScratchLease({lease,
    quiescent: {workerState: 'not-started', groupClosed: true,
      pinStorageClosed: true, candidateStorageClosed: true},
    snapshotTree: f.snapshotTree});
  assert.equal(cleanup.completeSaveTreeRestored, true);
  assert.equal(cleanup.cloneHandleClosed, true);
  assert.equal(cleanup.markerHitVerified, false);
  assert.equal(cleanup.fsStageVerified, false);
  assert.equal(f.state.commitCount, 1);
  assert.deepEqual([...f.transport.ownedHandles].sort(), [311, 312]);
  assert.equal(f.state.operations.includes('close:118'), false);
  await assert.rejects(cleanupGapScratchLease({lease,
    quiescent: {workerState: 'not-started', groupClosed: true,
      pinStorageClosed: true, candidateStorageClosed: true},
    snapshotTree: f.snapshotTree}), /one-shot/);
});

test('changed scratch contents before cleanup retain owned clone and paths', async () => {
  const f = fixture();
  const lease = await prepareGapScratchLease(f);
  f.state.files.get(lease.paths.file)[0] ^= 1;
  await assert.rejects(cleanupGapScratchLease({lease,
    quiescent: {workerState: 'joined-closed', groupClosed: true,
      pinStorageClosed: true, candidateStorageClosed: true},
    snapshotTree: f.snapshotTree}), error =>
      error.resourceStateUncertain === true &&
      /scratch cleanup did not finish/.test(error.message));
  assert.equal(f.transport.ownedHandles.has(313), true);
  assert.equal(f.state.files.has(lease.paths.file), true);
  assert.equal(f.state.commitCount, 0);
});

test('scratch lease refuses stale owner before any copy or save write', async () => {
  const f = fixture();
  f.preflight.markerHitVerified = true;
  await assert.rejects(prepareGapScratchLease(f), /fresh pinned owner/);
  assert.deepEqual(f.state.operations, []);
});

test('ambiguous baseline inventory retains cloned owner for recovery', async () => {
  const f = fixture();
  await assert.rejects(prepareGapScratchLease({...f,
    snapshotTree: async () => {throw Error('inventory transport unknown');}}),
  error => error.resourceStateUncertain === true &&
    error.diagnostic.phase === 'snapshot-before-scratch');
  assert.equal(f.transport.ownedHandles.has(313), true);
  assert.equal(f.state.operations.includes('close:313'), false);
  assert.equal(f.state.directories.size, 1);
});

test('certain insufficient free space closes the distinct clone before mutation', async () => {
  const f = fixture();
  const call = f.transport.call;
  f.transport.call = async (name, args) => {
    if (name === 'freeSpace') {
      const buffer = f.state.memory.get(args[0] - 4) ?? Buffer.alloc(16);
      buffer.writeBigUInt64LE(0x100000n, 4);
      f.state.memory.set(args[0] - 4, buffer);
      return 0;
    }
    return call(name, args);
  };
  await assert.rejects(prepareGapScratchLease(f), /save free space/);
  assert.equal(f.transport.ownedHandles.has(313), false);
  assert.equal(f.state.operations.includes('close:313'), true);
  assert.equal(f.state.directories.size, 1);
});
