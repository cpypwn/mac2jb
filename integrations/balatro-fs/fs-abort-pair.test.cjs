const assert = require('node:assert/strict');
const {test} = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {createQualifiedContext, parseOpenServiceReply} =
  require('./fs-counter-probe.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {claimClone, claimFile} = require('./fs-attempt-packets.cjs');
const {runAbortPair} = require('./fs-abort-pair.cjs');

const sdk = 0x57390b4000;
const arena = 0x4964000000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveIds = ['aabbccddeeff0011', '1122334455667788'];
const preflight = {gameProfile: profile.gameProfile,
  sdkBase: `0x${sdk.toString(16)}`, arenaBase: `0x${arena.toString(16)}`,
  arenaNonce, markerNonce, exactAllocationBytes: null,
  markerHitVerified: false, fsStageVerified: false};

function movedHandle(handle) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(0x80000004, 4);
  bytes.writeUInt32LE(1 << 5, 8);
  bytes.writeUInt32LE(handle, 12);
  bytes.write('SFCO', 16);
  return bytes;
}

function preparedLease() {
  const scratch = arena + 0x10000;
  const context = createQualifiedContext({arenaBase: preflight.arenaBase,
    nonce: arenaNonce,
    hello: {status: 'read-only transport handshake verified',
      scratch: `0x${scratch.toString(16)}`, scratchBytes: 0x80000,
      sdkBase: preflight.sdkBase,
      sdkCrc32: Number.parseInt(profile.sdkCode.offlineCrc32, 16)},
    crc: {gameProfile: profile.gameProfile, nonce: arenaNonce,
      port: 39381, sdkBase: preflight.sdkBase,
      sdkCrc32: profile.sdkCode.offlineCrc32}});
  const rootReply = Buffer.alloc(0x8010);
  rootReply.writeUInt32LE(321, 16);
  const root = parseOpenServiceReply(rootReply, context);
  const manager = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
  const evidence = {gameProfile: profile.gameProfile,
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
  const native = {addresses: {sdk, scratch},
    write() {}, read() {}, callAddress() {}, callAddress6() {},
    exchange() {}, verifyFunction() {}};
  const transport = new BalatroCloneTransport({native, evidence,
    inspectLive() {}});
  transport.ownedHandles.add(311);
  transport.ownedHandles.add(312);
  const clone = claimClone({transport, controlReply: movedHandle(311)});
  const file = claimFile({clone,
    openReply: {result: 0, moves: [312], copies: []}});
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
  const state = () => ({marker: {result: 0, type: 1,
    bytes: content(markerNonce)},
  absent: {result: 0x202, type: null, bytes: null}});
  return {original: state(), cloned: state(), padded: state(),
    explicitSaveWrites: 0};
}

function counterPair(value = 14096) {
  const sample = Array(16).fill(0);
  sample[5] = value;
  return {samples: [[...sample], [...sample]]};
}

function nativeWave(plan, index) {
  const base = index * 1000;
  const row = (role, start, end, ipcResult, id) => ({role,
    startTick: base + start, endTick: base + end,
    transportResult: 0, ipcResult,
    requestKind: plan.requests[role].requestKind,
    handle: plan.requests[role].handle,
    threadId: `00000000000000${index}${id}`,
    requestId: `${plan.waveId.slice(0, 14)}0${id}`});
  return {waveId: plan.waveId, sdkBase: plan.sdkBase,
    arenaNonce: plan.arenaNonce, clock: 'native-counter',
    nativeCounterFrequencyVerified: true,
    workerState: 'joined-closed', serviceHandles: 'closed',
    movedStorageHandleClosed: true, receiveBufferVerified: true,
    triggerControl: plan.triggerControl,
    borrowedSession: 'preserved', explicitSaveWrites: 0,
    negativePathControl: 'executed-absent-path-0x202',
    rows: [row('pin', 100, 500, 0, 1),
      {...row('receive', 150, 550, 0, 2), receiveBytesVerified: 16},
      row('trigger', 200, 400, 0x202, 3)]};
}

function fakeAdapter({failWave = 0, uncertain = false,
  changedAfterWave = 0, counterDriftAfterWave = 0,
  pathMismatchAfterWave = 0, counterFailurePhase = null,
  cleanupFailure = false} = {}) {
  const calls = [];
  const lease = preparedLease();
  let executed = 0;
  const adapter = {
    async inspect() {calls.push('inspect');
      return {state: 'serving', gameProfile: profile.gameProfile,
        runtimeVersion: profile.runtimeVersion,
        codeHeadProfile: '1.0.1f', sdkBase: preflight.sdkBase,
        arenaBase: preflight.arenaBase, arenaNonce,
        ownerState: 'ready', workers: 0, ownedHandles: 0};},
    async prepare() {calls.push('prepare'); return lease;},
    async readPaths() {calls.push('paths');
      const states = pathStates();
      if (pathMismatchAfterWave > 0 && pathMismatchAfterWave === executed) {
        states.padded.marker.bytes = Buffer.alloc(16);
      }
      return states;},
    async counterPair(phase) {calls.push(`counter:${phase}`);
      if (phase === counterFailurePhase) throw Error('counter reply changed');
      return counterPair(counterDriftAfterWave === executed &&
        phase.endsWith('-after') && !phase.includes('no-storage') ? 14095 : 14096);},
    async executeWave(plan) {calls.push(`wave:${plan.waveId}`);
      executed++;
      if (failWave === executed) {
        const error = Error(uncertain ? 'native reply is uncertain' :
          'staged frame guard failed');
        if (uncertain) error.resourceStateUncertain = true;
        else error.workerNotStarted = true;
        throw error;
      }
      return nativeWave(plan, executed);},
    async auditPaths() {calls.push('audit');
      return changedAfterWave === executed ? ['save:/unexpected'] : [];},
    auditDetails() {return {coverage: 'bounded-cloned-save-tree',
      completeSaveTreeVerified: true, logPrefixVerified: true,
      changed: changedAfterWave === executed ?
        [{path: 'save:/unexpected'}] : []};},
    async cleanup() {calls.push('cleanup');
      if (cleanupFailure) throw Error('owned close failed');
      return {ownedHandlesClosed: true, markerNeutralized: true,
        markerRemoved: false,
        borrowedSession: 'preserved', arena: 'released'};},
  };
  return {calls, adapter};
}

test('two distinct same-owner controls audit each wave and clean up once', async () => {
  const fake = fakeAdapter();
  const result = await runAbortPair({preflight, adapter: fake.adapter, waveIds});
  assert.equal(result.abortControlsVerified, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.waveIds, waveIds);
  assert.equal(result.runs.length, 2);
  assert.ok(result.runs.every(run => run.cleanup === 'verified' &&
    run.phases.before.samples.length === 2 &&
    run.waveRows.length === 3 &&
    run.saveTreeAudit.completeSaveTreeVerified === true &&
    run.readback.markerBefore.bytes.equals(content(markerNonce)) &&
    run.changedPaths.length === 0));
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.markerNeutralized, true);
  assert.equal(result.markerRemoved, false);
  assert.ok(result.runs.every(run => run.markerRemoved === false));
  assert.equal(result.fsStageVerified, false);
  assert.deepEqual(fake.calls, ['inspect', 'prepare', 'paths',
    'counter:first-before', 'counter:first-no-storage-before', `wave:${waveIds[0]}`,
    'counter:first-after', 'counter:first-no-storage-after', 'paths', 'audit',
    'paths', 'counter:second-before', 'counter:second-no-storage-before',
    `wave:${waveIds[1]}`, 'counter:second-after', 'counter:second-no-storage-after',
    'paths', 'audit', 'cleanup']);
});

test('final control rejection retains both complete runs after verified cleanup', async () => {
  const finalPreflight = {...preflight};
  const fake = fakeAdapter();
  const executeWave = fake.adapter.executeWave;
  fake.adapter.executeWave = async plan => {
    const wave = await executeWave(plan);
    if (plan.waveId === waveIds[1]) finalPreflight.markerHitVerified = true;
    return wave;
  };
  await assert.rejects(runAbortPair({preflight: finalPreflight,
    adapter: fake.adapter, waveIds}), error => {
    assert.match(error.message, /conservative Balatro preflight/);
    assert.equal(error.completedWaves, 2);
    assert.equal(error.diagnostic.cleanup, 'verified');
    assert.deepEqual(error.diagnostic.completedRuns.map(run => run.waveId), waveIds);
    assert.ok(error.diagnostic.completedRuns.every(run =>
      run.waveRows.length === 3 &&
      run.saveTreeAudit.completeSaveTreeVerified === true &&
      run.cleanup === 'verified'));
    return true;
  });
  assert.equal(fake.calls.filter(call => call === 'cleanup').length, 1);
});

test('an uncertain second native wave stops without replay or cleanup', async () => {
  const fake = fakeAdapter({failWave: 2, uncertain: true});
  await assert.rejects(runAbortPair({preflight, adapter: fake.adapter,
    waveIds}), /retain resources and restart/);
  assert.equal(fake.calls.filter(call => call.startsWith('wave:')).length, 2);
  assert.equal(fake.calls.includes('cleanup'), false);
});

test('a certain second preworker failure cleans the owner once', async () => {
  const fake = fakeAdapter({failWave: 2});
  await assert.rejects(runAbortPair({preflight, adapter: fake.adapter,
    waveIds}), /staged frame guard failed/);
  assert.equal(fake.calls.filter(call => call.startsWith('wave:')).length, 2);
  assert.equal(fake.calls.filter(call => call === 'cleanup').length, 1);
});

test('first-wave save mutation stops before the second wave and cleans up', async () => {
  const fake = fakeAdapter({changedAfterWave: 1});
  await assert.rejects(runAbortPair({preflight, adapter: fake.adapter,
    waveIds}), error => {
    assert.match(error.message, /save:\/unexpected/);
    assert.deepEqual(error.changedPaths, ['save:/unexpected']);
    return true;
  });
  assert.equal(fake.calls.filter(call => call.startsWith('wave:')).length, 1);
  assert.equal(fake.calls.filter(call => call === 'cleanup').length, 1);
});

test('path-control mismatch names the source and exact failed fields', async () => {
  const fake = fakeAdapter({pathMismatchAfterWave: 1});
  await assert.rejects(runAbortPair({preflight, adapter: fake.adapter,
    waveIds}), error => {
    assert.match(error.message, /wave 1 after path controls differ/);
    assert.equal(error.pathDiagnostics.padded.markerBytesMatch, false);
    assert.equal(error.pathDiagnostics.original.markerBytesMatch, true);
    return true;
  });
  assert.equal(fake.calls.filter(call => call.startsWith('wave:')).length, 1);
  assert.equal(fake.calls.filter(call => call === 'cleanup').length, 1);
});

test('unstable post-wave counter control blocks the next wave', async () => {
  const fake = fakeAdapter({counterDriftAfterWave: 1});
  await assert.rejects(runAbortPair({preflight, adapter: fake.adapter,
    waveIds}), error => {
    assert.match(error.message, /baseline restoration failed/);
    const observed = error.diagnostic.currentWave;
    assert.equal(observed.waveId, waveIds[0]);
    assert.equal(observed.workerStarted, true);
    assert.equal(observed.waveRows.length, 3);
    assert.equal(observed.phases.after.samples[0][5], 14095);
    assert.equal(observed.phases.noStorageAfter.samples[0][5], 14096);
    assert.deepEqual(observed.changedPaths, []);
    assert.equal(observed.saveAudit.completeSaveTreeVerified, true);
    assert.equal(observed.pathBefore.original.marker.bytes.equals(content(markerNonce)), true);
    assert.equal(observed.pathAfter.padded.marker.bytes.equals(content(markerNonce)), true);
    return true;
  });
  assert.equal(fake.calls.filter(call => call.startsWith('wave:')).length, 1);
  assert.equal(fake.calls.filter(call => call === 'audit').length, 1);
  assert.equal(fake.calls.filter(call => call === 'cleanup').length, 1);
});

test('uncertain counter IPC retains the owner and blocks another wave', async () => {
  const fake = fakeAdapter({counterFailurePhase: 'first-after'});
  await assert.rejects(runAbortPair({preflight, adapter: fake.adapter,
    waveIds}), /retain resources and restart/);
  assert.equal(fake.calls.filter(call => call.startsWith('wave:')).length, 1);
  assert.equal(fake.calls.includes('cleanup'), false);
});

test('duplicate IDs stop before preparing or sending a wave', async () => {
  const fake = fakeAdapter();
  await assert.rejects(runAbortPair({preflight, adapter: fake.adapter,
    waveIds: [waveIds[0], waveIds[0]]}), /two distinct wave IDs/);
  assert.deepEqual(fake.calls, []);
});

test('cleanup still runs once if the phase observer throws', async () => {
  const fake = fakeAdapter();
  await assert.rejects(runAbortPair({preflight, adapter: fake.adapter,
    waveIds, onPhase: phase => {
      if (phase === 'cleanup-owned-marker-and-handles') {
        throw Error('phase observer failed');
      }
    }}), /phase observer failed/);
  assert.equal(fake.calls.filter(call => call === 'cleanup').length, 1);
});

test('failed cleanup is reported as uncertain and never retried', async () => {
  const fake = fakeAdapter({cleanupFailure: true});
  await assert.rejects(runAbortPair({preflight, adapter: fake.adapter,
    waveIds}), error => {
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.completedWaves, 2);
    assert.match(error.message, /cleanup is uncertain/);
    return true;
  });
  assert.equal(fake.calls.filter(call => call === 'cleanup').length, 1);
});
