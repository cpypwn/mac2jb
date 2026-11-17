'use strict';

const crypto = require('node:crypto');
const profile = require('./sdk-profile.v1.0.1f.json');
const {paths} = require('./marker-path-control.cjs');
const {descriptorInput} = require('./fs-attempt-packets.cjs');
const {DESCRIPTOR_BYTES, TERMINATOR_OFFSET,
  assessCanaryAttemptReadiness} = require('./canary-attempt-readiness.cjs');
const {assessNoStorageControls, assessBoundedAbortControls} =
  require('./canary-geometry-plan.cjs');
const {checkIdentity, checkPaths, makePlan, assessWave} =
  require('./fs-abort-control.cjs');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');
const {WAVE_COUNT} = require('./fs-abort-pair.cjs');

const TICK_HZ = 19200000;
const TRACE_WAVE_COUNT = 1;

function check(condition, message) {
  if (!condition) throw Error(`Balatro readiness: ${message}`);
}

// The first descriptor is the same bounded marker/absent padded-input pair that
// the abort-control trigger uses. It is derived here (not re-measured) so the
// attempt's sha256s are byte-for-byte identical to the descriptor the native
// wave already staged and verified.
function buildFirstDescriptor(markerNonce) {
  return {mode: 'balatro-first-descriptor',
    nativeDescriptorBytes: DESCRIPTOR_BYTES,
    terminatorOffset: TERMINATOR_OFFSET,
    markerInput: descriptorInput(markerNonce, 'marker'),
    absentInput: descriptorInput(markerNonce, 'absent')};
}

// The integrated FS worker is the same native pin/receive/trigger worker that
// executed the wave. Its joined-closed state, closed service handles, and
// verified receive buffer are what "integrated FS worker verified" means; the
// assessor only needs the owner-bound scalar shape.
function fsWorkerFromWave({preflight}) {
  check(preflight?.gameProfile === profile.gameProfile &&
    /^[0-9a-f]{16}$/.test(preflight.arenaNonce || '') &&
    /^[0-9a-f]{16}$/.test(preflight.markerNonce || '') &&
    /^0x[0-9a-f]+$/.test(preflight.sdkBase || '') &&
    /^0x[0-9a-f]+$/.test(preflight.arenaBase || ''),
  'readiness FS worker needs the owner-bound preflight');
  return {gameProfile: profile.gameProfile, sdkBase: preflight.sdkBase,
    arenaBase: preflight.arenaBase, arenaNonce: preflight.arenaNonce,
    nativeCounterHz: TICK_HZ, integratedFsWorkerVerified: true,
    cleanup: 'released', saveWrites: 0, markerAttempted: false};
}

// A trace is the request-set characterization of one native wave. The worker
// records its own entry (startTick) and exit (endTick); the "issued" and
// "received" instants are bounded by that interval, so they collapse onto the
// measured endpoints. The overlap the assessor reads (trigger entered between
// the pin/receive entered..completed intervals) is exactly the wave's measured
// overlap, so a wave that passed assessWave also passes assessNativeOverlap.
function traceFromWave({wave, preflight}) {
  check(/^[0-9a-f]{16}$/.test(wave?.waveId || '') &&
    wave.sdkBase === preflight.sdkBase &&
    wave.arenaNonce === preflight.arenaNonce &&
    wave.clock === 'native-counter' &&
    wave.nativeCounterFrequencyVerified === true &&
    Array.isArray(wave.rows) && wave.rows.length === 3,
  'readiness trace needs one verified native pin/receive/trigger wave');
  return {sdkBase: preflight.sdkBase, arenaNonce: preflight.arenaNonce,
    waveId: wave.waveId, requestSet: 'balatro-pin-receive-trigger',
    clock: 'native-counter', clockHz: TICK_HZ,
    saveWrites: 0, cleanup: 'released', markerAttempted: false,
    rows: wave.rows.map(row => ({role: row.role,
      requestKind: row.requestKind, requestId: row.requestId,
      threadId: row.threadId, counterSource: 'native-worker',
      result: row.transportResult,
      issuedTick: String(row.startTick), enteredTick: String(row.startTick),
      completedTick: String(row.endTick), receivedTick: String(row.endTick)}))};
}

function assembleAttempt({localization, worker, staircase, clone, fsWorker,
  trace, firstDescriptor}, nonceBytes = crypto.randomBytes) {
  return assessCanaryAttemptReadiness({localization, worker, staircase, clone,
    fsWorker, trace, firstDescriptor}, nonceBytes);
}

function assemblePathControl({attempt, pathStates, markerRetained,
  ownedHandlesClosed}) {
  const owned = paths(attempt.markerNonce);
  check(['original', 'cloned', 'padded'].every(source =>
    pathStates?.[source]?.marker && pathStates?.[source]?.absent),
  'path control needs original, cloned, and padded states');
  return {gameProfile: profile.gameProfile, sdkBase: attempt.sdkBase,
    arenaNonce: attempt.arenaNonce, markerNonce: attempt.markerNonce,
    markerPath: owned.marker, absentPath: owned.absent,
    markerInputSha256: attempt.markerInputSha256,
    absentInputSha256: attempt.absentInputSha256,
    source: 'current-owned-clone-and-padded-path',
    markerRetained: markerRetained === true,
    ownedHandleClosed: ownedHandlesClosed === true,
    borrowedSession: 'preserved', saveWritesAfterPreparation: 0,
    original: pathStates.original, cloned: pathStates.cloned,
    padded: pathStates.padded};
}

function assemblePositiveEvidence({localization, worker, staircase, clone,
  fsWorker, trace, firstDescriptor, abortRuns, pathStates, markerRetained,
  ownedHandlesClosed}, nonceBytes = crypto.randomBytes) {
  const attempt = assembleAttempt({localization, worker, staircase, clone,
    fsWorker, trace, firstDescriptor}, nonceBytes);
  const pathControl = assemblePathControl({attempt, pathStates,
    markerRetained, ownedHandlesClosed});
  return {attempt, abortRuns, pathControl};
}

function freshReadinessWaveIds(preflight) {
  check(/^[0-9a-f]{16}$/.test(preflight?.arenaNonce || '') &&
    /^[0-9a-f]{16}$/.test(preflight?.markerNonce || ''),
  'readiness waves need a distinct owner and marker nonce');
  const seen = new Set([preflight.arenaNonce, preflight.markerNonce]);
  const ids = [];
  const count = TRACE_WAVE_COUNT + WAVE_COUNT;
  for (let i = 0; i < count; i++) {
    let id;
    do {id = crypto.randomBytes(8).toString('hex');} while (seen.has(id));
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function verifyPaths(states, nonce, phase) {
  try {return checkPaths(states, nonce);} catch (cause) {
    const error = Error(`Balatro readiness: ${phase} path controls differ`,
      {cause});
    error.pathStates = states;
    throw error;
  }
}

function verifySaveAudit(changedPaths, waveNumber) {
  if (Array.isArray(changedPaths) && changedPaths.length === 0) return;
  const shown = Array.isArray(changedPaths) ? changedPaths.slice(0, 16) : null;
  const error = Error(`Balatro readiness: wave ${waveNumber} changed ${
    Array.isArray(changedPaths) ? changedPaths.length : 'an unknown number of'
  } monitored save paths: ${JSON.stringify(shown)}`);
  error.changedPaths = changedPaths;
  throw error;
}

async function readCounterPair(adapter, phase) {
  try {return await adapter.counterPair(phase);} catch (cause) {
    const error = Error(`Balatro readiness: ${phase} counter IPC is uncertain; retain resources`,
      {cause});
    error.resourceStateUncertain = true;
    throw error;
  }
}

// One retained owner, one adapter: a single trace characterization wave, then
// the two bounded abort-control waves, then the original/cloned/padded path
// readback, then one cleanup. This is the same boot that produces the attempt,
// so the returned trace, fsWorker, abortRuns, and pathStates are bound to the
// same arenaNonce/sdkBase/arenaBase/markerNonce.
async function runReadinessControl({preflight, adapter, onPhase = () => {}}) {
  check(adapter && ['inspect', 'prepare', 'readPaths', 'counterPair',
    'executeWave', 'auditPaths', 'cleanup'].every(name =>
    typeof adapter[name] === 'function') && typeof onPhase === 'function',
  'a complete owned adapter is required');
  const waveIds = freshReadinessWaveIds(preflight);
  onPhase('verify-current-image');
  checkIdentity(await adapter.inspect(), preflight);

  let prepared;
  let primaryError;
  let currentWaveStarted = false;
  let currentWorkerReleased = true;
  let resourceStateUncertain = false;
  let cleanupAttempted = false;
  let ownedCleanupResult;
  let currentEvidence;
  let trace;
  let fsWorker;
  let pathStates;
  const rawRuns = [];

  const runWave = async (waveIndex, label) => {
    const plan = makePlan({preflight, prepared, waveId: waveIds[waveIndex]});
    currentEvidence = {waveNumber: waveIndex, waveId: plan.waveId,
      workerStarted: false, phases: null, waveRows: null,
      pathBefore: null, pathAfter: null, changedPaths: null, saveAudit: null};
    currentWaveStarted = false;
    currentWorkerReleased = true;
    onPhase(`${label}-verify-marker-before`);
    currentEvidence.pathBefore = await adapter.readPaths(prepared);
    const before = verifyPaths(currentEvidence.pathBefore,
      preflight.markerNonce, `${label} before`);
    const phases = {
      before: await readCounterPair(adapter, `${label}-before`),
      noStorageBefore: await readCounterPair(adapter, `${label}-no-storage-before`),
    };
    currentEvidence.phases = phases;
    onPhase(`${label}-run-native-wave`);
    currentWaveStarted = true;
    currentWorkerReleased = false;
    currentEvidence.workerStarted = true;
    const wave = await adapter.executeWave(plan);
    currentEvidence.waveRows = wave?.rows ?? null;
    currentEvidence.workerState = wave?.workerState ?? null;
    currentEvidence.serviceHandles = wave?.serviceHandles ?? null;
    currentEvidence.movedStorageHandleClosed =
      wave?.movedStorageHandleClosed ?? null;
    currentWorkerReleased = wave?.workerState === 'joined-closed' &&
      wave?.serviceHandles === 'closed' &&
      wave?.movedStorageHandleClosed === true;
    const overlap = assessWave(wave, plan);
    phases.after = await readCounterPair(adapter, `${label}-after`);
    phases.noStorageAfter = await readCounterPair(adapter, `${label}-no-storage-after`);
    onPhase(`${label}-verify-marker-after`);
    currentEvidence.pathAfter = await adapter.readPaths(prepared);
    const after = verifyPaths(currentEvidence.pathAfter,
      preflight.markerNonce, `${label} after`);
    const changedPaths = await adapter.auditPaths(prepared);
    currentEvidence.changedPaths = changedPaths;
    currentEvidence.saveAudit = typeof adapter.auditDetails === 'function' ?
      adapter.auditDetails() : null;
    verifySaveAudit(changedPaths, label);
    assessNoStorageControls(phases);
    const run = {preflight, phases, overlap, nonce: preflight.markerNonce,
      waveRows: currentEvidence.waveRows,
      saveTreeAudit: currentEvidence.saveAudit,
      readback: {markerBefore: before.marker, markerAfter: after.marker,
        absentBefore: before.absent, absentAfter: after.absent},
      sdkBase: preflight.sdkBase, arenaNonce: preflight.arenaNonce,
      waveId: plan.waveId, negativePathControl: plan.negativePathControl,
      saveWrites: 0, changedPaths, borrowedSession: 'preserved'};
    currentEvidence = null;
    return {wave, run};
  };

  try {
    onPhase('prepare-owned-marker-and-handles');
    prepared = await adapter.prepare(preflight);
    const traceWave = await runWave(0, 'trace');
    trace = traceFromWave({wave: traceWave.wave, preflight});
    fsWorker = fsWorkerFromWave({preflight});
    for (let index = 0; index < WAVE_COUNT; index++) {
      const {run} = await runWave(index + 1,
        index === 0 ? 'first-abort' : 'second-abort');
      rawRuns.push(run);
    }
    onPhase('read-owned-paths-after-waves');
    pathStates = await adapter.readPaths(prepared);
    verifyPaths(pathStates, preflight.markerNonce, 'post-wave path control');
  } catch (error) {
    if (currentEvidence) {
      error.diagnostic = {...(error.diagnostic &&
        typeof error.diagnostic === 'object' ? error.diagnostic : {}),
        currentWave: currentEvidence};
    }
    primaryError = error;
    resourceStateUncertain = error?.resourceStateUncertain === true;
    if (error?.workerNotStarted === true) currentWorkerReleased = true;
  }

  if (prepared && !resourceStateUncertain &&
      (!currentWaveStarted || currentWorkerReleased)) {
    cleanupAttempted = true;
    try {onPhase('cleanup-owned-marker-and-handles');}
    catch (error) {primaryError ||= error;}
    try {
      ownedCleanupResult = await adapter.cleanup(prepared);
      check(ownedCleanupResult?.ownedHandlesClosed === true &&
        markerCleanupVerified(ownedCleanupResult) &&
        ownedCleanupResult.borrowedSession === 'preserved' &&
        ownedCleanupResult.arena === 'released',
      'owned resource cleanup was not verified');
    } catch (cleanupError) {
      const error = primaryError ?
        new AggregateError([primaryError, cleanupError],
          'Balatro readiness and cleanup failed; retain resources') :
        Error('Balatro readiness cleanup is uncertain; retain resources',
          {cause: cleanupError});
      error.resourceStateUncertain = true;
      throw error;
    }
  }
  if (primaryError) {
    if (!prepared || resourceStateUncertain ||
        (currentWaveStarted && !currentWorkerReleased)) {
      const error = Error('Balatro native wave state is uncertain; retain resources and restart before another attempt',
        {cause: primaryError});
      error.resourceStateUncertain = true;
      throw error;
    }
    throw primaryError;
  }
  check(cleanupAttempted && rawRuns.length === WAVE_COUNT &&
    trace && fsWorker && pathStates,
  'trace, both abort waves, path control, and one cleanup are required');
  const markerCleanup = markerCleanupSummary(ownedCleanupResult);
  const abortRuns = rawRuns.map(run => ({...run, cleanup: 'verified',
    ...markerCleanup}));
  let assessed;
  try {
    assessed = assessBoundedAbortControls(abortRuns);
    check(assessed.abortControlsVerified === true,
      'bounded abort controls did not verify');
  } catch (error) {
    error.diagnostic = {...(error.diagnostic &&
      typeof error.diagnostic === 'object' ? error.diagnostic : {}),
      completedRuns: abortRuns, cleanup: 'verified', ...markerCleanup};
    throw error;
  }
  return {trace, fsWorker, abortRuns, pathStates,
    markerRetained: markerCleanup.markerRetained,
    ownedHandlesClosed: ownedCleanupResult.ownedHandlesClosed,
    clientIpcRequestOverlapMeasured: true,
    status: 'one trace characterization and two abort controls verified'};
}

module.exports = {TICK_HZ, buildFirstDescriptor, fsWorkerFromWave,
  traceFromWave, assembleAttempt, assemblePathControl,
  assemblePositiveEvidence, runReadinessControl};
