const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {REQUEST_BYTES, RESPONSE_BYTES, makeQueryPacket, parseQueryReply,
  runNativeReadOnlySmoke} = require('./native-readonly-smoke.cjs');

const arenaBase = '0x4cf2cf8000';
const sdkBase = '0x6005cb4000';
const scratch = `0x${(BigInt(arenaBase) + 0x10000n).toString(16)}`;
const nonce = 'bafb9ee55e2770bb';
const hello = {scratch, sdkBase};

function greeting() {
  const bytes = Buffer.alloc(128);
  const words = [0x31545344n, 1n, 2n, BigInt(scratch), 0x80000n,
    0x194ec04000n, BigInt(sdkBase), 0n,
    BigInt(sdkBase) + BigInt(profile.symbols.memmove.offset)];
  words.forEach((value, index) => bytes.writeBigUInt64LE(value, index * 8));
  bytes.writeBigUInt64LE(BigInt(profile.sdkCode.offlineCrc32), 15 * 8);
  return bytes;
}

function reply() {
  const bytes = Buffer.alloc(RESPONSE_BYTES);
  const output = BigInt(scratch) + 0x4040n;
  bytes.writeBigUInt64LE(output, 0);
  bytes.writeBigUInt64LE(0n, 8);
  bytes.writeBigUInt64LE(BigInt(sdkBase), 16);
  bytes.writeBigUInt64LE(0x5e8000n, 24);
  bytes.writeUInt32LE(3, 32);
  bytes.writeUInt32LE(0, 36);
  bytes.writeUInt32LE(5, 40);
  return bytes;
}

test('native query packets contain only pinned read-only calls', () => {
  const bytes = makeQueryPacket(hello);
  assert.equal(bytes.length, REQUEST_BYTES);
  assert.equal(bytes.readBigUInt64LE(0),
    BigInt(sdkBase) + BigInt(profile.symbols.svcQueryMemory.offset));
  assert.equal(bytes.readBigUInt64LE(8), BigInt(scratch) + 0x4040n);
  assert.equal(bytes.readBigUInt64LE(0x28),
    BigInt(sdkBase) + BigInt(profile.symbols.memmove.offset));
  assert.equal(bytes.readBigUInt64LE(0x40), 0n);
  assert.throws(() => makeQueryPacket({scratch, sdkBase: '0xffffffffff'}), /outside/);
});

test('native query accepts only the pinned SDK mapping', () => {
  assert.equal(parseQueryReply(reply(), hello).sdkMappingBytes, 0x5e8000);
  const wrong = reply();
  wrong.writeUInt32LE(3, 40);
  assert.throws(() => parseQueryReply(wrong, hello), /did not verify/);
});

test('native smoke uses the owned listener and closes it after the query', async () => {
  let prepared = false;
  let closed = false;
  let reads = 0;
  const writes = [];
  const connection = {
    read: async length => {
      reads += 1;
      assert.equal(length, reads === 1 ? 128 : RESPONSE_BYTES);
      return reads === 1 ? greeting() : reply();
    },
    write: async bytes => writes.push(bytes),
    close: () => { closed = true; },
  };
  const result = await runNativeReadOnlySmoke({host: '10.0.0.189',
    macIp: '10.0.0.205', nonce,
    prepare: async () => {prepared = true; return {nonce, port: 39381, arenaBase};},
    connect: async (host, port) => {
      assert.ok(prepared);
      assert.equal(host, '10.0.0.189');
      assert.equal(port, 39381);
      return connection;
    },
    execute: async ({port, source}) => {
      assert.equal(port, 9026);
      assert.match(source, /t:close\(\)/);
      return '-> BAL_TRANSPORT_V1\tclosed\t39381\n';
    },
  });
  assert.equal(result.sdkBase, sdkBase);
  assert.equal(reads, 2);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].length, REQUEST_BYTES);
  assert.ok(writes[1].every(byte => byte === 0));
  assert.ok(closed);
});
