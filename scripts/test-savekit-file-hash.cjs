'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {hashFile} = require('../vendor/ns2-savekit/tools/lib/verified-file-hash.cjs');

test('large save files are hashed in bounded reads', async () => {
  const source = Buffer.alloc(0x280000);
  for (let offset = 0; offset < source.length; offset += 4)
    source.writeUInt32LE(offset, offset);
  const session = {};
  const handle = 73;
  const reads = [];
  const filesystem = {
    async readFile(actualSession, actualHandle, offset, size) {
      assert.equal(actualSession, session);
      assert.equal(actualHandle, handle);
      assert.ok(size > 0 && size <= 0x40000);
      reads.push({offset, size});
      return source.subarray(offset, offset + size);
    }
  };
  const actual = await hashFile(session, filesystem, handle, source.length);
  const expected = crypto.createHash('sha256').update(source).digest('hex');
  assert.equal(actual, expected);
  assert.ok(reads.length > 1);
  assert.equal(reads.reduce((sum, read) => sum + read.size, 0), source.length);
  for (let index = 1; index < reads.length; index++)
    assert.equal(reads[index].offset, reads[index - 1].offset + reads[index - 1].size);
});

test('empty save files hash without a console read', async () => {
  const filesystem = {async readFile() {assert.fail('an empty file must not be read');}};
  const actual = await hashFile({}, filesystem, 1, 0);
  assert.equal(actual, crypto.createHash('sha256').digest('hex'));
});

test('short or malformed console reads cannot verify a save file', async () => {
  await assert.rejects(() => hashFile({}, {
    async readFile(_session, _handle, _offset, size) {return Buffer.alloc(size - 1);}
  }, 1, 0x40001));
  await assert.rejects(() => hashFile({}, {
    async readFile() {return 'not bytes';}
  }, 1, 1));
});
