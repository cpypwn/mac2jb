const test = require('node:test');
const assert = require('node:assert/strict');
const {main, parseArguments} = require('./run.cjs');

test('direct Gravity Circuit canary refuses to listen without a geometry proof', async () => {
  await assert.rejects(main(['--target', 'gravcirc', '--canary-only', '10.0.0.205']),
    /NS2_GC_GEOMETRY_PROOF/);
});

test('bounded Gravity Circuit write diagnostic requires an enumerated explicit maximum', () => {
  const previousMax = process.env.NS2_WRITE_SIZE_MAX;
  const previousRpc = process.env.NS2_RPC_MODE;
  try {
    delete process.env.NS2_RPC_MODE;
    process.env.NS2_WRITE_SIZE_MAX = '524288';
    const parsed = parseArguments(['--target', 'gravcirc', '--write-size-only', '10.0.0.205']);
    assert.equal(parsed.targetName, 'gravcirc');
    assert.equal(parsed.writeSizeOnly, true);
    assert.equal(parsed.maxWriteSize, 524288);
    assert.deepEqual(parsed.hostArgs, ['10.0.0.205']);
    assert.throws(() => parseArguments(['--target', 'civ7', '--write-size-only']), /scoped to Gravity Circuit/);
    assert.throws(() => parseArguments(['--target', 'gravcirc', '--write-size-only', '--rpc']),
      /cannot be combined/);
    process.env.NS2_WRITE_SIZE_MAX = '0x100000';
    assert.throws(() => parseArguments(['--target', 'gravcirc', '--write-size-only']),
      /must stop at or before/);
    process.env.NS2_WRITE_SIZE_MAX = '524289';
    assert.throws(() => parseArguments(['--target', 'gravcirc', '--write-size-only']),
      /enumerated probe size/);
    delete process.env.NS2_WRITE_SIZE_MAX;
    assert.throws(() => parseArguments(['--target', 'gravcirc', '--write-size-only']),
      /enumerated probe size/);
  } finally {
    if (previousMax === undefined) delete process.env.NS2_WRITE_SIZE_MAX;
    else process.env.NS2_WRITE_SIZE_MAX = previousMax;
    if (previousRpc === undefined) delete process.env.NS2_RPC_MODE;
    else process.env.NS2_RPC_MODE = previousRpc;
  }
});

test('one-shot Gravity Circuit retry is isolated and selects only 1 or 2 MiB', () => {
  const previousSize = process.env.NS2_ONE_SHOT_SIZE;
  const previousRpc = process.env.NS2_RPC_MODE;
  try {
    delete process.env.NS2_RPC_MODE;
    delete process.env.NS2_ONE_SHOT_SIZE;
    const one = parseArguments(['--target', 'gravcirc', '--one-mib-retry', '10.0.0.205']);
    assert.equal(one.oneMiBRetry, true);
    assert.equal(one.retrySize, 0x100000);
    process.env.NS2_ONE_SHOT_SIZE = '2097152';
    assert.equal(parseArguments(['--target', 'gravcirc', '--one-mib-retry']).retrySize, 0x200000);
    assert.throws(() => parseArguments(['--target', 'civ7', '--one-mib-retry']),
      /scoped to Gravity Circuit/);
    assert.throws(() => parseArguments(['--target', 'gravcirc', '--one-mib-retry', '--rpc']),
      /cannot be combined/);
    assert.throws(() => parseArguments(['--target', 'gravcirc', '--one-mib-retry', '--write-size-only']),
      /cannot be combined/);
    process.env.NS2_ONE_SHOT_SIZE = '3145728';
    assert.throws(() => parseArguments(['--target', 'gravcirc', '--one-mib-retry']), /1m or 2m/);
  } finally {
    if (previousSize === undefined) delete process.env.NS2_ONE_SHOT_SIZE;
    else process.env.NS2_ONE_SHOT_SIZE = previousSize;
    if (previousRpc === undefined) delete process.env.NS2_RPC_MODE;
    else process.env.NS2_RPC_MODE = previousRpc;
  }
});

test('split one MiB diagnostic is isolated to Gravity Circuit without RPC', () => {
  const previousRpc = process.env.NS2_RPC_MODE;
  try {
    delete process.env.NS2_RPC_MODE;
    const parsed = parseArguments(['--target', 'gravcirc', '--split-mib', '10.0.0.205']);
    assert.equal(parsed.targetName, 'gravcirc');
    assert.equal(parsed.splitMiB, true);
    assert.deepEqual(parsed.hostArgs, ['10.0.0.205']);
    assert.throws(() => parseArguments(['--target', 'civ7', '--split-mib']),
      /scoped to Gravity Circuit/);
    for (const conflict of ['--rpc', '--app-only', '--write-size-only',
      '--one-mib-retry', '--geometry-only', '--canary-only']) {
      assert.throws(() => parseArguments(['--target', 'gravcirc', '--split-mib', conflict]),
        /cannot be combined/);
    }
  } finally {
    if (previousRpc === undefined) delete process.env.NS2_RPC_MODE;
    else process.env.NS2_RPC_MODE = previousRpc;
  }
});
