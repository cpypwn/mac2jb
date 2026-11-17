const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {createQualifiedContext, parseOpenServiceReply} =
  require('./fs-counter-probe.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {claimClone, claimFile, belongsToTransport} =
  require('./fs-attempt-packets.cjs');
const {descriptorInput} = require('./fs-attempt-packets.cjs');
const {buildGapFirstXInput} = require('./fs-gap-first-x-input.cjs');
const {checkIdentity, makePlan, assessWave, runAbortControl,
  runPositiveWave} =
  require('./fs-abort-control.cjs');

const sdk = 0x57390b4000;
const arena = 0x4964000000;
const scratch = arena + 0x10000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'aabbccddeeff0011';
const cloneHandle = 311;
const fileHandle = 312;
const preflight = {gameProfile: profile.gameProfile,
  sdkBase: `0x${sdk.toString(16)}`,
  arenaBase: `0x${arena.toString(16)}`,
  arenaNonce, markerNonce, exactAllocationBytes: null,
  markerHitVerified: false, fsStageVerified: false};

function evidence() {
  const manager = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
  return {gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    nonce: '9876543210abcdef', sdkBase: preflight.sdkBase,
    mount: {name: 'save', accessor: '0x49646472a0',
      implementation: '0x4964689680', service: '0x49646896a0',
      serviceVtable: `0x${(sdk + 0xcec000).toString(16)}`,
      serviceVtableOffset: '0xcec000',
      manager: `0x${manager.toString(16)}`, objectId: 412,
      guardsVerified: true},
    proxy: {object: `0x${(sdk +
      Number(BigInt(captured.fsProxy.objectSdkOffset))).toString(16)}`,
      manager: `0x${manager.toString(16)}`, objectId: 153},
    sessionManager: {stateSize: 2048, stateValue: 3,
      slot: '0x4964a0a000', borrowedHandle: 118},
    absentPathResult: '0x00000202',
    status: 'read-only; mounted domain not cloned'};
}

function movedHandle(handle) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(0x80000004, 4);
  bytes.writeUInt32LE(1 << 5, 8);
  bytes.writeUInt32LE(handle, 12);
  bytes.write('SFCO', 16);
  return bytes;
}

function prepared() {
  const context = createQualifiedContext({arenaBase: preflight.arenaBase,
    nonce: arenaNonce,
    hello: {status: 'read-only transport handshake verified',
      scratch: `0x${scratch.toString(16)}`, scratchBytes: 0x80000,
      sdkBase: preflight.sdkBase,
      sdkCrc32: Number.parseInt(profile.sdkCode.offlineCrc32, 16)},
    crc: {gameProfile: profile.gameProfile,
      nonce: arenaNonce, port: 39381,
      sdkBase: preflight.sdkBase,
      sdkCrc32: profile.sdkCode.offlineCrc32}});
  const rootReply = Buffer.alloc(0x8010);
  rootReply.writeUInt32LE(321, 16);
  const root = parseOpenServiceReply(rootReply, context);
  const native = {addresses: {sdk, scratch},
    write() {}, read() {}, callAddress() {}, callAddress6() {},
    exchange() {}, verifyFunction() {}};
  const transport = new BalatroCloneTransport({native,
    evidence: evidence(), inspectLive() {}});
  transport.ownedHandles.add(cloneHandle);
  transport.ownedHandles.add(fileHandle);
  const clone = claimClone({transport,
    controlReply: movedHandle(cloneHandle)});
  const file = claimFile({clone,
    openReply: {result: 0, moves: [fileHandle], copies: []}});
  return {arenaNonce, markerNonce, sdkBase: preflight.sdkBase,
    markerPath: paths(markerNonce).marker,
    absentPath: paths(markerNonce).absent,
    markerWrittenAndVerified: true, borrowedSession: 'preserved',
    ownedHandlesOpen: true, explicitSaveWrites: 1,
    context, root, transport, clone, file,
    receiveAddress: transport.dataAddress,
    pathAddress: transport.pathAddress};
}

function pathStates() {
  const marker = {result: 0, type: 1, bytes: content(markerNonce)};
  const absent = {result: 0x202, type: null, bytes: null};
  return {original: {marker, absent}, cloned: {marker, absent},
    padded: {marker, absent}, explicitSaveWrites: 0};
}

function counterPair() {
  const sample = Array(16).fill(0);
  sample[5] = 14096;
  return {samples: [[...sample], [...sample]]};
}

function wave(plan) {
  return {waveId: plan.waveId, sdkBase: plan.sdkBase,
    arenaNonce: plan.arenaNonce, clock: 'native-counter',
    nativeCounterFrequencyVerified: true,
    workerState: 'joined-closed', serviceHandles: 'closed',
    movedStorageHandleClosed: true, receiveBufferVerified: true,
    triggerControl: plan.triggerControl,
    borrowedSession: 'preserved', explicitSaveWrites: 0,
    negativePathControl: 'executed-absent-path-0x202',
    rows: [
      {role: 'pin', startTick: 100, endTick: 500,
        transportResult: 0, ipcResult: 0,
        requestKind: 'owned-storage-open',
        handle: plan.requests.pin.handle,
        threadId: '0000000000000001', requestId: '1000000000000001'},
      {role: 'receive', startTick: 150, endTick: 550,
        transportResult: 0, ipcResult: 0, receiveBytesVerified: 16,
        requestKind: 'receive-buffer-request',
        handle: plan.requests.receive.handle,
        threadId: '0000000000000002', requestId: '1000000000000002'},
      {role: 'trigger', startTick: 200, endTick: 400,
        transportResult: 0, ipcResult: 0x202,
        requestKind: 'cloned-save-entry-type',
        handle: plan.requests.trigger.handle,
        threadId: '0000000000000003', requestId: '1000000000000003'},
    ]};
}

function adapter({nativeFailure = false, preWorkerFailure = false,
  movedStorageHandleClosed = true,
  uncertainPathRead = false, changedPaths = []} = {}) {
  const calls = [];
  const lease = prepared();
  const obj = {
    inspect: async () => {calls.push('inspect');
      return {state: 'serving', gameProfile: profile.gameProfile,
        runtimeVersion: profile.runtimeVersion,
        codeHeadProfile: '1.0.1f', sdkBase: preflight.sdkBase,
        arenaBase: preflight.arenaBase, arenaNonce,
        ownerState: 'ready', workers: 0, ownedHandles: 0};},
    prepare: async () => {calls.push('prepare'); return lease;},
    readPaths: async () => {calls.push('paths');
      if (uncertainPathRead) {
        const error = Error('ambiguous IPC response');
        error.resourceStateUncertain = true;
        throw error;
      }
      return pathStates();},
    counterPair: async () => {calls.push('counter'); return counterPair();},
    executeWave: async plan => {calls.push('wave');
      if (preWorkerFailure) {
        const error = Error('read-only staged frame guard failed');
        error.workerNotStarted = true;
        throw error;
      }
      if (nativeFailure) throw Error('native response timed out');
      return {...wave(plan), movedStorageHandleClosed};},
    auditPaths: async () => {calls.push('audit'); return changedPaths;},
    auditDetails: () => ({changed: changedPaths.map(path => ({path}))}),
    cleanup: async () => {calls.push('cleanup');
      return {ownedHandlesClosed: true, markerRemoved: true,
        borrowedSession: 'preserved', arena: 'released'};},
  };
  return {calls, adapter: obj};
}

test('abort packet plan requires one owner and three distinct owned handles', () => {
  const lease = prepared();
  const plan = makePlan({preflight, prepared: lease, waveId});
  assert.equal(plan.requests.pin.packet.readUInt32LE(24), 200);
  assert.equal(plan.requests.receive.packet.readUInt32LE(24), 0);
  assert.equal(plan.requests.trigger.packet.readUInt32LE(24), 7);
  assert.deepEqual(plan.requests.trigger.descriptorInput,
    descriptorInput(markerNonce, 'absent'));
  assert.equal(plan.requests.trigger.descriptorInput.length, 0x800);
  assert.equal(plan.triggerControl, 'nonce-bound-absent-path');
  assert.equal(plan.markerHitVerified, false);
  assert.equal(belongsToTransport(lease.clone, lease.transport, 'clone'), true);
  assert.throws(() => makePlan({preflight,
    prepared: {...lease, receiveAddress: lease.pathAddress}, waveId}),
  /marker setup/);
  assert.throws(() => makePlan({preflight,
    prepared: {...lease, arenaNonce: '0000000000000000'}, waveId}),
  /marker setup/);
});

test('abort trace checks role provenance, result and measured request overlap', () => {
  const plan = makePlan({preflight, prepared: prepared(), waveId});
  const result = assessWave(wave(plan), plan);
  assert.equal(result.qualified, true);
  const mismatched = wave(plan);
  mismatched.rows[1].handle = 118;
  assert.throws(() => assessWave(mismatched, plan), /native role/);
  const wrongResult = wave(plan);
  wrongResult.rows[2].ipcResult = 0;
  assert.throws(() => assessWave(wrongResult, plan), /native role/);
  const falseTransport = wave(plan);
  falseTransport.rows[2].transportResult = 0x202;
  assert.throws(() => assessWave(falseTransport, plan), /native role/);
  const noOverlap = wave(plan);
  noOverlap.rows[2].startTick = 501;
  noOverlap.rows[2].endTick = 520;
  assert.throws(() => assessWave(noOverlap, plan), /overlap/);
});

test('one bounded abort control verifies unchanged marker and closes owned resources', async () => {
  const run = adapter();
  const result = await runAbortControl({preflight, adapter: run.adapter,
    waveId});
  assert.equal(result.abortControlVerified, true);
  assert.equal(result.fsSideMarkerReadbackVerified, false);
  assert.equal(result.fsStageVerified, false);
  assert.deepEqual(result.waveRows.map(row => row.role),
    ['pin', 'receive', 'trigger']);
  assert.deepEqual(result.saveTreeAudit, {changed: []});
  assert.deepEqual(run.calls, ['inspect', 'prepare', 'paths', 'counter',
    'counter', 'wave', 'counter', 'counter', 'paths', 'audit', 'cleanup']);
});

test('abort cleanup reports verified neutralization without claiming removal', async () => {
  const run = adapter();
  run.adapter.cleanup = async () => {
    run.calls.push('cleanup');
    return {ownedHandlesClosed: true, markerNeutralized: true,
      markerRemoved: false, borrowedSession: 'preserved',
      arena: 'released'};
  };
  const result = await runAbortControl({preflight, adapter: run.adapter,
    waveId});
  assert.equal(result.abortControlVerified, true);
  assert.equal(result.markerNeutralized, true);
  assert.equal(result.markerRemoved, false);
});

test('uncertain worker result retains resources and never replays or cleans up', async () => {
  const run = adapter({nativeFailure: true});
  await assert.rejects(runAbortControl({preflight, adapter: run.adapter,
    waveId}), /retain resources and restart/);
  assert.equal(run.calls.filter(call => call === 'wave').length, 1);
  assert.equal(run.calls.includes('cleanup'), false);
});

test('pre-worker guard failure cleans known owned state without starting a worker', async () => {
  const run = adapter({preWorkerFailure: true});
  await assert.rejects(runAbortControl({preflight, adapter: run.adapter,
    waveId}), /staged frame guard failed/);
  assert.equal(run.calls.filter(call => call === 'wave').length, 1);
  assert.equal(run.calls.at(-1), 'cleanup');
});

test('unclosed moved storage handle retains the arena for recovery', async () => {
  const run = adapter({movedStorageHandleClosed: false});
  await assert.rejects(runAbortControl({preflight, adapter: run.adapter,
    waveId}), /retain resources and restart/);
  assert.equal(run.calls.filter(call => call === 'wave').length, 1);
  assert.equal(run.calls.includes('cleanup'), false);
});

test('uncertain pre-wave path read retains owned resources', async () => {
  const run = adapter({uncertainPathRead: true});
  await assert.rejects(runAbortControl({preflight, adapter: run.adapter,
    waveId}), /retain resources and restart/);
  assert.equal(run.calls.includes('wave'), false);
  assert.equal(run.calls.includes('cleanup'), false);
});

test('path mutation fails after a single wave but still cleans up known-idle workers', async () => {
  const run = adapter({changedPaths: ['save:/unexpected']});
  await assert.rejects(runAbortControl({preflight, adapter: run.adapter,
    waveId}), error => {
    assert.match(error.message, /changed a monitored save path/);
    assert.deepEqual(error.diagnostic.changedPaths, ['save:/unexpected']);
    assert.deepEqual(error.diagnostic.saveTreeAudit.changed,
      [{path: 'save:/unexpected'}]);
    assert.deepEqual(error.diagnostic.waveRows.map(row => row.role),
      ['pin', 'receive', 'trigger']);
    assert.equal(error.diagnostic.workerState, 'joined-closed');
    return true;
  });
  assert.equal(run.calls.filter(call => call === 'wave').length, 1);
  assert.equal(run.calls.at(-1), 'cleanup');
});

test('post-cleanup counter rejection retains phases, wave rows and save audit', async () => {
  const run = adapter();
  let reads = 0;
  run.adapter.counterPair = async () => {
    reads++;
    const result = counterPair();
    if (reads === 3) result.samples[0][5]++;
    return result;
  };
  await assert.rejects(runAbortControl({preflight, adapter: run.adapter,
    waveId}), error => {
    assert.match(error.message, /diagnostic pair is missing or unstable/);
    assert.equal(error.diagnostic.cleanup, 'verified');
    assert.equal(error.diagnostic.counterPhases.after.samples[0][5], 14097);
    assert.deepEqual(error.diagnostic.waveRows.map(row => row.role),
      ['pin', 'receive', 'trigger']);
    assert.deepEqual(error.diagnostic.saveTreeAudit, {changed: []});
    return true;
  });
  assert.equal(run.calls.at(-1), 'cleanup');
});

test('stale image stops before marker preparation', async () => {
  const run = adapter();
  run.adapter.inspect = async () => ({state: 'serving',
    gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    codeHeadProfile: '1.0.1f', sdkBase: '0x2000000000',
    arenaBase: preflight.arenaBase, arenaNonce,
    ownerState: 'ready', workers: 0, ownedHandles: 0});
  assert.throws(() => checkIdentity({state: 'serving'}, preflight));
  await assert.rejects(runAbortControl({preflight, adapter: run.adapter,
    waveId}), /image or native owner/);
  assert.deepEqual(run.calls, []);
});

function positiveAdapter(canaryStates) {
  const lease = prepared();
  lease.transport.ownedHandles.add(313);
  const scratchClone = claimClone({transport: lease.transport,
    controlReply: movedHandle(313)});
  const calls = [];
  const obj = {
    inspect: async () => {throw Error('prepared lease should skip inspect');},
    prepare: async () => {throw Error('prepared lease should skip prepare');},
    readPaths: async () => {calls.push('paths'); return pathStates();},
    counterPair: async () => counterPair(),
    executePositiveWave: async plan => {
      calls.push('wave');
      return {...wave(plan), positivePathControl: plan.positivePathControl};
    },
    auditPaths: async () => {calls.push('audit'); return [];},
    cleanup: async () => {
      calls.push('cleanup');
      return {ownedHandlesClosed: true, markerNeutralized: true,
        markerRemoved: false, borrowedSession: 'preserved',
        arena: 'released'};
    },
  };
  let readCount = 0;
  const readCanary = async () => {
    calls.push('canary');
    return canaryStates[readCount++];
  };
  const cleanupScratch = async () => {
    calls.push('scratch-cleanup');
    return {scratchPathsRemoved: true, completeSaveTreeRestored: true,
      cloneHandleClosed: true, borrowedSession: 'preserved'};
  };
  const positiveReadiness = {positiveWaveAllowed: true,
    phase: 'single-matched-comparison', abortControlsVerified: true,
    nativePaddedLookupVerified: true,
    sdkBase: preflight.sdkBase, arenaNonce, markerNonce};
  return {lease, scratchClone, adapter: obj, readCanary,
    cleanupScratch, positiveReadiness, calls,
    get readCount() {return readCount;}};
}

test('positive wave attributes only a post-trigger app-visible canary change', async () => {
  const run = positiveAdapter([{result: 0, type: 1},
    {result: 0, type: 0}]);
  const descriptor = buildGapFirstXInput({preflight})
    .descriptors.positiveCandidate;
  const result = await runPositiveWave({preflight, adapter: run.adapter,
    prepared: run.lease, scratchClone: run.scratchClone,
    positiveDescriptor: descriptor,
    positiveReadiness: run.positiveReadiness,
    canaryAfterCommit: {result: 0, type: 1},
    readCanary: run.readCanary, cleanupScratch: run.cleanupScratch,
    waveId});
  assert.equal(result.appSideCanaryFlipObserved, true);
  assert.equal(result.canaryType, 0);
  assert.deepEqual(result.readback.canaryBefore, {result: 0, type: 1});
  assert.deepEqual(result.readback.canaryAfter, {result: 0, type: 0});
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsSideMarkerReadbackVerified, false);
  assert.equal(result.fsStageVerified, false);
  assert.equal(result.markerNeutralized, true);
  assert.equal(result.markerRemoved, false);
  assert.equal(result.scratchCleanupVerified, true);
  assert.deepEqual(run.calls.filter(call => call === 'canary' ||
    call === 'wave'), ['canary', 'wave', 'canary']);
});

test('pre-trigger canary change prevents the positive native worker', async () => {
  const run = positiveAdapter([{result: 0, type: 0}]);
  const descriptor = buildGapFirstXInput({preflight})
    .descriptors.positiveCandidate;
  await assert.rejects(runPositiveWave({preflight, adapter: run.adapter,
    prepared: run.lease, scratchClone: run.scratchClone,
    positiveDescriptor: descriptor,
    positiveReadiness: run.positiveReadiness,
    canaryAfterCommit: {result: 0, type: 0},
    readCanary: run.readCanary, cleanupScratch: run.cleanupScratch,
    waveId}),
  /deep canary changed before/);
  assert.equal(run.readCount, 1);
  assert.equal(run.calls.includes('wave'), false);
  assert.equal(run.calls.at(-1), 'cleanup');
});

test('positive wave passes its closed worker quiescence to scratch cleanup', async () => {
  const run = positiveAdapter([{result: 0, type: 1},
    {result: 0, type: 0}]);
  let quiescent;
  run.cleanupScratch = async args => {
    quiescent = args;
    return {scratchPathsRemoved: true, completeSaveTreeRestored: true,
      cloneHandleClosed: true, borrowedSession: 'preserved'};
  };
  const descriptor = buildGapFirstXInput({preflight})
    .descriptors.positiveCandidate;
  await runPositiveWave({preflight, adapter: run.adapter,
    prepared: run.lease, scratchClone: run.scratchClone,
    positiveDescriptor: descriptor,
    positiveReadiness: run.positiveReadiness,
    canaryAfterCommit: {result: 0, type: 1},
    readCanary: run.readCanary, cleanupScratch: run.cleanupScratch,
    waveId});
  assert.deepEqual(quiescent, {workerState: 'joined-closed',
    serviceHandles: 'closed', movedStorageHandleClosed: true});
});

test('positive wave refuses missing scratch cleanup before owned work', async () => {
  const run = positiveAdapter([]);
  const descriptor = buildGapFirstXInput({preflight})
    .descriptors.positiveCandidate;
  await assert.rejects(runPositiveWave({preflight, adapter: run.adapter,
    prepared: run.lease, scratchClone: run.scratchClone,
    positiveDescriptor: descriptor,
    positiveReadiness: run.positiveReadiness,
    canaryAfterCommit: {result: 0, type: 1},
    readCanary: run.readCanary, waveId}),
  /scratch cleanup are required/);
  assert.deepEqual(run.calls, []);
});

test('positive wave refuses missing readiness before owned work', async () => {
  const run = positiveAdapter([]);
  const descriptor = buildGapFirstXInput({preflight})
    .descriptors.positiveCandidate;
  await assert.rejects(runPositiveWave({preflight, adapter: run.adapter,
    prepared: run.lease, scratchClone: run.scratchClone,
    positiveDescriptor: descriptor,
    canaryAfterCommit: {result: 0, type: 1},
    readCanary: run.readCanary, cleanupScratch: run.cleanupScratch,
    waveId}), /same-session positive readiness decision is required/);
  assert.deepEqual(run.calls, []);
});
