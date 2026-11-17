const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {MARKER, EXPECTED_FREQUENCY} = require('./worker-chain-smoke.cjs');
const {INTERVAL_MS, tickValue, clockEnvelope,
  runWorkerRepeatability} = require('./worker-repeatability.cjs');

const nonce = 'bafb9ee55e2770bb';
const arenaBase = '0x4cf2cf8000';
const sdkBase = '0x6005cb4000';
const context = {nonce, arenaBase};

function reply(low, high = 0, cleanup = 'released') {
  return `-> ${MARKER}\tworker-chain-smoke\tok\t${nonce}\t${arenaBase}` +
    `\t37\t1\t${low}\t${high}\t${EXPECTED_FREQUENCY}\t${cleanup}\n`;
}

function fixtures(replies = [reply(1920000), reply(11295000)]) {
  const calls = [];
  let index = 0;
  const clock = [0, 50, 300, 350];
  return {calls, dependencies: {
    host: '10.0.0.189', macIp: '10.0.0.205', nonce,
    preflight: async () => ({gameProfile: profile.gameProfile, nonce,
      arenaBase, arenaBytes: 0x200000}),
    verifyCrc: async () => ({nonce, sdkBase, port: 39381,
      sdkCrc32: profile.sdkCode.offlineCrc32}),
    execute: async request => {calls.push(request); return replies[index++];},
    wait: async ms => assert.equal(ms, INTERVAL_MS),
    now: () => clock.shift(),
  }};
}

test('worker clock envelope accepts only bounded advancing ticks', () => {
  assert.equal(tickValue({tickLow: 5, tickHigh: 1}), 0x100000005n);
  const times = {firstStart: 0, firstEnd: 50, secondStart: 300, secondEnd: 350};
  const result = clockEnvelope({tickLow: 1920000, tickHigh: 0},
    {tickLow: 11295000, tickHigh: 0}, times);
  assert.equal(result.elapsedMs, 300);
  assert.equal(result.minimumMs, 250);
  assert.equal(result.maximumMs, 350);
  assert.throws(() => clockEnvelope({tickLow: 10, tickHigh: 0},
    {tickLow: 9, tickHigh: 0}, times), /did not advance/);
  assert.throws(() => clockEnvelope({tickLow: 1, tickHigh: 0},
    {tickLow: 100, tickHigh: 0}, times), /outside/);
  assert.throws(() => clockEnvelope({tickLow: 1920000, tickHigh: 0},
    {tickLow: 11295000, tickHigh: 0}, {...times, secondStart: 40}), /boundaries/);
});

test('repeatability probes two workers after same-boot CRC and rechecks arena', async () => {
  const {calls, dependencies} = fixtures();
  const result = await runWorkerRepeatability(dependencies);
  assert.equal(result.workerRepeatabilityVerified, true);
  assert.equal(result.nativeCounterFrequencyVerified, false);
  assert.equal(result.markerAttempted, false);
  assert.equal(result.cleanup, 'released');
  assert.equal(result.timing.elapsedTicks, '9375000');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.host === '10.0.0.189' && call.port === 9026 &&
    call.timeoutMs === 15000));
  assert.equal(calls[0].source, calls[1].source);
  assert.match(calls[0].source, /BAL_CHAIN_SMOKE_V1/);
  assert.doesNotMatch(calls[0].source.slice(calls[0].source.indexOf('local held=b.fs_bridge')),
    /CreateFile|WriteFile|CommitSaveData|marker-hit|race-window/);
});

test('stale profile or retained worker stops without a second attempt', async () => {
  const stale = fixtures();
  stale.dependencies.verifyCrc = async () => ({nonce, sdkBase, port: 39381,
    sdkCrc32: '0x00000000'});
  await assert.rejects(runWorkerRepeatability(stale.dependencies), /SDK CRC/);
  assert.equal(stale.calls.length, 0);

  const retained = fixtures([reply(1920000, 0, 'retained'), reply(11295000)]);
  await assert.rejects(runWorkerRepeatability(retained.dependencies), /incomplete/);
  assert.equal(retained.calls.length, 1);

  const backwards = fixtures([reply(11295000), reply(1920000)]);
  await assert.rejects(runWorkerRepeatability(backwards.dependencies), /did not advance/);
  assert.equal(backwards.calls.length, 2);
});
