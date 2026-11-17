const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');

const NATIVE_TICK_HZ = 19200000;
// Same live reading as marker-localization-live.cjs: the owned-storage open
// cost may drift between retained boots, so the overlap gate accepts the
// measured value within its assessor-enforced bound instead of pinning 14096.
const MAX_CANDIDATE_DIAGNOSTIC_BYTES = 0x10000;
const MAX_ALLOCATION_BYTES = 0x200000;
const ROLES = Object.freeze(['pin', 'receive', 'trigger']);

function requireEvidence(condition, message) {
  if (!condition) throw Error(`Balatro marker wave gate: ${message}`);
}

function tick(value) {
  requireEvidence(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value),
    'native tick is missing or imprecise');
  return BigInt(value);
}

function assessNativeOverlap({localization, worker, trace}) {
  requireEvidence(localization?.gameProfile === profile.gameProfile &&
    localization.runtimeVersion === profile.runtimeVersion &&
    localization.nativeCounterFrequencyVerified === true &&
    localization.serialReceiveOrderVerified === true &&
    Number.isSafeInteger(localization.candidateDiagnosticCostBytes) &&
    localization.candidateDiagnosticCostBytes > 0 &&
    localization.candidateDiagnosticCostBytes <= MAX_CANDIDATE_DIAGNOSTIC_BYTES &&
    localization.exactAllocationBytes === null &&
    localization.pinAddress === null &&
    localization.concurrentOverlapMeasured === false &&
    localization.markerHitVerified === false &&
    localization.fsStageVerified === false,
  'same-boot serial control is missing or already claims a marker');
  requireEvidence(worker?.gameProfile === profile.gameProfile &&
    worker.sdkBase === localization.sdkBase &&
    worker.arenaBase === localization.arenaBase &&
    worker.arenaNonce === localization.arenaNonce &&
    worker.nativeCounterHz === NATIVE_TICK_HZ &&
    worker.integratedFsWorkerVerified === true &&
    worker.cleanup === 'released' && worker.saveWrites === 0 &&
    worker.markerAttempted === false,
  'Balatro integrated FS worker is not verified on this boot');
  requireEvidence(trace?.sdkBase === localization.sdkBase &&
    trace.arenaNonce === localization.arenaNonce &&
    trace.clock === 'native-counter' &&
    trace.clockHz === NATIVE_TICK_HZ &&
    /^[0-9a-f]{16}$/.test(trace.waveId || '') &&
    trace.saveWrites === 0 && trace.cleanup === 'released' &&
    trace.markerAttempted === false &&
    Array.isArray(trace.rows) && trace.rows.length === ROLES.length,
  'overlap trace is missing, stale, or changed savedata');
  const byRole = new Map();
  const requestIds = new Set();
  const threadIds = new Set();
  for (const row of trace.rows) {
    requireEvidence(ROLES.includes(row?.role) && !byRole.has(row.role) &&
      /^[0-9a-f]{16}$/.test(row.requestId || '') &&
      /^[0-9a-f]{16}$/.test(row.threadId || '') &&
      row.counterSource === 'native-worker' && row.result === 0,
    'overlap row is missing an independent native request');
    const issued = tick(row.issuedTick);
    const entered = tick(row.enteredTick);
    const completed = tick(row.completedTick);
    const received = tick(row.receivedTick);
    requireEvidence(issued <= entered && entered < completed &&
      completed <= received,
    'native request timing is out of order');
    requireEvidence(!requestIds.has(row.requestId) &&
      !threadIds.has(row.threadId),
    'overlap rows reused a request or worker thread');
    requestIds.add(row.requestId);
    threadIds.add(row.threadId);
    byRole.set(row.role, {issued, entered, completed, received});
  }
  const trigger = byRole.get('trigger');
  for (const role of ['pin', 'receive']) {
    const held = byRole.get(role);
    requireEvidence(held.entered < trigger.entered &&
      trigger.completed < held.completed,
    `native ${role} request did not span the trigger`);
  }
  return {waveId: trace.waveId, sdkBase: localization.sdkBase,
    arenaNonce: localization.arenaNonce,
    nativeOverlapMeasured: true, markerHitVerified: false,
    fsStageVerified: false};
}

function assessPlacement({localization, placement}) {
  requireEvidence(placement?.gameProfile === profile.gameProfile &&
    placement.sdkBase === localization?.sdkBase &&
    placement.arenaNonce === localization?.arenaNonce &&
    placement.method === 'balatro-native-address-measurement' &&
    placement.command1009UsedAsExactSize === false &&
    placement.saveWrites === 0 && placement.cleanup === 'released' &&
    Number.isSafeInteger(placement.exactAllocationBytes) &&
    placement.exactAllocationBytes > 0 &&
    placement.exactAllocationBytes <= MAX_ALLOCATION_BYTES &&
    /^0x[0-9a-f]+$/.test(placement.pinAddress || '') &&
    BigInt(placement.pinAddress) % 8n === 0n &&
    BigInt(placement.pinAddress) < 1n << 39n &&
    Array.isArray(placement.independentSamples) &&
    placement.independentSamples.length === 2 &&
    placement.independentSamples.every(sample =>
      sample?.exactAllocationBytes === placement.exactAllocationBytes &&
      sample?.method === 'native-address-readback' &&
      sample?.cleanup === 'released'),
  'independently measured Balatro pin address and allocation are missing');
  return {exactAllocationBytes: placement.exactAllocationBytes,
    pinAddress: placement.pinAddress, source: placement.method};
}

function assessReadbackPlan({localization, overlap, placement, markerNonce,
  markerControl, readback}) {
  requireEvidence(overlap?.nativeOverlapMeasured === true &&
    overlap.sdkBase === localization?.sdkBase &&
    overlap.arenaNonce === localization?.arenaNonce &&
    overlap.markerHitVerified === false,
  'native overlap was not measured for this boot');
  const pin = assessPlacement({localization, placement});
  const owned = paths(markerNonce);
  requireEvidence(markerControl?.gameProfile === profile.gameProfile &&
    markerControl.nonce === markerNonce &&
    markerControl.marker === owned.marker &&
    markerControl.absent === owned.absent &&
    markerControl.markerContentVerified === true &&
    markerControl.absentPathVerified === true &&
    markerControl.cleanup === 'verified' &&
    markerControl.markerWaveAttempted === false,
  'owned marker and equal-length absent-path control are missing');
  requireEvidence(readback?.transport === 'balatro-fs-acquisition' &&
    readback.waveId === overlap.waveId &&
    readback.sdkBase === localization.sdkBase &&
    readback.arenaNonce === localization.arenaNonce &&
    readback.markerPath === owned.marker &&
    readback.absentPath === owned.absent &&
    readback.saveWrites === 0 && readback.cleanup === 'released' &&
    readback.borrowedSession === 'preserved' &&
    Buffer.isBuffer(readback.markerBytes) &&
    readback.markerBytes.equals(content(markerNonce)) &&
    readback.absentPathResult === 0x202,
  'FS acquisition readback is missing or differs from the nonce-bound controls');
  requireEvidence(readback.nativeTransportVerified === true &&
    readback.ownedSaveRead === false &&
    readback.clonedSaveRead === false &&
    readback.fsSideReaderVerified === true,
  'readback provenance does not exclude the owned or cloned save path');
  return {waveId: overlap.waveId, ...pin,
    exactMarkerBytesMatched: true, markerHitVerified: false,
    fsStageVerified: false,
    status: 'offline evidence shape accepted; a live FS-side reader and abort controls still require verification'};
}

module.exports = {NATIVE_TICK_HZ, MAX_ALLOCATION_BYTES,
  assessNativeOverlap, assessPlacement, assessReadbackPlan};
