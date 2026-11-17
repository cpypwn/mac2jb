const test = require('node:test');
const assert = require('node:assert/strict');
const {main} = require('./run-pinning.cjs');

test('pinning runner uses the guarded app-only bridge path and restores its flag', async () => {
  const before = process.env.NS2_GC_PINNING_PROBE;
  delete process.env.NS2_GC_PINNING_PROBE;
  const values = ['10.0.0.199', '10.0.0.205'];
  const result = await main(values, {run: async (received, _dependencies, mode) => {
    assert.equal(process.env.NS2_GC_PINNING_PROBE, '1');
    assert.equal(mode, 'app');
    assert.deepEqual(received, values);
    return {verified: true};
  }});
  assert.deepEqual(result, {verified: true});
  assert.equal(process.env.NS2_GC_PINNING_PROBE, undefined);
  if (before !== undefined) process.env.NS2_GC_PINNING_PROBE = before;
});

test('pinning runner restores its flag after failure', async () => {
  const before = process.env.NS2_GC_PINNING_PROBE;
  process.env.NS2_GC_PINNING_PROBE = 'previous';
  try {
    await assert.rejects(main([], {run: async () => {throw Error('probe failed');}}), /probe failed/);
    assert.equal(process.env.NS2_GC_PINNING_PROBE, 'previous');
  } finally {
    if (before === undefined) delete process.env.NS2_GC_PINNING_PROBE;
    else process.env.NS2_GC_PINNING_PROBE = before;
  }
});
