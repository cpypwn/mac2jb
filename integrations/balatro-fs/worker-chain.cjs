const {FUNCTIONS, RESULT_SENTINEL, verifyImage} = require('./worker-frame.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const PAGE = 0x1000;
const MAX_CALLS = 16;
const RESULT_OFFSET = 0x400;
const SCRATCH_OFFSET = 0x500;
const TABLE_OFFSET = 0x800;
const STACK_OFFSET = 0x1000;
const CALL_STRIDE = 0x100;
const READ_ONLY = Object.freeze({
  systemTick: profile.symbols['nn::os::GetSystemTick'],
  tickFrequency: profile.symbols['nn::os::GetSystemTickFrequency'],
});

function buildChainLayout({base, sdk, calls}) {
  for (const [name, address] of Object.entries({base, sdk})) {
    if (!Number.isSafeInteger(address) || address <= 0 || address % PAGE || address >= 2 ** 39) {
      throw new RangeError(`${name} must be a page-aligned user address`);
    }
  }
  if (!Array.isArray(calls) || calls.length < 2 || calls.length > MAX_CALLS ||
      sdk + profile.sdkCode.size >= 2 ** 39) {
    throw new RangeError(`Balatro read-only chain needs 2-${MAX_CALLS} calls`);
  }
  const selected = calls.map(name => {
    const symbol = READ_ONLY[name];
    if (!Object.hasOwn(READ_ONLY, name) || !symbol ||
        !Number.isSafeInteger(symbol.offset) || symbol.offset % 4 ||
        symbol.offset < 0 || symbol.offset >= profile.sdkCode.size) {
      throw new RangeError(`unsupported Balatro read-only call: ${String(name)}`);
    }
    return {name, offset: symbol.offset};
  });
  const lastStackWord = STACK_OFFSET + 0x30 + (calls.length - 1) * CALL_STRIDE + 0xc0;
  const bytes = Math.ceil((lastStackWord + 8) / PAGE) * PAGE;
  if (base + bytes >= 2 ** 39 ||
      RESULT_OFFSET + calls.length * 8 > SCRATCH_OFFSET ||
      SCRATCH_OFFSET + calls.length * 16 > TABLE_OFFSET ||
      TABLE_OFFSET + calls.length * 8 > STACK_OFFSET ||
      bytes > 0x3000) {
    throw new RangeError('Balatro read-only chain regions overlap or exceed the arena');
  }

  const frame = Buffer.alloc(bytes);
  const put = (offset, value) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new RangeError('Balatro worker pointer is not an exact integer');
    }
    frame.writeBigUInt64LE(BigInt(value), offset);
  };
  const stack = STACK_OFFSET;
  put(0x10, base + TABLE_OFFSET);
  put(0x20, base + SCRATCH_OFFSET);
  put(0x48, base + SCRATCH_OFFSET + 8);
  put(0x50, base + stack + 0x48);
  put(0x58, sdk + FUNCTIONS.loadTable.offset);
  put(0x68, base + stack);
  put(stack + 0x08, sdk + FUNCTIONS.call4.offset);
  put(stack + 0x20, 0);

  selected.forEach((call, index) => {
    const sp = stack + 0x30 + index * CALL_STRIDE;
    const result = RESULT_OFFSET + index * 8;
    put(TABLE_OFFSET + index * 8, sdk + call.offset);
    put(result, RESULT_SENTINEL);
    put(sp + 0x20, 0);
    put(sp + 0x28, 0);
    put(sp + 0x58, sdk + FUNCTIONS.saveResult64.offset);
    put(sp + 0xa8, base + result);
    if (index + 1 < selected.length) {
      const next = index + 1;
      put(sp + 0x60, base + SCRATCH_OFFSET + next * 16 + 8);
      put(sp + 0x68, 0);
      put(sp + 0x78, 0);
      put(sp + 0x80, 0);
      put(sp + 0x88, base + SCRATCH_OFFSET + next * 16);
      put(sp + 0x98, base + TABLE_OFFSET + next * 8);
      put(sp + 0xa0, 0);
      put(sp + 0xb8, sdk + FUNCTIONS.loadTable.offset);
      put(sp + 0xd8, sdk + FUNCTIONS.call4.offset);
      put(sp + 0xf0, 0);
    } else {
      put(sp + 0xb8, sdk + FUNCTIONS.exitThread.offset);
    }
  });

  return {frame, proof: {
    gameProfile: profile.gameProfile,
    sdkCodeSha256: profile.sdkCode.sha256,
    base, sdk, bytes,
    calls: selected.map(call => call.name),
    resultOffsets: selected.map((_, index) => RESULT_OFFSET + index * 8),
    scratchOffsets: selected.map((_, index) =>
      [SCRATCH_OFFSET + index * 16, SCRATCH_OFFSET + index * 16 + 8]),
    tableOffset: TABLE_OFFSET,
    stackOffset: STACK_OFFSET,
    callStride: CALL_STRIDE,
    entryOffset: FUNCTIONS.longjmp.offset,
    status: 'offline read-only chain candidate; multi-call execution and FS marker unverified',
  }};
}

function buildVerifiedChain({base, sdk, calls, sdkImage}) {
  verifyImage(sdkImage);
  for (const name of calls) {
    const symbol = READ_ONLY[name];
    if (!symbol) throw new RangeError(`unsupported Balatro read-only call: ${String(name)}`);
    const expected = Buffer.from(symbol.bytes, 'hex');
    if (!sdkImage.subarray(symbol.offset, symbol.offset + expected.length).equals(expected)) {
      throw new Error(`Balatro SDK read-only function differs: ${name}`);
    }
  }
  return buildChainLayout({base, sdk, calls});
}

module.exports = {PAGE, MAX_CALLS, RESULT_OFFSET, SCRATCH_OFFSET, TABLE_OFFSET,
  STACK_OFFSET, CALL_STRIDE, READ_ONLY, buildChainLayout, buildVerifiedChain};
