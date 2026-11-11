'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {resolvePool, locatePoolAnchor, DECIDABLE_CANDIDATES} = require('./find-metadata.cjs');
const {externalLink} = require('./link-anchor.cjs');

test('three pool candidates are handed to the anchor check without extra captures', async () => {
  const address = 0x6002000000;
  const bytes = Buffer.alloc(0x4000);
  bytes.writeBigUInt64LE(BigInt(address - 0x1a00000));
  const evidence = {};
  const bounds = await resolvePool(null, {}, {result: {address, length: bytes.length}, bytes},
    evidence, async () => {});
  assert.equal(DECIDABLE_CANDIDATES, 4);
  assert.equal(bounds.unresolved, true);
  assert.equal(bounds.candidates.length, 3);
  assert.equal(evidence.poolSearch.captures.length, 0);
});

test('candidate anchors are checked in order and stop at the first valid link', async () => {
  const candidates = [0x6000200000, 0x6000400000, 0x6000600000];
  const calls = [];
  const read = async (address, length) => {
    calls.push(address);
    const bytes = Buffer.alloc(length);
    if (address === candidates[1] + 0x3a00000) {
      const next = address + 0x9000000;
      bytes.writeBigUInt64LE(BigInt(next), 0);
      bytes.writeBigUInt64LE(BigInt(next), 8);
      bytes.writeBigUInt64LE(0x10000n, 16);
    }
    return {result: {address, length}, bytes};
  };
  const evidence = {};
  const found = await locatePoolAnchor(read, {candidates, unresolved: true},
    {plan: {addressBias: 0}, bucketPeriod: 0x4000}, evidence, async () => {});
  assert.deepEqual(calls, [candidates[0] + 0x3a00000, candidates[1] + 0x3a00000]);
  assert.equal(found.first, candidates[1]);
  assert.equal(found.tried[0].found, false);
  assert.equal(found.tried[1].found, true);
  assert.equal(evidence.nodeCapture.address, calls[1]);
  assert.equal(evidence.pending, undefined);
});

test('external link rejects mismatched pointers and invalid extent', () => {
  const address = 0x6004000000;
  const bytes = Buffer.alloc(24);
  const next = address + 0x9000000;
  bytes.writeBigUInt64LE(BigInt(next), 0);
  bytes.writeBigUInt64LE(BigInt(next), 8);
  bytes.writeBigUInt64LE(0x10000n, 16);
  assert.deepEqual(externalLink(bytes, 0, address), {next, previous: next, extent: 0x10000});
  bytes.writeBigUInt64LE(BigInt(next + 8), 8);
  assert.equal(externalLink(bytes, 0, address), undefined);
  bytes.writeBigUInt64LE(BigInt(next), 8);
  bytes.writeBigUInt64LE(0x1234n, 16);
  assert.equal(externalLink(bytes, 0, address), undefined);
});
