const assert = require('node:assert/strict');
const test = require('node:test');
const {NativeClient, REQUEST_BYTES, RESPONSE_BYTES} = require('./native.cjs');
const {loadTarget} = require('../shared/target.cjs');

const MAGIC = 0x504d4347;
const addresses = {scratch: 0x5012340000, sdk: 0x4012300000, target: 'gravcirc'};

function fixture(upgrade = true) {
  const writes = [];
  const reads = [];
  const connection = {
    async write(bytes) { writes.push(Buffer.from(bytes)); },
    async read(size) {
      reads.push(size);
      if (writes.length === 1 && writes[0].readUInt32LE(16) === MAGIC) {
        const reply = Buffer.alloc(RESPONSE_BYTES);
        if (upgrade) {
          reply.writeBigUInt64LE(BigInt(MAGIC));
          reply.writeBigUInt64LE(1n, 8);
        }
        return reply;
      }
      const reply = Buffer.alloc(size, 0x41);
      reply.writeBigUInt64LE(0x111n);
      reply.writeBigUInt64LE(0x222n, 8);
      return reply;
    },
    close() {},
  };
  return {native: new NativeClient(connection, addresses, loadTarget('gravcirc')), writes, reads};
}

test('compact upgrade uses one legacy no-op frame and falls back safely', async () => {
  const next = fixture(true);
  assert.equal(await next.native.negotiateCompact(), true);
  assert.equal(next.writes[0].length, REQUEST_BYTES);
  assert.equal(next.writes[0].readUInt32LE(16), MAGIC);
  assert.equal(next.writes[0].readBigUInt64LE(), 0n);
  assert.equal(next.writes[0].readBigUInt64LE(0x28), 0n);
  assert.deepEqual(next.reads, [RESPONSE_BYTES]);

  const old = fixture(false);
  assert.equal(await old.native.negotiateCompact(), false);
  assert.equal(old.native.compact, false);
  await old.native.exchange([{offset: 0x1000, args: [1, 2, 3, 4]}]);
  assert.equal(old.writes[1].length, REQUEST_BYTES);
  assert.deepEqual(old.reads, [RESPONSE_BYTES, RESPONSE_BYTES]);
});

test('compact packets preserve native call records and carry only declared bytes', async () => {
  const compact = fixture(true);
  const legacy = fixture(false);
  await compact.native.negotiateCompact();
  const call = {offset: 0x1000, args: [1, 2, 3, 4]};
  const small = Buffer.from('abc');
  const compactResult = await compact.native.exchange([call], small, 4);
  await legacy.native.exchange([call], small, 4);
  assert.equal(compact.writes[1].length, 0x80 + small.length);
  assert.deepEqual(compact.writes[1].subarray(0, 0x50), legacy.writes[0].subarray(0, 0x50));
  assert.deepEqual(compact.writes[1].subarray(0x80), small);
  assert.equal(compact.writes[1].readUInt32LE(0x50), MAGIC);
  assert.equal(compact.writes[1].readBigUInt64LE(0x58), BigInt(small.length));
  assert.equal(compact.writes[1].readBigUInt64LE(0x60), 4n);
  assert.deepEqual(compactResult.results, [0x222n, 0x111n]);
  assert.deepEqual(compactResult.output, Buffer.alloc(4, 0x41));
  assert.equal(compact.reads[1], 20);

  const large = Buffer.alloc(0x8000, 0x5a);
  const largeResult = await compact.native.exchange([call], large, 0x8000);
  await legacy.native.exchange([call], large, 0x8000);
  assert.equal(compact.writes[2].length, 0x8080);
  assert.deepEqual(compact.writes[2].subarray(0, 0x50), legacy.writes[1].subarray(0, 0x50));
  assert.deepEqual(compact.writes[2].subarray(0x80), large);
  assert.equal(largeResult.output.length, 0x8000);
  assert.deepEqual(largeResult.output, Buffer.alloc(0x8000, 0x41));
  assert.equal(compact.reads[2], RESPONSE_BYTES);
});

test('compact progress and termination use a header only', async () => {
  const item = fixture(true);
  await item.native.negotiateCompact();
  item.native.connection.read = async size => {
    item.reads.push(size);
    const reply = Buffer.alloc(size);
    reply.writeBigUInt64LE(0x47504353n);
    reply.writeBigUInt64LE(2n, 8);
    return reply;
  };
  await item.native.progress(2);
  assert.equal(item.writes[1].length, 0x80);
  assert.equal(item.writes[1].readUInt32LE(0x50), MAGIC);
  assert.equal(item.writes[1].readUInt32LE(16), 0x47504353);
  assert.equal(item.reads[1], 16);
  await item.native.stop();
  assert.equal(item.writes[2].length, 0x80);
  assert.deepEqual(item.writes[2], Buffer.alloc(0x80));
});

test('compact query and guarded read request only the bytes they parse', async () => {
  const item = fixture(true);
  await item.native.negotiateCompact();
  const address = 0x5012380000;
  const region = Buffer.alloc(0x40);
  region.writeBigUInt64LE(BigInt(address));
  region.writeBigUInt64LE(0x1000n, 8);
  region.writeUInt32LE(3, 16);
  region.writeUInt32LE(5, 24);
  const content = Buffer.from('abc');
  item.native.connection.read = async size => {
    item.reads.push(size);
    const reply = Buffer.alloc(size);
    if (size === 16 + region.length) region.copy(reply, 16);
    else if (size === 16 + content.length) {
      reply.writeBigUInt64LE(BigInt(item.native.output), 8);
      content.copy(reply, 16);
    } else throw Error('Unexpected compact reply size');
    return reply;
  };
  assert.equal((await item.native.query(address)).permissions, 5);
  assert.deepEqual(await item.native.read(address, content.length), content);
  assert.deepEqual(item.reads.slice(1), [80, 80, 19]);
  assert.equal(item.writes.slice(1).every(packet => packet.length === 0x80), true);
  assert.deepEqual(item.writes.slice(1).map(packet => Number(packet.readBigUInt64LE(0x60))),
    [64, 64, 3]);
});
