'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {PHASES, assessStaircase} = require('./fs-pinning-staircase.cjs');
const {assessPreflight, assessOverlap} = require('./canary-geometry-plan.cjs');
const {DESCRIPTOR_BYTES, TERMINATOR_OFFSET,
  assessCanaryAttemptReadiness, assessPositiveWaveReadiness} =
  require('./canary-attempt-readiness.cjs');

const sdkBase = '0x28b04b4000';
const arenaBase = '0x3cb18f8000';
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';

const sample = value => {
  const row = Array(16).fill(0);
  row[5] = value;
  return row;
};
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
    serialReceiveOrderVerified: true,
    candidateDiagnosticCostBytes: 14096,
    nativeOrderSaveWrites: 0,
    exactAllocationBytes: null, pinAddress: null,
    concurrentOverlapMeasured: false,
    markerHitVerified: false, fsStageVerified: false};
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
  const owned = paths(markerNonce);
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
  return {preflight: assessPreflight(input), sdkBase, arenaNonce,
    nonce: markerNonce, waveId, overlap,
    phases: {before: phase(100000), noStorageBefore: phase(100000),
      after: phase(100000), noStorageAfter: phase(100000)},
    negativePathControl: 'executed-absent-path-0x202',
    saveWrites: 0, cleanup: 'verified',
    borrowedSession: 'preserved', changedPaths: [],
    readback: {markerBefore: present(), markerAfter: present(),
      absentBefore: absent(), absentAfter: absent()}};
}

function pathControl(attempt) {
  const owned = paths(markerNonce);
  const pair = () => ({marker: present(), absent: absent()});
  return {gameProfile: profile.gameProfile, sdkBase, arenaNonce,
    markerNonce, markerPath: owned.marker, absentPath: owned.absent,
    markerInputSha256: attempt.markerInputSha256,
    absentInputSha256: attempt.absentInputSha256,
    source: 'current-owned-clone-and-padded-path',
    markerRetained: true, ownedHandleClosed: true,
    borrowedSession: 'preserved', saveWritesAfterPreparation: 0,
    original: pair(), cloned: pair(), padded: pair()};
}

test('bounded entry accepts candidate cost and first descriptor without claiming a marker or 2/4', () => {
  const result = assessCanaryAttemptReadiness(evidence());
  assert.equal(result.candidateDiagnosticCostBytes, 14096);
  assert.equal(result.exactAllocationBytes, null);
  assert.equal(result.pinAddress, null);
  assert.equal(result.terminatorOffset, 0x7ff);
  assert.equal(result.firstDescriptorInputGuarded, true);
  assert.equal(result.nativePaddedLookupVerified, false);
  assert.equal(result.clientRequestWindowOverlapMeasured, true);
  assert.equal(result.fsHandlerOverlapMeasured, false);
  assert.equal(result.fsSideReaderVerified, false);
  assert.equal(result.automaticRetryAllowed, false);
  assert.equal(result.positiveWaveAllowed, false);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
  assert.equal(result.maxAbortControls, 2);
});

test('entry rejects a single staircase, a claimed exact size, and a stale retained owner', () => {
  const one = evidence();
  one.staircase.cycles.pop();
  assert.throws(() => assessCanaryAttemptReadiness(one), /repeated pin diagnostic/);
  const exact = evidence();
  exact.staircase.exactAllocationBytes = 14096;
  assert.throws(() => assessCanaryAttemptReadiness(exact), /repeated pin diagnostic/);
  const stale = evidence();
  stale.fsWorker.arenaNonce = 'aaaaaaaaaaaaaaaa';
  assert.throws(() => assessCanaryAttemptReadiness(stale), /retained owner/);
});

test('cmd1009-only client overlap is not a pin, receive, and trigger trace', () => {
  const input = evidence();
  input.trace.requestSet = 'fsp-srv-counter-1009';
  input.trace.rows.forEach(row => {row.requestKind = 'fsp-srv-command-1009';});
  assert.throws(() => assessCanaryAttemptReadiness(input), /target-specific/);
  const serial = evidence();
  serial.trace.rows[0].completedTick = '120';
  assert.throws(() => assessCanaryAttemptReadiness(serial), /did not span/);
});

test('descriptor guard rejects a shifted NUL, changed basename, and imported placement', () => {
  const early = evidence();
  early.firstDescriptor.markerInput[TERMINATOR_OFFSET - 1] = 0;
  assert.throws(() => assessCanaryAttemptReadiness(early), /first-descriptor/);
  const wrong = evidence();
  wrong.firstDescriptor.absentInput[TERMINATOR_OFFSET - 6] ^= 1;
  assert.throws(() => assessCanaryAttemptReadiness(wrong), /first-descriptor/);
  const imported = evidence();
  imported.firstDescriptor.markerOffset = 0x2340;
  assert.throws(() => assessCanaryAttemptReadiness(imported), /first-descriptor/);
});

test('one or duplicate abort controls cannot authorize a positive comparison', () => {
  const attempt = assessCanaryAttemptReadiness(evidence());
  const first = abortRun('aaaaaaaaaaaaaaaa');
  const control = pathControl(attempt);
  assert.throws(() => assessPositiveWaveReadiness({attempt,
    abortRuns: [first], pathControl: control}), /two independent/);
  assert.throws(() => assessPositiveWaveReadiness({attempt,
    abortRuns: [first, first], pathControl: control}), /duplicated/);
  const changed = abortRun('bbbbbbbbbbbbbbbb');
  changed.readback.markerAfter.bytes[0] ^= 1;
  assert.throws(() => assessPositiveWaveReadiness({attempt,
    abortRuns: [first, changed], pathControl: control}), /exact marker/);
});

test('positive gate binds current padded controls to exact inputs and still makes no hit claim', () => {
  const attempt = assessCanaryAttemptReadiness(evidence());
  const abortRuns = [abortRun('aaaaaaaaaaaaaaaa'),
    abortRun('bbbbbbbbbbbbbbbb')];
  const control = pathControl(attempt);
  assert.throws(() => assessPositiveWaveReadiness({attempt, abortRuns,
    pathControl: {...control, markerInputSha256: '0'.repeat(64)}}), /path controls/);
  const altered = pathControl(attempt);
  altered.padded.marker.bytes[0] ^= 1;
  assert.throws(() => assessPositiveWaveReadiness({attempt, abortRuns,
    pathControl: altered}), /path controls/);
  const result = assessPositiveWaveReadiness({attempt, abortRuns,
    pathControl: control});
  assert.equal(result.abortControlsVerified, true);
  assert.equal(result.nativePaddedLookupVerified, true);
  assert.equal(result.positiveWaveAllowed, true);
  assert.equal(result.maxMatchedComparisons, 1);
  assert.equal(result.exactAllocationBytes, null);
  assert.equal(result.pinAddress, null);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
});
