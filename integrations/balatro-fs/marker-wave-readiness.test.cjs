const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {assessNativeOverlap, assessPlacement, assessReadbackPlan} =
  require('./marker-wave-readiness.cjs');

const sdkBase = '0x28b04b4000';
const arenaBase = '0x3cb18f8000';
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'aabbccddeeff0011';

function localization() {
  return {gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion, sdkBase, arenaBase,
    arenaNonce, nativeCounterFrequencyVerified: true,
    serialReceiveOrderVerified: true,
    candidateDiagnosticCostBytes: 14096,
    exactAllocationBytes: null, pinAddress: null,
    concurrentOverlapMeasured: false, markerHitVerified: false,
    fsStageVerified: false};
}

function worker() {
  return {gameProfile: profile.gameProfile, sdkBase, arenaBase,
    arenaNonce, nativeCounterHz: 19200000,
    integratedFsWorkerVerified: true, cleanup: 'released',
    saveWrites: 0, markerAttempted: false};
}

function trace() {
  const row = (role, requestId, threadId, issued, entered, completed, received) =>
    ({role, requestId, threadId, counterSource: 'native-worker',
      result: 0, issuedTick: issued, enteredTick: entered,
      completedTick: completed, receivedTick: received});
  return {sdkBase, arenaNonce, waveId, clock: 'native-counter',
    clockHz: 19200000, saveWrites: 0, cleanup: 'released',
    markerAttempted: false, rows: [
      row('pin', '0000000000000001', '0000000000000011',
        '9007199254740994', '9007199254740995',
        '9007199254741030', '9007199254741031'),
      row('receive', '0000000000000002', '0000000000000012',
        '9007199254740996', '9007199254740997',
        '9007199254741040', '9007199254741041'),
      row('trigger', '0000000000000003', '0000000000000013',
        '9007199254741000', '9007199254741001',
        '9007199254741020', '9007199254741021'),
    ]};
}

function placement() {
  return {gameProfile: profile.gameProfile, sdkBase, arenaNonce,
    method: 'balatro-native-address-measurement',
    command1009UsedAsExactSize: false, exactAllocationBytes: 16384,
    pinAddress: '0x2abc004000', saveWrites: 0, cleanup: 'released',
    independentSamples: [1, 2].map(() =>
      ({exactAllocationBytes: 16384, method: 'native-address-readback',
        cleanup: 'released'}))};
}

function readback() {
  const owned = paths(markerNonce);
  return {transport: 'balatro-fs-acquisition', waveId, sdkBase,
    arenaNonce, markerPath: owned.marker, absentPath: owned.absent,
    markerBytes: content(markerNonce), absentPathResult: 0x202,
    saveWrites: 0, cleanup: 'released', borrowedSession: 'preserved',
    nativeTransportVerified: true, ownedSaveRead: false,
    clonedSaveRead: false, fsSideReaderVerified: true};
}

function markerControl() {
  const owned = paths(markerNonce);
  return {gameProfile: profile.gameProfile, nonce: markerNonce,
    marker: owned.marker, absent: owned.absent,
    markerContentVerified: true, absentPathVerified: true,
    cleanup: 'verified', markerWaveAttempted: false};
}

test('current serial preflight cannot qualify a native overlap', () => {
  assert.throws(() => assessNativeOverlap({localization: localization(),
    worker: {gameProfile: profile.gameProfile, integratedFsWorkerVerified: false},
    trace: trace()}), /integrated FS worker/);
});

test('large native ticks retain precision and a measured overlap stays a preflight', () => {
  const overlap = assessNativeOverlap({localization: localization(),
    worker: worker(), trace: trace()});
  assert.equal(overlap.nativeOverlapMeasured, true);
  assert.equal(overlap.markerHitVerified, false);
  assert.equal(overlap.fsStageVerified, false);
});

test('a drifted but bounded diagnostic cost still qualifies a serial overlap', () => {
  const loc = localization();
  loc.candidateDiagnosticCostBytes = 14336;
  const overlap = assessNativeOverlap({localization: loc,
    worker: worker(), trace: trace()});
  assert.equal(overlap.nativeOverlapMeasured, true);
  const unbounded = localization();
  unbounded.candidateDiagnosticCostBytes = 0x10001;
  assert.throws(() => assessNativeOverlap({localization: unbounded,
    worker: worker(), trace: trace()}), /serial control/);
});

test('stale boot, serial requests, duplicate workers and imprecise ticks stop', () => {
  const stale = trace();
  stale.sdkBase = '0x28b04b5000';
  assert.throws(() => assessNativeOverlap({localization: localization(),
    worker: worker(), trace: stale}), /stale/);
  const serial = trace();
  serial.rows[0].completedTick = '9007199254741002';
  assert.throws(() => assessNativeOverlap({localization: localization(),
    worker: worker(), trace: serial}), /did not span/);
  const reused = trace();
  reused.rows[1].threadId = reused.rows[0].threadId;
  assert.throws(() => assessNativeOverlap({localization: localization(),
    worker: worker(), trace: reused}), /reused/);
  const rounded = trace();
  rounded.rows[1].enteredTick = Number(rounded.rows[1].enteredTick);
  assert.throws(() => assessNativeOverlap({localization: localization(),
    worker: worker(), trace: rounded}), /imprecise/);
});

test('command-1009 candidate is not an exact Balatro allocation', () => {
  assert.throws(() => assessPlacement({localization: localization(),
    placement: {...placement(), exactAllocationBytes: 14096,
      command1009UsedAsExactSize: true}}), /independently measured/);
  const incomplete = placement();
  incomplete.independentSamples.pop();
  assert.throws(() => assessPlacement({localization: localization(),
    placement: incomplete}), /independently measured/);
});

test('direct and cloned save reads do not satisfy the FS-side readback gate', () => {
  const overlap = assessNativeOverlap({localization: localization(),
    worker: worker(), trace: trace()});
  const args = {localization: localization(), overlap,
    placement: placement(), markerNonce,
    markerControl: markerControl(), readback: readback()};
  assert.throws(() => assessReadbackPlan({...args,
    readback: {...readback(), transport: 'cloned-save-read',
      clonedSaveRead: true}}), /FS acquisition readback/);
  assert.throws(() => assessReadbackPlan({...args,
    readback: {...readback(), ownedSaveRead: true}}), /provenance/);
  assert.throws(() => assessReadbackPlan({...args,
    readback: {...readback(), markerBytes: Buffer.alloc(16)}}),
  /FS acquisition readback/);
  assert.throws(() => assessReadbackPlan({...args,
    readback: {...readback(), waveId: 'ffeeddccbbaa0099'}}),
  /FS acquisition readback/);
  const shape = assessReadbackPlan(args);
  assert.equal(shape.exactMarkerBytesMatched, true);
  assert.equal(shape.markerHitVerified, false);
  assert.equal(shape.fsStageVerified, false);
});
