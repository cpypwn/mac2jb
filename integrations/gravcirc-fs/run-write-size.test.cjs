const test = require('node:test');
const assert = require('node:assert/strict');
const {main} = require('./run-write-size.cjs');
const profile = require('./profile.v1.2.1.json');

test('bounded write wrapper stages once, qualifies timing, and stops after the host succeeds', async () => {
  const order = [];
  let requests = 0;
  const result = await main(['10.0.0.199', '10.0.0.205'], {
    probe: async () => {
      order.push('probe');
      return {runtimeReady: true, gameId: 'gravity-circuit',
        nativeProfile: 'gravity-circuit-v1.2.1'};
    },
    executeLua: async () => {
      order.push(++requests === 1 ? 'status' : 'arena');
      return requests === 1 ? '-> GC_BRIDGE_V1\tabsent\n' :
        '-> GC_APP_ARENA_V1\t7340032\t37748736\n';
    },
    stage: async ({profile: measured}) => {
      order.push('stage');
      assert.equal(measured.sdkCrc32, profile.sdkCrc32);
      return {bridge: {status: 'listening', port: 39380}};
    },
    qualifyTimingProof: async () => {
      order.push('timing');
      return {measuredFrequency: 31264192};
    },
    startHost: (_macIp, _timeout, dependencies, mode) => {
      order.push('host');
      assert.equal(mode, 'write-size');
      assert.equal(dependencies.timingProof.measuredFrequency, 31264192);
      return {ready: Promise.resolve(), finished: Promise.resolve({code: 0, signal: null}),
        stop() {order.push('stop');}};
    },
    relay: async () => {order.push('relay'); return {requests: 4};},
  });
  assert.deepEqual(order, ['probe', 'status', 'stage', 'arena', 'timing', 'host', 'relay', 'stop']);
  assert.equal(result.traffic.requests, 4);
});
