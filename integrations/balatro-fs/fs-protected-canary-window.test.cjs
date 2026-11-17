'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths: markerPaths} = require('./marker-path-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {claimClone, claimFile} = require('./fs-attempt-packets.cjs');
const {createQualifiedContext, parseOpenServiceReply} =
  require('./fs-counter-probe.cjs');
const {buildProtectedCanaryPlan} =
  require('./fs-protected-canary-plan.cjs');
const {READ_BYTES, LOG_PATH} = require('./fs-receive-window.cjs');
const {openProtectedClone, closeProtectedClone, stageProtectedFrames,
  runProtectedCanaryWindow} = require('./fs-protected-canary-window.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'aabbccddeeff0011';
const prefix = Buffer.alloc(READ_BYTES, 0x5a);

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

function cloneReply(handle) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(0x80000004, 4);
  bytes.writeUInt32LE(1 << 5, 8);
  bytes.writeUInt32LE(handle, 12);
  bytes.write('SFCO', 16);
  return bytes;
}

function cmif(result, move, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(256);
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

function setup() {
  const scratch = arena + 0x10000;
  const memory = new Map();
  const native = {addresses: {sdk, scratch},
    async write(address, bytes) {memory.set(address, Buffer.from(bytes));},
    async read(address, length) {return memory.get(address)?.subarray(0, length);},
    callAddress() {}, callAddress6() {}, exchange() {}, verifyFunction() {}};
  const transport = new BalatroCloneTransport({native,
    evidence: evidence(), inspectLive() {}});
  for (const handle of [311, 312]) transport.ownedHandles.add(handle);
  const clone = claimClone({transport, controlReply: cloneReply(311)});
  const file = claimFile({clone, openReply: {result: 0,
    copies: [], moves: [312]}});
  const context = createQualifiedContext({arenaBase: `0x${arena.toString(16)}`,
    nonce: arenaNonce,
    hello: {status: 'read-only transport handshake verified',
      scratch: `0x${scratch.toString(16)}`, scratchBytes: 0x80000,
      sdkBase: `0x${sdk.toString(16)}`,
      sdkCrc32: Number.parseInt(profile.sdkCode.offlineCrc32, 16)},
    crc: {gameProfile: profile.gameProfile, nonce: arenaNonce,
      port: 39381, sdkBase: `0x${sdk.toString(16)}`,
      sdkCrc32: profile.sdkCode.offlineCrc32}});
  const rootReply = Buffer.alloc(0x8010);
  rootReply.writeUInt32LE(321, 16);
  const root = parseOpenServiceReply(rootReply, context);
  const preflight = {gameProfile: profile.gameProfile,
    arenaBase: `0x${arena.toString(16)}`,
    sdkBase: `0x${sdk.toString(16)}`, arenaNonce, markerNonce,
    exactAllocationBytes: null, markerHitVerified: false,
    fsStageVerified: false};
  const prepared = {arenaNonce, markerNonce, sdkBase: preflight.sdkBase,
    markerPath: markerPaths(markerNonce).marker,
    absentPath: markerPaths(markerNonce).absent,
    markerWrittenAndVerified: true, borrowedSession: 'preserved',
    ownedHandlesOpen: true, explicitSaveWrites: 1, context, transport,
    root, clone, file, pathAddress: transport.pathAddress,
    receiveAddress: transport.dataAddress};
  return {preflight, prepared, memory, native, transport};
}

function pathStates() {
  const marker = {result: 0, type: 1, bytes: content(markerNonce)};
  const absent = {result: 0x202, type: null, bytes: null};
  return {original: {marker, absent}, cloned: {marker, absent},
    padded: {marker, absent}, explicitSaveWrites: 0};
}

function counterPhase() {
  const row = Array(16).fill(0);
  row[5] = 100000;
  return {samples: [row.slice(), row.slice()]};
}

test('second copied clone is distinct and closes exactly once', async () => {
  const {prepared, transport} = setup();
  transport.sendControl = async () => {
    transport.ownedHandles.add(314);
    return cloneReply(314);
  };
  transport.readClone = async (handle, path) => {
    assert.equal(handle, 314);
    return path.includes('absent') ? pathStates().original.absent :
      pathStates().original.marker;
  };
  transport.closeOwned = async handle => {
    assert.equal(handle, 314);
    assert.equal(transport.ownedHandles.delete(handle), true);
    return {closed: true};
  };
  const protectedClone = await openProtectedClone(prepared);
  assert.equal(protectedClone.handle, 314);
  assert.equal(protectedClone.markerVerified, true);
  assert.equal((await closeProtectedClone(prepared, protectedClone)).closed, true);
  await assert.rejects(closeProtectedClone(prepared, protectedClone),
    /already closed/);
});

test('stages both descriptors, 64 KiB receive, and four frames with final readback', async () => {
  const {preflight, prepared, native, memory, transport} = setup();
  transport.ownedHandles.add(313);
  transport.ownedHandles.add(314);
  const protectedClone = claimClone({transport,
    controlReply: cloneReply(314)});
  const log = {path: LOG_PATH, closed: false, handle: 313,
    receiveAddress: transport.dataAddress, prefix};
  const staged = buildProtectedCanaryPlan({preflight, prepared, log,
    protectedClone, waveId});
  const receipt = await stageProtectedFrames(native, staged);
  assert.equal(receipt.exactReadbackVerified, true);
  assert.equal(receipt.frameSha256.length, 4);
  assert.equal(memory.get(staged.receiveAddress).length, READ_BYTES);
  assert.deepEqual(memory.get(staged.descriptors.canary.address),
    staged.descriptors.canary.bytes);
  assert.deepEqual(memory.get(staged.descriptors.trigger.address),
    staged.descriptors.trigger.bytes);
  staged.descriptors.canary.bytes[0] ^= 1;
  await assert.rejects(stageProtectedFrames(native, staged),
    /four exact owned frames/);
});

async function simulate({counterDrift = false, badWorkerReply = false,
  unexpectedCanaryType = false} = {}) {
  const {preflight, prepared, native, memory, transport} = setup();
  const counts = {copies: 0, logOpens: 0, closeLog: 0,
    closeProtected: 0, closeMoved: 0, cleanups: 0, workers: 0};
  transport.sendControl = async () => {
    counts.copies++;
    transport.ownedHandles.add(314);
    return cloneReply(314);
  };
  transport.readClone = async (_handle, path) => path.includes('absent') ?
    pathStates().original.absent : pathStates().original.marker;
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(279648n);
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(READ_BYTES));
  transport.sendOwned = async (handle, bytes) => {
    const command = require('./fs-abort-frames.cjs').requestCommand(bytes);
    if (handle === 311 && command === 8) {
      counts.logOpens++;
      return {result: 0, copies: [], moves: [313]};
    }
    if (handle === 313 && command === 4) {
      return {result: 0, copies: [], moves: [], data: size};
    }
    if (handle === 313 && command === 0) {
      memory.set(prepared.receiveAddress, Buffer.from(prefix));
      return {result: 0, copies: [], moves: [], data: length};
    }
    throw Error(`unexpected owned IPC ${handle}/${command}`);
  };
  transport.closeOwned = async handle => {
    assert.equal(transport.ownedHandles.delete(handle), true);
    if (handle === 313) counts.closeLog++;
    else if (handle === 314) counts.closeProtected++;
    else throw Error(`unexpected owned close ${handle}`);
    return {closed: true};
  };
  native.call = async (_offset, handle) => {
    assert.equal(handle, 450);
    counts.closeMoved++;
    return {result: 0n};
  };
  const adapter = {
    async inspect() {return {state: 'serving',
      gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
      codeHeadProfile: '1.0.1f', sdkBase: preflight.sdkBase,
      arenaBase: preflight.arenaBase, arenaNonce,
      ownerState: 'ready', workers: 0, ownedHandles: 0};},
    async prepare(input) {assert.equal(input, preflight); return prepared;},
    async readPaths() {return pathStates();},
    async counterPair(phase) {
      const pair = counterPhase();
      if (counterDrift && phase === 'protected-after') {
        pair.samples[0][5]--;
        pair.samples[1][5]--;
      }
      return pair;
    },
    async auditPaths() {return [];},
    auditDetails() {return {coverage: 'bounded-cloned-save-tree',
      completeSaveTreeVerified: true, logPrefixVerified: true,
      logState: 'append-only', changed: []};},
    async cleanup(input) {
      assert.equal(input, prepared);
      assert.equal(transport.ownedHandles.has(313), false);
      assert.equal(transport.ownedHandles.has(314), false);
      counts.cleanups++;
      return {ownedHandlesClosed: true, markerNeutralized: true,
        markerRemoved: false,
        borrowedSession: 'preserved', arena: 'released'};
    },
  };
  const type = Buffer.alloc(4);
  type.writeUInt32LE(unexpectedCanaryType ? 0 : 1);
  const executeSource = async ({source}) => {
    if (source.includes('BAL_FS_ABORT_GUARD_V1')) {
      return `-> BAL_FS_ABORT_GUARD_V1\tok\t${arenaNonce}\t${waveId}\tall-frames-verified`;
    }
    counts.workers++;
    if (badWorkerReply) return '-> BAL_FS_ABORT_WORKER_V1\tfs-abort-worker\tfail';
    const replies = [cmif(0, null, type), cmif(0, 450),
      cmif(0, null, length), cmif(0x202)];
    for (let index = 0; index < 4; index++) {
      const frame = arena + index * 0x4000;
      const ticks = Buffer.alloc(24);
      ticks.writeBigUInt64LE(BigInt(100 + index * 20), 0);
      ticks.writeBigUInt64LE(BigInt(500 + index * 20), 16);
      memory.set(frame + 0x400, ticks);
      memory.set(frame + 0x2000, replies[index]);
    }
    memory.set(prepared.receiveAddress, Buffer.from(prefix));
    const rows = [0, 1, 2, 3].map(index =>
      `000000000000000${index + 1},${(100 + index * 20).toString(16).padStart(16, '0')},${(500 + index * 20).toString(16).padStart(16, '0')},0`);
    return `-> BAL_FS_ABORT_WORKER_V1\tfs-abort-worker\tok\t${arenaNonce}\t${waveId}\t${preflight.arenaBase}\t${preflight.sdkBase}\tjoined-closed\t${rows.join('\t')}\tarena-retained`;
  };
  let observed, error;
  try {
    observed = await runProtectedCanaryWindow({preflight, adapter,
      executeSource, host: '10.0.0.189', macIp: '10.0.0.205', port: 39381,
      mainBase: '0x4900000000', waveId});
  } catch (cause) {error = cause;}
  return {observed, error, counts};
}

test('one protected client window keeps marker claims false and cleans once', async () => {
  const {observed, error, counts} = await simulate();
  assert.equal(error, undefined);
  assert.equal(observed.waveRows.length, 4);
  assert.equal(observed.protectedCloneClosed, true);
  assert.equal(observed.markerNeutralized, true);
  assert.equal(observed.markerRemoved, false);
  assert.equal(observed.clientIpcCommonOverlapTicks, 340);
  assert.equal(observed.markerHitVerified, false);
  assert.equal(observed.fsStageVerified, false);
  assert.deepEqual(counts, {copies: 1, logOpens: 1,
    closeLog: 1, closeProtected: 1, closeMoved: 1, cleanups: 1,
    workers: 1});
});

test('counter drift preserves raw four-row evidence after exact cleanup', async () => {
  const {observed, error, counts} = await simulate({counterDrift: true});
  assert.equal(observed, undefined);
  assert.match(error.message, /baseline restoration/);
  assert.equal(error.diagnostic.waveRows.length, 4);
  assert.equal(error.diagnostic.protectedCloneClosed, true);
  assert.equal(error.diagnostic.logHandleClosed, true);
  assert.equal(error.diagnostic.movedStorageClosed, true);
  assert.equal(error.diagnostic.ownedCleanupVerified, true);
  assert.equal(error.diagnostic.resourceStateUncertain, false);
  assert.equal(counts.cleanups, 1);
});

test('uncertain worker reply retains every owned handle for inspection', async () => {
  const {observed, error, counts} = await simulate({badWorkerReply: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.workerRequestSent, true);
  assert.equal(error.diagnostic.workerReleased, false);
  assert.equal(error.diagnostic.protectedCloneClosed, false);
  assert.equal(error.diagnostic.logHandleClosed, false);
  assert.equal(error.diagnostic.ownedCleanupAttempted, false);
  assert.equal(counts.cleanups, 0);
});

test('unexpected canary reply preserves exact native bytes and retains handles', async () => {
  const {observed, error, counts} = await simulate({unexpectedCanaryType: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.workerReleased, true);
  assert.equal(error.diagnostic.nativeRepliesHex.length, 4);
  assert.equal(error.diagnostic.nativeRepliesHex[0].slice(64, 72),
    '00000000');
  assert.equal(error.diagnostic.nativeReceiveSha256,
    createHash('sha256').update(prefix).digest('hex'));
  assert.equal(error.diagnostic.protectedCloneClosed, false);
  assert.equal(counts.cleanups, 0);
});
