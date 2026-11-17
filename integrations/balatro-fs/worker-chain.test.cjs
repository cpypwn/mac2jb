const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {FUNCTIONS, RESULT_SENTINEL} = require('./worker-frame.cjs');
const {MAX_CALLS, RESULT_OFFSET, SCRATCH_OFFSET, TABLE_OFFSET,
  STACK_OFFSET, CALL_STRIDE, buildChainLayout, buildVerifiedChain} = require('./worker-chain.cjs');

const BASE = 0x4cf2cf8000;
const SDK = 0x6005cb4000;
const imagePath = process.env.BALATRO_SDK_IMAGE ||
  (process.env.BALATRO_PROFILE_DIR ?
    path.join(process.env.BALATRO_PROFILE_DIR, 'sdk-1.0.1f-code.bin') : null);

test('Balatro read-only chain links each call through its own result and scratch cells', () => {
  const calls = ['systemTick', 'tickFrequency', 'systemTick'];
  const {frame, proof} = buildChainLayout({base: BASE, sdk: SDK, calls});
  const word = offset => frame.readBigUInt64LE(offset);
  assert.equal(proof.calls.join(','), calls.join(','));
  assert.equal(frame.length, 0x2000);
  assert.equal(word(0x10), BigInt(BASE + TABLE_OFFSET));
  assert.equal(word(0x20), BigInt(BASE + SCRATCH_OFFSET));
  assert.equal(word(0x48), BigInt(BASE + SCRATCH_OFFSET + 8));
  assert.equal(word(0x58), BigInt(SDK + FUNCTIONS.loadTable.offset));
  assert.equal(word(0x68), BigInt(BASE + STACK_OFFSET));
  assert.equal(word(STACK_OFFSET + 0x08), BigInt(SDK + FUNCTIONS.call4.offset));

  calls.forEach((call, index) => {
    const sp = STACK_OFFSET + 0x30 + index * CALL_STRIDE;
    const result = RESULT_OFFSET + index * 8;
    const functionOffset = profile.symbols[call === 'systemTick' ?
      'nn::os::GetSystemTick' : 'nn::os::GetSystemTickFrequency'].offset;
    assert.equal(word(TABLE_OFFSET + index * 8), BigInt(SDK + functionOffset));
    assert.equal(word(result), RESULT_SENTINEL);
    assert.equal(word(sp + 0x58), BigInt(SDK + FUNCTIONS.saveResult64.offset));
    assert.equal(word(sp + 0xa8), BigInt(BASE + result));
    assert.equal(word(sp + 0x20), 0n);
    assert.equal(word(sp + 0x28), 0n);
    if (index + 1 < calls.length) {
      const next = index + 1;
      assert.equal(word(sp + 0x60), BigInt(BASE + SCRATCH_OFFSET + next * 16 + 8));
      assert.equal(word(sp + 0x88), BigInt(BASE + SCRATCH_OFFSET + next * 16));
      assert.equal(word(sp + 0x98), BigInt(BASE + TABLE_OFFSET + next * 8));
      assert.equal(word(sp + 0xb8), BigInt(SDK + FUNCTIONS.loadTable.offset));
      assert.equal(word(sp + 0xd8), BigInt(SDK + FUNCTIONS.call4.offset));
      assert.equal(word(sp + 0xf0), 0n);
    } else {
      assert.equal(word(sp + 0xb8), BigInt(SDK + FUNCTIONS.exitThread.offset));
    }
  });
  assert.match(proof.status, /multi-call execution and FS marker unverified/);
});

test('Balatro gadget epilogues walk three calls and store each return independently', () => {
  const {frame} = buildChainLayout({base: BASE, sdk: SDK,
    calls: ['systemTick', 'tickFrequency', 'systemTick']});
  const read = address => frame.readBigUInt64LE(Number(address - BigInt(BASE)));
  const write = (address, value) => frame.writeBigUInt64LE(value, Number(address - BigInt(BASE)));
  const sdk = BigInt(SDK);
  const base = BigInt(BASE);
  const returns = [101n, 19200000n, 103n];
  let sp = read(base + 0x68n);
  let x20 = read(base + 0x08n);
  let x21 = read(base + 0x10n);
  let x23 = read(base + 0x20n);
  let x24 = read(base + 0x28n);
  let x25 = read(base + 0x30n);
  let x27 = read(base + 0x40n);
  let x28 = read(base + 0x48n);
  let pc = read(base + 0x58n);

  returns.forEach((value, index) => {
    assert.equal(pc, sdk + BigInt(FUNCTIONS.loadTable.offset));
    const target = read(x21) + (x20 & 0xffffffffn);
    x20 = read(sp + 0x20n);
    x21 = read(sp + 0x10n);
    pc = read(sp + 0x08n);
    sp += 0x30n;
    assert.equal(pc, sdk + BigInt(FUNCTIONS.call4.offset));
    assert.equal(target, sdk + BigInt(index === 1 ?
      profile.symbols['nn::os::GetSystemTickFrequency'].offset :
      profile.symbols['nn::os::GetSystemTick'].offset));
    assert.equal(x25, 0n);
    assert.equal(x24, 0n);
    assert.equal(x20, 0n);
    assert.equal(x27, 0n);
    const x13 = read(sp + 0x20n);
    assert.equal(read(sp + 0x28n), 0n);
    write(x23, x27 + x20 - x24);
    write(x28, x13 === x20 ? x27 + x20 - x24 : x27 + x13 - x24);
    x20 = read(sp + 0xa0n);
    const x19 = read(sp + 0xa8n);
    x21 = read(sp + 0x98n);
    x23 = read(sp + 0x88n);
    x24 = read(sp + 0x80n);
    x25 = read(sp + 0x78n);
    x27 = read(sp + 0x68n);
    x28 = read(sp + 0x60n);
    pc = read(sp + 0x58n);
    sp += 0xb0n;
    assert.equal(pc, sdk + BigInt(FUNCTIONS.saveResult64.offset));
    write(x19, value);
    pc = read(sp + 0x08n);
    sp += 0x20n;
  });
  assert.equal(pc, sdk + BigInt(FUNCTIONS.exitThread.offset));
  assert.deepEqual(returns.map((_, index) => read(base + BigInt(RESULT_OFFSET + index * 8))), returns);
});

test('read-only chain rejects mutation functions, unchecked addresses and oversized call lists', () => {
  assert.throws(() => buildChainLayout({base: BASE, sdk: SDK,
    calls: ['systemTick', 'CreateFile']}), /unsupported Balatro read-only call/);
  assert.throws(() => buildChainLayout({base: BASE, sdk: SDK,
    calls: ['systemTick']}), /needs 2-/);
  assert.throws(() => buildChainLayout({base: BASE, sdk: SDK,
    calls: Array(MAX_CALLS + 1).fill('systemTick')}), /needs 2-/);
  assert.throws(() => buildChainLayout({base: BASE + 8, sdk: SDK,
    calls: ['systemTick', 'systemTick']}), /page-aligned/);
  assert.throws(() => buildChainLayout({base: BASE, sdk: 2 ** 39,
    calls: ['systemTick', 'systemTick']}), /page-aligned/);
  assert.throws(() => buildChainLayout({base: 2 ** 39 - 0x1000, sdk: SDK,
    calls: ['systemTick', 'systemTick']}), /regions overlap or exceed/);
});

test('chain is pinned to the captured Balatro 1.0.1f SDK image',
  {skip: !imagePath || !fs.existsSync(imagePath)}, () => {
  const image = fs.readFileSync(imagePath);
  const {frame} = buildVerifiedChain({base: BASE, sdk: SDK,
    calls: ['systemTick', 'tickFrequency'], sdkImage: image});
  assert.equal(frame.length, 0x2000);
  const corrupt = Buffer.from(image);
  corrupt[profile.symbols['nn::os::GetSystemTick'].offset] ^= 1;
  assert.throws(() => buildVerifiedChain({base: BASE, sdk: SDK,
    calls: ['systemTick', 'tickFrequency'], sdkImage: corrupt}), /pinned profile/);
});
