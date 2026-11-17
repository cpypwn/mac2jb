'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const {packet} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths: markerPaths} = require('./marker-path-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {claimClone, claimFile} = require('./fs-attempt-packets.cjs');
const {createQualifiedContext, parseOpenServiceReply} =
  require('./fs-counter-probe.cjs');
const {READ_BYTES, LOG_PATH} = require('./fs-receive-window.cjs');
const {OUTPUT_OFFSETS, storageReadPacket} =
  require('./fs-owned-storage-read.cjs');
const {validateOrdinaryBaseline} =
  require('./fs-event-pinned-storage-read.cjs');
const {buildGapEventFrame, RESULT_OFFSETS} =
  require('./fs-gap-event-frame.cjs');
const {makeGapEventWorkerSource, MARKER} =
  require('./fs-gap-event-worker.cjs');
const {ROLES} = require('./fs-protected-canary-plan.cjs');
const {buildProtectedEventControl, stageProtectedEventControl,
  runProtectedEventControl} = require('./fs-protected-event-control.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'aabbccddeeff0011';
const prefix = Buffer.alloc(READ_BYTES, 0x5a);
const ordinaryBytes = Buffer.alloc(READ_BYTES, 0x27);

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

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
    async read(address, length) {
      for (const [base, bytes] of memory)
        if (address >= base && address + length <= base + bytes.length)
          return Buffer.from(bytes.subarray(address - base,
            address - base + length));
      return undefined;
    },
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

function ordinaryBaseline() {
  const hash = sha(ordinaryBytes);
  return {gameProfile: profile.gameProfile,
    owner: '1111111111111111', markerNonce,
    arena: 'detached',
    nativeBridge: 'closed', listener: 'closed',
    markerHitVerified: false, fsStageVerified: false,
    ownedStorageRead: {gameProfile: profile.gameProfile,
      arenaNonce: '1111111111111111', markerNonce,
      cleanup: 'verified', completeSaveAuditVerified: true,
      storageHandleClosed: true, counterBaselineRestored: true,
      changedPaths: [], pathBefore: pathStates(), pathAfter: pathStates(),
      exactRepeatVerified: true,
      markerBytesAbsentFromOrdinaryContent: true,
      outputGuardsIntact: true, storageReadOffset: 0,
      storageReadBytes: READ_BYTES, storageBytes: 57958544,
      ordinaryContentSha256: hash, readSha256: [hash, hash],
      outputPoisons: [0xa5, 0x5a],
      saveTreeAudit: {coverage: 'bounded-cloned-save-tree',
        completeSaveTreeVerified: true, logPrefixVerified: true,
        logState: 'append-only', changed: []},
      fsSideAliasVerified: false,
      fsSideMarkerReadbackVerified: false,
      markerHitVerified: false, fsStageVerified: false}};
}

function workerReply(staged, preflight) {
  const rows = staged.frames.map((_, index) =>
    `000000000000000${index + 1},${(100 + index * 20).toString(16).padStart(16, '0')},${(500 + index * 20).toString(16).padStart(16, '0')},0`);
  return `-> ${MARKER}\tfs-gap-event-worker\tok\t${arenaNonce}\t${waveId}\t${preflight.arenaBase}\t${preflight.sdkBase}\tprotected-event-control\tjoined-closed\t4\t${rows.join(';')}\tevent-finalized\tarena-retained`;
}

function writeWorkerResults(memory, staged, prepared,
  {unexpectedCanaryType = false, movedStorageHandle = 450} = {}) {
  const type = Buffer.alloc(4);
  type.writeUInt32LE(unexpectedCanaryType ? 0 : 1);
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(READ_BYTES));
  const replies = [cmif(0, null, type),
    cmif(0, movedStorageHandle),
    cmif(0, null, length), cmif(0x202)];
  for (let index = 0; index < ROLES.length; index++) {
    const frame = staged.frames[index];
    const bytes = memory.get(frame.address);
    bytes.writeBigUInt64LE(BigInt(100 + index * 20),
      RESULT_OFFSETS.startTick);
    bytes.writeBigUInt64LE(0n, RESULT_OFFSETS.transportResult);
    bytes.writeBigUInt64LE(BigInt(500 + index * 20),
      RESULT_OFFSETS.endTick);
    replies[index].copy(bytes, 0x2000);
  }
  memory.set(prepared.receiveAddress, Buffer.from(prefix));
}

async function simulate({badWorkerReply = false, unexpectedCanaryType = false,
  movedStorageHandle = 450, cleanupFails = false,
  counterDrift = false, reader = false, readTransfersHandle = false,
  sizeTransfersHandle = false, pinnedCloseFails = false,
  ordinaryContentChanged = false} = {}) {
  const {preflight, prepared, memory, native, transport} = setup();
  const counts = {copies: 0, logOpens: 0, closeLog: 0,
    closeProtected: 0, closeMoved: 0, closePinned: 0,
    rawSends: 0, cleanups: 0, workers: 0};
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
    if (handle === 313 && command === 4)
      return {result: 0, copies: [], moves: [], data: size};
    if (handle === 313 && command === 0) {
      memory.set(prepared.receiveAddress, Buffer.from(prefix));
      return {result: 0, copies: [], moves: [], data: length};
    }
    throw Error(`unexpected owned IPC ${handle}/${command}`);
  };
  transport.closeOwned = async handle => {
    if (handle === 450 && pinnedCloseFails) {
      counts.closePinned++;
      throw Error('adopted storage close response lost');
    }
    assert.equal(transport.ownedHandles.delete(handle), true);
    if (handle === 313) counts.closeLog++;
    else if (handle === 314) counts.closeProtected++;
    else if (handle === 450) counts.closePinned++;
    else throw Error(`unexpected owned close ${handle}`);
    return {closed: true};
  };
  let readIndex = 0;
  transport.sendPacket = async (handle, bytes) => {
    assert.equal(reader, true);
    assert.equal(handle, 450);
    counts.rawSends++;
    const command = require('./fs-abort-frames.cjs').requestCommand(bytes);
    if (command === 4) {
      assert.deepEqual(bytes, packet(4));
      const value = Buffer.alloc(8);
      value.writeBigUInt64LE(57958544n);
      return cmif(0, sizeTransfersHandle ? 999 : null, value);
    }
    assert.equal(command, 0);
    assert.ok(readIndex < 2);
    const address = transport.scratch + OUTPUT_OFFSETS[readIndex];
    assert.deepEqual(bytes, storageReadPacket(address));
    readIndex++;
    if (readTransfersHandle) return cmif(0, 999);
    memory.set(address, Buffer.from(ordinaryContentChanged ?
      Buffer.alloc(READ_BYTES, 0x28) : ordinaryBytes));
    return cmif(0);
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
      if (counterDrift && phase === 'protected-event-after') {
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
      if (cleanupFails) throw Error('cleanup response lost');
      return {ownedHandlesClosed: true, markerNeutralized: true,
        markerRemoved: false,
        borrowedSession: 'preserved', arena: 'released'};
    },
  };
  const eventFrames = [];
  const originalWrite = native.write;
  native.write = async (address, bytes) => {
    await originalWrite(address, bytes);
    if (bytes.length === 0x3000 && address >= arena + 0x100000)
      eventFrames.push(address);
  };
  const executeSource = async ({source}) => {
    assert.match(source, /BAL_GAP_EVENT_WORKER_V1/);
    counts.workers++;
    if (badWorkerReply) return '-> BAL_GAP_EVENT_WORKER_V1\tfs-gap-event-worker\tfail';
    const staged = {frames: eventFrames.map((address, index) => ({
      address, role: ROLES[index], handle: [314, 321, 313, 311][index],
      packetAddress: address + 0x2000}))};
    writeWorkerResults(memory, staged, prepared,
      {unexpectedCanaryType, movedStorageHandle});
    return workerReply(staged, preflight);
  };
  let observed, error;
  try {
    observed = await runProtectedEventControl({preflight, adapter,
      executeSource,
      host: '10.0.0.189', macIp: '10.0.0.205', port: 39381,
      mainBase: '0x4900000000', waveId,
      ordinaryBaseline: reader ? ordinaryBaseline() : null});
  } catch (cause) {error = cause;}
  return {observed, error, counts};
}

test('four-role negative event frames bind existing handles and exact requests',
  async t => {
    const {preflight, prepared, native, memory, transport} = setup();
    transport.ownedHandles.add(313);
    transport.ownedHandles.add(314);
    const protectedClone = claimClone({transport,
      controlReply: cloneReply(314)});
    const log = {path: LOG_PATH, closed: false, handle: 313,
      receiveAddress: transport.dataAddress, prefix};
    const staged = buildProtectedEventControl({preflight, prepared, log,
      protectedClone, waveId});
    assert.deepEqual(staged.frames.map(frame => frame.role), ROLES);
    assert.deepEqual(staged.frames.map(frame => frame.handle),
      [314, 321, 313, 311]);
    assert.equal(staged.frames[0].address, arena + 0x100000);
    assert.equal(staged.markerHitVerified, false);
    const receipt = await stageProtectedEventControl(native, staged);
    assert.equal(receipt.exactReadbackVerified, true);
    assert.equal(memory.get(staged.protectedPlan.receiveAddress).length,
      READ_BYTES);
    const options = {nonce: arenaNonce, waveId,
      arenaBase: preflight.arenaBase, sdkBase: preflight.sdkBase,
      mainBase: '0x4900000000', hostIp: '10.0.0.205',
      port: 39381, staged, stageReceipt: receipt};
    const source = makeGapEventWorkerSource(options);
    assert.match(source, /protected-event-control/);
    assert.match(source, /hold\.phase='cleanup-signal'/);
    assert.match(source, /hold\.phase='event-finalize'/);
    const available = spawnSync('luajit', ['-v'], {encoding: 'utf8'});
    if (!available.error) {
      const parsed = spawnSync('luajit', ['-e',
        'local s=io.read("*a"); local f,e=loadstring(s); if not f then io.stderr:write(e); os.exit(1) end'],
      {input: source, encoding: 'utf8'});
      assert.equal(parsed.status, 0, parsed.stderr);
    } else if (available.error?.code === 'ENOENT') {
      t.diagnostic('LuaJIT unavailable; source size and structural checks passed');
    }
    staged.frames[1] = buildGapEventFrame({layout: staged.layout,
      role: 'pin', handle: prepared.root.handle, request: packet(1009)});
    let writes = 0;
    const noWrite = {addresses: native.addresses,
      async write() {writes++;}, async read() {throw Error('unexpected read');}};
    await assert.rejects(stageProtectedEventControl(noWrite, staged),
      /event frame ownership changed/);
    assert.equal(writes, 0);
  });

test('four event-gated negative requests clean once and leave all stages false',
  async () => {
    const {observed, error, counts} = await simulate();
    assert.equal(error, undefined);
    assert.equal(observed.eventGate, 'initialized-signaled-finalized');
    assert.equal(observed.nativeFourWorkerEventControlVerified, true);
    assert.equal(observed.waveRows.length, 4);
    assert.equal(observed.requestIdsHostDerived, true);
    assert.equal(observed.waveRows[0].requestIdSource,
      'host-wave-role-hash');
    assert.equal(observed.clientIpcCommonOverlapTicks, 340);
    assert.equal(observed.cleanup, 'verified');
    assert.equal(observed.markerNeutralized, true);
    assert.equal(observed.markerRemoved, false);
    assert.equal(observed.markerAttempted, false);
    assert.equal(observed.markerHitVerified, false);
    assert.equal(observed.fsStageVerified, false);
    assert.deepEqual(counts, {copies: 1, logOpens: 1,
      closeLog: 1, closeProtected: 1, closeMoved: 1,
      closePinned: 0, rawSends: 0, cleanups: 1, workers: 1});
  });

test('event pin storage reader uses the exact moved handle twice and closes once',
  async () => {
    const {observed, error, counts} = await simulate({reader: true});
    assert.equal(error, undefined);
    assert.equal(observed.eventPinnedStorageClosed, true);
    assert.equal(observed.independentOrdinaryBaselineMatched, true);
    assert.equal(observed.eventPinnedStorageRead.handle, 450);
    assert.equal(observed.eventPinnedStorageRead.pin.movedHandle, 450);
    assert.equal(observed.eventPinnedStorageRead.pin.requestHex.length, 512);
    assert.equal(observed.eventPinnedStorageRead.pin.replyHex.length, 512);
    assert.equal(observed.eventPinnedStorageRead.size.replyHex.length, 512);
    assert.equal(observed.eventPinnedStorageRead.reads.length, 2);
    assert.ok(observed.eventPinnedStorageRead.reads.every(row =>
      row.handle === 450 && row.requestHex.length === 512 &&
      row.replyHex.length === 512 &&
      row.outputSha256 === sha(ordinaryBytes) && row.guardsIntact));
    assert.equal(observed.markerHitVerified, false);
    assert.equal(observed.fsStageVerified, false);
    assert.equal(counts.closeMoved, 0);
    assert.equal(counts.closePinned, 1);
    assert.equal(counts.rawSends, 3);
    assert.equal(counts.cleanups, 1);
  });

test('reader rejects a transferred read handle and retains the owner', async () => {
  const {observed, error, counts} = await simulate({reader: true,
    readTransfersHandle: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.pinnedStorageHandle, 450);
  assert.equal(error.diagnostic.pinnedStorageClosed, false);
  assert.equal(error.diagnostic.pinnedStorageRead.reads[0].replyHex.length, 512);
  assert.equal(error.diagnostic.ownedCleanupAttempted, false);
  assert.equal(counts.closePinned, 0);
  assert.equal(counts.cleanups, 0);
});

test('reader rejects a transferred size handle before any content read',
  async () => {
    const {observed, error, counts} = await simulate({reader: true,
      sizeTransfersHandle: true});
    assert.equal(observed, undefined);
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.pinnedStorageRead.size.replyHex.length, 512);
    assert.equal(error.diagnostic.pinnedStorageRead.reads.length, 0);
    assert.equal(counts.closePinned, 0);
    assert.equal(counts.cleanups, 0);
  });

test('unknown adopted-storage close retains owner and is never retried',
  async () => {
    const {observed, error, counts} = await simulate({reader: true,
      pinnedCloseFails: true});
    assert.equal(observed, undefined);
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.movedStorageCloseAttempted, true);
    assert.equal(error.diagnostic.pinnedStorageClosed, false);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    assert.equal(counts.closePinned, 1);
    assert.equal(counts.cleanups, 0);
  });

test('ordinary content mismatch fails after one close and complete cleanup',
  async () => {
    const {observed, error, counts} = await simulate({reader: true,
      ordinaryContentChanged: true});
    assert.equal(observed, undefined);
    assert.match(error.message, /independent baseline/);
    assert.equal(error.diagnostic.resourceStateUncertain, false);
    assert.equal(error.diagnostic.pinnedStorageClosed, true);
    assert.equal(error.diagnostic.pinnedStorageRead.baselineMatched, false);
    assert.equal(error.diagnostic.ownedCleanupVerified, true);
    assert.equal(counts.closePinned, 1);
    assert.equal(counts.cleanups, 1);
  });

test('reader baseline must be independent and fully cleaned', () => {
  const baseline = ordinaryBaseline();
  assert.equal(validateOrdinaryBaseline(baseline, arenaNonce).storageBytes,
    57958544);
  assert.throws(() => validateOrdinaryBaseline({...baseline,
    owner: arenaNonce}, arenaNonce), /independent completed/);
  assert.throws(() => validateOrdinaryBaseline({...baseline,
    ownedStorageRead: {...baseline.ownedStorageRead,
      cleanup: 'unknown'}}, arenaNonce), /independent completed/);
});

test('uncertain event reply retains all owner handles without a cleanup retry',
  async () => {
    const {observed, error, counts} = await simulate({badWorkerReply: true});
    assert.equal(observed, undefined);
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.workerRequestSent, true);
    assert.equal(error.diagnostic.workerReleased, false);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    assert.equal(error.diagnostic.protectedCloneClosed, false);
    assert.equal(error.diagnostic.logHandleClosed, false);
    assert.equal(counts.cleanups, 0);
  });

test('unexpected canary result retains exact raw replies and moved storage',
  async () => {
    const {observed, error, counts} = await simulate({unexpectedCanaryType: true});
    assert.equal(observed, undefined);
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.workerReleased, true);
    assert.equal(error.diagnostic.nativeRepliesHex.length, 4);
    assert.equal(error.diagnostic.nativeReceiveSha256, sha(prefix));
    assert.equal(error.diagnostic.movedStorageCloseAttempted, false);
    assert.equal(counts.closeMoved, 0);
    assert.equal(counts.cleanups, 0);
  });

test('moved storage alias to retained marker file is never closed', async () => {
  const {observed, error, counts} = await simulate({movedStorageHandle: 312});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.match(error.cause.message, /aliases a preexisting/);
  assert.equal(error.diagnostic.workerReleased, true);
  assert.equal(error.diagnostic.movedStorageCloseAttempted, false);
  assert.equal(counts.closeMoved, 0);
  assert.equal(counts.cleanups, 0);
});

test('uncertain owner cleanup is one-shot and never reports success', async () => {
  const {observed, error, counts} = await simulate({cleanupFails: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.ownedCleanupAttempted, true);
  assert.equal(error.diagnostic.ownedCleanupVerified, false);
  assert.equal(error.diagnostic.movedStorageClosed, true);
  assert.equal(error.diagnostic.logHandleClosed, true);
  assert.equal(error.diagnostic.protectedCloneClosed, true);
  assert.equal(counts.cleanups, 1);
});

test('counter mismatch fails only after verified exact cleanup', async () => {
  const {observed, error, counts} = await simulate({counterDrift: true});
  assert.equal(observed, undefined);
  assert.match(error.message, /baseline restoration/);
  assert.equal(error.diagnostic.ownedCleanupVerified, true);
  assert.equal(error.diagnostic.resourceStateUncertain, false);
  assert.equal(error.diagnostic.waveRows.length, 4);
  assert.equal(counts.cleanups, 1);
});
