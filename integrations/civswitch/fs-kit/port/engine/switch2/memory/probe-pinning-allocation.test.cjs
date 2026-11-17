const test = require('node:test');
const assert = require('node:assert/strict');
const {assessPinning, readCounters, readStableCounters, measureCycle, assessCycles,
  MAX_COUNTER_READS} = require('./probe-pinning-allocation.cjs');

const counters = free => Array.from({length: 16}, (_, index) => index === 5 ? free : 0);
const pair = free => [counters(free), counters(free)];

test('stable owned storage allocation and restoration are measured', () => {
  const measured = assessPinning(pair(100000), pair(93040), pair(100000));
  assert.deepEqual(measured, {bytes: 6960, restoration: 0,
    stability: {before: 0, held: 0, after: 0}, verified: true});
});

test('background heap drift cannot qualify as exact pinning geometry', () => {
  const unstable = [counters(100000), counters(99936)];
  assert.equal(assessPinning(unstable, pair(93040), pair(100000)).verified, false);
  assert.equal(assessPinning(pair(100000), pair(93040), pair(99936)).verified, false);
  assert.equal(assessPinning(pair(100000), pair(100000), pair(100000)).verified, false);
  assert.equal(assessPinning(pair(100000), pair(100001), pair(100000)).verified, false);
  assert.equal(assessPinning(pair(100000), pair(1), pair(100000)).verified, false);
});

test('allocation counters require a complete reply', async () => {
  let calls = 0;
  const session = {async ipc(label, root, command) {
    assert.equal(root, 77);
    assert.equal(command, 1009);
    assert.match(label, /counters/);
    calls++;
    const data = Buffer.alloc(128);
    data.writeBigUInt64LE(100000n, 40);
    return {result: 0, data};
  }};
  assert.deepEqual(await readCounters(session, 77, 'Read counters'), counters(100000));
  assert.equal(calls, 1);
  await assert.rejects(() => readCounters({ipc: async () =>
    ({result: 0, data: Buffer.alloc(64)})}, 77, 'Read counters'), /unavailable/);
});

test('sampling waits for three consecutive equal heap readings within a fixed limit', async () => {
  const values = [100000, 99984, 100000, 100000, 100000];
  let calls = 0;
  const session = {async ipc() {
    const data = Buffer.alloc(128);
    data.writeBigUInt64LE(BigInt(values[calls++]), 40);
    return {result: 0, data};
  }};
  const sample = await readStableCounters(session, 77, 'baseline');
  assert.deepEqual(sample.samples, pair(100000));
  assert.equal(sample.reads, 5);
  assert.equal(calls, 5);
});

test('sampling rejects unsettled counters without accepting a convenient pair', async () => {
  let calls = 0;
  const session = {async ipc() {
    const data = Buffer.alloc(128);
    data.writeBigUInt64LE(BigInt(100000 + (calls++ % 2) * 16), 40);
    return {result: 0, data};
  }};
  await assert.rejects(() => readStableCounters(session, 77, 'baseline'), error =>
    error.code === 'UNSTABLE_COUNTERS' && error.observedGeneralHeap.length === MAX_COUNTER_READS);
  assert.equal(calls, MAX_COUNTER_READS);
});

test('a failed held reading still closes its owned content storage', async () => {
  let phase = 'before', reads = 0, closed = false;
  const session = {
    async ipc(_label, _root, command) {
      if (command === 200) {
        phase = 'held';
        return {result: 0, moves: [42], copies: []};
      }
      const data = Buffer.alloc(128);
      data.writeBigUInt64LE(BigInt(phase === 'before' ? 100000 : 90000 + (reads++ % 2) * 16), 40);
      return {result: 0, data};
    },
    async close(handle) {assert.equal(handle, 42); closed = true;},
  };
  await assert.rejects(() => measureCycle(session, 77, 1), error =>
    error.code === 'UNSTABLE_COUNTERS');
  assert.equal(closed, true);
});

test('pinning cost needs two consecutive clean cycles with the same bytes', () => {
  const valid = bytes => ({assessment: {verified: true, bytes}});
  assert.deepEqual(assessCycles([valid(13616)]),
    {verified: false, bytes: null, repetitions: 0});
  assert.deepEqual(assessCycles([valid(13616), {error: 'unstable'}, valid(13616)]),
    {verified: false, bytes: null, repetitions: 0});
  assert.deepEqual(assessCycles([valid(13616), valid(6960)]),
    {verified: false, bytes: null, repetitions: 0});
  assert.deepEqual(assessCycles([valid(13616), valid(13616), valid(6960)]),
    {verified: false, bytes: null, repetitions: 0});
  assert.deepEqual(assessCycles([valid(13616), valid(13616)]),
    {verified: true, bytes: 13616, repetitions: 2});
});
