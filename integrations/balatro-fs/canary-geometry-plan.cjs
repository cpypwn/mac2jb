const crypto = require('node:crypto');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {validStaircaseResult} = require('./fs-pinning-staircase-live.cjs');

const MAX_ABORT_CONTROLS = 2;
const CANDIDATE_DIAGNOSTIC_BYTES = 14096;
const DIAGNOSTIC_INDEX = 5;
const MISSING_RESULT = 0x202;

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Balatro canary gate: ${message}`);
}

// The clone-control diagnostic writes its own nonce-bound marker and, because
// deleteMarker now straight-skips the overwrite, leaves that marker in place.
// The owned lease must start from an ABSENT marker, so its marker nonce has to
// be distinct from the clone diagnostic's marker nonce (clone.nonce) and the
// retained arena owner nonce (worker.nonce). Both phases keep the "never
// re-open an existing marker" invariant: each writes a fresh, absent marker.
function distinctNonce(avoid, nonceBytes) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = nonceBytes(8);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 8) {
      throw new TypeError('Balatro marker nonce generator must return eight bytes');
    }
    const nonce = bytes.toString('hex');
    if (!/^[0-9a-f]{16}$/.test(nonce)) {
      throw new TypeError('Balatro marker nonce generator returned invalid bytes');
    }
    if (!avoid.includes(nonce)) return nonce;
  }
  throw new Error('Balatro marker nonce generator did not produce a distinct nonce');
}

function assessPreflight({worker, staircase, clone},
  nonceBytes = crypto.randomBytes) {
  requireEvidence(worker?.gameProfile === profile.gameProfile &&
    worker.workerRepeatabilityVerified === true && worker.cleanup === 'released' &&
    worker.markerAttempted === false && worker.samples === 2,
  'same-boot worker repeatability is missing');
  requireEvidence(staircase?.gameProfile === profile.gameProfile &&
    validStaircaseResult(staircase) &&
    staircase.repeatabilityVerified === true && staircase.cleanup === 'released' &&
    staircase.markerAttempted === false && staircase.saveWrites === 0 &&
    staircase.exactAllocationBytes === null &&
    Number.isInteger(staircase.candidateDiagnosticCostBytes) &&
    staircase.candidateDiagnosticCostBytes > 0,
  `repeated pin diagnostic is missing or claimed as an exact allocation (cost=${staircase?.candidateDiagnosticCostBytes} exact=${staircase?.exactAllocationBytes})`);
  requireEvidence(clone?.gameProfile === profile.gameProfile &&
    clone.ownedCloneVerified === true && clone.markerContentVerified === true &&
    clone.absentPathVerified === true && clone.cleanup === 'verified' &&
    clone.markerWaveAttempted === false && clone.nativeTransport === 'closed' &&
    clone.borrowedSession === 'preserved',
  'owned clone and exact path controls are missing');
  requireEvidence(worker.nonce === staircase.nonce &&
    worker.nonce === clone.arenaNonce &&
    worker.arenaBase === staircase.arenaBase &&
    worker.sdkBase === clone.sdkBase,
  'worker, pin, and clone evidence are not from one retained owner and SDK base');
  requireEvidence(clone.marker === paths(clone.nonce).marker &&
    clone.absent === paths(clone.nonce).absent,
  'clone paths are not the nonce-bound equal-length controls');
  requireEvidence(typeof nonceBytes === 'function',
    'marker nonce generator is missing');
  const markerNonce = distinctNonce([worker.nonce, clone.nonce], nonceBytes);
  return {gameProfile: profile.gameProfile,
    sdkBase: worker.sdkBase, arenaBase: worker.arenaBase,
    arenaNonce: worker.nonce, markerNonce,
    candidateDiagnosticCostBytes: staircase.candidateDiagnosticCostBytes,
    exactAllocationBytes: null, maxAbortControls: MAX_ABORT_CONTROLS,
    nextGate: 'measure Balatro-specific native counter, pin placement and receive order',
    abortControlsVerified: false, markerHitVerified: false,
    fsStageVerified: false};
}

function diagnostic(phase) {
  const samples = phase?.samples;
  requireEvidence(Array.isArray(samples) && samples.length === 2 &&
    samples.every(row => Array.isArray(row) && row.length === 16 &&
      row.every(value => Number.isSafeInteger(value) && value >= 0)) &&
    samples[0][DIAGNOSTIC_INDEX] === samples[1][DIAGNOSTIC_INDEX],
  'a command-1009 diagnostic pair is missing or unstable');
  return samples[1][DIAGNOSTIC_INDEX];
}

function assessNoStorageControls(phases) {
  const before = diagnostic(phases?.before);
  const noStorageBefore = diagnostic(phases?.noStorageBefore);
  const after = diagnostic(phases?.after);
  const noStorageAfter = diagnostic(phases?.noStorageAfter);
  requireEvidence(before === noStorageBefore && after === noStorageAfter &&
    after === before,
  'matched no-storage controls or baseline restoration failed');
  return {matched: true, restored: true, diagnosticValue: before,
    exactAllocationBytes: null};
}

function assessOverlap({rows, heldRoles, throughRoles, triggerRole = 'trigger',
  clock, nativeCounterFrequencyVerified}) {
  requireEvidence(clock === 'native-counter' &&
    nativeCounterFrequencyVerified === true,
  'Balatro native-counter timing is not verified');
  requireEvidence(Array.isArray(rows) && Array.isArray(heldRoles) &&
    Array.isArray(throughRoles) && heldRoles.length > 0 &&
    throughRoles.length > 0,
  'target-specific held and through roles are required');
  const roles = [triggerRole, ...heldRoles, ...throughRoles];
  requireEvidence(new Set(roles).size === roles.length &&
    rows.length === roles.length,
  'overlap rows must have one measurement per target role');
  const byRole = new Map(rows.map(row => [row.role, row]));
  requireEvidence(byRole.size === roles.length && roles.every(role => byRole.has(role)) &&
    rows.every(row => Number.isSafeInteger(row.startTick) &&
      Number.isSafeInteger(row.endTick) && row.startTick < row.endTick),
  'overlap measurements are incomplete');
  const trigger = byRole.get(triggerRole);
  requireEvidence([...heldRoles, ...throughRoles].every(role =>
    byRole.get(role).startTick < trigger.startTick) &&
    heldRoles.every(role => trigger.startTick < byRole.get(role).endTick) &&
    throughRoles.every(role => trigger.endTick < byRole.get(role).endTick),
  'measured request lifetimes did not overlap the trigger');
  return {qualified: true, triggerStartTick: trigger.startTick,
    triggerEndTick: trigger.endTick, heldRoles: [...heldRoles],
    throughRoles: [...throughRoles]};
}

function exactState(value, expectedBytes) {
  return value?.result === 0 && value.type === 1 &&
    Buffer.isBuffer(value.bytes) && value.bytes.equals(expectedBytes);
}

function absentState(value) {
  return value?.result === MISSING_RESULT && value.type === null &&
    value.bytes === null;
}

function assessAbortControl({preflight, phases, overlap, nonce, readback,
  sdkBase, arenaNonce, waveId, negativePathControl, saveWrites, cleanup,
  borrowedSession, changedPaths}) {
  requireEvidence(preflight?.gameProfile === profile.gameProfile &&
    preflight.markerHitVerified === false &&
    preflight.exactAllocationBytes === null,
  'the conservative Balatro preflight is required');
  requireEvidence(sdkBase === preflight.sdkBase &&
    arenaNonce === preflight.arenaNonce && nonce === preflight.markerNonce &&
    typeof waveId === 'string' && /^[0-9a-f]{16}$/.test(waveId),
  'abort control does not match the pinned boot or unique wave identity');
  const controls = assessNoStorageControls(phases);
  requireEvidence(overlap?.qualified === true &&
    Number.isSafeInteger(overlap.triggerStartTick) &&
    Number.isSafeInteger(overlap.triggerEndTick) &&
    overlap.triggerStartTick < overlap.triggerEndTick,
  'controlled overlap was not measured');
  const expected = content(nonce);
  requireEvidence(negativePathControl === 'executed-absent-path-0x202' &&
    saveWrites === 0 &&
    cleanup === 'verified' && borrowedSession === 'preserved' &&
    Array.isArray(changedPaths) && changedPaths.length === 0,
  'abort control changed storage or did not clean up');
  requireEvidence(exactState(readback?.markerBefore, expected) &&
    exactState(readback?.markerAfter, expected) &&
    absentState(readback?.absentBefore) &&
    absentState(readback?.absentAfter),
  'abort control did not preserve the exact marker and absent path');
  return {abortControlVerified: true, noStorageControls: controls,
    negativePathControl,
    sdkBase, arenaNonce, markerNonce: nonce, waveId,
    overlap, candidateDiagnosticCostBytes: CANDIDATE_DIAGNOSTIC_BYTES,
    exactAllocationBytes: null, markerHitVerified: false,
    fsStageVerified: false};
}

function assessBoundedAbortControls(runs) {
  requireEvidence(Array.isArray(runs) && runs.length > 0 &&
    runs.length <= MAX_ABORT_CONTROLS,
  'abort-control count is outside the bounded plan');
  const assessed = [];
  for (const run of runs) assessed.push(assessAbortControl(run));
  requireEvidence(new Set(assessed.map(run => run.waveId)).size === assessed.length &&
    assessed.every(run => run.sdkBase === assessed[0].sdkBase &&
      run.arenaNonce === assessed[0].arenaNonce &&
      run.markerNonce === assessed[0].markerNonce),
  'abort controls are duplicated or do not share the pinned boot');
  return {abortControlsVerified: assessed.length === MAX_ABORT_CONTROLS,
    count: assessed.length, max: MAX_ABORT_CONTROLS,
    sdkBase: assessed[0].sdkBase, arenaNonce: assessed[0].arenaNonce,
    markerNonce: assessed[0].markerNonce,
    waveIds: assessed.map(run => run.waveId),
    markerHitVerified: false, fsStageVerified: false};
}

function assessExactFsMarker({nonce, sdkBase, arenaNonce, waveId, source,
  phases, overlap, marker, absent, saveWrites, changedPaths,
  cleanup, borrowedSession, abortControls}) {
  requireEvidence(abortControls?.abortControlsVerified === true,
  'both abort controls must pass before a positive marker is evaluated');
  assessNoStorageControls(phases);
  requireEvidence(overlap?.qualified === true &&
    Number.isSafeInteger(overlap.triggerStartTick) &&
    Number.isSafeInteger(overlap.triggerEndTick) &&
    overlap.triggerStartTick < overlap.triggerEndTick &&
    typeof waveId === 'string' && /^[0-9a-f]{16}$/.test(waveId) &&
    !abortControls.waveIds.includes(waveId),
  'positive marker wave lacks distinct measured overlap');
  requireEvidence(sdkBase === abortControls.sdkBase &&
    arenaNonce === abortControls.arenaNonce &&
    nonce === abortControls.markerNonce &&
    source === 'fs-acquisition-readback' &&
    exactState(marker, content(nonce)) && absentState(absent) &&
    saveWrites === 0 && Array.isArray(changedPaths) &&
    changedPaths.length === 0 && cleanup === 'verified' &&
    borrowedSession === 'preserved',
  'FS readback did not contain the exact nonce-bound marker and absent-path control');
  return {markerHitVerified: true, exactMarkerBytes: 16,
    fsStageVerified: false};
}

module.exports = {MAX_ABORT_CONTROLS, CANDIDATE_DIAGNOSTIC_BYTES,
  assessPreflight, assessNoStorageControls, assessOverlap,
  assessAbortControl, assessBoundedAbortControls, assessExactFsMarker};
