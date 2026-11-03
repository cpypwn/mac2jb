'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {unusedTail} = require('./cache-shape.cjs');

test('accepts only the observed eight-byte prefix and 552-byte path shape', () => {
  const bytes = Buffer.alloc(0x5a0);
  const tail = bytes.subarray(0x30);
  Buffer.from('0000400100000000', 'hex').copy(tail);
  tail.fill(0x41, 8, 8 + 552);
  tail[20] = 0x2f;
  assert.equal(unusedTail(bytes), true);

  const wrongLength = Buffer.from(bytes);
  wrongLength[0x30 + 8 + 551] = 0;
  assert.equal(unusedTail(wrongLength), false);

  const wrongPrefix = Buffer.from(bytes);
  wrongPrefix[0x30 + 2] = 0x41;
  assert.equal(unusedTail(wrongPrefix), false);
});
