'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths: markerPaths} = require('./marker-path-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {claimClone, claimFile, descriptorInput} =
  require('./fs-attempt-packets.cjs');
const {createQualifiedContext, parseOpenServiceReply} =
  require('./fs-counter-probe.cjs');
const {PACKET_OFFSET} = require('./fs-counter-overlap.cjs');
const {requestCommand} = require('./fs-abort-frames.cjs');
const {LOG_PATH, READ_BYTES} = require('./fs-receive-window.cjs');
const {ROLES, CANARY_DESCRIPTOR_OFFSET, buildProtectedCanaryPlan,
  parseProtectedReplies, assessProtectedCanary} =
  require('./fs-protected-canary-plan.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'aabbccddeeff0011';
const prefix = Buffer.alloc(READ_BYTES, 0x5a);

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

function cloneReply(handle) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(0x80000004, 4);
  bytes.writeUInt32LE(1 << 5, 8);
  bytes.writeUInt32LE(handle, 12);
  bytes.write('SFCO', 16);
  return bytes;
}

function ownedFixture() {
  const scratch = arena + 0x10000;
  const native = {addresses: {sdk, scratch},
    async write() {}, async read() {}, callAddress() {}, callAddress6() {},
    exchange() {}, verifyFunction() {}};
  const transport = new BalatroCloneTransport({native,
    evidence: validEvidence(), inspectLive() {}});
  for (const handle of [311, 312, 313, 314]) transport.ownedHandles.add(handle);
  const clone = claimClone({transport, controlReply: cloneReply(311)});
  const protectedClone = claimClone({transport, controlReply: cloneReply(314)});
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
  const log = {path: LOG_PATH, closed: false, handle: 313,
    receiveAddress: transport.dataAddress, prefix};
  return {preflight, prepared, log, protectedClone};
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

function observation(staged, canaryStart = 150, canaryEnd = 600) {
  const ticks = {canary: [canaryStart, canaryEnd], pin: [100, 900],
    receive: [120, 700], trigger: [200, 400]};
  const worker = {waveId, arenaNonce, workerState: 'joined-closed',
    serviceHandles: 'closed', rows: staged.frames.map((frame, index) => ({
      role: frame.role, handle: frame.handle, transportResult: 0,
      startTick: ticks[frame.role][0], endTick: ticks[frame.role][1],
      requestId: `100000000000000${index + 1}`,
      threadId: `000000000000000${index + 1}`}))};
  const type = Buffer.alloc(4);
  type.writeUInt32LE(1);
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(READ_BYTES));
  const replies = [cmif(0, null, type), cmif(0, 450),
    cmif(0, null, length), cmif(0x202)];
  return {worker, replies};
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

function audit() {
  return {coverage: 'bounded-cloned-save-tree',
    completeSaveTreeVerified: true, logPrefixVerified: true,
    logState: 'append-only', changed: []};
}

function cleanup() {
  return {movedStorageClosed: true, logHandleClosed: true,
    protectedCloneClosed: true,
    ownedHandlesClosed: true, markerNeutralized: true, markerRemoved: false,
    borrowedSession: 'preserved', arena: 'released'};
}

test('four exact frames use distinct owned handles and separate path descriptors', () => {
  const fixture = ownedFixture();
  const staged = buildProtectedCanaryPlan({...fixture, waveId});
  assert.equal(staged.workerKind, 'protected-canary-window');
  assert.deepEqual(staged.frames.map(frame => frame.role), ROLES);
  assert.deepEqual(staged.frames.map(frame => frame.handle), [314, 321, 313, 311]);
  assert.deepEqual(staged.frames.map(frame =>
    requestCommand(frame.bytes.subarray(PACKET_OFFSET,
      PACKET_OFFSET + 256))), [7, 200, 0, 7]);
  assert.equal(staged.frames[3].address + 0x3000 < arena + 0x10000, true);
  assert.equal(staged.descriptors.canary.address,
    arena + 0x10000 + CANARY_DESCRIPTOR_OFFSET);
  assert.equal(staged.descriptors.trigger.address,
    arena + 0x10000 + 0x20000);
  assert.equal(staged.receiveAddress, arena + 0x10000 + 0x22000);
  assert.deepEqual(staged.descriptors.canary.bytes,
    descriptorInput(markerNonce, 'marker'));
  assert.deepEqual(staged.descriptors.trigger.bytes,
    descriptorInput(markerNonce, 'absent'));
  assert.equal(staged.descriptors.canary.bytes[0x7ff], 0);
  assert.equal(staged.descriptors.trigger.bytes[0x7ff], 0);
  for (const frame of staged.frames) {
    assert.equal(frame.requestSha256,
      createHash('sha256').update(frame.bytes.subarray(PACKET_OFFSET,
        PACKET_OFFSET + 256)).digest('hex'));
  }
  assert.equal(staged.markerHitVerified, false);
  assert.equal(staged.fsStageVerified, false);
});

test('same clone, closed clone, or changed owner cannot build a protected plan', () => {
  const fixture = ownedFixture();
  assert.throws(() => buildProtectedCanaryPlan({...fixture,
    protectedClone: fixture.prepared.clone, waveId}), /distinct owned/);
  fixture.prepared.transport.ownedHandles.delete(314);
  assert.throws(() => buildProtectedCanaryPlan({...fixture, waveId}),
    /open owned clone/);
  const owned = ownedFixture();
  owned.preflight.markerHitVerified = true;
  assert.throws(() => buildProtectedCanaryPlan({...owned, waveId}),
    /fresh unverified/);
});

test('normal marker type1 is a path control; four-role timing stays client-side', () => {
  const staged = buildProtectedCanaryPlan({...ownedFixture(), waveId});
  const {worker, replies} = observation(staged);
  const parsed = parseProtectedReplies(staged, worker, replies, prefix, prefix);
  const result = assessProtectedCanary({staged, worker, parsed,
    phases: phases(), changedPaths: [], saveAudit: audit(),
    pathBefore: paths(), pathAfter: paths(), cleanup: cleanup()});
  assert.equal(parsed.movedStorageHandle, 450);
  assert.equal(result.clientIpcCommonOverlapTicks, 200);
  assert.equal(result.clientCanarySpansTrigger, true);
  assert.equal(result.clientPinSpansTrigger, true);
  assert.equal(result.clientReceiveSpansTrigger, true);
  assert.equal(result.protectedControl,
    'owned-clone-marker-entry-type-0/type1');
  assert.equal(result.exactAllocationBytes, null);
  assert.equal(result.pinAddress, null);
  assert.equal(result.fsHandlerOverlapMeasured, false);
  assert.equal(result.fsSideMarkerReadbackVerified, false);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.markerNeutralized, true);
  assert.equal(result.markerRemoved, false);
  assert.equal(result.fsStageVerified, false);
  assert.equal(result.waveRows.length, 4);
  assert.equal(result.completeSaveAuditVerified, true);
  assert.equal(result.protectedCloneClosed, true);
});

test('no canary overlap remains a diagnostic miss with no FS-stage claim', () => {
  const staged = buildProtectedCanaryPlan({...ownedFixture(), waveId});
  const {worker, replies} = observation(staged, 10, 50);
  const parsed = parseProtectedReplies(staged, worker, replies, prefix, prefix);
  const result = assessProtectedCanary({staged, worker, parsed,
    phases: phases(), changedPaths: [], saveAudit: audit(),
    pathBefore: paths(), pathAfter: paths(), cleanup: cleanup()});
  assert.equal(result.clientIpcCommonOverlapTicks, 0);
  assert.equal(result.clientCanarySpansTrigger, false);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
});

test('changed marker reply, log prefix, save tree, or cleanup veto assessment', () => {
  const staged = buildProtectedCanaryPlan({...ownedFixture(), waveId});
  const {worker, replies} = observation(staged);
  const wrongType = Buffer.alloc(4);
  wrongType.writeUInt32LE(0);
  assert.throws(() => parseProtectedReplies(staged, worker,
    [cmif(0, null, wrongType), ...replies.slice(1)], prefix, prefix),
  /marker path control/);
  assert.throws(() => parseProtectedReplies(staged, worker, replies,
    Buffer.alloc(READ_BYTES), prefix), /exact serial log prefix/);
  const parsed = parseProtectedReplies(staged, worker, replies, prefix, prefix);
  const input = {staged, worker, parsed, phases: phases(), changedPaths: [],
    saveAudit: audit(), pathBefore: paths(), pathAfter: paths(),
    cleanup: cleanup()};
  assert.throws(() => assessProtectedCanary({...input,
    changedPaths: ['save:/unexpected']}), /save audit/);
  assert.throws(() => assessProtectedCanary({...input,
    cleanup: {...cleanup(), movedStorageClosed: false}}), /cleanup/);
  const drift = phases();
  drift.after.samples[0][5]--;
  drift.after.samples[1][5]--;
  assert.throws(() => assessProtectedCanary({...input, phases: drift}),
    /baseline restoration/);
});
