const {randomBytes} = require('node:crypto');
const {checkIdentity, checkPaths, makePlan, assessWave} =
  require('./fs-abort-control.cjs');
const {assessNoStorageControls, assessBoundedAbortControls} =
  require('./canary-geometry-plan.cjs');
const {content} = require('./marker-content-control.cjs');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');

const WAVE_COUNT = 2;

function requirePair(condition, message) {
  if (!condition) throw Error(`Balatro abort pair: ${message}`);
}

function freshWaveIds() {
  const first = randomBytes(8).toString('hex');
  let second;
  do {second = randomBytes(8).toString('hex');} while (second === first);
  return [first, second];
}

function validateWaveIds(waveIds, preflight) {
  requirePair(Array.isArray(waveIds) && waveIds.length === WAVE_COUNT &&
    waveIds.every(id => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) &&
      id !== preflight?.arenaNonce && id !== preflight?.markerNonce) &&
    waveIds[0] !== waveIds[1],
  'two distinct wave IDs are required for one retained owner');
}

function describePathStates(states, nonce) {
  const expected = content(nonce);
  const scalar = value => typeof value === 'bigint' ? `0x${value.toString(16)}` :
    value ?? null;
  const describe = state => ({
    markerResult: scalar(state?.marker?.result),
    markerType: scalar(state?.marker?.type),
    markerLength: Buffer.isBuffer(state?.marker?.bytes) ? state.marker.bytes.length : null,
    markerBytesMatch: Buffer.isBuffer(state?.marker?.bytes) &&
      state.marker.bytes.equals(expected),
    absentResult: scalar(state?.absent?.result),
    absentType: scalar(state?.absent?.type),
    absentBytesNull: state?.absent?.bytes === null,
  });
  return {explicitSaveWrites: states?.explicitSaveWrites ?? null,
    original: describe(states?.original), cloned: describe(states?.cloned),
    padded: describe(states?.padded)};
}

function verifyPaths(states, nonce, phase) {
  try {return checkPaths(states, nonce);} catch (cause) {
    const pathDiagnostics = describePathStates(states, nonce);
    const error = Error(`Balatro abort pair: ${phase} path controls differ: ${JSON.stringify(pathDiagnostics)}`,
      {cause});
    error.pathDiagnostics = pathDiagnostics;
    throw error;
  }
}

function verifySaveAudit(changedPaths, waveNumber) {
  if (Array.isArray(changedPaths) && changedPaths.length === 0) return;
  const shown = Array.isArray(changedPaths) ? changedPaths.slice(0, 16) : null;
  const error = Error(`Balatro abort pair: wave ${waveNumber} changed ${
    Array.isArray(changedPaths) ? changedPaths.length : 'an unknown number of'
  } monitored save paths: ${JSON.stringify(shown)}`);
  error.changedPaths = changedPaths;
  throw error;
}

async function readCounterPair(adapter, phase) {
  try {return await adapter.counterPair(phase);} catch (cause) {
    const error = Error(`Balatro abort pair: ${phase} counter IPC is uncertain; retain resources`,
      {cause});
    error.resourceStateUncertain = true;
    throw error;
  }
}

async function runAbortPair({preflight, adapter, waveIds = freshWaveIds(),
  onPhase = () => {}}) {
  requirePair(adapter && ['inspect', 'prepare', 'readPaths', 'counterPair',
    'executeWave', 'auditPaths', 'cleanup'].every(name =>
    typeof adapter[name] === 'function') && typeof onPhase === 'function',
  'a complete owned adapter is required');
  validateWaveIds(waveIds, preflight);
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
  const rawRuns = [];
  try {
    onPhase('prepare-owned-marker-and-handles');
    prepared = await adapter.prepare(preflight);
    for (let index = 0; index < WAVE_COUNT; index++) {
      const waveNumber = index + 1;
      const plan = makePlan({preflight, prepared, waveId: waveIds[index]});
      currentEvidence = {waveNumber, waveId: plan.waveId,
        workerStarted: false, phases: null, waveRows: null,
        pathBefore: null, pathAfter: null,
        changedPaths: null, saveAudit: null};
      currentWaveStarted = false;
      currentWorkerReleased = true;
      onPhase(`wave-${waveNumber}-verify-marker-before`);
      currentEvidence.pathBefore = await adapter.readPaths(prepared);
      const before = verifyPaths(currentEvidence.pathBefore,
        preflight.markerNonce, `wave ${waveNumber} before`);
      const label = index === 0 ? 'first' : 'second';
      const phases = {
        before: await readCounterPair(adapter, `${label}-before`),
        noStorageBefore: await readCounterPair(adapter, `${label}-no-storage-before`),
      };
      currentEvidence.phases = phases;

      onPhase(`wave-${waveNumber}-run-native-abort`);
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
      onPhase(`wave-${waveNumber}-verify-marker-after`);
      currentEvidence.pathAfter = await adapter.readPaths(prepared);
      const after = verifyPaths(currentEvidence.pathAfter,
        preflight.markerNonce, `wave ${waveNumber} after`);
      const changedPaths = await adapter.auditPaths(prepared);
      currentEvidence.changedPaths = changedPaths;
      currentEvidence.saveAudit = typeof adapter.auditDetails === 'function' ?
        adapter.auditDetails() : null;
      verifySaveAudit(changedPaths, waveNumber);
      assessNoStorageControls(phases);
      rawRuns.push({preflight, phases, overlap, nonce: preflight.markerNonce,
        waveRows: currentEvidence.waveRows,
        saveTreeAudit: currentEvidence.saveAudit,
        readback: {markerBefore: before.marker, markerAfter: after.marker,
          absentBefore: before.absent, absentAfter: after.absent},
        sdkBase: preflight.sdkBase, arenaNonce: preflight.arenaNonce,
        waveId: plan.waveId, negativePathControl: plan.negativePathControl,
        saveWrites: 0, changedPaths, borrowedSession: 'preserved'});
      currentEvidence = null;
    }
  } catch (error) {
    if (currentEvidence) {
      error.diagnostic = {
        ...(error.diagnostic && typeof error.diagnostic === 'object' ?
          error.diagnostic : {}),
        currentWave: currentEvidence,
      };
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
      requirePair(ownedCleanupResult?.ownedHandlesClosed === true &&
        markerCleanupVerified(ownedCleanupResult) &&
        ownedCleanupResult.borrowedSession === 'preserved' &&
        ownedCleanupResult.arena === 'released',
      'owned resource cleanup was not verified');
    } catch (cleanupError) {
      const error = primaryError ? new AggregateError([primaryError, cleanupError],
        'Balatro abort pair and cleanup failed; retain resources') :
        Error('Balatro abort pair cleanup is uncertain; retain resources',
          {cause: cleanupError});
      error.resourceStateUncertain = true;
      error.completedWaves = rawRuns.length;
      throw error;
    }
  }
  if (primaryError) {
    if (!prepared || resourceStateUncertain ||
        (currentWaveStarted && !currentWorkerReleased)) {
      const error = Error('Balatro native wave state is uncertain; retain resources and restart before another attempt',
        {cause: primaryError});
      error.resourceStateUncertain = true;
      error.completedWaves = rawRuns.length;
      throw error;
    }
    throw primaryError;
  }
  requirePair(cleanupAttempted && rawRuns.length === WAVE_COUNT,
    'both native abort waves and one cleanup are required');
  const markerCleanup = markerCleanupSummary(ownedCleanupResult);
  const runs = rawRuns.map(run => ({...run, cleanup: 'verified',
    ...markerCleanup}));
  let assessed;
  try {
    assessed = assessBoundedAbortControls(runs);
    requirePair(assessed.abortControlsVerified === true,
      'bounded abort controls did not verify');
  } catch (error) {
    error.diagnostic = {
      ...(error.diagnostic && typeof error.diagnostic === 'object' ?
        error.diagnostic : {}),
      completedRuns: runs,
      cleanup: 'verified',
      ...markerCleanup,
    };
    error.completedWaves = runs.length;
    throw error;
  }
  return {...assessed, runs, cleanup: 'verified', ...markerCleanup,
    clientIpcRequestOverlapMeasured: true,
    fsHandlerOverlapMeasured: false, fsSideMarkerReadbackVerified: false,
    status: 'two same-owner Balatro abort controls verified; FS marker and 2/4 remain unverified'};
}

module.exports = {WAVE_COUNT, freshWaveIds, validateWaveIds,
  describePathStates, runAbortPair};
