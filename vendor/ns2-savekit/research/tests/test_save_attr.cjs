#!/usr/bin/env node
// Offline tests for tools/lib/save-attr.cjs. No console, no network, no deps.
//
//   node tests/test_save_attr.cjs
//
// The offsets are the whole point: a shifted field opens a different save
// archive (or none), and the failure looks like "no save data" rather than a
// malformed request.
const assert = require('node:assert');
const {build, openCommand, plan, SIZE, OFFSET} = require('../tools/lib/save-attr.cjs');

let passes = 0, failures = 0;
function test(name, fn) {
  try {
    fn();
    passes++;
    console.log('ok    ' + name);
  } catch (error) {
    failures++;
    console.log('FAIL  ' + name + '\n      ' + String(error.message).split('\n').join('\n      '));
  }
}

const UID = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

test('SaveDataAttribute packs at its documented offsets', () => {
  const input = build({space: 1, referenceId: 0x01007ef00011e000n, uid: UID,
    type: 1, rank: 1, index: 0x1234, staticId: 0xdeadbeefn});
  assert.strictEqual(SIZE, 0x48);
  assert.strictEqual(input.length, 0x48);
  assert.strictEqual(input[0], 1);                                   // space
  assert.strictEqual(input.readBigUInt64LE(OFFSET + 0x00), 0x01007ef00011e000n);
  assert.deepStrictEqual(input.subarray(OFFSET + 0x08, OFFSET + 0x18), UID);
  assert.strictEqual(input.readBigUInt64LE(OFFSET + 0x18), 0xdeadbeefn);
  assert.strictEqual(input[OFFSET + 0x20], 1);                       // type
  assert.strictEqual(input[OFFSET + 0x21], 1);                       // rank
  assert.strictEqual(input.readUInt16LE(OFFSET + 0x22), 0x1234);     // index
});

test('rank, index and static id default to zero', () => {
  const input = build({space: 1, referenceId: 1n, uid: UID, type: 3});
  assert.strictEqual(input[OFFSET + 0x21], 0);
  assert.strictEqual(input.readUInt16LE(OFFSET + 0x22), 0);
  assert.strictEqual(input.readBigUInt64LE(OFFSET + 0x18), 0n);
});

test('uid 0 is the common/device shape, not an error', () => {
  const input = build({space: 1, referenceId: 1n, uid: Buffer.alloc(16), type: 3});
  assert.deepStrictEqual(input.subarray(OFFSET + 0x08, OFFSET + 0x18), Buffer.alloc(16));
});

test('system saves use the BySystemSaveDataId command', () => {
  assert.strictEqual(openCommand(0), 52);
  assert.strictEqual(openCommand(6), 52);
  for (const type of [1, 2, 3, 4, 5, 7]) assert.strictEqual(openCommand(type), 53);
});

test('a uid that is not 16 raw bytes is rejected', () => {
  assert.throws(() => build({space: 1, referenceId: 1n, uid: Buffer.alloc(8), type: 1}),
    /16 raw bytes/);
  assert.throws(() => build({space: 1, referenceId: 1n, uid: '0011', type: 1}),
    /16 raw bytes/);
});

test('an Account sweep tries each user, then the common uid', () => {
  const uids = [Buffer.from('11'.repeat(16), 'hex'), Buffer.from('22'.repeat(16), 'hex')];
  const candidates = plan({spaces: [1], types: [1], ranks: [0], uids});
  assert.deepStrictEqual(candidates.map(c => c.uid.toString('hex').slice(0, 2)),
    ['11', '22', '00']);
});

test('Device/Bcat/Cache try uid 0 first, and only uid 0 under --all', () => {
  const uids = [Buffer.from('11'.repeat(16), 'hex')];
  const single = plan({spaces: [1], types: [3], ranks: [0], uids});
  assert.deepStrictEqual(single.map(c => c.uid.toString('hex').slice(0, 2)), ['00', '11']);
  const all = plan({spaces: [1], types: [3], ranks: [0], uids, all: true});
  assert.deepStrictEqual(all.map(c => c.uid.toString('hex').slice(0, 2)), ['00']);
});

test('an explicit zero uid is not duplicated', () => {
  const candidates = plan({spaces: [1], types: [1], ranks: [0], uids: [Buffer.alloc(16)]});
  assert.strictEqual(candidates.length, 1);
});

test('plan keeps the space/type/rank order', () => {
  const uids = [Buffer.from('11'.repeat(16), 'hex')];
  const candidates = plan({spaces: [1, 4], types: [1, 3], ranks: [0, 1], uids});
  assert.deepStrictEqual(candidates[0], {space: 1, type: 1, rank: 0, index: 0,
    staticId: 0, uid: uids[0]});
  assert.strictEqual(candidates[2].rank, 1);
  assert.strictEqual(candidates[4].type, 3);
  assert.strictEqual(candidates.at(-1).space, 4);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
