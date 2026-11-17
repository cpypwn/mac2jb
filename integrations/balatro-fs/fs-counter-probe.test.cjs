const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {
  REQUEST_BYTES, RESPONSE_BYTES, COUNTER_COUNT, GENERAL_HEAP_INDEX,
  createQualifiedContext, makeOpenServicePacket, parseOpenServiceReply,
  makeIpcPacket, parseIpcReply, makeCloseServicePacket, parseCloseServiceReply,
  sampleStableCounters, assessPinning, runCounterPreflight,
} = require('./fs-counter-probe.cjs');

const arenaBase = '0x4cf2cf8000';
const scratch = `0x${(BigInt(arenaBase) + 0x10000n).toString(16)}`;
const sdkBase = '0x6005cb4000';
const nonce = 'bafb9ee55e2770bb';
const hello = {status: 'read-only transport handshake verified', scratch,
  scratchBytes: 0x80000, sdkBase,
  sdkCrc32: Number.parseInt(profile.sdkCode.offlineCrc32, 16)};
const crc = {gameProfile: profile.gameProfile, nonce, port: 39381,
  sdkBase, sdkCrc32: profile.sdkCode.offlineCrc32};

function context() {
  return createQualifiedContext({arenaBase, hello, crc, nonce});
}

function serviceReply(handle = 0x321) {
  const bytes = Buffer.alloc(RESPONSE_BYTES);
  bytes.writeUInt32LE(handle, 16);
  return bytes;
}

function ipcReply(ctx, {result = 0, counters, words = 40} = {}) {
  const bytes = Buffer.alloc(RESPONSE_BYTES);
  bytes.writeBigUInt64LE(ctx.scratch + 0x4040n);
  bytes.writeUInt32LE(words, 20);
  bytes.write('SFCO', 32);
  bytes.writeUInt32LE(result, 40);
  if (counters) counters.forEach((value, index) =>
    bytes.writeBigUInt64LE(BigInt(value), 48 + index * 8));
  return bytes;
}

function values(generalHeap = 0x12345) {
  return Array.from({length: COUNTER_COUNT}, (_, index) =>
    index === GENERAL_HEAP_INDEX ? generalHeap : index * 4);
}

test('counter context is tied to a live CRC, exact arena and pinned target', () => {
  const ctx = context();
  assert.equal(ctx.scratch, BigInt(scratch));
  assert.equal(ctx.sdk, BigInt(sdkBase));
  assert.throws(() => createQualifiedContext({arenaBase, hello,
    crc: {...crc, sdkCrc32: '0x0'}, nonce}), /live SDK CRC/);
  assert.throws(() => createQualifiedContext({arenaBase, hello,
    crc: {...crc, nonce: '0000000000000000'}, nonce}), /live SDK CRC/);
  assert.throws(() => createQualifiedContext({arenaBase, hello:
    {...hello, scratch: '0x4000'}, crc, nonce}), /verified arena/);
  assert.throws(() => createQualifiedContext({arenaBase, hello,
    crc, nonce, port: 39380}), /transport port/);
});

test('service open uses only pinned SDK entry and owned scratch addresses', () => {
  const ctx = context();
  const bytes = makeOpenServicePacket(ctx);
  assert.equal(bytes.length, REQUEST_BYTES);
  assert.equal(bytes.readBigUInt64LE(0),
    ctx.sdk + BigInt(profile.symbols['nn::sm::GetServiceHandle'].offset));
  assert.equal(bytes.readBigUInt64LE(8), ctx.scratch + 0x4040n);
  assert.equal(bytes.readBigUInt64LE(16), ctx.scratch + 0x40080n);
  assert.equal(bytes.readBigUInt64LE(24), 7n);
  assert.equal(bytes.readBigUInt64LE(0x28), 0n);
  assert.equal(bytes.toString('ascii', 0x80, 0x88), 'fsp-srv\0');
  assert.ok(bytes.subarray(0x88).every(byte => byte === 0));
});

test('service handle must come from the current reply and closes once', () => {
  const ctx = context();
  const service = parseOpenServiceReply(serviceReply(), ctx);
  const other = context();
  assert.throws(() => makeIpcPacket(other, service, 'counters'), /owned, open/);
  assert.throws(() => parseOpenServiceReply(serviceReply(0), ctx), /not verified/);
  assert.throws(() => parseOpenServiceReply(serviceReply(0xffff8000), ctx), /not verified/);
  const close = makeCloseServicePacket(ctx, service);
  assert.equal(close.readBigUInt64LE(0),
    ctx.sdk + BigInt(profile.symbols.svcCloseHandle.offset));
  assert.equal(close.readBigUInt64LE(8), 0x321n);
  assert.equal(parseCloseServiceReply(Buffer.alloc(RESPONSE_BYTES), ctx, service).closed, true);
  assert.throws(() => makeCloseServicePacket(ctx, service), /owned, open/);
});

test('IPC packets are restricted to root initialization and read-only counters', () => {
  const ctx = context();
  const service = parseOpenServiceReply(serviceReply(), ctx);
  const init = makeIpcPacket(ctx, service, 'initialize');
  const counters = makeIpcPacket(ctx, service, 'counters');
  for (const bytes of [init, counters]) {
    assert.equal(bytes.length, REQUEST_BYTES);
    assert.equal(bytes.readBigUInt64LE(0),
      ctx.sdk + BigInt(profile.symbols.svcSend.offset));
    assert.equal(bytes.readBigUInt64LE(8), ctx.scratch + 0x41000n);
    assert.equal(bytes.readBigUInt64LE(8) % 4096n, 0n);
    assert.equal(bytes.readBigUInt64LE(16), 4096n);
    assert.equal(bytes.readBigUInt64LE(24), 0x321n);
    assert.equal(bytes.readBigUInt64LE(0x28),
      ctx.sdk + BigInt(profile.symbols.memmove.offset));
    assert.equal(bytes.readBigUInt64LE(0x30), ctx.scratch + 0x4040n);
    assert.equal(bytes.readBigUInt64LE(0x38), ctx.scratch + 0x41000n);
    assert.equal(bytes.readBigUInt64LE(0x40), 256n);
    assert.ok(bytes.subarray(0x80, 0x1000).every(byte => byte === 0));
  }
  assert.equal(init.readUInt32LE(0x1000 + 40), 1);
  assert.equal(counters.readUInt32LE(0x1000 + 24), 1009);
  assert.throws(() => makeIpcPacket(ctx, service, 200), /only supports/);
});

test('counter reply requires successful native copy, CMIF response and 16 counters', () => {
  const ctx = context();
  assert.deepEqual(parseIpcReply(ipcReply(ctx, {counters: values()}), ctx, 'counters'),
    values());
  assert.deepEqual(parseIpcReply(ipcReply(ctx), ctx, 'initialize'),
    {initialized: true});
  const wrongPointer = ipcReply(ctx, {counters: values()});
  wrongPointer.writeBigUInt64LE(0n);
  assert.throws(() => parseIpcReply(wrongPointer, ctx, 'counters'), /did not complete/);
  const short = ipcReply(ctx, {counters: values(), words: 8});
  assert.throws(() => parseIpcReply(short, ctx, 'counters'), /data words/);
  const error = ipcReply(ctx, {result: 0x202, counters: values()});
  assert.throws(() => parseIpcReply(error, ctx, 'counters'), /unsuccessful/);
  const noSfco = ipcReply(ctx, {counters: values()});
  noSfco.writeUInt32LE(0, 32);
  assert.throws(() => parseIpcReply(noSfco, ctx, 'counters'), /SFCO/);
  const tooLarge = values();
  tooLarge[GENERAL_HEAP_INDEX] = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  assert.throws(() => parseIpcReply(ipcReply(ctx, {counters: tooLarge}), ctx,
    'counters'), /safe integer/);
});

test('bounded stable sampling records jitter and rejects non-stabilizing heap', async () => {
  const inputs = [values(100), values(99), values(98), values(98), values(98)];
  const stable = await sampleStableCounters(async () => inputs.shift());
  assert.equal(stable.reads, 5);
  assert.deepEqual(stable.observedGeneralHeap, [100, 99, 98, 98, 98]);
  assert.deepEqual(stable.samples.map(row => row[GENERAL_HEAP_INDEX]), [98, 98]);
  await assert.rejects(() => sampleStableCounters(async index => values(index), 3),
    error => error.code === 'UNSTABLE_COUNTERS' &&
      error.observedGeneralHeap.length === 3);
  await assert.rejects(() => sampleStableCounters(async () => [1, 2, 3]),
    /incomplete/);
});

test('pinning assessment needs stable held and restored snapshots', () => {
  const before = [values(0x5000), values(0x5000)];
  const held = [values(0x4000), values(0x4000)];
  const after = [values(0x5000), values(0x5000)];
  assert.deepEqual(assessPinning(before, held, after),
    {bytes: 0x1000, restoration: 0, stability: {before: 0, held: 0, after: 0},
      verified: true});
  assert.equal(assessPinning(before, [values(0x4001), held[1]], after).verified,
    false);
  assert.equal(assessPinning(before, held, [values(0x5001), values(0x5001)]).verified,
    false);
});

test('offline counter preflight opens, samples, and closes the owned service', async () => {
  const ctx = context();
  const steps = [];
  const result = await runCounterPreflight({context: ctx, exchange: async (bytes, step) => {
    steps.push(step);
    assert.equal(bytes.length, REQUEST_BYTES);
    if (step === 'open-fsp-srv') return serviceReply();
    if (step === 'close-fsp-srv') return Buffer.alloc(RESPONSE_BYTES);
    return ipcReply(ctx, {counters: values()});
  }});
  assert.deepEqual(steps, ['open-fsp-srv', 'initialize-fsp-srv',
    'allocation-counters-1', 'allocation-counters-2',
    'allocation-counters-3', 'close-fsp-srv']);
  assert.equal(result.cleanup, 'released');
  assert.equal(result.reads, 3);
  assert.match(result.status, /canary unverified/);
});

test('offline counter preflight attempts one close after a failed read', async () => {
  const ctx = context();
  const steps = [];
  await assert.rejects(() => runCounterPreflight({context: ctx,
    exchange: async (_bytes, step) => {
      steps.push(step);
      if (step === 'open-fsp-srv') return serviceReply();
      if (step === 'allocation-counters-1') throw Error('read failed');
      if (step === 'close-fsp-srv') return Buffer.alloc(RESPONSE_BYTES);
      return ipcReply(ctx);
    }}), /read failed/);
  assert.deepEqual(steps, ['open-fsp-srv', 'initialize-fsp-srv',
    'allocation-counters-1', 'close-fsp-srv']);
});
