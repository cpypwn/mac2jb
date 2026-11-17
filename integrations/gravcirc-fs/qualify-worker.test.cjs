const assert = require('node:assert/strict');
const test = require('node:test');
const {plan, makeSource, parseReply} = require('./qualify-worker.cjs');
const {MAX_REQUEST_BYTES} = require('./repl-client.cjs');

test('disposable worker frame is bounded and uses a separate event and kernel stack', () => {
  const {words, proof} = plan();
  assert.equal(proof.nativeCalls, 2);
  assert.deepEqual(proof.resultOffsets, [0x800, 0x808]);
  assert.ok(proof.bytes <= 0x18000);
  assert.ok(proof.stackOffset + 0x4000 < 0x18000);
  assert.ok(words.length > 0 && words.length < 64);
});

test('qualifier source is bounded and has explicit gate and cleanup steps', () => {
  const source = makeSource();
  assert.ok(Buffer.byteLength(source) < MAX_REQUEST_BYTES);
  for (const fragment of [
    "LS.fs_bridge.stage=='accept'",
    'LS.gc_worker_hold=hold',
    'gate-passed-before-signal',
    'worker-mask-readback',
    'signal()\n  wait_done()',
    'close-handle:',
    'finalize-event',
    'worker-join-timeout',
    "LS.fs_bridge.stage~='accept'",
  ]) assert.ok(source.includes(fragment), fragment);
});

test('qualifier accepts only a complete released worker result', () => {
  assert.deepEqual(parseReply('-> GC_WORKER_V1\tok\t0x7100000000\t44\t0\t0\t15\t1\treleased\n'), {
    sdkBase: '0x7100000000', priority: 44, borrowedCore: 0, workerCore: 0,
    affinityBefore: 15, affinityAfter: 1, cleanup: 'released',
  });
  assert.throws(() => parseReply('-> GC_WORKER_V1\tfail\tworker-join-timeout\tretained\n'),
    /worker-join-timeout retained/);
  assert.throws(() => parseReply('-> GC_WORKER_V1\tok\t0x7100000000\t44\t0\t0\t15\t1\tretained\n'),
    /incomplete/);
});
