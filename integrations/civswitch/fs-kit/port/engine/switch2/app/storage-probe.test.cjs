const test = require('node:test');
const assert = require('node:assert/strict');
const {temporaryStorageInput, spacePacket} = require('./storage-probe-protocol.cjs');
const {probeStorage, querySpace} = require('./storage-probe-core.cjs');

test('temporary storage uses the libnx space and attribute layout', () => {
  const input = temporaryStorageInput();
  assert.equal(input.length, 0x48);
  assert.equal(input[0], 3);
  assert.equal(input[8 + 0x20], 4);
  assert.equal(input.filter(byte => byte !== 0).length, 2);
});

test('space request has one path descriptor and only read-only commands', () => {
  const bytes = spacePacket(12, 0x123456789);
  assert.equal(bytes.readUInt32LE(0), 4 | 1 << 16);
  assert.equal(bytes.readUInt32LE(8), 0x3010000 | 1 << 12);
  assert.equal(bytes.readUInt32LE(12), 0x23456789);
  assert.equal(bytes.toString('ascii', 16, 20), 'SFCI');
  assert.equal(bytes.readUInt32LE(24), 12);
  assert.throws(() => spacePacket(0, 0x123456789), /Invalid filesystem space request/);
});

test('space query reads a size without issuing a filesystem write', async () => {
  const writes = [];
  const reply = Buffer.alloc(256);
  reply.write('SFCO', 16);
  reply.writeBigInt64LE(0x300000n, 32);
  const session = {
    base: 0x10000000, handles: new Set(),
    write: async (address, bytes) => writes.push({address, bytes}),
    call: async (name, base, size, handle) => {
      assert.deepEqual([name, base, size, handle], ['send', 0x10000000, 4096, 15]);
      return 0;
    },
    readOwned: async () => reply,
  };
  assert.deepEqual(await querySpace(session, 15, 11),
    {result: 0, canonicalResult: 0, bytes: '3145728'});
  assert.equal(writes.length, 2);
  assert.equal(writes[0].bytes[0], 0x2f);
  assert.equal(writes[1].bytes.readUInt32LE(24), 11);
});

function mockSession(sdResult = 0) {
  const calls = [], closed = [], handles = new Set();
  return {
    calls, closed, handles,
    openService: async name => {
      calls.push(['service', name]);
      handles.add(10);
      return 10;
    },
    ipc: async (label, handle, command, data, options) => {
      calls.push(['ipc', label, handle, command, data, options]);
      if (command === 1) return {result: 0, canonicalResult: 0};
      if (command === 18 && sdResult)
        return {result: sdResult, canonicalResult: sdResult & 0x3fffff, moves: [], copies: []};
      const moved = command === 18 ? 11 : 12;
      handles.add(moved);
      return {result: 0, canonicalResult: 0, moves: [moved], copies: []};
    },
    close: async handle => {
      closed.push(handle);
      handles.delete(handle);
    },
  };
}

test('both storage handles are queried and closed', async () => {
  const session = mockSession();
  const spaceReader = async (_session, handle, command) =>
    ({result: 0, bytes: String(command === 12 ? 0x800000 : 0x400000), handle});
  const report = await probeStorage(session, {spaceReader});
  assert.deepEqual(report.storage.map(item => [item.name, item.verified]),
    [['sd', true], ['temporary', true]]);
  assert.deepEqual(session.closed, [11, 12, 10]);
  assert.deepEqual([...session.handles], []);
  assert.deepEqual(session.calls.filter(call => call[0] === 'ipc').map(call => call[3]), [1, 18, 51]);
  const temporary = session.calls.find(call => call[3] === 51);
  assert.deepEqual(temporary[4], temporaryStorageInput());
});

test('an unavailable SD filesystem does not prevent the temporary storage probe', async () => {
  const session = mockSession(0x402);
  const report = await probeStorage(session, {spaceReader: async (_session, _handle, command) =>
    ({result: 0, bytes: String(command === 12 ? 100 : 50)})});
  assert.equal(report.storage[0].openResult, 0x402);
  assert.equal(report.storage[1].verified, true);
  assert.deepEqual(session.closed, [12, 10]);
});
