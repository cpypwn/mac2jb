const assert = require('node:assert/strict');
const {test} = require('node:test');
const {content} = require('./marker-content-control.cjs');
const {LOGGER_SHA256} = require('./rpc-log-snapshot.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {assessMonitoredState, captureMonitoredState} =
  require('./fs-monitored-save-audit.cjs');

const markerNonce = 'a1b2c3d4e5f60718';

function snapshot(nonce, logSize = 1000) {
  return {gameProfile: profile.gameProfile, nonce,
    readonly: {gameProfile: profile.gameProfile, freeBytes: 16367616,
      absentPathResult: '0x00000202'},
    log: {sizeBytes: logSize, phaseSizeBytes: 24,
      loggerSourceSha256: LOGGER_SHA256, sourcePinned: true}};
}

function pathState() {
  const state = () => ({marker: {result: 0, type: 1,
    bytes: content(markerNonce)},
  absent: {result: 0x202, type: null, bytes: null}});
  return {original: state(), cloned: state(),
    padded: state(), explicitSaveWrites: 0};
}

function input() {
  return {before: snapshot('1111111111111111'),
    after: snapshot('2222222222222222', 1111),
    beforePaths: pathState(), afterPaths: pathState(), markerNonce};
}

test('accepts pinned monitored controls and reports incomplete tree coverage', () => {
  const result = assessMonitoredState(input());
  assert.equal(result.coverage, 'monitored-properties-only');
  assert.equal(result.completeSaveTreeVerified, false);
  assert.equal(result.logGrowthBytes, 111);
  assert.equal(result.logContentVerified, false);
  assert.equal(result.monitoredPaths.length, 4);
  assert.equal(Object.hasOwn(result, 'changedPaths'), false);
});

test('refuses to attribute free-space drift to logger growth', () => {
  const value = input();
  value.after.readonly.freeBytes -= 16384;
  assert.throws(() => assessMonitoredState(value), /free-space drift/);
});

test('rejects changed absent path, logger source, and phase size', () => {
  for (const mutate of [
    value => {value.after.readonly.absentPathResult = '0x00000000';},
    value => {value.after.log.loggerSourceSha256 = '0'.repeat(64);},
    value => {value.after.log.phaseSizeBytes++;},
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => assessMonitoredState(value));
  }
});

test('rejects marker content changes across all three readback routes', () => {
  for (const route of ['original', 'cloned', 'padded']) {
    const value = input();
    value.afterPaths[route].marker.bytes[0] ^= 1;
    assert.throws(() => assessMonitoredState(value), /marker\/absent controls/);
  }
});

test('rejects reused snapshot nonce and a shrinking activity log', () => {
  const reused = input();
  reused.after.nonce = reused.before.nonce;
  assert.throws(() => assessMonitoredState(reused), /fresh pinned snapshots/);
  const shrinking = input();
  shrinking.after.log.sizeBytes = 999;
  assert.throws(() => assessMonitoredState(shrinking), /log shrank/);
});

test('capture wrapper takes a single snapshot through its injected inspector', async () => {
  const result = snapshot('1111111111111111');
  const calls = [];
  assert.equal(await captureMonitoredState({host: '10.0.0.189',
    inspect: async args => {calls.push(args); return result;}}), result);
  assert.deepEqual(calls, [{host: '10.0.0.189'}]);
});
