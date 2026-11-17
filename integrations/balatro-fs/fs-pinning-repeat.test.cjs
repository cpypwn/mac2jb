const assert = require('node:assert/strict');
const test = require('node:test');
const {MAX_CYCLES, runRepeatedPinning} = require('./fs-pinning-repeat.cjs');
const {validRepeatedResult, runRepeatedLive} = require('./fs-pinning-repeat-live.cjs');

const context = Object.freeze({qualified: true});
const exchange = async () => Buffer.alloc(0);

function cycle(bytes = 14096, verified = true) {
  return {cleanup: 'released', assessment: {verified, bytes, restoration: 0}};
}

test('two equal positive diagnostics give a candidate, never an allocation size or marker', async () => {
  const phases = [];
  const result = await runRepeatedPinning({context, exchange: async (_, phase) => {
    phases.push(phase);
    return Buffer.alloc(0);
  }, cycle: async ({exchange: send}) => {
    await send(Buffer.alloc(1), 'owned-service');
    return cycle();
  }});
  assert.equal(MAX_CYCLES, 2);
  assert.deepEqual(phases, ['cycle-1-owned-service', 'cycle-2-owned-service']);
  assert.equal(result.repeatabilityVerified, true);
  assert.equal(result.candidateDiagnosticDropBytes, 14096);
  assert.equal(result.markerAttempted, false);
  assert.match(result.interpretation, /not an exact allocation size/);
  assert.equal(validRepeatedResult(result), true);
});

test('an unmatched first cycle stops before a second native cycle', async () => {
  let calls = 0;
  const result = await runRepeatedPinning({context, exchange, cycle: async () => {
    calls++;
    return cycle(0, false);
  }});
  assert.equal(calls, 1);
  assert.equal(result.repeatabilityVerified, false);
  assert.equal(result.candidateDiagnosticDropBytes, null);
});

test('a different second drop is reported but never becomes geometry', async () => {
  let calls = 0;
  const result = await runRepeatedPinning({context, exchange, cycle: async () =>
    cycle(calls++ === 0 ? 14096 : 14112)});
  assert.equal(calls, 2);
  assert.equal(result.repeatabilityVerified, false);
  assert.equal(result.candidateDiagnosticDropBytes, null);
  assert.equal(validRepeatedResult(result), true);
});

test('result gate rejects a claimed repeat with missing second cycle', () => {
  assert.equal(validRepeatedResult({cleanup: 'released', markerAttempted: false,
    repeatabilityVerified: true, candidateDiagnosticDropBytes: 14096,
    cycles: [cycle()]}), false);
});

test('unverified cleanup stops without another native cycle', async () => {
  let calls = 0;
  await assert.rejects(runRepeatedPinning({context, exchange, cycle: async () => {
    calls++;
    return {cleanup: 'unknown', assessment: {verified: true, bytes: 14096}};
  }}), /resource cleanup/);
  assert.equal(calls, 1);
});

test('live wrapper keeps the counter transport and validates the bounded report', async () => {
  const profile = require('./sdk-profile.v1.0.1f.json');
  const arenaBase = '0x42ab8f8000';
  const sdkBase = '0x6005cb4000';
  const greeting = Buffer.alloc(128);
  [0x31545344n, 1n, 2n, BigInt(arenaBase) + 0x10000n,
    0x80000n, 0x100000000n, BigInt(sdkBase), 0n,
    BigInt(sdkBase) + BigInt(profile.symbols.memmove.offset),
    0n, 0n, 0n, 0n, 0n, 0n, BigInt(profile.sdkCode.offlineCrc32)]
    .forEach((word, index) => greeting.writeBigUInt64LE(word, index * 8));
  const result = await runRepeatedLive({host: '10.0.0.189', macIp: '10.0.0.205',
    nonce: '0123456789abcdef',
    preflight: async () => ({nonce: '0123456789abcdef', arenaBytes: 0x200000,
      arenaBase}),
    verifyCrc: async () => ({nonce: '0123456789abcdef', port: 39381,
      gameProfile: profile.gameProfile, sdkCrc32: profile.sdkCode.offlineCrc32,
      sdkBase}),
    stage: async () => ({nonce: '0123456789abcdef', port: 39381,
      arenaBase}),
    connect: async () => ({
      read: async size => size === 128 ? greeting : Buffer.alloc(size),
      write: async () => {}, close: () => {},
    }),
    execute: async () => '-> BAL_TRANSPORT_V1\tclosed\t39381\n',
    sample: async () => ({...await runRepeatedPinning({context, exchange,
      cycle: async () => cycle()}), cleanup: 'released'}),
  });
  assert.equal(result.repeatabilityVerified, true);
});
