const {randomBytes} = require('node:crypto');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {assessOverlap, assessAbortControl} = require('./canary-geometry-plan.cjs');
const {makePinRequest, makeReceiveRequest, makeTriggerRequest} =
  require('./fs-attempt-packets.cjs');
const {descriptorInput} = require('./fs-attempt-packets.cjs');
const {belongsToTransport} = require('./fs-attempt-packets.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');

const MAX_WAVE_TICKS = 19200000 * 2;
const EXPECTED_KINDS = Object.freeze({pin: 'owned-storage-open',
  receive: 'receive-buffer-request', trigger: 'cloned-save-entry-type'});

function check(condition, message) {
  if (!condition) throw Error(`Balatro abort control: ${message}`);
}

function exactPathState(state, markerBytes) {
  return state?.marker?.result === 0 && state.marker.type === 1 &&
    Buffer.isBuffer(state.marker.bytes) && state.marker.bytes.equals(markerBytes) &&
    state?.absent?.result === 0x202 && state.absent.type === null &&
    state.absent.bytes === null;
}

function checkPaths(states, nonce) {
  const expected = content(nonce);
  check(states?.explicitSaveWrites === 0 &&
    ['original', 'cloned', 'padded'].every(source =>
      exactPathState(states[source], expected)),
  'original, cloned, and padded marker/absent controls must match exactly');
  return {marker: states.original.marker, absent: states.original.absent};
}

function checkIdentity(identity, preflight) {
  check(identity?.state === 'serving' &&
    identity.gameProfile === profile.gameProfile &&
    identity.runtimeVersion === profile.runtimeVersion &&
    identity.codeHeadProfile === '1.0.1f' &&
    identity.sdkBase === preflight.sdkBase &&
    identity.arenaBase === preflight.arenaBase &&
    identity.arenaNonce === preflight.arenaNonce &&
    identity.ownerState === 'ready' && identity.workers === 0 &&
    identity.ownedHandles === 0,
  'current image or native owner is not idle and pinned');
  return identity;
}

function makePlan({preflight, prepared, waveId}) {
  check(preflight?.gameProfile === profile.gameProfile &&
    preflight.exactAllocationBytes === null &&
    preflight.markerHitVerified === false &&
    preflight.fsStageVerified === false &&
    /^[0-9a-f]{16}$/.test(preflight.arenaNonce || '') &&
    /^[0-9a-f]{16}$/.test(preflight.markerNonce || '') &&
    /^[0-9a-f]{16}$/.test(waveId || '') &&
    waveId !== preflight.arenaNonce && waveId !== preflight.markerNonce,
  'a distinct same-boot abort-control identity is required');
  check(prepared?.arenaNonce === preflight.arenaNonce &&
    prepared.markerNonce === preflight.markerNonce &&
    prepared.sdkBase === preflight.sdkBase &&
    prepared.markerPath === paths(preflight.markerNonce).marker &&
    prepared.absentPath === paths(preflight.markerNonce).absent &&
    prepared.markerWrittenAndVerified === true &&
    prepared.borrowedSession === 'preserved' &&
    prepared.ownedHandlesOpen === true &&
    prepared.explicitSaveWrites === 1 &&
    prepared.transport instanceof BalatroCloneTransport &&
    prepared.transport.evidence.sdkBase === preflight.sdkBase &&
    prepared.context?.arena === BigInt(preflight.arenaBase) &&
    prepared.context.sdk === BigInt(preflight.sdkBase) &&
    prepared.context.scratch === BigInt(prepared.transport.scratch) &&
    prepared.context.nonce === preflight.arenaNonce &&
    prepared.transport.scratch === Number(BigInt(preflight.arenaBase) + 0x10000n) &&
    prepared.pathAddress === prepared.transport.pathAddress &&
    prepared.receiveAddress === prepared.transport.dataAddress &&
    belongsToTransport(prepared.clone, prepared.transport, 'clone') &&
    belongsToTransport(prepared.file, prepared.transport, 'file'),
  'marker setup or owned handles are not verified');
  const pin = makePinRequest({context: prepared.context, root: prepared.root});
  const receive = makeReceiveRequest({file: prepared.file,
    receiveAddress: prepared.receiveAddress});
  const trigger = makeTriggerRequest({clone: prepared.clone,
    nonce: preflight.markerNonce, pathAddress: prepared.pathAddress,
    which: 'absent'});
  const requests = {pin, receive, trigger};
  check(new Set(Object.values(requests).map(row => row.handle)).size === 3 &&
    Object.entries(requests).every(([role, row]) =>
      row.requestKind === EXPECTED_KINDS[role] &&
      Buffer.isBuffer(row.packet) && row.packet.length <= 256),
  'pin, receive, and trigger need distinct owned handles and exact packets');
  check(trigger.descriptorInput.length === 0x800 &&
    trigger.descriptorInput.equals(descriptorInput(preflight.markerNonce, 'absent')) &&
    trigger.descriptorInput[0x7ff] === 0 &&
    trigger.aborted === false,
  'negative control must use the verified nonce-bound absent path');
  return {waveId, sdkBase: preflight.sdkBase,
    arenaNonce: preflight.arenaNonce, markerNonce: preflight.markerNonce,
    requests, maxDurationMs: 2000, maximumWorkers: 3,
    explicitSaveWrites: 0,
    negativePathControl: 'executed-absent-path-0x202',
    triggerControl: 'nonce-bound-absent-path',
    markerHitVerified: false, fsStageVerified: false};
}

function assessWave(wave, plan) {
  check(wave?.waveId === plan.waveId &&
    wave.sdkBase === plan.sdkBase &&
    wave.arenaNonce === plan.arenaNonce &&
    wave.clock === 'native-counter' &&
    wave.nativeCounterFrequencyVerified === true &&
    wave.workerState === 'joined-closed' &&
    wave.serviceHandles === 'closed' &&
    wave.movedStorageHandleClosed === true &&
    wave.receiveBufferVerified === true &&
    wave.triggerControl === plan.triggerControl &&
    wave.borrowedSession === 'preserved' &&
    wave.explicitSaveWrites === 0 &&
    wave.negativePathControl === plan.negativePathControl &&
    Array.isArray(wave.rows) && wave.rows.length === 3,
  'native worker result or cleanup is incomplete');
  const byRole = new Map();
  const threadIds = new Set();
  const requestIds = new Set();
  for (const row of wave.rows) {
    const expected = plan.requests[row?.role];
    check(expected && !byRole.has(row.role) &&
      row.requestKind === expected.requestKind &&
      row.handle === expected.handle &&
      /^[0-9a-f]{16}$/.test(row.threadId || '') &&
      /^[0-9a-f]{16}$/.test(row.requestId || '') &&
      !threadIds.has(row.threadId) && !requestIds.has(row.requestId) &&
      Number.isSafeInteger(row.startTick) &&
      Number.isSafeInteger(row.endTick) &&
      row.startTick < row.endTick &&
      row.endTick - row.startTick <= MAX_WAVE_TICKS &&
      row.transportResult === 0 &&
      row.ipcResult === (row.role === 'trigger' ? 0x202 : 0) &&
      (row.role !== 'receive' || row.receiveBytesVerified === 16),
    'native role, handle, result, or bounded timing changed');
    byRole.set(row.role, row);
    threadIds.add(row.threadId);
    requestIds.add(row.requestId);
  }
  return assessOverlap({rows: wave.rows, heldRoles: ['pin'],
    throughRoles: ['receive'], clock: wave.clock,
    nativeCounterFrequencyVerified: wave.nativeCounterFrequencyVerified});
}

async function runAbortControl({preflight, adapter,
  waveId = randomBytes(8).toString('hex'), onPhase = () => {}}) {
  check(adapter && ['inspect', 'prepare', 'readPaths', 'counterPair',
    'executeWave', 'auditPaths', 'cleanup'].every(name =>
      typeof adapter[name] === 'function') &&
    typeof onPhase === 'function',
  'a complete one-shot native adapter is required');
  onPhase('verify-current-image');
  checkIdentity(await adapter.inspect(), preflight);
  let prepared;
  let waveStarted = false;
  let workerCleanupCertain = false;
  let resourceStateUncertain = false;
  let cleanupAttempted = false;
  let markerCleanup;
  let primaryError;
  let result;
  let wave;
  let phases;
  try {
    onPhase('prepare-owned-marker-and-handles');
    prepared = await adapter.prepare(preflight);
    const plan = makePlan({preflight, prepared, waveId});
    onPhase('verify-marker-before');
    const before = checkPaths(await adapter.readPaths(prepared),
      preflight.markerNonce);
    phases = {before: await adapter.counterPair('before'),
      noStorageBefore: await adapter.counterPair('no-storage-before')};
    onPhase('run-single-native-abort');
    waveStarted = true;
    wave = await adapter.executeWave(plan);
    workerCleanupCertain = wave?.workerState === 'joined-closed' &&
      wave?.serviceHandles === 'closed' &&
      wave?.movedStorageHandleClosed === true;
    const overlap = assessWave(wave, plan);
    phases.after = await adapter.counterPair('after');
    phases.noStorageAfter = await adapter.counterPair('no-storage-after');
    onPhase('verify-marker-after');
    const after = checkPaths(await adapter.readPaths(prepared),
      preflight.markerNonce);
    const changedPaths = await adapter.auditPaths(prepared);
    check(Array.isArray(changedPaths),
      'native wave save audit did not return changed paths');
    if (changedPaths.length) {
      const error = Error('Balatro abort control: native wave changed a monitored save path');
      error.diagnostic = {changedPaths,
        saveTreeAudit: typeof adapter.auditDetails === 'function' ?
          adapter.auditDetails() : null};
      throw error;
    }
    result = {preflight, phases, overlap, nonce: preflight.markerNonce,
      readback: {markerBefore: before.marker, markerAfter: after.marker,
        absentBefore: before.absent, absentAfter: after.absent},
      sdkBase: preflight.sdkBase, arenaNonce: preflight.arenaNonce,
      waveId, negativePathControl: plan.negativePathControl, saveWrites: 0,
      changedPaths, borrowedSession: 'preserved'};
  } catch (error) {
    if (wave || phases || error.rawSamples) {
      error.diagnostic = {...error.diagnostic,
        counterPhases: phases || null,
        failedCounterPhase: error.counterPhase || null,
        failedCounterRawSamples: error.rawSamples || null,
        saveTreeAudit: typeof adapter.auditDetails === 'function' ?
          adapter.auditDetails() : null,
        waveRows: wave?.rows || null,
        workerState: wave?.workerState || null,
        serviceHandles: wave?.serviceHandles || null,
        movedStorageHandleClosed: wave?.movedStorageHandleClosed || null};
    }
    primaryError = error;
    resourceStateUncertain = error?.resourceStateUncertain === true;
    if (error?.workerNotStarted === true) workerCleanupCertain = true;
  }
  if (prepared && !resourceStateUncertain &&
      (!waveStarted || workerCleanupCertain)) {
    cleanupAttempted = true;
    onPhase('cleanup-owned-marker-and-handles');
    try {
      const cleaned = await adapter.cleanup(prepared);
      check(cleaned?.ownedHandlesClosed === true &&
        markerCleanupVerified(cleaned) &&
        cleaned.borrowedSession === 'preserved' &&
        cleaned.arena === 'released',
      'owned resource cleanup was not verified');
      markerCleanup = markerCleanupSummary(cleaned);
    } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError],
        'Balatro abort control and cleanup failed');
      throw cleanupError;
    }
  }
  if (primaryError) {
    if (resourceStateUncertain || (waveStarted && !workerCleanupCertain)) {
      throw new Error('Balatro native wave state is uncertain; retain resources and restart before another attempt',
        {cause: primaryError});
    }
    throw primaryError;
  }
  check(cleanupAttempted && result,
    'native abort control did not complete and release its owner');
  let assessed;
  try {
    assessed = assessAbortControl({...result, cleanup: 'verified'});
  } catch (error) {
    error.diagnostic = {cleanup: 'verified',
      counterPhases: result.phases, overlap: result.overlap,
      waveRows: wave.rows,
      saveTreeAudit: typeof adapter.auditDetails === 'function' ?
        adapter.auditDetails() : null};
    throw error;
  }
  return {...assessed, ...markerCleanup,
    clientIpcRequestOverlapMeasured: true,
    counterPhases: result.phases,
    waveRows: wave.rows,
    saveTreeAudit: typeof adapter.auditDetails === 'function' ?
      adapter.auditDetails() : null,
    fsHandlerOverlapMeasured: false, fsSideMarkerReadbackVerified: false,
    status: 'one Balatro abort control verified; FS marker and 2/4 remain unverified'};
}

function makePositivePlan({preflight, prepared, waveId, positiveDescriptor,
  scratchClone}) {
  check(preflight?.gameProfile === profile.gameProfile &&
    preflight.exactAllocationBytes === null &&
    preflight.markerHitVerified === false &&
    preflight.fsStageVerified === false &&
    /^[0-9a-f]{16}$/.test(preflight.arenaNonce || '') &&
    /^[0-9a-f]{16}$/.test(preflight.markerNonce || '') &&
    /^[0-9a-f]{16}$/.test(waveId || '') &&
    waveId !== preflight.arenaNonce && waveId !== preflight.markerNonce,
  'a distinct same-boot positive-wave identity is required');
  check(prepared?.arenaNonce === preflight.arenaNonce &&
    prepared.markerNonce === preflight.markerNonce &&
    prepared.sdkBase === preflight.sdkBase &&
    prepared.markerPath === paths(preflight.markerNonce).marker &&
    prepared.absentPath === paths(preflight.markerNonce).absent &&
    prepared.markerWrittenAndVerified === true &&
    prepared.borrowedSession === 'preserved' &&
    prepared.ownedHandlesOpen === true &&
    prepared.explicitSaveWrites === 1 &&
    prepared.transport instanceof BalatroCloneTransport &&
    prepared.transport.evidence.sdkBase === preflight.sdkBase &&
    prepared.context?.arena === BigInt(preflight.arenaBase) &&
    prepared.context.sdk === BigInt(preflight.sdkBase) &&
    prepared.context.scratch === BigInt(prepared.transport.scratch) &&
    prepared.context.nonce === preflight.arenaNonce &&
    prepared.transport.scratch === Number(BigInt(preflight.arenaBase) + 0x10000n) &&
    prepared.pathAddress === prepared.transport.pathAddress &&
    prepared.receiveAddress === prepared.transport.dataAddress &&
    belongsToTransport(prepared.clone, prepared.transport, 'clone') &&
    belongsToTransport(prepared.file, prepared.transport, 'file') &&
    belongsToTransport(scratchClone, prepared.transport, 'clone'),
  'marker setup, owned handles, or scratch clone are not verified');
  check(Buffer.isBuffer(positiveDescriptor) &&
    positiveDescriptor.length >= 0x800 &&
    positiveDescriptor.length <= 0x3000 &&
    positiveDescriptor[positiveDescriptor.length - 1] === 0 &&
    positiveDescriptor.subarray(0, positiveDescriptor.length - 1)
      .every(byte => byte !== 0),
  'positive candidate must be a bounded NUL-terminated first descriptor');
  const pin = makePinRequest({context: prepared.context, root: prepared.root});
  const receive = makeReceiveRequest({file: prepared.file,
    receiveAddress: prepared.receiveAddress});
  const trigger = makeTriggerRequest({clone: scratchClone,
    nonce: preflight.markerNonce, pathAddress: prepared.transport.positivePathAddress,
    which: 'absent', descriptor: positiveDescriptor});
  const requests = {pin, receive, trigger};
  check(new Set(Object.values(requests).map(row => row.handle)).size === 3 &&
    Object.entries(requests).every(([role, row]) =>
      row.requestKind === EXPECTED_KINDS[role] &&
      Buffer.isBuffer(row.packet) && row.packet.length <= 256),
  'pin, receive, and trigger need distinct owned handles and exact packets');
  check(trigger.descriptorInput.equals(positiveDescriptor) &&
    trigger.aborted === false &&
    trigger.handle !== prepared.clone.handle,
  'positive trigger must carry the exact B-filler candidate on the scratch clone');
  return {waveId, sdkBase: preflight.sdkBase,
    arenaNonce: preflight.arenaNonce, markerNonce: preflight.markerNonce,
    requests, maxDurationMs: 2000, maximumWorkers: 3,
    explicitSaveWrites: 0,
    positivePathControl: 'executed-b-filler-candidate',
    triggerControl: 'b-filler-positive-candidate',
    markerHitVerified: false, fsStageVerified: false};
}

function assessPositiveWave(wave, plan) {
  check(wave?.waveId === plan.waveId &&
    wave.sdkBase === plan.sdkBase &&
    wave.arenaNonce === plan.arenaNonce &&
    wave.clock === 'native-counter' &&
    wave.nativeCounterFrequencyVerified === true &&
    wave.workerState === 'joined-closed' &&
    wave.serviceHandles === 'closed' &&
    wave.movedStorageHandleClosed === true &&
    wave.receiveBufferVerified === true &&
    wave.triggerControl === plan.triggerControl &&
    wave.borrowedSession === 'preserved' &&
    wave.explicitSaveWrites === 0 &&
    wave.positivePathControl === plan.positivePathControl &&
    Array.isArray(wave.rows) && wave.rows.length === 3,
  'native positive worker result or cleanup is incomplete');
  const byRole = new Map();
  const threadIds = new Set();
  const requestIds = new Set();
  for (const row of wave.rows) {
    const expected = plan.requests[row?.role];
    check(expected && !byRole.has(row.role) &&
      row.requestKind === expected.requestKind &&
      row.handle === expected.handle &&
      /^[0-9a-f]{16}$/.test(row.threadId || '') &&
      /^[0-9a-f]{16}$/.test(row.requestId || '') &&
      !threadIds.has(row.threadId) && !requestIds.has(row.requestId) &&
      Number.isSafeInteger(row.startTick) &&
      Number.isSafeInteger(row.endTick) &&
      row.startTick < row.endTick &&
      row.endTick - row.startTick <= MAX_WAVE_TICKS &&
      row.transportResult === 0 &&
      (row.role === 'trigger' || row.ipcResult === 0) &&
      (row.role !== 'receive' || row.receiveBytesVerified === 16),
    'native positive role, handle, result, or bounded timing changed');
    byRole.set(row.role, row);
    threadIds.add(row.threadId);
    requestIds.add(row.requestId);
  }
  return assessOverlap({rows: wave.rows, heldRoles: ['receive'],
    throughRoles: ['pin'], clock: wave.clock,
    nativeCounterFrequencyVerified: wave.nativeCounterFrequencyVerified});
}

function flippedMarkerState(state) {
  return state?.marker?.result === 0 && state.marker.type === 0 &&
    state.marker.bytes === null &&
    state?.absent?.result === 0x202 && state.absent.type === null &&
    state.absent.bytes === null;
}

function checkFlippedMarker(states, nonce) {
  check(states?.explicitSaveWrites === 0 &&
    ['original', 'cloned', 'padded'].every(source =>
      flippedMarkerState(states[source])),
  'marker entry type did not flip to directory after the positive wave');
  return {marker: states.original.marker, absent: states.original.absent};
}

async function runPositiveWave({preflight, adapter, positiveDescriptor,
  scratchClone, prepared: preparedInput = null,
  positiveReadiness, readCanary, canaryAfterCommit, cleanupScratch,
  waveId = randomBytes(8).toString('hex'), onPhase = () => {}}) {
  check(adapter && ['inspect', 'prepare', 'readPaths', 'counterPair',
    'executePositiveWave', 'auditPaths', 'cleanup'].every(name =>
      typeof adapter[name] === 'function') &&
    typeof readCanary === 'function' &&
    typeof cleanupScratch === 'function' &&
    typeof onPhase === 'function',
  'a complete one-shot native adapter, canary reader, and scratch cleanup are required');
  check(positiveReadiness?.positiveWaveAllowed === true &&
    positiveReadiness.phase === 'single-matched-comparison' &&
    positiveReadiness.abortControlsVerified === true &&
    positiveReadiness.nativePaddedLookupVerified === true &&
    positiveReadiness.sdkBase === preflight?.sdkBase &&
    positiveReadiness.arenaNonce === preflight?.arenaNonce &&
    positiveReadiness.markerNonce === preflight?.markerNonce,
  'same-session positive readiness decision is required');
  if (!preparedInput) {
    onPhase('verify-current-image');
    checkIdentity(await adapter.inspect(), preflight);
  }
  let prepared;
  let waveStarted = false;
  let workerCleanupCertain = false;
  let resourceStateUncertain = false;
  let cleanupAttempted = false;
  let markerCleanup;
  let primaryError;
  let result;
  let wave;
  let phases;
  try {
    if (!preparedInput) {
      onPhase('prepare-owned-marker-and-handles');
      prepared = await adapter.prepare(preflight);
    } else {
      prepared = preparedInput;
    }
    const plan = makePositivePlan({preflight, prepared, waveId,
      positiveDescriptor, scratchClone});
    onPhase('verify-marker-before');
    const before = checkPaths(await adapter.readPaths(prepared),
      preflight.markerNonce);
    const canaryBefore = await readCanary();
    check(canaryAfterCommit?.result === 0 &&
      canaryAfterCommit.type === 1 &&
      canaryBefore?.result === 0 && canaryBefore.type === 1,
    'deep canary changed before the positive path trigger');
    phases = {before: await adapter.counterPair('before'),
      noStorageBefore: await adapter.counterPair('no-storage-before')};
    onPhase('run-single-native-positive');
    waveStarted = true;
    wave = await adapter.executePositiveWave(plan);
    workerCleanupCertain = wave?.workerState === 'joined-closed' &&
      wave?.serviceHandles === 'closed' &&
      wave?.movedStorageHandleClosed === true;
    const overlap = assessPositiveWave(wave, plan);
    phases.after = await adapter.counterPair('after');
    phases.noStorageAfter = await adapter.counterPair('no-storage-after');
    onPhase('verify-marker-after');
    const markerStates = await adapter.readPaths(prepared);
    const after = checkPaths(markerStates, preflight.markerNonce);
    const canaryAfter = await readCanary();
    check(canaryAfter?.result === 0 &&
      (canaryAfter.type === 0 || canaryAfter.type === 1),
    'deep canary readback after the positive path trigger is invalid');
    const saveTreeChanged = await adapter.auditPaths(prepared);
    check(Array.isArray(saveTreeChanged),
      'native positive wave save audit did not return changed paths');
    const appSideCanaryFlipObserved = canaryAfter.type === 0;
    result = {preflight, phases, overlap, nonce: preflight.markerNonce,
      readback: {markerBefore: before.marker, markerAfter: after.marker,
        absentBefore: before.absent, absentAfter: after.absent,
        canaryBefore, canaryAfter},
      sdkBase: preflight.sdkBase, arenaNonce: preflight.arenaNonce,
      waveId, positivePathControl: plan.positivePathControl, saveWrites: 0,
      triggerResult: wave.rows.find(row => row.role === 'trigger')?.ipcResult ?? null,
      canaryResult: canaryAfter.result, canaryType: canaryAfter.type,
      appSideCanaryFlipObserved, changedPaths: saveTreeChanged,
      saveTreeChanged, markerHitVerified: false,
      fsStageVerified: false, borrowedSession: 'preserved'};
  } catch (error) {
    if (wave || phases || error.rawSamples) {
      error.diagnostic = {...error.diagnostic,
        counterPhases: phases || null,
        failedCounterPhase: error.counterPhase || null,
        failedCounterRawSamples: error.rawSamples || null,
        saveTreeAudit: typeof adapter.auditDetails === 'function' ?
          adapter.auditDetails() : null,
        waveRows: wave?.rows || null,
        workerState: wave?.workerState || null,
        serviceHandles: wave?.serviceHandles || null,
        movedStorageHandleClosed: wave?.movedStorageHandleClosed || null};
    }
    primaryError = error;
    resourceStateUncertain = error?.resourceStateUncertain === true;
    if (error?.workerNotStarted === true) workerCleanupCertain = true;
  }
  if (prepared && !resourceStateUncertain &&
      (!waveStarted || workerCleanupCertain)) {
    cleanupAttempted = true;
    onPhase('cleanup-owned-marker-and-handles');
    try {
      const scratch = await cleanupScratch({workerState: waveStarted ?
        'joined-closed' : 'not-started',
        serviceHandles: wave?.serviceHandles ?? null,
        movedStorageHandleClosed: wave?.movedStorageHandleClosed === true});
      check(scratch?.scratchPathsRemoved === true &&
        scratch.completeSaveTreeRestored === true &&
        scratch.cloneHandleClosed === true &&
        scratch.borrowedSession === 'preserved',
      'positive scratch cleanup was not verified');
      const cleaned = await adapter.cleanup(prepared);
      check(cleaned?.ownedHandlesClosed === true &&
        markerCleanupVerified(cleaned) &&
        cleaned.borrowedSession === 'preserved' &&
        cleaned.arena === 'released',
      'owned resource cleanup was not verified');
      markerCleanup = markerCleanupSummary(cleaned);
    } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError],
        'Balatro positive wave and cleanup failed');
      throw cleanupError;
    }
  }
  if (primaryError) {
    if (resourceStateUncertain || (waveStarted && !workerCleanupCertain)) {
      throw new Error('Balatro positive native wave state is uncertain; retain resources and restart before another attempt',
        {cause: primaryError});
    }
    throw primaryError;
  }
  check(cleanupAttempted && result,
    'native positive wave did not complete and release its owner');
  return {...result, ...markerCleanup,
    cleanup: 'verified', cleanupAttempted: true,
    scratchCleanupVerified: true,
    clientIpcRequestOverlapMeasured: true,
    counterPhases: result.phases,
    waveRows: wave.rows,
    saveTreeAudit: typeof adapter.auditDetails === 'function' ?
      adapter.auditDetails() : null,
    fsHandlerOverlapMeasured: false, fsSideMarkerReadbackVerified: false,
    markerHitVerified: false,
    status: result.appSideCanaryFlipObserved ?
      'deep canary type changed after the path trigger; FS memory marker remains unverified' :
      'deep canary type did not change after the path trigger; FS memory marker remains unverified'};
}

module.exports = {MAX_WAVE_TICKS, checkIdentity, checkPaths,
  makePlan, assessWave, runAbortControl,
  makePositivePlan, assessPositiveWave, checkFlippedMarker, runPositiveWave};
