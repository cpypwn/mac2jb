const assert = require('node:assert/strict');
const test = require('node:test');
const {assess, runMarkerLocalization} = require('./marker-localization-live.cjs');
const {assessNativeOrderControl} = require('./fs-native-order-control.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const nonce = '0123456789abcdef';
const sdkBase = '0x6005cb4000';
const arenaBase = '0x4964000000';

function phase(value) {
  const row = Array.from({length: 16}, (_, index) => index === 5 ? value : index * 4);
  return {samples: [row, [...row]], reads: 3};
}

function fixture() {
  const image = {state: 'serving', metadataVersion: profile.runtimeVersion,
    codeHeadProfile: '1.0.1f', sdkBase, mainBase: '0x41a0000000',
    sampleFingerprintSha256: 'a'.repeat(64)};
  const arena = {gameProfile: profile.gameProfile, phase: 'inspect',
    nonce, base: arenaBase, bytes: 0x200000};
  const snapshot = {readonly: {gameProfile: profile.gameProfile,
    freeBytes: 16367616, absentPathResult: '0x00000202'},
  log: {sizeBytes: 4000, phaseSizeBytes: 11,
    loggerSourceSha256: 'a'.repeat(64), sourcePinned: true}};
  const phases = {before: phase(100000), noStorageBefore: phase(100000),
    oneHeld: phase(85904), noStorageHeld: phase(85904),
    after: phase(100000), noStorageAfter: phase(100000)};
  const roles = ['no-storage-before', 'open-owned-storage',
    'no-storage-held', 'close-owned-storage', 'no-storage-after'];
  const events = roles.map((role, index) => ({role,
    startTick: String(100 + index * 20), endTick: String(110 + index * 20),
    hostSendMs: index * 2, hostReceiveMs: index * 2 + 1}));
  const clock = {nativeCounterFrequencyVerified: true};
  const assessment = assessNativeOrderControl({phases, events, clock});
  const order = {gameProfile: profile.gameProfile, nonce, arenaBase,
    phases, events, clock, assessment, cleanup: 'released',
    markerAttempted: false, saveWrites: 0};
  return {before: {...image}, after: {...image},
    arenaBefore: {...arena}, arenaAfter: {...arena},
    snapshotBefore: structuredClone(snapshot),
    snapshotAfter: structuredClone(snapshot), order, nonce};
}

test('same-boot preflight reports marker and FS acquisition as unverified', () => {
  const result = assess(fixture());
  assert.equal(result.candidateDiagnosticCostBytes, 14096);
  assert.equal(result.saveFreeBytesBefore, 16367616);
  assert.equal(result.saveFreeBytesAfter, 16367616);
  assert.equal(result.saveFreeBytesDriftBytes, 0);
  assert.equal(result.autosaveBlockAttributed, false);
  assert.equal(result.savedataLogGrowthBytes, 0);
  assert.equal(result.nativeOrderSaveWrites, 0);
  assert.equal(result.saveScratchCapacityVerified, false);
  assert.equal(result.exactAllocationBytes, null);
  assert.equal(result.pinAddress, null);
  assert.equal(result.concurrentOverlapMeasured, false);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
});

test('image change, arena change, and save-space drift stop the probe', () => {
  const changedImage = fixture();
  changedImage.after.sdkBase = '0x6005cb5000';
  assert.throws(() => assess(changedImage), /image changed/);
  const changedArena = fixture();
  changedArena.arenaAfter.base = '0x4965000000';
  assert.throws(() => assess(changedArena), /arena changed/);
  const changedSave = fixture();
  changedSave.snapshotAfter.readonly.freeBytes--;
  assert.throws(() => assess(changedSave), error =>
    /not attributable/.test(error.message) &&
    /"freeBytesBefore":16367616/.test(error.message) &&
    /"freeBytesAfter":16367615/.test(error.message));
});

test('a single logged save block is attributed to one autosave', () => {
  const evidence = fixture();
  evidence.snapshotAfter.readonly.freeBytes -= 0x4000;
  evidence.snapshotAfter.log.sizeBytes += 200;
  const result = assess(evidence);
  assert.equal(result.saveFreeBytesBefore, 16367616);
  assert.equal(result.saveFreeBytesAfter, 16367616 - 0x4000);
  assert.equal(result.saveFreeBytesDriftBytes, 0x4000);
  assert.equal(result.autosaveBlockAttributed, true);
  assert.equal(result.savedataLogGrowthBytes, 200);
  assert.equal(result.nativeOrderSaveWrites, 0);
  assert.equal(result.markerHitVerified, false);
});

test('log-only growth is reported and never promoted to a save write', () => {
  const evidence = fixture();
  evidence.snapshotAfter.log.sizeBytes += 200;
  const result = assess(evidence);
  assert.equal(result.saveFreeBytesDriftBytes, 0);
  assert.equal(result.autosaveBlockAttributed, false);
  assert.equal(result.savedataLogGrowthBytes, 200);
  assert.equal(result.nativeOrderSaveWrites, 0);
});

test('an unattributable save-space drift still stops the probe', () => {
  // A save block with no log write is a silent block: unattributable.
  const silent = fixture();
  silent.snapshotAfter.readonly.freeBytes -= 0x4000;
  assert.throws(() => assess(silent), error =>
    /not attributable/.test(error.message) &&
    /"freeDriftBytes":16384/.test(error.message) &&
    /"logGrowthBytes":0/.test(error.message));
  // Two save blocks are more than one autosave: unattributable.
  const doubled = fixture();
  doubled.snapshotAfter.readonly.freeBytes -= 0x8000;
  doubled.snapshotAfter.log.sizeBytes += 200;
  assert.throws(() => assess(doubled), error =>
    /not attributable/.test(error.message) &&
    /"freeDriftBytes":32768/.test(error.message));
  // A sub-block decline cannot be a save block: unattributable.
  const subBlock = fixture();
  subBlock.snapshotAfter.readonly.freeBytes -= 1;
  subBlock.snapshotAfter.log.sizeBytes += 200;
  assert.throws(() => assess(subBlock), /not attributable/);
  // A free-space increase is unattributable.
  const increased = fixture();
  increased.snapshotAfter.readonly.freeBytes += 0x4000;
  increased.snapshotAfter.log.sizeBytes += 200;
  assert.throws(() => assess(increased), /not attributable/);
});

test('the reported 0x4000 live autosave drift completes the localization', () => {
  const evidence = fixture();
  evidence.snapshotBefore.readonly.freeBytes = 6225920;
  evidence.snapshotAfter.readonly.freeBytes = 6209536;
  evidence.snapshotBefore.log.sizeBytes = 1210388;
  evidence.snapshotAfter.log.sizeBytes = 1217605;
  const result = assess(evidence);
  assert.equal(result.saveFreeBytesBefore, 6225920);
  assert.equal(result.saveFreeBytesAfter, 6209536);
  assert.equal(result.saveFreeBytesDriftBytes, 0x4000);
  assert.equal(result.autosaveBlockAttributed, true);
  assert.equal(result.savedataLogGrowthBytes, 7217);
  assert.equal(result.nativeOrderSaveWrites, 0);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
});

test('a serial native control is never promoted to an overlapping marker wave', () => {
  const evidence = fixture();
  evidence.order.assessment = {...evidence.order.assessment,
    markerHitVerified: true};
  assert.throws(() => assess(evidence), /native order control/);
  const unexpectedWrite = fixture();
  unexpectedWrite.order.saveWrites = 1;
  assert.throws(() => assess(unexpectedWrite), /native order control/);
});

test('a drifted but bounded diagnostic cost is accepted and reported, never silently weakened', () => {
  const drifted = fixture();
  drifted.order.phases.oneHeld = phase(85664);
  drifted.order.phases.noStorageHeld = phase(85664);
  drifted.order.assessment = assessNativeOrderControl(
    {phases: drifted.order.phases, events: drifted.order.events,
      clock: drifted.order.clock});
  const result = assess(drifted);
  assert.equal(result.candidateDiagnosticCostBytes, 14336);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
  const stillFailClosed = fixture();
  stillFailClosed.order.assessment = {...stillFailClosed.order.assessment,
    overlapQualified: true};
  assert.throws(() => assess(stillFailClosed), /native order control/);
});

test('live preflight checks the pinned image before probing native FS order', async () => {
  const calls = [];
  await assert.rejects(runMarkerLocalization({host: '10.0.0.189',
    macIp: '10.0.0.205', nonce,
    inspectImage: async () => {calls.push('image'); return {state: 'serving',
      metadataVersion: '1.0.1o', codeHeadProfile: '1.0.1o'};},
    inspectArena: async () => {calls.push('arena'); throw Error('unexpected');},
    inspectSnapshot: async () => {calls.push('save'); throw Error('unexpected');},
    runOrder: async () => {calls.push('order'); throw Error('unexpected');}}),
  /pinned 1.0.1f/);
  assert.deepEqual(calls, ['image']);
});

test('live preflight performs one bounded native order and checks poststate', async () => {
  const evidence = fixture();
  const calls = [];
  const result = await runMarkerLocalization({host: '10.0.0.189',
    macIp: '10.0.0.205', nonce,
    inspectImage: async () => {calls.push('image');
      return calls.filter(value => value === 'image').length === 1 ?
        evidence.before : evidence.after;},
    inspectArena: async () => {calls.push('arena');
      return calls.filter(value => value === 'arena').length === 1 ?
        evidence.arenaBefore : evidence.arenaAfter;},
    inspectSnapshot: async () => {calls.push('save');
      return calls.filter(value => value === 'save').length === 1 ?
        evidence.snapshotBefore : evidence.snapshotAfter;},
    runOrder: async () => {calls.push('order'); return evidence.order;}});
  assert.deepEqual(calls, ['image', 'arena', 'save', 'order',
    'arena', 'image', 'save']);
  assert.equal(result.markerHitVerified, false);
});

test('live preflight stops after the native order if cleanup is unverified', async () => {
  const evidence = fixture();
  evidence.order.cleanup = 'retained';
  let poststateReads = 0;
  await assert.rejects(runMarkerLocalization({host: '10.0.0.189',
    macIp: '10.0.0.205', nonce,
    inspectImage: async () => evidence.before,
    inspectArena: async () => evidence.arenaBefore,
    inspectSnapshot: async () => {poststateReads++; return evidence.snapshotBefore;},
    runOrder: async () => evidence.order}), /native order control/);
  assert.equal(poststateReads, 1);
});
