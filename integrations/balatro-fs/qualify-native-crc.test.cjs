const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {REQUEST_BYTES, RESPONSE_BYTES} = require('./native-readonly-smoke.cjs');
const {VECTOR_CRC32, SDK_CRC32, makeCrcPacket, parseCrcReply,
  qualifyNativeCrc} = require('./qualify-native-crc.cjs');

const arenaBase = '0x4cf2cf8000';
const sdkBase = '0x6005cb4000';
const scratch = `0x${(BigInt(arenaBase) + 0x10000n).toString(16)}`;
const nonce = 'bafb9ee55e2770bb';
const hello = {scratch, sdkBase};

function greeting() {
  const bytes = Buffer.alloc(128);
  const fields = [0x31545344n, 1n, 2n, BigInt(scratch), 0x80000n,
    0x194ec04000n, BigInt(sdkBase), 0n,
    BigInt(sdkBase) + BigInt(profile.symbols.memmove.offset)];
  fields.forEach((value, index) => bytes.writeBigUInt64LE(value, index * 8));
  bytes.writeBigUInt64LE(BigInt(profile.sdkCode.offlineCrc32), 15 * 8);
  return bytes;
}

function reply() {
  const bytes = Buffer.alloc(RESPONSE_BYTES);
  bytes.writeBigUInt64LE(BigInt(SDK_CRC32), 0);
  bytes.writeBigUInt64LE(BigInt(VECTOR_CRC32), 8);
  return bytes;
}

test('native CRC frame calls only pinned CRC function over bounded data', () => {
  const packet = makeCrcPacket(hello);
  const fn = BigInt(sdkBase) + BigInt(profile.symbols.nnutilZlib_crc32.offset);
  assert.equal(packet.length, REQUEST_BYTES);
  assert.equal(packet.readBigUInt64LE(0), fn);
  assert.equal(packet.readBigUInt64LE(0x28), fn);
  assert.equal(packet.readBigUInt64LE(0x10), BigInt(scratch) + 0x40100n);
  assert.equal(packet.readBigUInt64LE(0x18), 9n);
  assert.equal(packet.readBigUInt64LE(0x38), BigInt(sdkBase));
  assert.equal(packet.readBigUInt64LE(0x40), BigInt(profile.sdkCode.size));
  assert.equal(packet.toString('ascii', 0x100, 0x109), '123456789');
  assert.throws(() => makeCrcPacket({scratch, sdkBase: '0xffffffffff'}), /outside/);
});

test('native CRC requires both reference vector and full SDK checksum', () => {
  assert.equal(parseCrcReply(reply(), hello).sdkCrc32, `0x${SDK_CRC32.toString(16)}`);
  const wrong = reply();
  wrong.writeBigUInt64LE(0n, 8);
  assert.throws(() => parseCrcReply(wrong, hello), /pinned vectors/);
  assert.throws(() => parseCrcReply(reply().subarray(1), hello), /wrong shape/);
});

test('native CRC uses owned listener and verifies cleanup', async () => {
  let reads = 0;
  let closed = false;
  const writes = [];
  const result = await qualifyNativeCrc({host: '10.0.0.189', macIp: '10.0.0.205', nonce,
    prepare: async () => ({nonce, port: 39381, arenaBase}),
    connect: async () => ({
      read: async () => ++reads === 1 ? greeting() : reply(),
      write: async bytes => writes.push(bytes),
      close: () => {closed = true;},
    }),
    execute: async ({port, source}) => {
      assert.equal(port, 9026);
      assert.match(source, /t:close\(\)/);
      return '-> BAL_TRANSPORT_V1\tclosed\t39381\n';
    },
  });
  assert.equal(result.sdkBase, sdkBase);
  assert.equal(reads, 2);
  assert.equal(writes.length, 2);
  assert.ok(writes[1].every(byte => byte === 0));
  assert.ok(closed);
});
