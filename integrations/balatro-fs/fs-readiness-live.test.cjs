'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {PHASES, assessStaircase} = require('./fs-pinning-staircase.cjs');
const {createQualifiedContext, parseOpenServiceReply} =
  require('./fs-counter-probe.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {claimClone, claimFile} = require('./fs-attempt-packets.cjs');
const {assessFirstDescriptor, assessPositiveWaveReadiness} =
  require('./canary-attempt-readiness.cjs');
const {assessNativeOverlap} = require('./marker-wave-readiness.cjs');
const {buildFirstDescriptor, fsWorkerFromWave, traceFromWave,
  assemblePositiveEvidence, runReadinessControl} =
  require('./fs-readiness-live.cjs');

// --- Pure assembly fixtures (offline shapes) ---
const sdkBase = '0x28b04b4000';
const arenaBase = '0x3cb18f8000';
const arenaNonce = '0123456789abcdef';
const cloneNonce = 'fedcba9876543210';
const markerNonce = '89abcdef01234567';
const nonceBytes = () => Buffer.from(markerNonce, 'hex');

const sample = value => {const row = Array(16).fill(0); row[5] = value; return row;};
const phase = value => ({samples: [sample(value), sample(value)]});
const present = () => ({result: 0, type: 1, bytes: content(markerNonce)});
const absent = () => ({result: 0x202, type: null, bytes: null});

function staircase() {
  const values = [100000, 100000, 85904, 71808, 85904, 100000, 100000];
  const phases = Object.fromEntries(PHASES.map((name, index) =>
    [name, phase(values[index])]));
  const cycle = () => ({phases, assessment: assessStaircase(phases),
    cleanup: 'released'});
  return {gameProfile: profile.gameProfile, nonce: arenaNonce, arenaBase,
    cycles: [cycle(), cycle()], repeatabilityVerified: true,
    candidateDiagnosticCostBytes: 14096, exactAllocationBytes: null,
    markerAttempted: false, saveWrites: 0, cleanup: 'released'};
}

function worker() {
  return {gameProfile: profile.gameProfile, nonce: arenaNonce,
    arenaBase, sdkBase, samples: 2, workerRepeatabilityVerified: true,
    cleanup: 'released', markerAttempted: false};
}

function clone() {
  const owned = paths(cloneNonce);
  return {gameProfile: profile.gameProfile, nonce: cloneNonce,
    arenaNonce, sdkBase, marker: owned.marker, absent: owned.absent,
    ownedCloneVerified: true, markerContentVerified: true,
    absentPathVerified: true, cleanup: 'verified',
    markerWaveAttempted: false, nativeTransport: 'closed',
    borrowedSession: 'preserved'};
}

function localization() {
  return {gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion, sdkBase, arenaBase,
    arenaNonce, nativeCounterFrequencyVerified: true,
    serialReceiveOrderVerified: true, candidateDiagnosticCostBytes: 14096,
    nativeOrderSaveWrites: 0, exactAllocationBytes: null, pinAddress: null,
    concurrentOverlapMeasured: false, markerHitVerified: false,
    fsStageVerified: false};
}

function traceWave(waveId = '1111111111111111') {
  const hex16 = n => n.toString(16).padStart(16, '0');
  const row = (role, requestKind, start, end) => ({role, requestKind,
    requestId: hex16(start), threadId: hex16(end),
    startTick: start, endTick: end, transportResult: 0, ipcResult: 0});
  return {waveId, sdkBase, arenaNonce, clock: 'native-counter',
    nativeCounterFrequencyVerified: true,
    rows: [row('pin', 'owned-storage-open', 101, 151),
      row('receive', 'receive-buffer-request', 105, 161),
      row('trigger', 'cloned-save-entry-type', 110, 130)]};
}

function pathStates() {
  const state = () => ({marker: present(), absent: absent()});
  return {original: state(), cloned: state(), padded: state(),
    explicitSaveWrites: 0};
}

function abortRun(waveId) {
  return {preflight: {gameProfile: profile.gameProfile, sdkBase, arenaBase,
    arenaNonce, markerNonce, markerHitVerified: false,
    exactAllocationBytes: null},
  sdkBase, arenaNonce, nonce: markerNonce, waveId,
    overlap: {qualified: true, triggerStartTick: 110, triggerEndTick: 130,
      heldRoles: ['pin'], throughRoles: ['receive']},
    phases: {before: phase(100000), noStorageBefore: phase(100000),
      after: phase(100000), noStorageAfter: phase(100000)},
    negativePathControl: 'executed-absent-path-0x202',
    saveWrites: 0, cleanup: 'verified', borrowedSession: 'preserved',
    changedPaths: [],
    readback: {markerBefore: present(), markerAfter: present(),
      absentBefore: absent(), absentAfter: absent()}};
}

function assemble() {
  const firstDescriptor = buildFirstDescriptor(markerNonce);
  const trace = traceFromWave({wave: traceWave(),
    preflight: {sdkBase, arenaNonce}});
  const fsWorker = fsWorkerFromWave({preflight: {gameProfile: profile.gameProfile,
    sdkBase, arenaBase, arenaNonce, markerNonce}});
  const abortRuns = [abortRun('aaaaaaaaaaaaaaaa'),
    abortRun('bbbbbbbbbbbbbbbb')];
  return assemblePositiveEvidence({localization: localization(),
    worker: worker(), staircase: staircase(), clone: clone(),
    fsWorker, trace, firstDescriptor, abortRuns, pathStates: pathStates(),
    markerRetained: true, ownedHandlesClosed: true}, nonceBytes);
}

test('derived first descriptor, trace, and FS worker pass their assessors', () => {
  const descriptor = buildFirstDescriptor(markerNonce);
  assert.equal(descriptor.mode, 'balatro-first-descriptor');
  assessFirstDescriptor(descriptor, markerNonce);

  const trace = traceFromWave({wave: traceWave(), preflight: {sdkBase, arenaNonce}});
  assert.equal(trace.requestSet, 'balatro-pin-receive-trigger');
  assert.ok(trace.rows.every(row => row.counterSource === 'native-worker'));

  const fsWorker = fsWorkerFromWave({preflight: {gameProfile: profile.gameProfile,
    sdkBase, arenaBase, arenaNonce, markerNonce}});
  assert.equal(fsWorker.nativeCounterHz, 19200000);
  assert.equal(fsWorker.integratedFsWorkerVerified, true);
  assessNativeOverlap({localization: localization(), worker: fsWorker, trace});
});

test('assembled evidence authorizes one bounded matched comparison', () => {
  const evidence = assemble();
  assert.equal(evidence.attempt.phase, 'abort-controls');
  assert.equal(evidence.abortRuns.length, 2);
  assert.equal(evidence.pathControl.source, 'current-owned-clone-and-padded-path');
  assert.equal(evidence.pathControl.markerRetained, true);
  assert.equal(evidence.pathControl.ownedHandleClosed, true);
  const gate = assessPositiveWaveReadiness(evidence);
  assert.equal(gate.positiveWaveAllowed, true);
  assert.equal(gate.phase, 'single-matched-comparison');
  assert.equal(gate.abortControlsVerified, true);
  assert.equal(gate.nativePaddedLookupVerified, true);
  assert.equal(gate.markerNonce, markerNonce);
});

// --- runReadinessControl (real transport-backed adapter) ---
const sdk = 0x57390b4000;
const arena = 0x4964000000;
const liveArenaNonce = '0123456789abcdef';
const liveMarkerNonce = 'fedcba9876543210';
const livePreflight = {gameProfile: profile.gameProfile,
  sdkBase: `0x${sdk.toString(16)}`, arenaBase: `0x${arena.toString(16)}`,
  arenaNonce: liveArenaNonce, markerNonce: liveMarkerNonce,
  exactAllocationBytes: null, markerHitVerified: false, fsStageVerified: false};

function movedHandle(handle) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(0x80000004, 4);
  bytes.writeUInt32LE(1 << 5, 8);
  bytes.writeUInt32LE(handle, 12);
  bytes.write('SFCO', 16);
  return bytes;
}

function preparedLease() {
  const scratch = arena + 0x10000;
  const context = createQualifiedContext({arenaBase: livePreflight.arenaBase,
    nonce: liveArenaNonce,
    hello: {status: 'read-only transport handshake verified',
      scratch: `0x${scratch.toString(16)}`, scratchBytes: 0x80000,
      sdkBase: livePreflight.sdkBase,
      sdkCrc32: Number.parseInt(profile.sdkCode.offlineCrc32, 16)},
    crc: {gameProfile: profile.gameProfile, nonce: liveArenaNonce,
      port: 39381, sdkBase: livePreflight.sdkBase,
      sdkCrc32: profile.sdkCode.offlineCrc32}});
  const rootReply = Buffer.alloc(0x8010);
  rootReply.writeUInt32LE(321, 16);
  const root = parseOpenServiceReply(rootReply, context);
  const manager = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
  const evidence = {gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    nonce: '9876543210abcdef', sdkBase: livePreflight.sdkBase,
    mount: {name: 'save', accessor: '0x49646472a0',
      implementation: '0x4964689680', service: '0x49646896a0',
      serviceVtable: `0x${(sdk + 0xcec000).toString(16)}`,
      serviceVtableOffset: '0xcec000',
      manager: `0x${manager.toString(16)}`, objectId: 412,
      guardsVerified: true},
    proxy: {object: `0x${(sdk +
      Number(BigInt(captured.fsProxy.objectSdkOffset))).toString(16)}`,
      manager: `0x${manager.toString(16)}`, objectId: 153},
    sessionManager: {stateSize: 2048, stateValue: 3,
      slot: '0x4964a0a000', borrowedHandle: 118},
    absentPathResult: '0x00000202',
    status: 'read-only; mounted domain not cloned'};
  const native = {addresses: {sdk, scratch},
    write() {}, read() {}, callAddress() {}, callAddress6() {},
    exchange() {}, verifyFunction() {}};
  const transport = new BalatroCloneTransport({native, evidence,
    inspectLive() {}});
  transport.ownedHandles.add(311);
  transport.ownedHandles.add(312);
  const clone = claimClone({transport, controlReply: movedHandle(311)});
  const file = claimFile({clone,
    openReply: {result: 0, moves: [312], copies: []}});
  return {arenaNonce: liveArenaNonce, markerNonce: liveMarkerNonce,
    sdkBase: livePreflight.sdkBase,
    markerPath: paths(liveMarkerNonce).marker,
    absentPath: paths(liveMarkerNonce).absent,
    markerWrittenAndVerified: true, borrowedSession: 'preserved',
    ownedHandlesOpen: true, explicitSaveWrites: 1,
    context, root, transport, clone, file,
    receiveAddress: transport.dataAddress,
    pathAddress: transport.pathAddress};
}

function livePathStates() {
  const state = () => ({marker: {result: 0, type: 1,
    bytes: content(liveMarkerNonce)},
  absent: {result: 0x202, type: null, bytes: null}});
  return {original: state(), cloned: state(), padded: state(),
    explicitSaveWrites: 0};
}

function liveCounterPair() {
  const sample = Array(16).fill(0);
  sample[5] = 14096;
  return {samples: [[...sample], [...sample]]};
}

function liveNativeWave(plan, index) {
  const base = index * 1000;
  const row = (role, start, end, ipcResult, id) => ({role,
    startTick: base + start, endTick: base + end,
    transportResult: 0, ipcResult,
    requestKind: plan.requests[role].requestKind,
    handle: plan.requests[role].handle,
    threadId: `00000000000000${index}${id}`,
    requestId: `${plan.waveId.slice(0, 14)}0${id}`});
  return {waveId: plan.waveId, sdkBase: plan.sdkBase,
    arenaNonce: plan.arenaNonce, clock: 'native-counter',
    nativeCounterFrequencyVerified: true,
    workerState: 'joined-closed', serviceHandles: 'closed',
    movedStorageHandleClosed: true, receiveBufferVerified: true,
    triggerControl: plan.triggerControl,
    borrowedSession: 'preserved', explicitSaveWrites: 0,
    negativePathControl: 'executed-absent-path-0x202',
    rows: [row('pin', 100, 500, 0, 1),
      {...row('receive', 150, 550, 0, 2), receiveBytesVerified: 16},
      row('trigger', 200, 400, 0x202, 3)]};
}

function liveFakeAdapter() {
  const calls = [];
  const lease = preparedLease();
  let executed = 0;
  const adapter = {
    async inspect() {calls.push('inspect');
      return {state: 'serving', gameProfile: profile.gameProfile,
        runtimeVersion: profile.runtimeVersion,
        codeHeadProfile: '1.0.1f', sdkBase: livePreflight.sdkBase,
        arenaBase: livePreflight.arenaBase, arenaNonce: liveArenaNonce,
        ownerState: 'ready', workers: 0, ownedHandles: 0};},
    async prepare() {calls.push('prepare'); return lease;},
    async readPaths() {calls.push('paths'); return livePathStates();},
    async counterPair(phase) {calls.push(`counter:${phase}`);
      return liveCounterPair();},
    async executeWave(plan) {calls.push(`wave:${plan.waveId}`);
      executed++;
      return liveNativeWave(plan, executed);},
    async auditPaths() {calls.push('audit'); return [];},
    auditDetails() {return {coverage: 'bounded-cloned-save-tree',
      completeSaveTreeVerified: true, logPrefixVerified: true, changed: []};},
    async cleanup() {calls.push('cleanup');
      return {ownedHandlesClosed: true, markerNeutralized: false,
        markerRemoved: false, markerRetained: true,
        borrowedSession: 'preserved', arena: 'released'};},
  };
  return {calls, adapter};
}

test('runReadinessControl runs trace + two aborts + one cleanup', async () => {
  const fake = liveFakeAdapter();
  const result = await runReadinessControl({preflight: livePreflight,
    adapter: fake.adapter, onPhase: () => {}});
  assert.equal(result.abortRuns.length, 2);
  assert.equal(result.abortRuns.every(run => run.cleanup === 'verified'), true);
  assert.equal(result.markerRetained, true);
  assert.equal(result.ownedHandlesClosed, true);
  assert.equal(result.trace.requestSet, 'balatro-pin-receive-trigger');
  assert.equal(result.trace.rows.length, 3);
  assert.equal(result.fsWorker.integratedFsWorkerVerified, true);
  assert.ok(result.pathStates.original.marker.bytes.equals(content(liveMarkerNonce)));
  const waveCalls = fake.calls.filter(call => call.startsWith('wave:'));
  assert.equal(waveCalls.length, 3);
  assert.equal(new Set(waveCalls).size, 3);
  assert.equal(fake.calls.filter(call => call === 'cleanup').length, 1);
  assert.deepEqual(fake.calls.slice(0, 2), ['inspect', 'prepare']);
  assert.equal(fake.calls[fake.calls.length - 1], 'cleanup');
});

test('runReadinessControl requires both abort controls to authorize', async () => {
  const fake = liveFakeAdapter();
  let extraWaves = 0;
  const executeWave = fake.adapter.executeWave;
  fake.adapter.executeWave = async plan => {
    extraWaves++;
    if (extraWaves === 2) {
      const error = Error('staged frame guard failed');
      error.workerNotStarted = true;
      throw error;
    }
    return executeWave(plan);
  };
  await assert.rejects(runReadinessControl({preflight: livePreflight,
    adapter: fake.adapter, onPhase: () => {}}), /staged frame guard failed/);
  assert.equal(extraWaves, 2);
  assert.equal(fake.calls.filter(call => call === 'cleanup').length, 1);
});
