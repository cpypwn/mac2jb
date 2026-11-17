'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {content} = require('./marker-content-control.cjs');
const {paths: markerPaths} = require('./marker-path-control.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {claimClone, claimFile} = require('./fs-attempt-packets.cjs');
const {createQualifiedContext, parseOpenServiceReply} =
  require('./fs-counter-probe.cjs');
const {requestCommand, stageAbortFrames} = require('./fs-abort-frames.cjs');
const {READ_BYTES, LOG_PATH, readPacket, parseReadReply,
  buildWindowFrames, parseWindowReplies, assessReceiveWindow,
  runReceiveWindow} =
  require('./fs-receive-window.cjs');

const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'aabbccddeeff0011';
const prefix = Buffer.alloc(READ_BYTES, 0x5a);
const hash = require('node:crypto').createHash('sha256').update(prefix).digest('hex');
const arena = 0x4964000000;
const sdk = 0x57390b4000;

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

function ownedFixture(logOwned = true) {
  const scratch = arena + 0x10000;
  const memory = new Map();
  const native = {addresses: {sdk, scratch},
    async write(address, bytes) {memory.set(address, Buffer.from(bytes));},
    async read(address, length) {return memory.get(address)?.subarray(0, length);},
    callAddress() {}, callAddress6() {}, exchange() {}, verifyFunction() {}};
  const transport = new BalatroCloneTransport({native,
    evidence: validEvidence(), inspectLive() {}});
  transport.ownedHandles.add(311);
  transport.ownedHandles.add(312);
  if (logOwned) transport.ownedHandles.add(313);
  const moved = Buffer.alloc(256);
  moved.writeUInt32LE(4);
  moved.writeUInt32LE(0x80000004, 4);
  moved.writeUInt32LE(1 << 5, 8);
  moved.writeUInt32LE(311, 12);
  moved.write('SFCO', 16);
  const clone = claimClone({transport, controlReply: moved});
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
  const preflight = {arenaBase: `0x${arena.toString(16)}`,
    sdkBase: `0x${sdk.toString(16)}`, arenaNonce, markerNonce};
  const prepared = {arenaNonce, markerNonce, sdkBase: preflight.sdkBase,
    ownedHandlesOpen: true, explicitSaveWrites: 1, context, transport,
    root, clone, file, pathAddress: transport.pathAddress,
    receiveAddress: transport.dataAddress};
  const log = {path: LOG_PATH, closed: false, handle: 313,
    receiveAddress: transport.dataAddress, prefix};
  return {preflight, prepared, log, memory, native};
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

function fixture() {
  const frames = ['pin', 'receive', 'trigger'].map((role, index) =>
    ({role, handle: 311 + index}));
  const staged = {waveId, arenaNonce, markerNonce,
    prefixSha256: hash, frames};
  const worker = {waveId, arenaNonce, workerState: 'joined-closed',
    serviceHandles: 'closed', rows: frames.map((frame, index) => ({
      role: frame.role, handle: frame.handle, transportResult: 0,
      startTick: 100 + index * 20, endTick: 500 + index * 20,
      requestId: `100000000000000${index + 1}`,
      threadId: `000000000000000${index + 1}`,
    }))};
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(READ_BYTES));
  const replies = [cmif(0, 450), cmif(0, null, length), cmif(0x202)];
  return {staged, worker, replies};
}

function paths() {
  const marker = {result: 0, type: 1, bytes: content(markerNonce)};
  const absent = {result: 0x202, type: null, bytes: null};
  return {original: {marker, absent}, cloned: {marker, absent},
    padded: {marker, absent}, explicitSaveWrites: 0};
}

function phases() {
  const sample = Array(16).fill(0);
  sample[5] = 100000;
  const phase = () => ({samples: [sample.slice(), sample.slice()]});
  return {before: phase(), noStorageBefore: phase(),
    after: phase(), noStorageAfter: phase()};
}

function saveAudit() {
  return {coverage: 'bounded-cloned-save-tree',
    completeSaveTreeVerified: true, logPrefixVerified: true,
    logState: 'append-only', changed: []};
}

test('read-only receive request is exactly 0x10000 and command zero', () => {
  const bytes = readPacket(0x4900032000);
  assert.equal(bytes.length, 256);
  assert.equal(requestCommand(bytes), 0);
  assert.equal(bytes.readBigUInt64LE(bytes.indexOf('SFCI') + 0x20),
    BigInt(READ_BYTES));
  assert.throws(() => readPacket(0), /receive address/);
});

test('owned root, log file, and clone stage three nonoverlapping exact frames', async () => {
  const {preflight, prepared, log, native, memory} = ownedFixture();
  const staged = buildWindowFrames({preflight, prepared, log, waveId});
  assert.deepEqual(staged.frames.map(row => row.handle), [321, 313, 311]);
  assert.deepEqual(staged.frames.map(row =>
    requestCommand(row.bytes.subarray(0x2000, 0x2100))), [200, 0, 7]);
  assert.equal(staged.descriptor.length, 0x800);
  assert.equal(staged.descriptor[0x7ff], 0);
  assert.equal(staged.prefixSha256, hash);
  const receipt = await stageAbortFrames(native, staged);
  assert.equal(receipt.exactReadbackVerified, true);
  assert.equal(memory.get(staged.receiveAddress).length, READ_BYTES);
  assert.equal(memory.get(staged.descriptorAddress).length, 0x800);
  assert.notDeepEqual(staged.descriptor,
    require('./fs-attempt-packets.cjs').descriptorInput(markerNonce, 'marker'));
  assert.equal(markerPaths(markerNonce).absent.includes('absent'), true);
});

test('native receive accepts exact prefix and distinguishes all three IPC results', () => {
  const {staged, worker, replies} = fixture();
  const parsed = parseWindowReplies(staged, worker, replies, prefix, prefix);
  assert.equal(parsed.movedStorageHandle, 450);
  assert.equal(parsed.rows[1].receiveBytesVerified, READ_BYTES);
  assert.equal(parsed.rows[2].ipcResult, 0x202);
  assert.equal(parsed.receivedPrefixSha256, hash);
  assert.throws(() => parseWindowReplies(staged, worker, replies,
    Buffer.alloc(READ_BYTES), prefix), /exact serial prefix/);
  assert.throws(() => parseWindowReplies(staged, worker,
    [replies[0], replies[1], cmif(0)], prefix, prefix), /absent-path trigger/);
});

test('read reply must report all 65536 bytes with no transferred handles', () => {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(READ_BYTES));
  assert.doesNotThrow(() => parseReadReply({result: 0,
    copies: [], moves: [], data: length}));
  length.writeBigUInt64LE(16n);
  assert.throws(() => parseReadReply({result: 0,
    copies: [], moves: [], data: length}), /exactly 0x10000/);
});

test('complete clean observation measures client overlap without FS claims', () => {
  const {staged, worker, replies} = fixture();
  const parsed = parseWindowReplies(staged, worker, replies, prefix, prefix);
  const observed = assessReceiveWindow({staged, worker, parsed,
    phases: phases(), changedPaths: [], saveAudit: saveAudit(), pathBefore: paths(),
    pathAfter: paths(), cleanup: 'verified'});
  assert.equal(observed.logPath, LOG_PATH);
  assert.equal(observed.counterPhases.before.samples[0][5], 100000);
  assert.equal(observed.waveRows.length, 3);
  assert.equal(observed.saveTreeAudit.completeSaveTreeVerified, true);
  assert.deepEqual(observed.changedPaths, []);
  assert.equal(observed.clientIpcCommonOverlapTicks, 360);
  assert.equal(observed.clientIpcRequestOverlapMeasured, true);
  assert.equal(observed.preparationMarkerSaveWrites, 1);
  assert.equal(observed.nativeWindowSaveWrites, 0);
  assert.equal(observed.fsHandlerOverlapMeasured, false);
  assert.equal(observed.fsSideMarkerReadbackVerified, false);
  assert.equal(observed.markerHitVerified, false);
  assert.equal(observed.fsStageVerified, false);
});

test('save change, counter drift, and incomplete cleanup veto a window result', () => {
  const {staged, worker, replies} = fixture();
  const parsed = parseWindowReplies(staged, worker, replies, prefix, prefix);
  const input = {staged, worker, parsed, phases: phases(),
    changedPaths: [], saveAudit: saveAudit(),
    pathBefore: paths(), pathAfter: paths(),
    cleanup: 'verified'};
  assert.throws(() => assessReceiveWindow({...input,
    changedPaths: ['save:/anything']}), /save audit/);
  assert.throws(() => assessReceiveWindow({...input,
    cleanup: 'unknown'}), /cleanup/);
  const changed = phases();
  changed.after.samples[0][5]--;
  changed.after.samples[1][5]--;
  assert.throws(() => assessReceiveWindow({...input, phases: changed}),
    /baseline restoration/);
});

async function simulateWindow({counterDrift = false, cleanupFailure = false} = {}) {
  const {preflight, prepared, memory, native} = ownedFixture(false);
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(READ_BYTES));
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(279648n);
  let openCount = 0;
  let closeCount = 0;
  let cleanupCount = 0;
  let workerCount = 0;
  let pinCloseCount = 0;
  prepared.transport.sendOwned = async (handle, bytes) => {
    const command = requestCommand(bytes);
    if (handle === 311 && command === 8) {
      openCount++;
      return {result: 0, copies: [], moves: [313]};
    }
    if (handle === 313 && command === 4)
      return {result: 0, copies: [], moves: [], data: size};
    if (handle === 313 && command === 0) {
      memory.set(prepared.receiveAddress, Buffer.from(prefix));
      return {result: 0, copies: [], moves: [], data: length};
    }
    throw Error(`unexpected owned IPC ${handle}/${command}`);
  };
  prepared.transport.closeOwned = async handle => {
    assert.equal(handle, 313);
    assert.equal(prepared.transport.ownedHandles.delete(handle), true);
    closeCount++;
    return {closed: true};
  };
  native.call = async (_offset, handle) => {
    assert.equal(handle, 450);
    pinCloseCount++;
    return {result: 0n};
  };
  const adapter = {
    async inspect() {return {state: 'serving',
      gameProfile: profile.gameProfile,
      runtimeVersion: profile.runtimeVersion,
      codeHeadProfile: '1.0.1f', sdkBase: preflight.sdkBase,
      arenaBase: preflight.arenaBase, arenaNonce,
      ownerState: 'ready', workers: 0, ownedHandles: 0};},
    async prepare(input) {assert.equal(input, preflight); return prepared;},
    async readPaths() {return paths();},
    async counterPair(phase) {
      const pair = phases().before;
      if (counterDrift && phase === 'window-after') {
        pair.samples[0][5]--;
        pair.samples[1][5]--;
      }
      return pair;
    },
    async auditPaths() {return [];},
    auditDetails() {return saveAudit();},
    async cleanup(input) {
      assert.equal(input, prepared);
      cleanupCount++;
      if (cleanupFailure) throw Error('owned cleanup failed');
      return {ownedHandlesClosed: true, markerNeutralized: true,
        markerRemoved: false,
        borrowedSession: 'preserved', arena: 'released'};
    },
  };
  const executeSource = async ({source}) => {
    if (source.includes('BAL_FS_ABORT_GUARD_V1')) {
      return `-> BAL_FS_ABORT_GUARD_V1\tok\t${arenaNonce}\t${waveId}\tall-frames-verified`;
    }
    workerCount++;
    for (let index = 0; index < 3; index++) {
      const frame = arena + index * 0x4000;
      const ticks = Buffer.alloc(24);
      ticks.writeBigUInt64LE(BigInt(100 + index * 20), 0);
      ticks.writeBigUInt64LE(BigInt(500 + index * 20), 16);
      memory.set(frame + 0x400, ticks);
      memory.set(frame + 0x2000, [cmif(0, 450), cmif(0, null, length),
        cmif(0x202)][index]);
    }
    memory.set(prepared.receiveAddress, Buffer.from(prefix));
    const rows = [0, 1, 2].map(index =>
      `000000000000000${index + 1},${(100 + index * 20).toString(16).padStart(16, '0')},${(500 + index * 20).toString(16).padStart(16, '0')},0`);
    return `-> BAL_FS_ABORT_WORKER_V1\tfs-abort-worker\tok\t${arenaNonce}\t${waveId}\t${preflight.arenaBase}\t${preflight.sdkBase}\tjoined-closed\t${rows.join('\t')}\tarena-retained`;
  };
  let observed, error;
  try {
    observed = await runReceiveWindow({preflight, adapter,
      executeSource, host: '10.0.0.189', macIp: '10.0.0.1', port: 39381,
      mainBase: '0x4900000000', waveId});
  } catch (cause) {error = cause;}
  return {observed, error,
    counts: [openCount, workerCount, pinCloseCount, closeCount, cleanupCount]};
}

test('one bounded native window retains exact evidence and cleans once', async () => {
  const {observed, error, counts} = await simulateWindow();
  assert.equal(error, undefined);
  assert.equal(observed.clientIpcCommonOverlapTicks, 360);
  assert.equal(observed.markerHitVerified, false);
  assert.equal(observed.markerNeutralized, true);
  assert.equal(observed.markerRemoved, false);
  assert.equal(observed.counterPhases.after.samples[0][5], 100000);
  assert.equal(observed.waveRows.length, 3);
  assert.equal(observed.saveTreeAudit.completeSaveTreeVerified, true);
  assert.deepEqual(observed.changedPaths, []);
  assert.deepEqual(counts, [1, 1, 1, 1, 1]);
});

test('post-cleanup gate rejection retains counters, rows, audit and cleanup facts', async () => {
  const {error, counts} = await simulateWindow({counterDrift: true});
  assert.match(error.message, /baseline restoration/);
  const evidence = error.diagnostic;
  assert.equal(evidence.counterPhases.after.samples[0][5], 99999);
  assert.equal(evidence.waveRows.length, 3);
  assert.equal(evidence.saveTreeAudit.completeSaveTreeVerified, true);
  assert.deepEqual(evidence.changedPaths, []);
  assert.equal(evidence.logHandleClosed, true);
  assert.equal(evidence.workerReleased, true);
  assert.equal(evidence.movedStorageClosed, true);
  assert.equal(evidence.ownedCleanupAttempted, true);
  assert.equal(evidence.ownedCleanupVerified, true);
  assert.equal(evidence.resourceStateUncertain, false);
  assert.deepEqual(counts, [1, 1, 1, 1, 1]);
});

test('cleanup rejection retains native evidence without claiming cleanup', async () => {
  const {error, counts} = await simulateWindow({cleanupFailure: true});
  assert.equal(error.resourceStateUncertain, true);
  const evidence = error.diagnostic;
  assert.equal(evidence.workerReleased, true);
  assert.equal(evidence.movedStorageClosed, true);
  assert.equal(evidence.logHandleClosed, true);
  assert.equal(evidence.ownedCleanupAttempted, true);
  assert.equal(evidence.ownedCleanupVerified, false);
  assert.equal(evidence.waveRows.length, 3);
  assert.equal(evidence.counterPhases.after.samples[0][5], 100000);
  assert.equal(evidence.saveTreeAudit.completeSaveTreeVerified, true);
  assert.deepEqual(counts, [1, 1, 1, 1, 1]);
});
