const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {createQualifiedContext, makeTickPacket, parseTickReply} =
  require('./fs-counter-probe.cjs');
const {CALIBRATION_MS, assessClock, assessEventOrder,
  runNativeOrderControl} = require('./fs-native-order-control.cjs');
const {validNativeOrderResult} = require('./fs-native-order-live.cjs');

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

function nativeReply(first, second = 0n) {
  const bytes = Buffer.alloc(0x8010);
  bytes.writeBigUInt64LE(BigInt(second), 0);
  bytes.writeBigUInt64LE(BigInt(first), 8);
  return bytes;
}

function counterReply(value) {
  const bytes = nativeReply(0n, output);
  bytes.writeUInt32LE(40, 20);
  bytes.write('SFCO', 32);
  for (let index = 0; index < 16; index++) {
    bytes.writeBigUInt64LE(BigInt(index === 5 ? value : index * 4),
      48 + index * 8);
  }
  return bytes;
}

function storageReply(handle = 0x322) {
  const bytes = nativeReply(0n, output);
  bytes.writeUInt32LE(0x80000004, 20);
  bytes.writeUInt32LE(1 << 5, 24);
  bytes.writeUInt32LE(handle, 28);
  bytes.write('SFCO', 32);
  return bytes;
}

function fixture(overrides = {}) {
  const events = [];
  let time = 1000;
  const values = {before: 100000, noStorageBefore: 100000,
    oneHeld: 85904, noStorageHeld: 85904,
    after: 100000, noStorageAfter: 100000, ...overrides};
  const now = () => ++time;
  const wait = async ms => {time += ms;};
  const exchange = async (packet, phase) => {
    events.push(phase);
    assert.equal(packet.length, 0x8080);
    if (phase.includes('tick') || phase.startsWith('clock-') ||
        phase.startsWith('no-storage-')) {
      return nativeReply(BigInt(time * 19200), 19200000n);
    }
    if (phase === 'open-fsp-srv') {
      const bytes = nativeReply(0n);
      bytes.writeUInt32LE(0x321, 16);
      return bytes;
    }
    if (phase === 'open-owned-storage') return storageReply();
    if (phase === 'initialize-fsp-srv') return counterReply(values.before);
    if (phase === 'close-owned-storage' || phase.startsWith('cleanup-') ||
        phase === 'close-fsp-srv') return nativeReply(0n);
    const label = phase.replace(/-\d+$/, '');
    assert.ok(Object.hasOwn(values, label), `unexpected phase ${phase}`);
    return counterReply(values[label]);
  };
  return {events, now, wait, exchange};
}

test('native tick packet calls the pinned tick and frequency functions', () => {
  const packet = makeTickPacket(context());
  assert.equal(packet.readBigUInt64LE(0), BigInt(sdkBase) +
    BigInt(profile.symbols['nn::os::GetSystemTick'].offset));
  assert.equal(packet.readBigUInt64LE(0x28), BigInt(sdkBase) +
    BigInt(profile.symbols['nn::os::GetSystemTickFrequency'].offset));
  assert.equal(parseTickReply(nativeReply(123n, 19200000n)), 123n);
  assert.throws(() => parseTickReply(nativeReply(123n, 19000000n)), /frequency/);
});

test('bounded native control matches no-storage phases and restores service state', async () => {
  const fake = fixture();
  const result = await runNativeOrderControl({context: context(),
    ...fake});
  assert.equal(result.cleanup, 'released');
  assert.equal(result.clock.nativeCounterFrequencyVerified, true);
  assert.equal(result.assessment.candidateDiagnosticCostBytes, 14096);
  assert.equal(result.assessment.exactAllocationBytes, null);
  assert.equal(result.assessment.pinAddress, null);
  assert.equal(result.assessment.concurrentOverlapMeasured, false);
  assert.equal(result.assessment.serialReceiveOrderVerified, true);
  assert.equal(result.markerAttempted, false);
  assert.equal(result.saveWrites, 0);
  assert.equal(validNativeOrderResult(result), true);
  assert.deepEqual(fake.events.filter(name => name === 'close-owned-storage' ||
    name === 'close-fsp-srv'), ['close-owned-storage', 'close-fsp-srv']);
  assert.equal(fake.events.filter(name => /^(before|noStorageBefore|oneHeld|noStorageHeld|after|noStorageAfter)-\d+$/.test(name)).length,
    18);
});

test('native clock rejects a nonadvancing counter and implausible frequency', () => {
  const first = {tick: '1000000', hostStartMs: 0, hostEndMs: 1};
  const second = {tick: '1000000', hostStartMs: CALIBRATION_MS + 1,
    hostEndMs: CALIBRATION_MS + 2};
  assert.throws(() => assessClock(first, second), /counter/);
  assert.throws(() => assessClock(first, {...second, tick: '1000100'}), /counter/);
});

test('receive-order assessment rejects reversed native intervals', () => {
  const roles = ['no-storage-before', 'open-owned-storage',
    'no-storage-held', 'close-owned-storage', 'no-storage-after'];
  const rows = roles.map((role, index) => ({role,
    startTick: String(100 + index * 20), endTick: String(110 + index * 20),
    hostSendMs: index * 2, hostReceiveMs: index * 2 + 1}));
  assert.equal(assessEventOrder(rows).serialReceiveOrderVerified, true);
  rows[2].startTick = rows[1].startTick;
  assert.throws(() => assessEventOrder(rows), /order changed/);
});

test('held no-storage drift stops and still closes both owned handles', async () => {
  const fake = fixture({noStorageHeld: 85800});
  await assert.rejects(runNativeOrderControl({context: context(), ...fake}),
    /held-storage no-storage control drifted/);
  assert.ok(fake.events.includes('cleanup-owned-storage'));
  assert.ok(fake.events.includes('close-fsp-srv'));
  assert.equal(fake.events.includes('close-owned-storage'), false);
  assert.equal(fake.events.some(name => name.startsWith('after-')), false);
});

test('baseline drift stops before opening a storage handle', async () => {
  const fake = fixture({noStorageBefore: 99900});
  await assert.rejects(runNativeOrderControl({context: context(), ...fake}),
    /baseline no-storage control drifted/);
  assert.equal(fake.events.includes('open-owned-storage'), false);
  assert.ok(fake.events.includes('close-fsp-srv'));
});

test('a close failure is not retried and reports unverified cleanup', async () => {
  const fake = fixture();
  const exchange = async (packet, phase) => {
    if (phase === 'close-owned-storage') {
      fake.events.push(phase);
      return nativeReply(1n);
    }
    return fake.exchange(packet, phase);
  };
  await assert.rejects(runNativeOrderControl({context: context(),
    exchange, now: fake.now, wait: fake.wait}),
  /did not verify handle cleanup/);
  assert.equal(fake.events.filter(name => name === 'close-owned-storage').length, 1);
  assert.ok(fake.events.includes('close-fsp-srv'));
});
