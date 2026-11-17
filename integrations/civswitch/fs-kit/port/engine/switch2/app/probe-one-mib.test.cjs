const test = require('node:test');
const assert = require('node:assert/strict');
const {packet} = require('../../shared/ipc.cjs');
const {fileReadOptions} = require('./file-read-options.cjs');

test('one MiB readback uses the IFile.Read map-alias receive mode', () => {
  const address = 0x12345000;
  const bytes = packet(0, Buffer.alloc(24), fileReadOptions(address, 0x10));
  assert.equal(bytes.readUInt32LE(0) >>> 24 & 0xf, 1);
  assert.equal(bytes.readUInt32LE(8), 0x10);
  assert.equal(bytes.readUInt32LE(12), address);
  assert.equal(bytes.readUInt32LE(16) & 3, 1);
});
