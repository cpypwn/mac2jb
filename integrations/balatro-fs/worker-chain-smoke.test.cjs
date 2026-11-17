const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {MARKER, EXPECTED_FREQUENCY, frameWords, makeSource, parseReply,
  runWorkerChainSmoke} = require('./worker-chain-smoke.cjs');

const nonce = 'bafb9ee55e2770bb';
const arenaBase = '0x4cf2cf8000';
const context = {nonce, arenaBase};
const sdkCrc32 = profile.sdkCode.offlineCrc32;
const valid = `-> ${MARKER}\tworker-chain-smoke\tok\t${nonce}\t${arenaBase}` +
  `\t37\t1\t123456789\t2\t${EXPECTED_FREQUENCY}\treleased\n`;

test('the Balatro chain smoke builds a bounded two-call read-only worker', () => {
  const source = makeSource(context);
  assert.ok(Buffer.byteLength(source, 'utf8') < 32768);
  assert.match(source, /local phase="worker-chain-smoke"/);
  assert.match(source, /previous-worker-retained/);
  assert.match(source, /worker-timeout/);
  assert.match(source, /arena-guard-after-worker/);
  assert.match(source, /frequency-result/);
  assert.doesNotMatch(source.slice(source.indexOf('local held=b.fs_bridge')),
    /CreateFile|WriteFile|save:|marker-hit|race-window/);
  const words = frameWords();
  assert.ok(words.length >= 20 && words.length <= 60);
  assert.deepEqual(words.find(word => word[0] === 0x400), [0x400, 3, 0]);
  assert.deepEqual(words.find(word => word[0] === 0x408), [0x408, 3, 0]);
  assert.deepEqual(words.find(word => word[0] === 0x800),
    [0x800, 2, profile.symbols['nn::os::GetSystemTick'].offset]);
  assert.deepEqual(words.find(word => word[0] === 0x808),
    [0x808, 2, profile.symbols['nn::os::GetSystemTickFrequency'].offset]);
});

test('the chain reply requires both results, matching owner and released handle', () => {
  const result = parseReply(valid, context);
  assert.equal(result.tickLow, 123456789);
  assert.equal(result.tickHigh, 2);
  assert.equal(result.tickFrequency, EXPECTED_FREQUENCY);
  assert.equal(result.cleanup, 'released');
  for (const bad of [
    valid.replace('released', 'retained'),
    valid.replace('\t19200000\t', '\t0\t'),
    valid.replace('\t123456789\t2\t', '\t0\t0\t'),
    valid.replace('\t123456789\t2\t', '\t1985229328\t4275878552\t'),
    valid.replace(nonce, '0123456789abcdef'),
    valid + valid,
    `-> ${MARKER}\tworker-chain-smoke\tfail\t${nonce}\tworker-timeout:retained\n`,
  ]) assert.throws(() => parseReply(bad, context));
});

test('the chain runner gates execution on same-boot preflight and full SDK CRC', async () => {
  let sent = 0;
  const execute = async ({host, port, source}) => {
    sent++;
    assert.equal(host, '10.0.0.189');
    assert.equal(port, 9026);
    assert.match(source, /BAL_CHAIN_SMOKE_V1/);
    return valid;
  };
  const preflight = async () => ({nonce, arenaBase, arenaBytes: 0x200000});
  const verifyCrc = async () => ({nonce, port: 39381, sdkCrc32, sdkBase: '0x6005cb4000'});
  assert.equal((await runWorkerChainSmoke({host: '10.0.0.189', macIp: '10.0.0.205',
    nonce, execute, preflight, verifyCrc})).cleanup, 'released');
  assert.equal(sent, 1);
  await assert.rejects(runWorkerChainSmoke({host: '10.0.0.189', macIp: '10.0.0.205',
    nonce, execute, preflight: async () => ({nonce: 'wrong', arenaBase,
      arenaBytes: 0x200000}), verifyCrc}), /preflight did not match/);
  await assert.rejects(runWorkerChainSmoke({host: '10.0.0.189', macIp: '10.0.0.205',
    nonce, execute, preflight, verifyCrc: async () => ({nonce, port: 39381,
      sdkCrc32: '0x00000000', sdkBase: '0x6005cb4000'})}), /SDK CRC did not match/);
  let checks = 0;
  await assert.rejects(runWorkerChainSmoke({host: '10.0.0.189', macIp: '10.0.0.205',
    nonce, execute, verifyCrc, preflight: async () => ({nonce, arenaBytes: 0x200000,
      arenaBase: ++checks === 1 ? arenaBase : '0x4cf2d18000'})}),
  /arena changed after SDK CRC/);
  assert.equal(sent, 1);
});
