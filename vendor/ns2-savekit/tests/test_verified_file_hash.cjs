'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {hashFile} = require('../tools/lib/verified-file-hash.cjs');

test('Elden Ring save files are hashed in bounded reads', async () => {
  const source = Buffer.alloc(0x280000);
  for (let offset = 0; offset < source.length; offset += 4)
    source.writeUInt32LE(offset, offset);
  const session = {};
  const reads = [];
  const filesystem = {
    async readFile(actualSession, handle, offset, size) {
      assert.equal(actualSession, session);
      assert.equal(handle, 73);
      assert.ok(size > 0 && size <= 0x40000);
      reads.push({offset, size});
      return source.subarray(offset, offset + size);
    },
  };
  const expected = crypto.createHash('sha256').update(source).digest('hex');
  assert.equal(await hashFile(session, filesystem, 73, source.length), expected);
  assert.equal(reads.reduce((sum, read) => sum + read.size, 0), source.length);
  for (let index = 1; index < reads.length; index++)
    assert.equal(reads[index].offset, reads[index - 1].offset + reads[index - 1].size);
});

test('empty files hash without a console read', async () => {
  const filesystem = {async readFile() {assert.fail('unexpected console read');}};
  assert.equal(await hashFile({}, filesystem, 1, 0),
    crypto.createHash('sha256').digest('hex'));
});

test('short console reads fail verification', async () => {
  await assert.rejects(() => hashFile({}, {
    async readFile(_session, _handle, _offset, size) {return Buffer.alloc(size - 1);}
  }, 1, 0x40001), /fewer bytes/);
});
