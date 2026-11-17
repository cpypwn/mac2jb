const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {build, SENTINEL} = require('./worker-frame.cjs');
const {build: sharedBuild} = require('../civswitch/fs-kit/port/engine/shared/frames.cjs');
const {loadTarget} = require('../civswitch/fs-kit/port/engine/shared/target.cjs');
const worker = require('./sdk-worker-layout.v1.2.1.json');
const events = require('./sdk-event-code.v1.2.1.json');
const rawSvc = require('./sdk-raw-svc.v1.2.1.json');

const base = 0x400000000;
const sdk = 0x7100000000;
const code = worker.functions;
const options = {sdkBytes: worker.sdkCode.size, memcpyOffset: 0x100,
  exitOffset: 0x158a20};

function simulate(frame, proof, count, invoke) {
  const read = offset => frame.readBigUInt64LE(offset);
  const put = (address, value) => {
    const offset = Number(BigInt(address) - BigInt(base));
    assert.ok(offset >= 0 && offset + 8 <= frame.length);
    frame.writeBigUInt64LE(BigInt.asUintN(64, value), offset);
  };
  let sp = Number(read(0x68) - BigInt(base));
  let x21 = read(0x10), x20 = read(0x08), x23 = read(0x20);
  let x25 = read(0x30), x27 = read(0x40), x28 = read(0x48);
  let continuation = read(0x58);
  for (let index = 0; index < count; index++) {
    assert.equal(continuation, BigInt(sdk + code.loadTable.offset));
    const table = Number(x21 - BigInt(base));
    const x8 = read(table);
    assert.equal(x20, 0n);
    const next20 = read(sp + 0x20);
    const next21 = read(sp + 0x10);
    continuation = read(sp + 0x08);
    sp += 0x30;
    assert.equal(continuation, BigInt(sdk + code.call4.offset));
    x20 = next20; x21 = next21;
    assert.equal(read(sp + 0x10), 0n);
    assert.equal(frame.readUInt8(sp + 0x18), 0);
    assert.equal(x23, BigInt(base + sp + 0x20));
    assert.equal(x27, BigInt(base + sp + 0x28));
    const x0 = invoke(x8, [x25, x21, x20, x28], {put});
    put(x23, BigInt.asUintN(64, x28 + x20 - x21));
    put(x27, BigInt.asUintN(64, x28 - x21));
    const next28 = read(sp + 0x50), next27 = read(sp + 0x58);
    const next25 = read(sp + 0x68), next23 = read(sp + 0x78);
    const next21AfterCall = read(sp + 0x88);
    const x19 = read(sp + 0x98);
    continuation = read(sp + 0x48);
    sp += 0xa0;
    assert.equal(continuation, BigInt(sdk + code.saveResult64.offset));
    put(x19, x0);
    continuation = read(sp + 0x08);
    sp += 0x20;
    x28 = next28; x27 = next27; x25 = next25; x23 = next23;
    x21 = next21AfterCall; x20 = 0n;
  }
  assert.equal(continuation, BigInt(sdk + options.exitOffset));
  assert.equal(sp, proof.firstCallSpOffset + count * proof.callStride - 0x30);
}

test('Gravity Circuit captured worker and event signatures match their exact SDK bytes', t => {
  const profileDir = process.env.GC_PROFILE_DIR;
  const file = profileDir ? path.join(profileDir, 'sdk-v1.2.1-code.bin') : null;
  if (!file || !fs.existsSync(file)) {
    t.skip('set GC_PROFILE_DIR to the captured Gravity Circuit SDK dump directory');
    return;
  }
  const sdkCode = fs.readFileSync(file);
  assert.equal(sdkCode.length, worker.sdkCode.size);
  assert.equal(crypto.createHash('sha256').update(sdkCode).digest('hex'), worker.sdkCode.sha256);
  assert.equal(events.sdkCode.sha256, worker.sdkCode.sha256);
  assert.equal(rawSvc.sdkCode.sha256, worker.sdkCode.sha256);
  assert.equal(events.objectLayout.kind, 'nn::os::LightEventType');
  assert.equal(events.objectLayout.bytes, 8);
  assert.equal(rawSvc.waitTimeoutResult, 0xea01);
  for (const table of [worker, events, rawSvc]) {
    for (const [name, entry] of Object.entries(table.functions)) {
      const captured = sdkCode.subarray(entry.offset, entry.offset + entry.size);
      assert.equal(captured.toString('hex'), entry.bytes, name);
      assert.equal(crypto.createHash('sha256').update(captured).digest('hex'), entry.sha256, name);
    }
  }
});

test('Gravity Circuit frame dispatches two four-argument calls and stores full 64-bit results', () => {
  const calls = [
    {function: sdk + 0x400, args: [11, 22, 33, 44]},
    {function: sdk + 0x500, args: [55, 66, 77, 88]},
  ];
  const {frame, proof} = build(base, sdk, calls, code, options);
  assert.equal(proof.callStride, 0xf0);
  assert.equal(proof.nativeCalls, 2);
  assert.deepEqual(proof.logicalResultIndices, [0, 1]);
  for (const offset of proof.resultOffsets)
    assert.equal(frame.readBigUInt64LE(offset), SENTINEL);
  let called = 0;
  simulate(frame, proof, 2, (functionAddress, args) => {
    assert.equal(functionAddress, BigInt(calls[called].function));
    assert.deepEqual(args, calls[called].args.map(BigInt));
    return [0x123456789abcdef0n, 0xfedcba9876543210n][called++];
  });
  assert.equal(called, 2);
  assert.equal(frame.readBigUInt64LE(proof.resultOffsets[0]), 0x123456789abcdef0n);
  assert.equal(frame.readBigUInt64LE(proof.resultOffsets[1]), 0xfedcba9876543210n);
});

test('dynamic u32 loader writes the next call argument into the owned frame', () => {
  const source = 0x200000000;
  const {frame, proof} = build(base, sdk,
    [{function: sdk + 0x400, args: [{u32: source}, 2, 3, 4]}], code, options);
  assert.equal(proof.nativeCalls, 2);
  assert.deepEqual(proof.logicalResultIndices, [1]);
  const destination = base + proof.firstCallSpOffset + 0x68;
  assert.equal(frame.readBigUInt64LE(0x30), BigInt(destination));
  let called = 0;
  simulate(frame, proof, 2, (functionAddress, args, memory) => {
    if (called++ === 0) {
      assert.equal(functionAddress, BigInt(sdk + options.memcpyOffset));
      assert.deepEqual(args, [BigInt(destination), BigInt(source), 4n, 0n]);
      const at = Number(args[0] - BigInt(base));
      frame.writeUInt32LE(0x76543210, at);
      return args[0];
    }
    assert.equal(functionAddress, BigInt(sdk + 0x400));
    assert.deepEqual(args, [0x76543210n, 2n, 3n, 4n]);
    return 0x100000000n;
  });
  assert.equal(frame.readBigUInt64LE(proof.resultOffset), 0x100000000n);
});

test('Gravity Circuit frame rejects Civ7 gadget offsets and unsafe call targets', () => {
  const call = [{function: sdk + 0x400, args: [1, 2, 3, 4]}];
  assert.throws(() => build(base, sdk, call,
    {...code, call4: {offset: 0x338ee8}}, options), /measured SDK/);
  assert.throws(() => build(base, sdk,
    [{function: sdk + worker.sdkCode.size + 4, args: [1, 2, 3, 4]}], code, options),
  /outside the captured SDK/);
});

test('shared frame dispatcher selects Gravity Circuit only for an explicit raw thread lifecycle', () => {
  const target = loadTarget('gravcirc');
  const calls = [{function: sdk + 0x400, args: [1, 2, 3, 4]}];
  const workerCode = {...code, rawExitContinuation: {offset: options.exitOffset}};
  const unqualified = {...target, thread: {mode: null}};
  assert.throws(() => sharedBuild(base, sdk, calls, workerCode, false, unqualified),
    /lifecycle is not qualified/);
  const qualified = {...target, thread: {mode: 'raw-svc'}};
  const result = sharedBuild(base, sdk, calls, workerCode, false, qualified);
  assert.equal(result.frame.readBigUInt64LE(result.proof.tablesOffset), BigInt(calls[0].function));
  assert.equal(result.proof.callStride, 0xf0);
  assert.throws(() => sharedBuild(base, sdk, calls, workerCode, true, qualified),
    /lifecycle is not qualified/);
});
