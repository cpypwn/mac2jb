'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {assessPreflight, assessBoundedAbortControls} =
  require('./canary-geometry-plan.cjs');
const {assessNativeOverlap} = require('./marker-wave-readiness.cjs');

const DESCRIPTOR_BYTES = 0x800;
const TERMINATOR_OFFSET = DESCRIPTOR_BYTES - 1;
const REQUEST_KINDS = Object.freeze({
  pin: 'owned-storage-open',
  receive: 'receive-buffer-request',
  trigger: 'cloned-save-entry-type',
});

function check(condition, message) {
  if (!condition) throw Error(`Balatro canary attempt gate: ${message}`);
}

function expectedInput(ownedPath) {
  const relative = ownedPath.slice('save:'.length);
  const basename = path.posix.basename(relative);
  check(relative === `/${basename}` && Buffer.byteLength(basename) < TERMINATOR_OFFSET,
    'marker path does not fit the first descriptor');
  const input = Buffer.alloc(DESCRIPTOR_BYTES, '/');
  input.write(basename, TERMINATOR_OFFSET - Buffer.byteLength(basename), 'ascii');
  input[TERMINATOR_OFFSET] = 0;
  check(path.posix.normalize(input.toString('ascii', 0, TERMINATOR_OFFSET)) === relative,
    'padded path does not resolve to the owned path');
  return input;
}

function assessFirstDescriptor(firstDescriptor, markerNonce) {
  const owned = paths(markerNonce);
  check(firstDescriptor?.mode === 'balatro-first-descriptor' &&
    firstDescriptor.terminatorOffset === TERMINATOR_OFFSET &&
    firstDescriptor.nativeDescriptorBytes === DESCRIPTOR_BYTES &&
    firstDescriptor.pinAddress == null &&
    firstDescriptor.exactAllocationBytes == null &&
    firstDescriptor.markerOffset == null &&
    Buffer.isBuffer(firstDescriptor.markerInput) &&
    Buffer.isBuffer(firstDescriptor.absentInput) &&
    firstDescriptor.markerInput.equals(expectedInput(owned.marker)) &&
    firstDescriptor.absentInput.equals(expectedInput(owned.absent)),
  'first-descriptor marker and absent inputs are not exact, bounded peers');
  return {nativeDescriptorBytes: DESCRIPTOR_BYTES,
    terminatorOffset: TERMINATOR_OFFSET,
    markerPath: owned.marker, absentPath: owned.absent,
    markerInputSha256: crypto.createHash('sha256').update(firstDescriptor.markerInput).digest('hex'),
    absentInputSha256: crypto.createHash('sha256').update(firstDescriptor.absentInput).digest('hex'),
    firstDescriptorInputGuarded: true, nativePaddedLookupVerified: false};
}

function assessCanaryAttemptReadiness({localization, worker, staircase, clone,
  fsWorker, trace, firstDescriptor} = {}, nonceBytes = crypto.randomBytes) {
  const preflight = assessPreflight({worker, staircase, clone}, nonceBytes);
  check(localization?.gameProfile === profile.gameProfile &&
    localization.runtimeVersion === profile.runtimeVersion &&
    localization.sdkBase === preflight.sdkBase &&
    localization.arenaBase === preflight.arenaBase &&
    localization.arenaNonce === preflight.arenaNonce &&
    localization.candidateDiagnosticCostBytes === preflight.candidateDiagnosticCostBytes &&
    localization.nativeOrderSaveWrites === 0 &&
    localization.exactAllocationBytes === null &&
    localization.pinAddress === null &&
    localization.markerHitVerified === false &&
    localization.fsStageVerified === false,
  'same-boot localization or candidate diagnostic does not match preflight');
  check(fsWorker?.sdkBase === preflight.sdkBase &&
    fsWorker.arenaBase === preflight.arenaBase &&
    fsWorker.arenaNonce === preflight.arenaNonce,
  'integrated FS worker does not belong to the retained owner');
  const overlap = assessNativeOverlap({localization, worker: fsWorker, trace});
  check(trace?.requestSet === 'balatro-pin-receive-trigger' &&
    trace.rows.every(row => row.requestKind === REQUEST_KINDS[row.role]),
  'request trace is not the target-specific pin, receive, and trigger set');
  const descriptor = assessFirstDescriptor(firstDescriptor, preflight.markerNonce);
  return {gameProfile: profile.gameProfile, sdkBase: preflight.sdkBase,
    arenaBase: preflight.arenaBase, arenaNonce: preflight.arenaNonce,
    markerNonce: preflight.markerNonce, traceWaveId: overlap.waveId,
    candidateDiagnosticCostBytes: preflight.candidateDiagnosticCostBytes,
    exactAllocationBytes: null, pinAddress: null,
    ...descriptor, phase: 'abort-controls', maxAbortControls: 2,
    maxMatchedComparisons: 1, abortControlsVerified: false,
    clientRequestWindowOverlapMeasured: true,
    fsHandlerOverlapMeasured: false, fsSideReaderVerified: false,
    automaticRetryAllowed: false,
    positiveWaveAllowed: false, markerHitVerified: false,
    fsStageVerified: false,
    status: 'bounded first-descriptor abort controls may begin; FS marker and 2/4 are unverified'};
}

function present(value, bytes) {
  return value?.result === 0 && value.type === 1 &&
    Buffer.isBuffer(value.bytes) && value.bytes.equals(bytes);
}

function absent(value) {
  return value?.result === 0x202 && value.type === null && value.bytes === null;
}

function assessPositiveWaveReadiness({attempt, abortRuns, pathControl} = {}) {
  check(attempt?.gameProfile === profile.gameProfile &&
    attempt.phase === 'abort-controls' && attempt.positiveWaveAllowed === false &&
    attempt.exactAllocationBytes === null && attempt.pinAddress === null &&
    attempt.markerHitVerified === false && attempt.fsStageVerified === false &&
    attempt.firstDescriptorInputGuarded === true &&
    attempt.nativePaddedLookupVerified === false &&
    attempt.nativeDescriptorBytes === DESCRIPTOR_BYTES &&
    attempt.terminatorOffset === TERMINATOR_OFFSET &&
    attempt.maxAbortControls === 2 && attempt.maxMatchedComparisons === 1,
  'bounded attempt preflight is missing');
  const controls = assessBoundedAbortControls(abortRuns);
  check(controls.abortControlsVerified === true &&
    controls.sdkBase === attempt.sdkBase &&
    controls.arenaNonce === attempt.arenaNonce &&
    controls.markerNonce === attempt.markerNonce &&
    !controls.waveIds.includes(attempt.traceWaveId),
  'two independent abort controls do not match this attempt');
  const owned = paths(attempt.markerNonce);
  const bytes = content(attempt.markerNonce);
  check(pathControl?.gameProfile === profile.gameProfile &&
    pathControl.sdkBase === attempt.sdkBase &&
    pathControl.arenaNonce === attempt.arenaNonce &&
    pathControl.markerNonce === attempt.markerNonce &&
    pathControl.markerPath === owned.marker &&
    pathControl.absentPath === owned.absent &&
    pathControl.markerInputSha256 === attempt.markerInputSha256 &&
    pathControl.absentInputSha256 === attempt.absentInputSha256 &&
    pathControl.source === 'current-owned-clone-and-padded-path' &&
    pathControl.markerRetained === true &&
    pathControl.ownedHandleClosed === true &&
    pathControl.borrowedSession === 'preserved' &&
    pathControl.saveWritesAfterPreparation === 0 &&
    ['original', 'cloned', 'padded'].every(source =>
      present(pathControl[source]?.marker, bytes) &&
      absent(pathControl[source]?.absent)),
  'current original, cloned, or padded marker/absent path controls are missing');
  return {...attempt, phase: 'single-matched-comparison',
    abortControlsVerified: true, abortWaveIds: controls.waveIds,
    nativePaddedLookupVerified: true, positiveWaveAllowed: true,
    markerHitVerified: false, fsStageVerified: false,
    status: 'one bounded matched comparison may begin; FS marker and 2/4 are unverified'};
}

module.exports = {DESCRIPTOR_BYTES, TERMINATOR_OFFSET, REQUEST_KINDS,
  assessFirstDescriptor, assessCanaryAttemptReadiness,
  assessPositiveWaveReadiness};
