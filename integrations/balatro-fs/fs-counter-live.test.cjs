const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {PORT, runCounterLive} = require('./fs-counter-live.cjs');

const nonce = '0123456789abcdef';
const arenaBase = '0x4964000000';
const sdkBase = '0x200000000';
const host = '10.0.0.189';
const macIp = '10.0.0.205';

function greeting() {
  const data = Buffer.alloc(128);
  [0x31545344n, 1n, 2n, BigInt(arenaBase) + 0x10000n,
    0x80000n, 0x100000000n, BigInt(sdkBase), 0n,
    BigInt(sdkBase) + BigInt(profile.symbols.memmove.offset),
    0n, 0n, 0n, 0n, 0n, 0n, BigInt(profile.sdkCode.offlineCrc32)]
    .forEach((word, index) => data.writeBigUInt64LE(word, index * 8));
  return data;
}

function fixtures(overrides = {}) {
  const events = [];
  const socket = {
    async read(size) {events.push(`read:${size}`); return size === 128 ?
      greeting() : Buffer.alloc(size);},
    async write(packet) {events.push(`write:${packet.length}`);},
    close() {events.push('socket-close');},
  };
  const dependencies = {
    host, macIp, nonce,
    onPhase: phase => events.push(`phase:${phase}`),
    preflight: async () => {events.push('preflight');
      return {nonce, arenaBase, arenaBytes: 0x200000};},
    verifyCrc: async () => {events.push('crc');
      return {gameProfile: profile.gameProfile, nonce, port: PORT, sdkBase,
        sdkCrc32: profile.sdkCode.offlineCrc32};},
    stage: async () => {events.push('stage');
      return {nonce, port: PORT, arenaBase};},
    connect: async () => {events.push('connect'); return socket;},
    sample: async ({exchange}) => {events.push('sample');
      await exchange(Buffer.alloc(0x8080), 'counters');
      return {reads: 3, samples: [Array(16).fill(0), Array(16).fill(0)],
        cleanup: 'released', status: 'stable counters; marker unverified'};},
    execute: async ({port, source}) => {events.push(`cleanup:${port}`);
      assert.match(source, /BL\.fs_transport=nil/);
      return `-> BAL_TRANSPORT_V1\tclosed\t${PORT}\n`;},
    ...overrides,
  };
  return {events, dependencies};
}

test('counter runner gates packets on CRC and closes the owned transport', async () => {
  const {events, dependencies} = fixtures();
  const result = await runCounterLive(dependencies);
  assert.equal(result.reads, 3);
  assert.equal(result.cleanup, 'released');
  assert.deepEqual(events, ['phase:arena-and-timing', 'preflight',
    'phase:sdk-crc', 'crc', 'preflight', 'phase:stage-owned-bridge', 'stage',
    'connect', 'read:128', 'sample', 'phase:counters', 'write:32896',
    'read:32784', 'write:32896', 'socket-close', 'cleanup:9026']);
});

test('mismatched CRC stops before bridge and counter failure still cleans listener', async () => {
  const failedCrc = fixtures({verifyCrc: async () => ({nonce, port: PORT,
    gameProfile: profile.gameProfile, sdkBase, sdkCrc32: '0x0'})});
  await assert.rejects(runCounterLive(failedCrc.dependencies), /SDK or retained arena changed/);
  assert.ok(!failedCrc.events.includes('stage'));
  const failedCounter = fixtures({sample: async () => {throw Error('counter IPC failed');}});
  await assert.rejects(runCounterLive(failedCounter.dependencies), /counter IPC failed/);
  assert.ok(failedCounter.events.includes('socket-close'));
  assert.ok(failedCounter.events.includes('cleanup:9026'));
});

test('partial bridge staging failure still verifies listener cleanup', async () => {
  const partialStage = fixtures({stage: async () => {throw Error('stage failed after opening listener');}});
  await assert.rejects(runCounterLive(partialStage.dependencies), /stage failed after opening listener/);
  assert.ok(partialStage.events.includes('cleanup:9026'));
  assert.ok(!partialStage.events.includes('connect'));
});

test('alternate bounded FS diagnostic uses its own result gate and cleanup', async () => {
  const result = {cleanup: 'released', assessment: {verified: false}};
  const {events, dependencies} = fixtures({sample: async () => result,
    validateResult: value => value === result});
  assert.equal((await runCounterLive(dependencies)).assessment.verified, false);
  assert.ok(events.includes('cleanup:9026'));
});
