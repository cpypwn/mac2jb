'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {ROLES, OWNER_BYTES, SCRATCH_BYTES, FRAME_BASE_OFFSET,
  FRAME_BYTES, planGapPortLayout} = require('./fs-gap-port-layout.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';

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

function fixture() {
  const scratch = arena + 0x10000;
  let nativeCalls = 0;
  const native = {addresses: {sdk, scratch},
    async write() {nativeCalls++;}, async read() {nativeCalls++;},
    callAddress() {nativeCalls++;}, callAddress6() {nativeCalls++;},
    exchange() {nativeCalls++;}, verifyFunction() {nativeCalls++;}};
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
    markerWrittenAndVerified: true, borrowedSession: 'preserved',
    ownedHandlesOpen: true, explicitSaveWrites: 1,
    root: {role: 'root', handle: 321, closed: false},
    clone: {handle: 311}, file: {handle: 312}, transport,
    context: {arena: BigInt(arena), sdk: BigInt(sdk),
      scratch: BigInt(scratch), nonce: arenaNonce},
    pathAddress: transport.pathAddress,
    receiveAddress: transport.dataAddress};
  return {preflight, prepared, nativeCalls: () => nativeCalls};
}

test('13 exact frames fit after fixed scratch inside the guarded 2 MiB owner', () => {
  const owned = fixture();
  const layout = planGapPortLayout(owned);
  assert.equal(layout.workerKind, 'balatro-gap-13-layout-only');
  assert.deepEqual(layout.frames.map(frame => frame.role), ROLES);
  assert.equal(layout.owner.arenaBytes, OWNER_BYTES);
  assert.equal(layout.scratch.address, arena + 0x10000);
  assert.equal(layout.scratch.end, arena + 0x10000 + SCRATCH_BYTES);
  assert.equal(layout.frameBase, arena + FRAME_BASE_OFFSET);
  assert.equal(layout.frames.at(-1).end,
    arena + FRAME_BASE_OFFSET + 12 * 0x4000 + FRAME_BYTES);
  assert.ok(layout.frames[0].address >= layout.scratch.end);
  assert.ok(layout.frames.at(-1).end < arena + OWNER_BYTES);
  assert.equal(layout.minimumScratchToFrameGapBytes, 0x70000);
  assert.equal(layout.frameLayoutNonoverlapVerified, true);
  assert.equal(layout.nativeFrameHandlesVerified, false);
  assert.equal(layout.targetWorkerQualified, false);
  assert.equal(layout.positiveAttemptAllowed, false);
  assert.equal(layout.markerHitVerified, false);
  assert.equal(layout.fsStageVerified, false);
  assert.ok(layout.unresolved.some(row => row.includes('512 KiB')));
  assert.equal(owned.nativeCalls(), 0);
});

test('stale owner, borrowed handle, or changed scratch cannot pass layout gate', () => {
  const stale = fixture();
  stale.preflight.markerHitVerified = true;
  assert.throws(() => planGapPortLayout(stale), /fresh pinned owner/);
  const borrowed = fixture();
  borrowed.prepared.transport.ownedHandles.add(118);
  assert.throws(() => planGapPortLayout(borrowed), /retained owned handles/);
  const wrongScratch = fixture();
  wrongScratch.prepared.transport.native.addresses.scratch += 0x1000;
  assert.throws(() => planGapPortLayout(wrongScratch), /native scratch/);
});
