const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {runVerifiedSession} = require('./run-full.cjs');

const profile = require('./profile.v1.2.1.json');
const request = {switchIp: '10.0.0.199', macIp: '10.0.0.205', profile};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};

function sessionFixture() {
  const signals = new EventEmitter();
  const held = deferred(), finished = deferred(), relaying = deferred();
  const calls = [];
  let stops = 0;
  const dependencies = {
    signals,
    ensureBridge: async () => {
      calls.push('bridge');
      return {bridge: {status: 'listening', port: 39380}};
    },
    reserveAppArena: async ({mode}) => {
      assert.equal(mode, 'full');
      calls.push('arena');
      return {base: 0x700000, bytes: 0x2400000};
    },
    qualifyTimingProof: async () => {
      calls.push('timing');
      return {gameProfile: profile.gameProfile, nativeFrequency: 31250000};
    },
    beforeHostStart: async () => {calls.push('banner');},
    startHost: (_macIp, _timeout, options, mode) => {
      assert.equal(mode, 'full');
      assert.equal(options.timingProof.nativeFrequency, 31250000);
      calls.push('host');
      return {ready: Promise.resolve(), heldReady: held.promise,
        finished: finished.promise,
        stop() {stops++; finished.resolve({code: 0, signal: null});}};
    },
    relay: ({signal}) => {
      calls.push('relay');
      signal.addEventListener('abort', () => relaying.reject(Error('Gravity Circuit relay stopped')),
        {once: true});
      return relaying.promise;
    }
  };
  return {signals, held, finished, relaying, calls, dependencies, get stops() {return stops;}};
}

test('full run stages once, keeps one relay through 4/4, and releases on SIGINT', async () => {
  const fixture = sessionFixture();
  const pending = runVerifiedSession(request, fixture.dependencies);
  while (!fixture.calls.includes('relay')) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fixture.calls, ['bridge', 'arena', 'timing', 'banner', 'host', 'relay']);
  fixture.held.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.stops, 0);
  fixture.signals.emit('SIGINT');
  const result = await pending;
  assert.equal(result.verified, true);
  assert.equal(result.releasedBy, 'SIGINT');
  assert.equal(fixture.stops, 1);
  assert.deepEqual(fixture.calls, ['bridge', 'arena', 'timing', 'banner', 'host', 'relay']);
  assert.equal(fixture.signals.listenerCount('SIGINT'), 0);
  assert.equal(fixture.signals.listenerCount('SIGTERM'), 0);
});

test('SIGTERM during acquisition waits for the held boundary before release', async () => {
  const fixture = sessionFixture();
  const pending = runVerifiedSession(request, fixture.dependencies);
  while (!fixture.calls.includes('relay')) await new Promise(resolve => setImmediate(resolve));
  fixture.signals.emit('SIGTERM');
  assert.equal(fixture.stops, 0);
  fixture.held.resolve();
  const result = await pending;
  assert.equal(result.releasedBy, 'SIGTERM');
  assert.equal(fixture.stops, 1);
});

test('a relay failure before 4/4 does not replay the bridge or send another native request', async () => {
  const fixture = sessionFixture();
  const pending = runVerifiedSession(request, fixture.dependencies);
  while (!fixture.calls.includes('relay')) await new Promise(resolve => setImmediate(resolve));
  fixture.relaying.reject(Error('native bridge disconnected'));
  fixture.finished.resolve({code: 1, signal: null});
  await assert.rejects(pending, /native bridge disconnected|before held RPC/);
  assert.deepEqual(fixture.calls, ['bridge', 'arena', 'timing', 'banner', 'host', 'relay']);
  assert.equal(fixture.stops, 0);
});

test('after an uncertain relay failure, only an explicit stop ends the waiting host', async () => {
  const fixture = sessionFixture();
  const pending = runVerifiedSession(request, fixture.dependencies);
  while (!fixture.calls.includes('relay')) await new Promise(resolve => setImmediate(resolve));
  fixture.relaying.reject(Error('native bridge disconnected'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.stops, 0);
  fixture.signals.emit('SIGINT');
  await assert.rejects(pending, /native bridge disconnected/);
  assert.equal(fixture.stops, 1);
  assert.deepEqual(fixture.calls, ['bridge', 'arena', 'timing', 'banner', 'host', 'relay']);
});

test('an explicit stop before the relay starts closes the waiting listener', async () => {
  const fixture = sessionFixture();
  const ready = deferred();
  const originalStart = fixture.dependencies.startHost;
  fixture.dependencies.startHost = (...args) => ({...originalStart(...args), ready: ready.promise});
  const pending = runVerifiedSession(request, fixture.dependencies);
  while (!fixture.calls.includes('host')) await new Promise(resolve => setImmediate(resolve));
  fixture.signals.emit('SIGTERM');
  await assert.rejects(pending, /stopped before native relay/);
  assert.equal(fixture.stops, 1);
  assert.equal(fixture.calls.includes('relay'), false);
});

test('a rejected console banner prevents the full host from starting', async () => {
  const fixture = sessionFixture();
  fixture.dependencies.beforeHostStart = async () => {
    fixture.calls.push('banner');
    throw Error('banner rejected');
  };
  await assert.rejects(runVerifiedSession(request, fixture.dependencies), /banner rejected/);
  assert.deepEqual(fixture.calls, ['bridge', 'arena', 'timing', 'banner']);
  assert.equal(fixture.stops, 0);
});
