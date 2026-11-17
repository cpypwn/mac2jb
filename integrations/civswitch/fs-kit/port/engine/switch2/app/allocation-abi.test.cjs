const test = require('node:test');
const assert = require('node:assert/strict');
const {allocationArgs, freeArgs} = require('./allocation-abi.cjs');

test('gravity circuit uses the sdk memory-block size for allocation and release', () => {
  const target = {name: 'gravcirc'};
  assert.deepEqual(allocationArgs(target, 0x12340000, 0x80000), [0x12340000, 0x80000]);
  assert.deepEqual(freeArgs(target, 0x56780000, 0x80000), [0x56780000, 0x80000]);
});

test('civ7 keeps its existing allocation and release arguments', () => {
  const target = {name: 'civ7'};
  assert.deepEqual(allocationArgs(target, 0x12340000, 0x80000), [0x12340000, 4096, 0x80000]);
  assert.deepEqual(freeArgs(target, 0x56780000, 0x80000), [0x56780000, 0, 0]);
});
