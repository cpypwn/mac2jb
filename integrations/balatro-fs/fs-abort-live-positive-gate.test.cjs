'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {PHASES, assessStaircase} = require('./fs-pinning-staircase.cjs');
const {assessPreflight, assessOverlap} = require('./canary-geometry-plan.cjs');
const {DESCRIPTOR_BYTES, TERMINATOR_OFFSET,
  assessCanaryAttemptReadiness} = require('./canary-attempt-readiness.cjs');
const {runOneAbortLive} = require('./fs-abort-live.cjs');

const sdkBase = '0x28b04b4000';
const arenaBase = '0x3cb18f8000';
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const ownedMarkerNonce = '89abcdef01234567';

const sample = value => {const row = Array(16).fill(0); row[5] = value; return row;};
const phase = value => ({samples: [sample(value), sample(value)]});
const present = () => ({result: 0, type: 1, bytes: content(ownedMarkerNonce)});
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
  const owned = paths(markerNonce);
  return {gameProfile: profile.gameProfile, nonce: markerNonce,
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

function fsWorker() {
  return {gameProfile: profile.gameProfile, sdkBase, arenaBase,
    arenaNonce, nativeCounterHz: 19200000,
    integratedFsWorkerVerified: true, cleanup: 'released',
    saveWrites: 0, markerAttempted: false};
}

function trace() {
  const row = (role, requestKind, requestId, threadId,
    issuedTick, enteredTick, completedTick, receivedTick) =>
    ({role, requestKind, requestId, threadId,
      counterSource: 'native-worker', result: 0,
      issuedTick, enteredTick, completedTick, receivedTick});
  return {sdkBase, arenaNonce, waveId: '1111111111111111',
    requestSet: 'balatro-pin-receive-trigger',
    clock: 'native-counter', clockHz: 19200000,
    saveWrites: 0, cleanup: 'released', markerAttempted: false,
    rows: [
      row('pin', 'owned-storage-open', '0000000000000001',
        '0000000000000011', '100', '101', '150', '151'),
      row('receive', 'receive-buffer-request', '0000000000000002',
        '0000000000000012', '103', '105', '160', '161'),
      row('trigger', 'cloned-save-entry-type', '0000000000000003',
        '0000000000000013', '108', '110', '130', '131'),
    ]};
}

function paddedInput(ownedPath) {
  const basename = ownedPath.slice('save:/'.length);
  const input = Buffer.alloc(DESCRIPTOR_BYTES, '/');
  input.write(basename, TERMINATOR_OFFSET - Buffer.byteLength(basename), 'ascii');
  input[TERMINATOR_OFFSET] = 0;
  return input;
}

function firstDescriptor() {
  const owned = paths(ownedMarkerNonce);
  return {mode: 'balatro-first-descriptor',
    nativeDescriptorBytes: DESCRIPTOR_BYTES,
    terminatorOffset: TERMINATOR_OFFSET,
    markerInput: paddedInput(owned.marker),
    absentInput: paddedInput(owned.absent)};
}

function evidence() {
  return {localization: localization(), worker: worker(),
    staircase: staircase(), clone: clone(), fsWorker: fsWorker(),
    trace: trace(), firstDescriptor: firstDescriptor()};
}

function attempt() {
  return assessCanaryAttemptReadiness(evidence(),
    () => Buffer.from(ownedMarkerNonce, 'hex'));
}

function abortRun(waveId) {
  const input = evidence();
  const overlap = assessOverlap({clock: 'native-counter',
    nativeCounterFrequencyVerified: true,
    heldRoles: ['held-pin'], throughRoles: ['through-receive'],
    rows: [
      {role: 'held-pin', startTick: 10, endTick: 35},
      {role: 'through-receive', startTick: 15, endTick: 50},
      {role: 'trigger', startTick: 20, endTick: 40},
    ]});
  return {preflight: assessPreflight(input,
    () => Buffer.from(ownedMarkerNonce, 'hex')), sdkBase, arenaNonce,
    nonce: ownedMarkerNonce, waveId, overlap,
    phases: {before: phase(100000), noStorageBefore: phase(100000),
      after: phase(100000), noStorageAfter: phase(100000)},
    negativePathControl: 'executed-absent-path-0x202',
    saveWrites: 0, cleanup: 'verified',
    borrowedSession: 'preserved', changedPaths: [],
    readback: {markerBefore: present(), markerAfter: present(),
      absentBefore: absent(), absentAfter: absent()}};
}

function pathControl(attempt) {
  const owned = paths(attempt.markerNonce);
  const pair = () => ({marker: present(), absent: absent()});
  return {gameProfile: profile.gameProfile, sdkBase, arenaNonce,
    markerNonce: attempt.markerNonce,
    markerPath: owned.marker, absentPath: owned.absent,
    markerInputSha256: attempt.markerInputSha256,
    absentInputSha256: attempt.absentInputSha256,
    source: 'current-owned-clone-and-padded-path',
    markerRetained: true, ownedHandleClosed: true,
    borrowedSession: 'preserved', saveWritesAfterPreparation: 0,
    original: pair(), cloned: pair(), padded: pair()};
}

function validEvidence() {
  const run = attempt();
  return {attempt: run,
    abortRuns: [abortRun('aaaaaaaaaaaaaaaa'), abortRun('bbbbbbbbbbbbbbbb')],
    pathControl: pathControl(run)};
}

test('positive mode fails before live setup without same-session readiness', async () => {
  let imageCalls = 0;
  await assert.rejects(runOneAbortLive({host: '10.0.0.189',
    macIp: '10.0.0.205', mode: 'positive',
    image: async () => {imageCalls++;}}),
  /disabled before live setup: same-session abort and path-control readiness evidence is missing/);
  assert.equal(imageCalls, 0);
});

test('positive mode refuses incomplete readiness before live setup', async () => {
  let imageCalls = 0;
  await assert.rejects(runOneAbortLive({host: '10.0.0.189',
    macIp: '10.0.0.205', mode: 'positive',
    positiveEvidence: {}, image: async () => {imageCalls++;}}),
  /bounded attempt preflight is missing/);
  assert.equal(imageCalls, 0);
});

test('valid same-session readiness opens the gate and reaches device contact', async () => {
  let imageCalls = 0;
  await assert.rejects(runOneAbortLive({host: '10.0.0.189',
    macIp: '10.0.0.205', nonce: arenaNonce, mode: 'positive',
    positiveEvidence: validEvidence(),
    image: async () => {imageCalls++; throw Error('device contact');}}),
  /device contact/);
  assert.equal(imageCalls, 1);
});

test('readiness bound to a different retained owner refuses before device contact', async () => {
  let imageCalls = 0;
  await assert.rejects(runOneAbortLive({host: '10.0.0.189',
    macIp: '10.0.0.205', nonce: '0000000000000000', mode: 'positive',
    positiveEvidence: validEvidence(),
    image: async () => {imageCalls++;}}),
  /same-session positive readiness belongs to this retained owner/);
  assert.equal(imageCalls, 0);
});
