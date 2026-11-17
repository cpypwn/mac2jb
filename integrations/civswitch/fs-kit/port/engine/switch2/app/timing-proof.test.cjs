const assert = require('node:assert/strict');
const test = require('node:test');
const {validatedGravityCircuitProof} = require('./timing-proof.cjs');

const now = 1794520000000;
const addresses = {sdk: 0x12345000, scratch: 0x23456000, sdkCrc32: 4209895763};
const target = {hello: {sdkCrc32: 4209895763}, timing: {sdkFrequency: 19200000,
  nativeFrequency: 31250000, measurementNs: 1000000000, tolerancePpm: 100000}};
const proof = {gameProfile: 'gravity-circuit-v1.2.1', sdkBase: addresses.sdk,
  scratch: addresses.scratch, sdkCrc32: addresses.sdkCrc32, sdkFrequency: 19200000,
  nativeFrequency: 31250000, intervalNs: 1000000000, elapsedTicks: 31264192,
  measuredFrequency: 31264192, tolerancePpm: 100000, fsBridgeStage: 'accept',
  nonce: '0123456789abcdef', issuedAt: now - 1000};

test('accepts a fresh atomic proof for the paired Gravity Circuit HELLO', () => {
  assert.deepEqual(validatedGravityCircuitProof(JSON.stringify(proof), addresses, target, now), proof);
});

test('rejects stale and mismatched atomic proofs', () => {
  const rejects = [
    {...proof, issuedAt: now - 20 * 60 * 1000 - 1},
    {...proof, sdkBase: proof.sdkBase + 0x1000},
    {...proof, scratch: proof.scratch + 0x1000},
    {...proof, sdkCrc32: 1},
    {...proof, nonce: 'stale'},
    {...proof, measuredFrequency: 48000000},
    {...proof, elapsedTicks: 48000000},
    {...proof, fsBridgeStage: 'closed'},
  ];
  for (const candidate of rejects)
    assert.throws(() => validatedGravityCircuitProof(JSON.stringify(candidate), addresses, target, now),
      /does not match/);
  assert.throws(() => validatedGravityCircuitProof(undefined, addresses, target, now), /missing/);
});
