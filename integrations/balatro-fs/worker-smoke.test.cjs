const assert = require('node:assert/strict');
const test = require('node:test');
const {MARKER, EXPECTED_RESULT, frameWords, makeSource, parseReply,
  runWorkerSmoke} = require('./worker-smoke.cjs');

const nonce = 'd3b7e24c1a09f563';
const arenaBase = '0x4a144f8000';
const context = {nonce, arenaBase};
const valid = `-> ${MARKER}\tworker-smoke\tok\t${nonce}\t${arenaBase}\t37\t1\t${EXPECTED_RESULT}\treleased\n`;

test('the Balatro smoke source is a bounded read-only single-call worker', () => {
  const source = makeSource(context);
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /local phase="worker-smoke"/);
  assert.match(source, /previous-worker-retained/);
  assert.match(source, /worker-timeout/);
  assert.match(source, /19200000/);
  assert.doesNotMatch(source.slice(source.indexOf('local held=b.fs_bridge')),
    /CreateFile|WriteFile|save:|marker-hit|race-window/);
  const words = frameWords();
  assert.ok(words.length >= 10 && words.length <= 20);
  assert.deepEqual(words.find(word => word[0] === 0x400), [0x400, 3, 0]);
  assert.deepEqual(words.find(word => word[0] === 0x300), [0x300, 2, 0x12fc30]);
});

test('the reply parser accepts only the exact completed and released proof', () => {
  const result = parseReply(valid, context);
  assert.equal(result.tickFrequency, EXPECTED_RESULT);
  assert.equal(result.cleanup, 'released');
  for (const bad of [
    valid.replace('released', 'retained'),
    valid.replace('19200000', '0'),
    valid.replace(nonce, '0123456789abcdef'),
    valid + valid,
    `-> ${MARKER}\tworker-smoke\tfail\t${nonce}\tworker-timeout:retained\n`,
  ]) assert.throws(() => parseReply(bad, context));
});

test('the runner requires a matching preflight and sends exactly one worker chunk', async () => {
  let sent = 0;
  const execute = async ({host, port, source}) => {
    sent++;
    assert.equal(host, '10.0.0.189');
    assert.equal(port, 9026);
    assert.match(source, /BAL_WORKER_SMOKE_V1/);
    return valid;
  };
  const preflight = async () => ({nonce, arenaBase, arenaBytes: 0x200000});
  assert.equal((await runWorkerSmoke({host: '10.0.0.189', nonce, execute, preflight})).cleanup,
    'released');
  assert.equal(sent, 1);
  await assert.rejects(runWorkerSmoke({host: '10.0.0.189', nonce, execute,
    preflight: async () => ({nonce: 'wrong', arenaBase, arenaBytes: 0x200000})}),
  /preflight did not match/);
  assert.equal(sent, 1);
});
