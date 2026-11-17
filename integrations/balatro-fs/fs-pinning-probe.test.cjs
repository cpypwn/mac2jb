const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {createQualifiedContext, makeIpcPacket, parseOpenServiceReply,
  parseOpenStorageReply, makeCloseServicePacket} = require('./fs-counter-probe.cjs');
const {runPinningCycle} = require('./fs-pinning-probe.cjs');
const {validPinningResult} = require('./fs-pinning-live.cjs');

const nonce = '0123456789abcdef';
const arenaBase = '0x4964000000';
const sdkBase = '0x6005cb4000';
const output = BigInt(arenaBase) + 0x10000n + 0x4040n;

function context() {
  return createQualifiedContext({arenaBase, nonce,
    hello: {status: 'read-only transport handshake verified',
      scratch: `0x${(BigInt(arenaBase) + 0x10000n).toString(16)}`,
      scratchBytes: 0x80000, sdkBase,
      sdkCrc32: Number.parseInt(profile.sdkCode.offlineCrc32, 16)},
    crc: {gameProfile: profile.gameProfile, nonce, port: 39381, sdkBase,
      sdkCrc32: profile.sdkCode.offlineCrc32}});
}

function serviceReply(handle = 0x321) {
  const bytes = Buffer.alloc(0x8010);
  bytes.writeUInt32LE(handle, 16);
  return bytes;
}

function ipcReply(value = 0x5000) {
  const bytes = Buffer.alloc(0x8010);
  bytes.writeBigUInt64LE(output);
  bytes.writeUInt32LE(40, 20);
  bytes.write('SFCO', 32);
  for (let index = 0; index < 16; index++)
    bytes.writeBigUInt64LE(BigInt(index === 5 ? value : index * 4), 48 + index * 8);
  return bytes;
}

function storageReply(handle = 0x322) {
  const bytes = Buffer.alloc(0x8010);
  bytes.writeBigUInt64LE(output);
  bytes.writeUInt32LE(0x80000004, 20);
  bytes.writeUInt32LE(1 << 5, 24);
  bytes.writeUInt32LE(handle, 28);
  bytes.write('SFCO', 32);
  return bytes;
}

function exchange(ctx, events, change = {}) {
  return async (packet, phase) => {
    events.push(phase);
    assert.equal(packet.length, 0x8080);
    if (phase === 'open-fsp-srv') return serviceReply();
    if (phase === 'open-owned-content-storage') return change.storage || storageReply();
    if (phase.startsWith('close-')) return Buffer.alloc(0x8010);
    if (phase === 'initialize-fsp-srv') return ipcReply();
    if (phase.startsWith('baseline-')) return ipcReply(0x5000);
    if (phase.startsWith('held-')) return ipcReply(change.held ?? 0x4000);
    if (phase.startsWith('restored-')) return ipcReply(0x5000);
    throw Error(`unexpected phase ${phase}`);
  };
}

test('owned storage uses command 200 and refuses root handle alias', () => {
  const ctx = context();
  const root = parseOpenServiceReply(serviceReply(), ctx);
  const packet = makeIpcPacket(ctx, root, 'open-storage');
  assert.equal(packet.readBigUInt64LE(8) % 4096n, 0n);
  assert.equal(packet.readUInt32LE(0x1000 + 24), 200);
  const storage = parseOpenStorageReply(storageReply(), ctx, root);
  assert.equal(storage.handle, 0x322);
  assert.equal(storage.role, 'storage');
  assert.equal(makeCloseServicePacket(ctx, storage).readBigUInt64LE(8), 0x322n);
  assert.throws(() => makeIpcPacket(ctx, storage, 'counters'), /root handle/);
  assert.throws(() => parseOpenStorageReply(storageReply(root.handle), ctx, root),
    /one owned handle/);
});

test('one bounded cycle samples and closes storage before root', async () => {
  const ctx = context(), events = [];
  const result = await runPinningCycle({context: ctx, exchange: exchange(ctx, events)});
  assert.equal(result.assessment.verified, true);
  assert.equal(result.assessment.bytes, 0x1000);
  assert.equal(result.cleanup, 'released');
  assert.equal(validPinningResult(result), true);
  assert.deepEqual(events.slice(-2), ['restored-counters-3', 'close-fsp-srv']);
  assert.ok(events.indexOf('close-owned-content-storage') <
    events.indexOf('restored-counters-1'));
  assert.equal(events.filter(phase => phase.startsWith('open-owned-')).length, 1);
  assert.equal(events.filter(phase => phase.startsWith('close-owned-')).length, 1);
});

test('an unmatched cycle stops after one attempt with verified cleanup', async () => {
  const ctx = context(), events = [];
  const result = await runPinningCycle({context: ctx,
    exchange: exchange(ctx, events, {held: 0x5000})});
  assert.equal(result.assessment.verified, false);
  assert.match(result.status, /no retry/);
  assert.equal(events.filter(phase => phase === 'close-fsp-srv').length, 1);
});

test('held counter failure still closes both owned handles', async () => {
  const ctx = context(), events = [];
  const base = exchange(ctx, events);
  await assert.rejects(runPinningCycle({context: ctx, exchange: async (packet, phase) => {
    if (phase === 'held-counters-1') throw Error('held report failed');
    return base(packet, phase);
  }}), /held report failed/);
  assert.ok(events.includes('close-owned-content-storage'));
  assert.ok(events.includes('close-fsp-srv'));
});

test('storage close failure stops and still closes the root handle', async () => {
  const ctx = context(), events = [];
  const base = exchange(ctx, events);
  await assert.rejects(runPinningCycle({context: ctx, exchange: async (packet, phase) => {
    if (phase === 'close-owned-content-storage') {
      events.push(phase);
      const failed = Buffer.alloc(0x8010);
      failed.writeBigUInt64LE(1n, 8);
      return failed;
    }
    return base(packet, phase);
  }}), /handle close was not verified/);
  assert.ok(!events.includes('restored-counters-1'));
  assert.equal(events.filter(phase => phase === 'close-fsp-srv').length, 1);
});
