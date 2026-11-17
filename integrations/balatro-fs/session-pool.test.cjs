const assert = require('node:assert/strict');
const {test} = require('node:test');
const {CAPACITY, NODE_BYTES, MANAGER_BYTES, SLOT_BYTES,
  inspectSessionPool} = require('./session-pool.cjs');

const managerAddress = 0x592a606940;
const pool = managerAddress + 0x80;

function fixture({idle = [2, 1, 0], spare = Array.from({length: 13}, (_, i) => i + 3)} = {}) {
  const manager = Buffer.alloc(MANAGER_BYTES);
  const slots = Buffer.alloc(SLOT_BYTES);
  manager.writeUInt32LE(2048, 8);
  manager.writeBigUInt64LE(BigInt(pool), 0x10);
  manager.writeBigUInt64LE(BigInt(idle.length ? pool + idle[0] * NODE_BYTES : 0), 0x40);
  manager.writeBigUInt64LE(BigInt(spare.length ? pool + spare[0] * NODE_BYTES : 0), 0x48);
  manager.writeUInt32LE(CAPACITY, 0x58);
  manager.writeUInt32LE(3, 0x5c);
  for (let i = 0; i < CAPACITY; i++) slots.writeUInt32LE(459250 + i, i * NODE_BYTES);
  for (const list of [idle, spare]) {
    list.forEach((index, position) => slots.writeBigUInt64LE(BigInt(position + 1 < list.length ?
      pool + list[position + 1] * NODE_BYTES : 0), index * NODE_BYTES + 8));
  }
  return {manager, slots};
}

test('pinned SDK pool list chooses the idle head, not slot zero', () => {
  const {manager, slots} = fixture();
  const result = inspectSessionPool(manager, slots, managerAddress);
  assert.equal(result.nextBorrowable.index, 2);
  assert.equal(result.nextBorrowable.handle, 459252);
  assert.equal(result.idleCount, 3);
  assert.equal(result.spareCount, 13);
  assert.equal(result.livenessVerified, false);
});

test('a recently allocated slot zero is not chosen merely because it has a handle', () => {
  const {manager, slots} = fixture({idle: [1, 2],
    spare: [0, ...Array.from({length: 13}, (_, i) => i + 3)]});
  const result = inspectSessionPool(manager, slots, managerAddress);
  assert.equal(result.nextBorrowable.index, 1);
  assert.equal(result.nextBorrowable.handle, 459251);
  assert.equal(result.spare[0].handle, 459250);
});

test('no idle session refuses selection', () => {
  const {manager, slots} = fixture({idle: [],
    spare: Array.from({length: 16}, (_, i) => i)});
  assert.throws(() => inspectSessionPool(manager, slots, managerAddress),
    /do not partition/);
});

test('cycles, duplicate nodes, out-of-pool links, and bad count fail closed', () => {
  const {manager, slots} = fixture();
  slots.writeBigUInt64LE(BigInt(pool + 2 * NODE_BYTES), 8);
  assert.throws(() => inspectSessionPool(manager, slots, managerAddress), /cyclic/);
  const badLink = fixture();
  badLink.slots.writeBigUInt64LE(BigInt(pool + 0x800), 2 * NODE_BYTES + 8);
  assert.throws(() => inspectSessionPool(badLink.manager, badLink.slots, managerAddress),
    /corrupt/);
  const badCount = fixture();
  badCount.manager.writeUInt32LE(2, 0x5c);
  assert.throws(() => inspectSessionPool(badCount.manager, badCount.slots, managerAddress),
    /layout changed/);
});

