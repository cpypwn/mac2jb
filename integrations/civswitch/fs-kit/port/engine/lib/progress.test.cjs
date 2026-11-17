const test = require('node:test');
const assert = require('node:assert/strict');
const {NativeClient, REQUEST_BYTES, RESPONSE_BYTES} = require('./native.cjs');
const {loadTarget} = require('../shared/target.cjs');

test('Gravity Circuit progress uses the native queue and calls no SDK function', async () => {
  const packets = [];
  let pending = false;
  const connection = {
    async write(bytes) {
      assert.equal(pending, false);
      pending = true;
      packets.push(Buffer.from(bytes));
    },
    async read(size) {
      assert.equal(size, RESPONSE_BYTES);
      await new Promise(resolve => setTimeout(resolve, 2));
      const packet = packets.at(-1);
      const reply = Buffer.alloc(size);
      if (packet.readUInt32LE(16) === 0x47504353) {
        reply.writeBigUInt64LE(0x47504353n);
        reply.writeBigUInt64LE(packet.readBigUInt64LE(24), 8);
      }
      pending = false;
      return reply;
    },
  };
  const native = new NativeClient(connection,
    {scratch: 0x5012340000, sdk: 0x4012300000, target: 'gravcirc'}, loadTarget('gravcirc'));
  const call = native.call(native.offsets.memmove, 1, 2, 0, 0);
  const progress = native.progress(2);
  await Promise.all([call, progress]);
  assert.equal(packets.length, 2);
  assert.equal(packets[1].length, REQUEST_BYTES);
  assert.equal(packets[1].readBigUInt64LE(0), 0n);
  assert.equal(packets[1].readBigUInt64LE(0x28), 0n);
  assert.equal(packets[1].readUInt32LE(16), 0x47504353);
  assert.equal(packets[1].readBigUInt64LE(24), 2n);
  assert.equal(native.calls, 1);
});

test('progress rejects invalid steps and a missing game acknowledgment', async () => {
  const connection = {
    async write() {},
    async read() {return Buffer.alloc(RESPONSE_BYTES);},
  };
  const addresses = {scratch: 0x5012340000, sdk: 0x4012300000, target: 'gravcirc'};
  const native = new NativeClient(connection, addresses, loadTarget('gravcirc'));
  await assert.rejects(native.progress(0), /Invalid Gravity Circuit progress step/);
  await assert.rejects(native.progress(7), /Invalid Gravity Circuit progress step/);
  await assert.rejects(native.progress(1), /did not acknowledge FS progress/);
  const smilebasic = new NativeClient(connection, {...addresses, target: 'smilebasic'},
    loadTarget('smilebasic'));
  await assert.rejects(smilebasic.progress(1), /Invalid Gravity Circuit progress step/);
});
