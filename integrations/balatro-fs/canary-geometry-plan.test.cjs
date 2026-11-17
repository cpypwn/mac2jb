const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {assessStaircase, PHASES} = require('./fs-pinning-staircase.cjs');
const {
  assessPreflight, assessNoStorageControls, assessOverlap,
  assessAbortControl, assessBoundedAbortControls, assessExactFsMarker,
} = require('./canary-geometry-plan.cjs');

const arenaNonce = '1234567890abcdef';
const markerNonce = '0123456789abcdef';
const sdkBase = '0x57390b4000';
const arenaBase = '0x42ab8f8000';
const sample = value => {
  const row = Array(16).fill(0);
  row[5] = value;
  return row;
};
const phase = value => ({samples: [sample(value), sample(value)]});
const present = bytes => ({result: 0, type: 1, bytes: Buffer.from(bytes)});
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

function preflightEvidence() {
  const markerPaths = paths(markerNonce);
  return {
    worker: {gameProfile: profile.gameProfile, nonce: arenaNonce,
      arenaBase, sdkBase, samples: 2, workerRepeatabilityVerified: true,
      cleanup: 'released', markerAttempted: false},
    staircase: staircase(),
    clone: {gameProfile: profile.gameProfile, nonce: markerNonce,
      arenaNonce, sdkBase, marker: markerPaths.marker,
      absent: markerPaths.absent, ownedCloneVerified: true,
      markerContentVerified: true, absentPathVerified: true,
      cleanup: 'verified', markerWaveAttempted: false,
      nativeTransport: 'closed', borrowedSession: 'preserved'},
  };
}

function measuredOverlap() {
  return assessOverlap({clock: 'native-counter',
    nativeCounterFrequencyVerified: true,
    heldRoles: ['held-pin'], throughRoles: ['through-receive'],
    rows: [
      {role: 'held-pin', startTick: 10, endTick: 35},
      {role: 'through-receive', startTick: 15, endTick: 50},
      {role: 'trigger', startTick: 20, endTick: 40},
    ]});
}

function abortRun(waveId = 'aaaaaaaaaaaaaaaa') {
  const marker = content(markerNonce);
  return {preflight: assessPreflight(preflightEvidence()),
    sdkBase, arenaNonce, nonce: markerNonce, waveId,
    phases: {before: phase(100000), noStorageBefore: phase(100000),
      after: phase(100000), noStorageAfter: phase(100000)},
    overlap: measuredOverlap(),
    negativePathControl: 'executed-absent-path-0x202', saveWrites: 0,
    cleanup: 'verified', borrowedSession: 'preserved', changedPaths: [],
    readback: {markerBefore: present(marker), markerAfter: present(marker),
      absentBefore: absent(), absentAfter: absent()}};
}

test('repeated peak diagnostic is a candidate only, with no marker or 2/4 claim', () => {
  const result = assessPreflight(preflightEvidence());
  assert.equal(result.candidateDiagnosticCostBytes, 14096);
  assert.equal(result.exactAllocationBytes, null);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
  assert.equal(result.maxAbortControls, 2);
});

test('preflight rejects one-cycle evidence, a claimed exact size, and mismatched boots', () => {
  const one = preflightEvidence();
  one.staircase.cycles.pop();
  assert.throws(() => assessPreflight(one), /repeated pin diagnostic/);
  const exact = preflightEvidence();
  exact.staircase.exactAllocationBytes = 14096;
  assert.throws(() => assessPreflight(exact), /exact allocation/);
  const stale = preflightEvidence();
  stale.clone.sdkBase = '0x19618b4000';
  assert.throws(() => assessPreflight(stale), /one retained owner and SDK base/);
});

test('matched no-storage controls require stable pairs and full restoration', () => {
  const good = abortRun().phases;
  assert.equal(assessNoStorageControls(good).restored, true);
  assert.throws(() => assessNoStorageControls({...good,
    noStorageBefore: phase(99999)}), /controls or baseline restoration/);
  assert.throws(() => assessNoStorageControls({...good,
    after: {samples: [sample(100000), sample(99999)]}}), /unstable/);
});

test('controlled overlap needs native clock evidence and role lifetimes', () => {
  assert.equal(measuredOverlap().qualified, true);
  assert.throws(() => assessOverlap({clock: 'sdk-tick',
    nativeCounterFrequencyVerified: true, heldRoles: ['held-pin'],
    throughRoles: ['through-receive'], rows: []}), /native-counter/);
  assert.throws(() => assessOverlap({clock: 'native-counter',
    nativeCounterFrequencyVerified: true,
    heldRoles: ['held-pin'], throughRoles: ['through-receive'],
    rows: [
      {role: 'held-pin', startTick: 10, endTick: 19},
      {role: 'through-receive', startTick: 15, endTick: 50},
      {role: 'trigger', startTick: 20, endTick: 40},
    ]}), /did not overlap/);
});

test('abort controls stop at the first failed control and cannot be replayed as two runs', () => {
  const good = abortRun();
  assert.equal(assessAbortControl(good).markerHitVerified, false);
  const bad = abortRun('bbbbbbbbbbbbbbbb');
  bad.readback.markerAfter.bytes[0] ^= 1;
  assert.throws(() => assessBoundedAbortControls([good, bad]),
    /exact marker and absent path/);
  assert.throws(() => assessBoundedAbortControls([good, good]),
    /duplicated/);
  assert.throws(() => assessBoundedAbortControls([good, bad, good]),
    /outside the bounded plan/);
  const result = assessBoundedAbortControls([good,
    abortRun('bbbbbbbbbbbbbbbb')]);
  assert.equal(result.abortControlsVerified, true);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
});

test('a direct or cloned file read is never mistaken for an FS marker hit', () => {
  const controls = assessBoundedAbortControls([abortRun(),
    abortRun('bbbbbbbbbbbbbbbb')]);
  const args = {nonce: markerNonce, sdkBase, arenaNonce,
    waveId: 'cccccccccccccccc', overlap: measuredOverlap(),
    phases: abortRun().phases, saveWrites: 0, changedPaths: [],
    source: 'clone-control-readback', marker: present(content(markerNonce)),
    absent: absent(), cleanup: 'verified', borrowedSession: 'preserved',
    abortControls: controls};
  assert.throws(() => assessExactFsMarker(args), /FS readback/);
  const wrong = {...args, source: 'fs-acquisition-readback',
    marker: present(Buffer.alloc(16))};
  assert.throws(() => assessExactFsMarker(wrong), /FS readback/);
  assert.throws(() => assessExactFsMarker({...args,
    source: 'fs-acquisition-readback', waveId: 'aaaaaaaaaaaaaaaa'}),
  /distinct measured overlap/);
  assert.throws(() => assessExactFsMarker({...args,
    source: 'fs-acquisition-readback',
    phases: {...args.phases, after: phase(99999)}}),
  /controls or baseline restoration/);
  const exact = assessExactFsMarker({...args, source: 'fs-acquisition-readback'});
  assert.equal(exact.markerHitVerified, true);
  assert.equal(exact.fsStageVerified, false);
});
