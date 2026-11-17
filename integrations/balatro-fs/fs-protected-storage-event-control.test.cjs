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
const {READ_BYTES, storageReadPacket} =
  require('./fs-owned-storage-read.cjs');
const {buildGapEventFrame, RESULT_OFFSETS} =
  require('./fs-gap-event-frame.cjs');
const {makeGapEventWorkerSource, MARKER} =
  require('./fs-gap-event-worker.cjs');
const {MODE, ROLES, buildStorageEventControl,
  stageStorageEventControl, runProtectedStorageEventControl} =
  require('./fs-protected-storage-event-control.cjs');
const {verifyProtectedStorageResult, runOneAbortLive} =
  require('./fs-abort-live.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'aabbccddeeff0011';
const ordinaryBytes = Buffer.alloc(READ_BYTES, 0x27);

function sha(bytes) {return createHash('sha256').update(bytes).digest('hex');}

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

function cmif(result, move = null, data = Buffer.alloc(0)) {
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

function cloneReply(handle) {
  const bytes = cmif(0, handle);
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
  transport.registerRawOwned(root.handle);
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
    arena: 'detached', nativeBridge: 'closed', listener: 'closed',
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

function workerReply(preflight, spans) {
  const times = spans ? [[100, 500], [120, 520], [130, 530],
    [200, 400]] : [[100, 500], [120, 520], [130, 300], [200, 400]];
  const rows = times.map(([start, end], index) =>
    `000000000000000${index + 1},${start.toString(16).padStart(16, '0')},${end.toString(16).padStart(16, '0')},0`);
  return `-> ${MARKER}\tfs-gap-event-worker\tok\t${arenaNonce}\t${waveId}\t${preflight.arenaBase}\t${preflight.sdkBase}\t${MODE}\tjoined-closed\t4\t${rows.join(';')}\tevent-finalized\tarena-retained`;
}

function writeWorkerResults(memory, frames, prepared, spans,
  {pinMove = 450, receiveMove = null} = {}) {
  const type = Buffer.alloc(4); type.writeUInt32LE(1);
  const replies = [cmif(0, null, type), cmif(0, pinMove),
    cmif(0, receiveMove), cmif(0x202)];
  const times = spans ? [[100, 500], [120, 520], [130, 530],
    [200, 400]] : [[100, 500], [120, 520], [130, 300], [200, 400]];
  frames.forEach((frame, index) => {
    const bytes = memory.get(frame.address);
    bytes.writeBigUInt64LE(BigInt(times[index][0]),
      RESULT_OFFSETS.startTick);
    bytes.writeBigUInt64LE(0n, RESULT_OFFSETS.transportResult);
    bytes.writeBigUInt64LE(BigInt(times[index][1]),
      RESULT_OFFSETS.endTick);
    replies[index].copy(bytes, 0x2000);
  });
  memory.set(prepared.receiveAddress, Buffer.from(ordinaryBytes));
}

async function simulate({spans = true, openTimeout = false,
  childHandle = 313, receiveMove = null, pinMove = 450,
  childCloseFails = false, pinCloseFails = false,
  badWorkerReply = false, serialChanged = false,
  markerRemoved = false} = {}) {
  const {preflight, prepared, memory, native, transport} = setup();
  const counts = {copies: 0, opens: 0, sizes: 0, serialReads: 0,
    closeChild: 0, closePin: 0, closeProtected: 0,
    workers: 0, cleanups: 0};
  transport.sendControl = async () => {
    counts.copies++;
    transport.ownedHandles.add(314);
    return cloneReply(314);
  };
  transport.readClone = async (_handle, path) => path.includes('absent') ?
    pathStates().original.absent : pathStates().original.marker;
  transport.sendPacket = async (handle, bytes) => {
    const command = bytes.readUInt32LE(24);
    if (handle === 321 && command === 200) {
      counts.opens++;
      assert.deepEqual(bytes, packet(200));
      if (openTimeout) throw Error('open response timed out');
      return cmif(0, childHandle);
    }
    if (handle === 313 && command === 4) {
      counts.sizes++;
      assert.deepEqual(bytes, packet(4));
      const size = Buffer.alloc(8);
      size.writeBigUInt64LE(57958544n);
      return cmif(0, null, size);
    }
    if (handle === 313 && command === 0) {
      counts.serialReads++;
      assert.deepEqual(bytes, storageReadPacket(transport.scratch + 0x50000));
      memory.set(transport.scratch + 0x50000,
        Buffer.from(serialChanged ? Buffer.alloc(READ_BYTES, 0x28) :
          ordinaryBytes));
      return cmif(0);
    }
    throw Error(`unexpected raw IPC ${handle}/${command}`);
  };
  transport.closeOwned = async handle => {
    if (handle === 314) counts.closeProtected++;
    else if (handle === 313) {
      counts.closeChild++;
      if (childCloseFails) throw Error('child close response lost');
    } else throw Error(`unexpected owned close ${handle}`);
    assert.equal(transport.ownedHandles.delete(handle), true);
    return {closed: true, closeResult: 0};
  };
  transport.closeRawOwned = async handle => {
    assert.equal(handle, 450);
    counts.closePin++;
    if (pinCloseFails) throw Error('pin close response lost');
    assert.equal(transport.rawOwnedHandles.delete(handle), true);
    return {closed: true, closeResult: 0,
      method: 'worker-svcCloseHandle'};
  };
  native.call = async () => {throw Error('unexpected main-thread storage close');};
  const adapter = {
    async inspect() {return {state: 'serving',
      gameProfile: profile.gameProfile,
      runtimeVersion: profile.runtimeVersion,
      codeHeadProfile: '1.0.1f', sdkBase: preflight.sdkBase,
      arenaBase: preflight.arenaBase, arenaNonce,
      ownerState: 'ready', workers: 0, ownedHandles: 0};},
    async prepare(input) {assert.equal(input, preflight); return prepared;},
    async readPaths() {return pathStates();},
    async counterPair() {return counterPhase();},
    async auditPaths() {return [];},
    auditDetails() {return {coverage: 'bounded-cloned-save-tree',
      completeSaveTreeVerified: true, logPrefixVerified: true,
      logState: 'append-only', changed: []};},
    async cleanup(input) {
      assert.equal(input, prepared);
      assert.equal(transport.ownedHandles.has(313), false);
      assert.equal(transport.ownedHandles.has(314), false);
      counts.cleanups++;
      return {ownedHandlesClosed: true, markerNeutralized: !markerRemoved,
        markerRemoved,
        borrowedSession: 'preserved', arena: 'released'};
    },
  };
  const frames = [];
  const originalWrite = native.write;
  native.write = async (address, bytes) => {
    await originalWrite(address, bytes);
    if (bytes.length === 0x3000 && address >= arena + 0x100000)
      frames.push({address, packetAddress: address + 0x2000,
        role: ROLES[frames.length],
        handle: [314, 321, 313, 311][frames.length]});
  };
  const executeSource = async ({source}) => {
    counts.workers++;
    assert.match(source, /BAL_GAP_EVENT_WORKER_V1/);
    assert.match(source, /protected-storage-event-control/);
    assert.equal(frames.length, 4);
    assert.deepEqual(frames.map(frame => frame.handle),
      [314, 321, 313, 311]);
    assert.deepEqual(memory.get(frames[2].address).subarray(0x2000, 0x2100),
      storageReadPacket(prepared.receiveAddress));
    if (badWorkerReply) return `-> ${MARKER}\tfs-gap-event-worker\tfail`;
    writeWorkerResults(memory, frames, prepared, spans,
      {pinMove, receiveMove});
    return workerReply(preflight, spans);
  };
  let observed, error;
  try {
    observed = await runProtectedStorageEventControl({preflight, adapter,
      executeSource, host: '10.0.0.189', macIp: '10.0.0.205',
      port: 39381, mainBase: '0x4900000000',
      waveId, ordinaryBaseline: ordinaryBaseline()});
  } catch (cause) {error = cause;}
  return {observed, error, counts, transport};
}

test('storage event uses one distinct root child, exact IStorage packet, and one close each',
  async () => {
    const {observed, error, counts} = await simulate();
    assert.equal(error, undefined);
    assert.deepEqual(observed.waveRows.map(row => row.role), ROLES);
    assert.deepEqual(observed.frameProvenance.map(row => row.handle),
      [314, 321, 313, 311]);
    assert.equal(observed.receiveStorage.open.parentRootHandle, 321);
    assert.equal(observed.receiveStorage.open.movedHandle, 313);
    assert.equal(observed.receiveStorage.open.requestHex.length, 512);
    assert.equal(observed.receiveStorage.open.replyHex.length, 512);
    assert.equal(observed.receiveStorage.size.storageBytes, 57958544);
    assert.equal(observed.receiveStorage.serial.requestHex.length, 512);
    assert.equal(observed.receiveStorage.serial.replyHex.length, 512);
    assert.equal(observed.eventRead.requestHex.length, 512);
    assert.equal(observed.eventRead.replyHex.length, 512);
    assert.equal(observed.eventRead.outputSha256, sha(ordinaryBytes));
    assert.equal(observed.receiveStorage.close.resultHex, '0x0');
    assert.equal(observed.pinStorage.close.resultHex, '0x0');
    assert.equal(observed.receiveStorage.close.method, 'worker-svcCloseHandle');
    assert.equal(observed.pinStorage.close.method, 'worker-svcCloseHandle');
    assert.equal(observed.cleanup, 'verified');
    assert.equal(observed.markerNeutralized, true);
    assert.equal(observed.markerRemoved, false);
    assert.equal(observed.fsHandlerOverlapMeasured, false);
    assert.equal(observed.markerHitVerified, false);
    assert.equal(observed.fsStageVerified, false);
    assert.equal(observed.clientReceiveSpansTrigger, true);
    assert.deepEqual(counts, {copies: 1, opens: 1, sizes: 1,
      serialReads: 1, closeChild: 1, closePin: 1,
      closeProtected: 1, workers: 1, cleanups: 1});
  });

test('storage event records a measured receive miss without promoting stage',
  async () => {
    const {observed, error} = await simulate({spans: false});
    assert.equal(error, undefined);
    assert.equal(observed.clientReceiveSpansTrigger, false);
    assert.equal(observed.markerHitVerified, false);
    assert.equal(observed.fsStageVerified, false);
  });

test('storage event reports a verified removal if cleanup later supports it', async () => {
  const {observed, error} = await simulate({markerRemoved: true});
  assert.equal(error, undefined);
  assert.equal(observed.markerNeutralized, false);
  assert.equal(observed.markerRemoved, true);
});

test('opt-in CLI result gate requires false stage claims and exact storage closure',
  async () => {
    const {observed, error} = await simulate();
    assert.equal(error, undefined);
    assert.equal(verifyProtectedStorageResult(observed), true);
    assert.throws(() => verifyProtectedStorageResult({
      ...observed, fsStageVerified: true}), /exact cleanup/);
    assert.throws(() => verifyProtectedStorageResult({
      ...observed, receiveStorageClosed: false}), /exact cleanup/);
    let images = 0;
    await assert.rejects(runOneAbortLive({host: '10.0.0.189',
      macIp: '10.0.0.205', nonce: arenaNonce,
      mode: 'protected-storage-event-control',
      image: async () => {images++;}}), /ordinary baseline/);
    assert.equal(images, 0);
  });

test('ambiguous child open retains the owner before any event worker', async () => {
  const {observed, error, counts} = await simulate({openTimeout: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.receiveOpenAttempted, true);
  assert.equal(error.diagnostic.receiveStorage, null);
  assert.equal(error.diagnostic.ownedCleanupAttempted, false);
  assert.equal(counts.workers, 0);
  assert.equal(counts.cleanups, 0);
});

test('child handle alias is uncertain and never starts the event worker',
  async () => {
    const {observed, error, counts} = await simulate({childHandle: 312});
    assert.equal(observed, undefined);
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(counts.workers, 0);
    assert.equal(counts.cleanups, 0);
  });

test('unexpected IStorage event handle transfer retains both storage owners',
  async () => {
    const {observed, error, counts} = await simulate({receiveMove: 777});
    assert.equal(observed, undefined);
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.rawReplies[2].hex.length, 512);
    assert.equal(error.diagnostic.receiveStorage.closed, false);
    assert.equal(error.diagnostic.pinMovedHandle, 450);
    assert.equal(counts.closeChild, 0);
    assert.equal(counts.closePin, 0);
    assert.equal(counts.cleanups, 0);
  });

test('pin moved handle cannot alias the preopened receive child', async () => {
  const {observed, error, counts} = await simulate({pinMove: 313});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(counts.closeChild, 0);
  assert.equal(counts.cleanups, 0);
});

test('unknown child close is one-shot and retains the owner', async () => {
  const {observed, error, counts} = await simulate({childCloseFails: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.receiveCloseAttempted, true);
  assert.equal(error.diagnostic.receiveClosed, false);
  assert.equal(error.diagnostic.storageClosePhase, 'close-receive-storage');
  assert.equal(counts.closeChild, 1);
  assert.equal(counts.closePin, 1);
  assert.equal(counts.cleanups, 0);
});

test('unknown pin worker close identifies its phase and retains the owner', async () => {
  const {observed, error, counts} = await simulate({pinCloseFails: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.storageClosePhase, 'close-pin-storage');
  assert.equal(error.diagnostic.pinCloseAttempted, true);
  assert.equal(error.diagnostic.pinClosed, false);
  assert.equal(counts.closePin, 1);
  assert.equal(counts.closeChild, 0);
  assert.equal(counts.cleanups, 0);
});

test('serial ordinary mismatch closes known child and owner before a worker',
  async () => {
    const {observed, error, counts} = await simulate({serialChanged: true});
    assert.equal(observed, undefined);
    assert.match(error.message, /ordinary content/);
    assert.equal(error.diagnostic.resourceStateUncertain, false);
    assert.equal(error.diagnostic.receiveClosed, true);
    assert.equal(counts.workers, 0);
    assert.equal(counts.closeChild, 1);
    assert.equal(counts.cleanups, 1);
  });

test('event source is a bounded four-role gate and altered packet is rejected before writes',
  async t => {
    const {preflight, prepared, transport, native, memory} = setup();
    transport.ownedHandles.add(314);
    transport.ownedHandles.add(313);
    const protectedClone = {handle: 314, closed: false,
      capability: claimClone({transport,
        controlReply: cloneReply(314)})};
    const receiveStorage = {owner: arenaNonce, handle: 313,
      closed: false,
      open: {parentRootHandle: 321, movedHandle: 313,
        replySha256: sha(cmif(0, 313))},
      size: {storageBytes: 57958544},
      serial: {output: Buffer.from(ordinaryBytes),
        outputSha256: sha(ordinaryBytes), guardsIntact: true,
        markerBytesAbsent: true}};
    const staged = buildStorageEventControl({preflight, prepared,
      protectedClone, receiveStorage,
      baseline: ordinaryBaseline(), waveId});
    const receipt = await stageStorageEventControl(native, staged);
    assert.equal(receipt.exactReadbackVerified, true);
    assert.equal(memory.get(staged.protectedPlan.receiveAddress).length,
      READ_BYTES);
    const options = {nonce: arenaNonce, waveId,
      arenaBase: preflight.arenaBase, sdkBase: preflight.sdkBase,
      mainBase: '0x4900000000', hostIp: '10.0.0.205',
      port: 39381, staged, stageReceipt: receipt};
    const source = makeGapEventWorkerSource(options);
    assert.match(source, /protected-storage-event-control/);
    assert.match(source, /hold\.phase='cleanup-signal'/);
    assert.match(source, /hold\.phase='event-finalize'/);
    const available = spawnSync('luajit', ['-v'], {encoding: 'utf8'});
    if (!available.error) {
      const parsed = spawnSync('luajit', ['-e',
        'local s=io.read("*a"); local f,e=loadstring(s); if not f then io.stderr:write(e); os.exit(1) end'],
      {input: source, encoding: 'utf8'});
      assert.equal(parsed.status, 0, parsed.stderr);
    } else if (available.error?.code === 'ENOENT')
      t.diagnostic('LuaJIT unavailable; structural source checks passed');
    staged.frames[2] = buildGapEventFrame({layout: staged.layout,
      role: 'receive', handle: 313,
      request: packet(1009)});
    let writes = 0;
    const noWrite = {addresses: native.addresses,
      async write() {writes++;}, async read() {throw Error('unexpected read');}};
    await assert.rejects(stageStorageEventControl(noWrite, staged),
      /event frame ownership changed/);
    assert.equal(writes, 0);
  });
