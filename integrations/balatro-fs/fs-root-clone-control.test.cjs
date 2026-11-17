'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const test = require('node:test');
const domain =
  require('../civswitch/fs-kit/port/engine/shared/domain.cjs');
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
const {CLONE_REQUEST, COUNTER_REQUEST, runRootCloneControl} =
  require('./fs-root-clone-control.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';

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

function cmif(result, moves = [], copies = [], data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(256);
  const special = moves.length > 0 || copies.length > 0;
  bytes.writeUInt32LE(special ? 0x80000004 : 4, 4);
  if (special) {
    bytes.writeUInt32LE((copies.length << 1) | (moves.length << 5), 8);
    let at = 12;
    for (const handle of copies) {bytes.writeUInt32LE(handle, at); at += 4;}
    for (const handle of moves) {bytes.writeUInt32LE(handle, at); at += 4;}
  }
  const at = ((special ? 12 + 4 * (moves.length + copies.length) : 8) +
    15) & ~15;
  bytes.write('SFCO', at);
  bytes.writeUInt32LE(result, at + 8);
  data.copy(bytes, at + 16);
  return bytes;
}

function setup() {
  const scratch = arena + 0x10000;
  const native = {addresses: {sdk, scratch},
    async write() {}, async read() {return Buffer.alloc(0);},
    callAddress() {}, callAddress6() {}, exchange() {}, verifyFunction() {}};
  const transport = new BalatroCloneTransport({native,
    evidence: evidence(), inspectLive() {}});
  for (const handle of [311, 312]) transport.ownedHandles.add(handle);
  const clone = claimClone({transport,
    controlReply: cmif(0, [311])});
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
  return {preflight, prepared, transport, native};
}

function pathStates() {
  const marker = {result: 0, type: 1, bytes: content(markerNonce)};
  const absent = {result: 0x202, type: null, bytes: null};
  return {original: {marker, absent}, cloned: {marker, absent},
    padded: {marker, absent}, explicitSaveWrites: 0};
}

function counters(generalHeap = 100000) {
  const values = Array(16).fill(0);
  values[5] = generalHeap;
  const bytes = Buffer.alloc(128);
  values.forEach((value, index) =>
    bytes.writeBigUInt64LE(BigInt(value), index * 8));
  return cmif(0, [], [], bytes);
}

async function simulate({cloneTimeout = false,
  cloneMalformed = false, cloneMoves = [322], cloneCopies = [],
  counterTransfer = false, counterMalformed = false,
  counterResult = 0, closeFails = false,
  baselineDrift = false, cleanupFails = false} = {}) {
  const {preflight, prepared, transport, native} = setup();
  const counts = {control2: 0, rootCounters: 0, cloneCounters: 0,
    cloneCloses: 0, ownerCleanups: 0};
  let cloneOpen = false;
  let cloneClosed = false;
  transport.sendPacket = async (handle, bytes) => {
    if (bytes.equals(CLONE_REQUEST)) {
      assert.equal(handle, 321);
      counts.control2++;
      if (cloneTimeout) throw Error('root clone response timed out');
      if (cloneMalformed) return Buffer.alloc(256);
      cloneOpen = true;
      return cmif(0, cloneMoves, cloneCopies);
    }
    assert.deepEqual(bytes, COUNTER_REQUEST);
    assert.ok(handle === 321 || handle === 322);
    if (handle === 321) counts.rootCounters++;
    else counts.cloneCounters++;
    if (handle === 322 && counterMalformed) return Buffer.alloc(256);
    if (handle === 322 && counterTransfer)
      return cmif(0, [999], [], Buffer.alloc(128));
    if (handle === 322 && counterResult)
      return cmif(counterResult, [], [], Buffer.alloc(128));
    return counters(cloneOpen ? 99900 :
      cloneClosed && baselineDrift ? 99999 : 100000);
  };
  transport.closeOwned = async handle => {
    assert.equal(handle, 322);
    counts.cloneCloses++;
    if (closeFails) throw Error('close reply lost');
    cloneOpen = false;
    cloneClosed = true;
    transport.ownedHandles.delete(handle);
    return {closed: true, closeResult: 0, method: 'worker-svcCloseHandle'};
  };
  const adapter = {
    async inspect() {return {state: 'serving',
      gameProfile: profile.gameProfile,
      runtimeVersion: profile.runtimeVersion,
      codeHeadProfile: '1.0.1f', sdkBase: preflight.sdkBase,
      arenaBase: preflight.arenaBase, arenaNonce,
      ownerState: 'ready', workers: 0, ownedHandles: 0};},
    async prepare(input) {assert.equal(input, preflight); return prepared;},
    async readPaths() {return pathStates();},
    async auditPaths() {return [];},
    auditDetails() {return {coverage: 'bounded-cloned-save-tree',
      completeSaveTreeVerified: true, logPrefixVerified: true,
      logState: 'append-only', changed: []};},
    async cleanup(input) {
      assert.equal(input, prepared);
      assert.deepEqual([...transport.ownedHandles].sort(), [311, 312]);
      counts.ownerCleanups++;
      if (cleanupFails) throw Error('owner close response lost');
      return {ownedHandlesClosed: true, markerNeutralized: true,
        markerRemoved: false,
        borrowedSession: 'preserved', arena: 'released'};
    },
  };
  let observed, error;
  try {observed = await runRootCloneControl({preflight, adapter});}
  catch (cause) {error = cause;}
  return {observed, error, counts, transport};
}

test('exact control(2) request and one moved root produce bounded counter proof',
  async () => {
    assert.equal(CLONE_REQUEST.length, 256);
    assert.equal(CLONE_REQUEST.readUInt32LE(0), 5);
    assert.equal(CLONE_REQUEST.readUInt32LE(
      domain.dataStart(CLONE_REQUEST) + 8), 2);
    assert.deepEqual(COUNTER_REQUEST, packet(1009));
    const {observed, error, counts} = await simulate();
    assert.equal(error, undefined);
    assert.equal(observed.cloneCounterVerified, true);
    assert.equal(observed.originalRootPreserved, true);
    assert.equal(observed.counterBaselineRestored, true);
    assert.equal(observed.clonedRootHandle, 322);
    assert.equal(observed.cloneRequest.movedHandle, 322);
    assert.equal(observed.cloneRequest.requestSha256, sha(CLONE_REQUEST));
    assert.equal(observed.cloneRequest.replyHex.length, 512);
    assert.equal(observed.cloneClose.resultHex, '0x0');
    assert.equal(observed.cloneClose.method, 'worker-svcCloseHandle');
    assert.equal(observed.heldGeneralHeapDelta, 100);
    assert.equal(observed.counterPhases.cloneHeld.rawReplies.length, 3);
    assert.ok(observed.counterPhases.cloneHeld.rawReplies.every(row =>
      row.replyHex.length === 512 &&
      row.requestSha256 === sha(COUNTER_REQUEST)));
    assert.equal(observed.rootClonesOpened, 1);
    assert.equal(observed.rootClonesClosed, 1);
    assert.equal(observed.domainConverted, false);
    assert.equal(observed.groupObjectsOpened, 0);
    assert.equal(observed.storageHandlesOpened, 0);
    assert.equal(observed.workerStarted, false);
    assert.equal(observed.markerHitVerified, false);
    assert.equal(observed.markerNeutralized, true);
    assert.equal(observed.markerRemoved, false);
    assert.equal(observed.fsStageVerified, false);
    assert.deepEqual(counts, {control2: 1, rootCounters: 15,
      cloneCounters: 3, cloneCloses: 1, ownerCleanups: 1});
  });

test('ambiguous control timeout retains owner and does not retry', async () => {
  const {observed, error, counts} = await simulate({cloneTimeout: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.cloneOpenAttempted, true);
  assert.equal(error.diagnostic.cloneHandle, null);
  assert.equal(error.diagnostic.ownedCleanupAttempted, false);
  assert.equal(counts.control2, 1);
  assert.equal(counts.cloneCloses, 0);
  assert.equal(counts.ownerCleanups, 0);
});

test('malformed control reply retains raw bytes and owner', async () => {
  const {observed, error, counts} = await simulate({cloneMalformed: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.cloneReplyHex.length, 512);
  assert.equal(counts.cloneCloses, 0);
  assert.equal(counts.ownerCleanups, 0);
});

test('aliased or extra moved root reply retains the owner', async () => {
  for (const moves of [[311], [322, 323]]) {
    const {observed, error, counts} = await simulate({cloneMoves: moves});
    assert.equal(observed, undefined);
    assert.equal(error.resourceStateUncertain, true);
    assert.deepEqual(error.diagnostic.movedHandles, moves);
    assert.equal(error.diagnostic.ownedCleanupAttempted, false);
    assert.equal(counts.cloneCloses, 0);
  }
});

test('copied root reply is not accepted as an owned clone', async () => {
  const {observed, error, counts} = await simulate({
    cloneMoves: [], cloneCopies: [322]});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.deepEqual(error.diagnostic.copiedHandles, [322]);
  assert.equal(counts.cloneCloses, 0);
  assert.equal(counts.ownerCleanups, 0);
});

test('counter reply that moves a handle retains raw evidence and clone',
  async () => {
    const {observed, error, counts} = await simulate({counterTransfer: true});
    assert.equal(observed, undefined);
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.diagnostic.rawReplies[0].replyHex.length, 512);
    assert.deepEqual(error.diagnostic.movedHandles, [999]);
    assert.equal(error.diagnostic.cloneHandle, 322);
    assert.equal(counts.cloneCloses, 0);
    assert.equal(counts.ownerCleanups, 0);
  });

test('unknown clone close is one-shot and retains owner', async () => {
  const {observed, error, counts} = await simulate({closeFails: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.cloneCloseAttempted, true);
  assert.equal(error.diagnostic.cloneClosed, false);
  assert.equal(counts.cloneCloses, 1);
  assert.equal(counts.ownerCleanups, 0);
});

test('known nonzero clone counter closes clone and owner without qualification',
  async () => {
    const {observed, error, counts} = await simulate({counterResult: 514});
    assert.equal(observed, undefined);
    assert.match(error.message, /counter reply changed/);
    assert.equal(error.diagnostic.resourceStateUncertain, false);
    assert.equal(error.diagnostic.cloneClosed, true);
    assert.equal(error.diagnostic.ownedCleanupVerified, true);
    assert.equal(counts.cloneCloses, 1);
    assert.equal(counts.ownerCleanups, 1);
  });

test('baseline drift rejects result after exact one-shot cleanup', async () => {
  const {observed, error, counts} = await simulate({baselineDrift: true});
  assert.equal(observed, undefined);
  assert.match(error.message, /baseline restoration failed/);
  assert.equal(error.diagnostic.resourceStateUncertain, false);
  assert.equal(error.diagnostic.cloneClosed, true);
  assert.equal(error.diagnostic.ownedCleanupVerified, true);
  assert.equal(counts.cloneCloses, 1);
  assert.equal(counts.ownerCleanups, 1);
});

test('owner cleanup uncertainty never reports clone qualification', async () => {
  const {observed, error, counts} = await simulate({cleanupFails: true});
  assert.equal(observed, undefined);
  assert.equal(error.resourceStateUncertain, true);
  assert.equal(error.diagnostic.ownedCleanupAttempted, true);
  assert.equal(error.diagnostic.ownedCleanupVerified, false);
  assert.equal(counts.cloneCloses, 1);
  assert.equal(counts.ownerCleanups, 1);
});
