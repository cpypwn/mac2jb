const assert = require('node:assert/strict');
const {test} = require('node:test');
const {COUNTER_MAX_READS, parseCounterReply, sampleCounterPair,
  createAbortAdapter} =
  require('./fs-abort-adapter.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

function reply({dataBytes = 128, moved = false, result = 0} = {}) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(0, 0);
  if (moved) {
    bytes.writeUInt32LE(0x80000000, 4);
    bytes.writeUInt32LE(1 << 5, 8);
    bytes.writeUInt32LE(0x100, 12);
  }
  const at = moved ? 16 : 16;
  bytes.write('SFCO', at);
  bytes.writeUInt32LE(result, at + 8);
  if (dataBytes < 128) return bytes.subarray(0, at + 16 + dataBytes);
  for (let i = 0; i < 16; i++) bytes.writeBigUInt64LE(BigInt(i + 1), at + 16 + i * 8);
  return bytes;
}

test('counter reply parses exact bounded values and rejects moved handles', () => {
  assert.deepEqual(parseCounterReply(reply()), Array.from({length: 16},
    (_, index) => index + 1));
  assert.throws(() => parseCounterReply(reply({moved: true})),
    /counter reply changed/);
  assert.throws(() => parseCounterReply(reply({result: 0x202})),
    /counter reply changed/);
  assert.throws(() => parseCounterReply(reply({dataBytes: 40})),
    /counter reply changed/);
});

test('counter phase retains transient raw readings and requires three stable values', async () => {
  const values = [2237296, 2267216, 2267216, 2267216];
  const stable = await sampleCounterPair(async index => {
    const row = Array(16).fill(0);
    row[5] = values[index - 1];
    return row;
  }, 'after');
  assert.equal(stable.reads, 4);
  assert.deepEqual(stable.observedGeneralHeap, values);
  assert.deepEqual(stable.rawSamples.map(row => row[5]), values);
  assert.deepEqual(stable.samples.map(row => row[5]),
    [2267216, 2267216]);
  await assert.rejects(sampleCounterPair(async index => {
    const row = Array(16).fill(0);
    row[5] = index;
    return row;
  }, 'unstable'), error => {
    assert.equal(error.rawSamples.length, COUNTER_MAX_READS);
    assert.deepEqual(error.rawSamples.map(row => row[5]),
      Array.from({length: COUNTER_MAX_READS}, (_, index) => index + 1));
    return true;
  });
});

test('abort adapter refuses mismatched retained owner before any IPC', () => {
  const sdkBase = '0x1000000000';
  const arenaBase = '0x2000000000';
  const nonce = '1234567890abcdef';
  const evidence = {gameProfile: profile.gameProfile, sdkBase};
  const context = {nonce, arena: BigInt(arenaBase),
    scratch: BigInt(arenaBase) + 0x10000n};
  const transport = Object.create(BalatroCloneTransport.prototype);
  transport.evidence = evidence;
  transport.native = {addresses: {sdk: Number(BigInt(sdkBase)),
    scratch: Number(context.scratch)}};
  const base = {preflight: {gameProfile: profile.gameProfile, sdkBase,
    arenaBase, arenaNonce: nonce}, evidence, transport, context,
  host: '10.0.0.189', macIp: '10.0.0.205', port: 39381,
  mainBase: '0x3000000000', inspectIdentity() {}, executeSource() {},
  stopNative() {}, closeTransport() {}, releaseArena() {}};
  assert.throws(() => createAbortAdapter({...base,
    preflight: {...base.preflight, arenaNonce: '0000000000000000'}}),
  /owner or image/);
  assert.doesNotThrow(() => createAbortAdapter(base));
});
