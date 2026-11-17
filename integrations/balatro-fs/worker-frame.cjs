const crypto = require('node:crypto');
const profile = require('./sdk-profile.v1.0.1f.json');

const FRAME_BYTES = 0x2000;
const RESULT_OFFSET = 0x400;
const RESULT_SENTINEL = 0xfedcba9876543210n;
const FUNCTIONS = Object.freeze({
  longjmp: {offset: 0x5c4534, bytes: '135040a9155841a9176042a9196843a91b7044a91d7845a9023440f95f0000910824476d0a2c486d0c34496d0e3c4a6d3f00007120149f1ac0031fd6'},
  loadTable: {offset: 0x4bbc8, bytes: 'a80240f90041348bf44f42a9f50b40f9fd7bc3a8c0035fd6'},
  call4: {offset: 0x525874, bytes: 'e00319aae10318aae20314aae3031baa00013fd6880218cbed1340f96803088be80200f903000014fc0740f9ed1340f9a90118cbbf0114eb6903098beaa340390801899a880300f96a000036e01f40f9b7800294f44f4aa9f65749a9f85f48a9fa6747a9fc6f46a9fd7b45a9ffc30291c0035fd6'},
  saveResult64: {offset: 0x1922c0, bytes: '600200f9f30b40f9fd7bc2a8c0035fd6'},
  exitThread: {offset: 0x15f108, bytes: '410100d4c0035fd6'},
  tickFrequency: {offset: 0x12fc30, bytes: '00009f528024a072c0035fd6'},
  closeHandle: {offset: 0x15f1a0, bytes: 'c10200d4c0035fd6'},
  closeFile: {offset: 0xa2210, bytes: 'fd7bbea9f44f01a9fd030091f30300aa'},
});

function verifyImage(image) {
  if (!Buffer.isBuffer(image) || image.length !== profile.sdkCode.size ||
      crypto.createHash('sha256').update(image).digest('hex') !== profile.sdkCode.sha256) {
    throw Error('Balatro 1.0.1f SDK image does not match the pinned profile');
  }
  for (const [name, spec] of Object.entries(FUNCTIONS)) {
    const expected = Buffer.from(spec.bytes, 'hex');
    if (!image.subarray(spec.offset, spec.offset + expected.length).equals(expected)) {
      throw Error(`Balatro SDK worker function differs: ${name}`);
    }
  }
  return true;
}

function buildFrameLayout({base, sdk, functionOffset = FUNCTIONS.tickFrequency.offset}) {
  for (const [name, address] of Object.entries({base, sdk})) {
    if (!Number.isSafeInteger(address) || address <= 0 || address >= 2 ** 39 || address % 0x1000) {
      throw new RangeError(`${name} must be a page-aligned user address`);
    }
  }
  if (!Number.isSafeInteger(functionOffset) || functionOffset < 0 || functionOffset >= profile.sdkCode.size ||
      functionOffset % 4 || base + FRAME_BYTES >= 2 ** 39 || sdk + profile.sdkCode.size >= 2 ** 39) {
    throw new RangeError('worker frame or function is outside the pinned address range');
  }
  if (functionOffset !== FUNCTIONS.tickFrequency.offset) {
    throw new RangeError('only the read-only tick-frequency worker is prepared');
  }
  const frame = Buffer.alloc(FRAME_BYTES);
  const put = (offset, value) => frame.writeBigUInt64LE(BigInt(value), offset);
  const table = base + 0x300;
  const result = base + RESULT_OFFSET;
  const scratchA = base + 0x500;
  const scratchB = base + 0x508;
  const stack = base + 0x1000;

  put(0x10, table);
  put(0x20, scratchA);
  put(0x28, 0);
  put(0x30, 0);
  put(0x40, 0);
  put(0x48, scratchB);
  put(0x50, stack + 0x48);
  put(0x58, sdk + FUNCTIONS.loadTable.offset);
  put(0x68, stack);

  put(0x300, sdk + functionOffset);
  put(RESULT_OFFSET, RESULT_SENTINEL);

  put(0x1008, sdk + FUNCTIONS.call4.offset);
  put(0x1020, 0);
  put(0x1050, 0);
  put(0x1058, 0);
  put(0x1088, sdk + FUNCTIONS.saveResult64.offset);
  put(0x10d8, result);
  put(0x10e8, sdk + FUNCTIONS.exitThread.offset);

  return {frame, proof: {
    gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    base, sdk, functionOffset, bytes: FRAME_BYTES,
    resultOffset: RESULT_OFFSET,
    scratchOffsets: [0x500, 0x508],
    entryOffset: FUNCTIONS.longjmp.offset,
    status: 'offline native worker candidate; no live call, canary, or marker verified',
  }};
}

function buildVerifiedFrame({base, sdk, sdkImage}) {
  verifyImage(sdkImage);
  return buildFrameLayout({base, sdk});
}

// A one-call worker frame that runs the raw svcCloseHandle thunk (svc #0x16) with
// x0 = handle (masked to 32 bits), saves the raw result, then exits the thread.
// This is the x0-argument sibling of buildFrameLayout: the only differences are
// the table slot (closeHandle instead of tickFrequency) and x25 (frame+0x30), which
// call4 moves into x0. Using the raw thunk keeps the close non-throwing, so the
// raw svc result is surfaced instead of raising inside the worker.
function buildCloseLayout({base, sdk, handle}) {
  for (const [name, address] of Object.entries({base, sdk})) {
    if (!Number.isSafeInteger(address) || address <= 0 || address >= 2 ** 39 ||
        address % 0x1000) {
      throw new RangeError(`${name} must be a page-aligned user address`);
    }
  }
  if (!Number.isSafeInteger(handle) || handle < 0 || handle >= 0xffff8000 ||
      base + FRAME_BYTES >= 2 ** 39 || sdk + profile.sdkCode.size >= 2 ** 39) {
    throw new RangeError('worker close frame or handle is outside the pinned range');
  }
  const masked = handle & 0xffffffff;
  const frame = Buffer.alloc(FRAME_BYTES);
  const put = (offset, value) => frame.writeBigUInt64LE(BigInt(value), offset);
  const table = base + 0x300;
  const result = base + RESULT_OFFSET;
  const scratchA = base + 0x500;
  const scratchB = base + 0x508;
  const stack = base + 0x1000;

  put(0x10, table);
  put(0x20, scratchA);
  put(0x28, 0);
  put(0x30, masked);                       // x25 -> x0 in call4
  put(0x40, 0);
  put(0x48, scratchB);
  put(0x50, stack + 0x48);
  put(0x58, sdk + FUNCTIONS.loadTable.offset);
  put(0x68, stack);

  put(0x300, sdk + FUNCTIONS.closeHandle.offset);
  put(RESULT_OFFSET, RESULT_SENTINEL);

  put(0x1008, sdk + FUNCTIONS.call4.offset);
  put(0x1020, 0);
  put(0x1050, 0);
  put(0x1058, 0);
  put(0x1088, sdk + FUNCTIONS.saveResult64.offset);
  put(0x10d8, result);
  put(0x10e8, sdk + FUNCTIONS.exitThread.offset);

  return {frame, proof: {
    gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    base, sdk, handle: masked, bytes: FRAME_BYTES,
    resultOffset: RESULT_OFFSET,
    closeOffset: FUNCTIONS.closeHandle.offset,
    entryOffset: FUNCTIONS.longjmp.offset,
    status: 'offline close-worker candidate; svcCloseHandle on a worker thread unverified',
  }};
}

// A one-call worker frame that runs nn::fs::CloseFile (SDK 0xa2210) with
// x0 = handle — the full 64-bit FileAccessor* returned by nn::fs::OpenFile, so
// the handle is NOT masked to 32 bits. CloseFile tail-calls its cleanup
// (b 0x5c8d60), which still `ret`s through the preserved x30 back into the
// call4 gadget, so saveResult64 records x0 and exitThread ends the worker.
// CloseFile is void: the recorded x0 is informational, not a Result.
function buildCloseFileLayout({base, sdk, handle}) {
  for (const [name, address] of Object.entries({base, sdk})) {
    if (!Number.isSafeInteger(address) || address <= 0 || address >= 2 ** 39 ||
        address % 0x1000) {
      throw new RangeError(`${name} must be a page-aligned user address`);
    }
  }
  const value = typeof handle === 'bigint' ? handle : BigInt(handle);
  if (value <= 0n || value >= 1n << 39n ||
      base + FRAME_BYTES >= 2 ** 39 || sdk + profile.sdkCode.size >= 2 ** 39) {
    throw new RangeError('worker close-file frame or handle is outside the pinned range');
  }
  const frame = Buffer.alloc(FRAME_BYTES);
  const put = (offset, v) => frame.writeBigUInt64LE(BigInt(v), offset);
  const table = base + 0x300;
  const result = base + RESULT_OFFSET;
  const scratchA = base + 0x500;
  const scratchB = base + 0x508;
  const stack = base + 0x1000;

  put(0x10, table);
  put(0x20, scratchA);
  put(0x28, 0);
  put(0x30, value);                        // x25 -> x0 (64-bit FileAccessor*)
  put(0x40, 0);
  put(0x48, scratchB);
  put(0x50, stack + 0x48);
  put(0x58, sdk + FUNCTIONS.loadTable.offset);
  put(0x68, stack);

  put(0x300, sdk + FUNCTIONS.closeFile.offset);
  put(RESULT_OFFSET, RESULT_SENTINEL);

  put(0x1008, sdk + FUNCTIONS.call4.offset);
  put(0x1020, 0);
  put(0x1050, 0);
  put(0x1058, 0);
  put(0x1088, sdk + FUNCTIONS.saveResult64.offset);
  put(0x10d8, result);
  put(0x10e8, sdk + FUNCTIONS.exitThread.offset);

  return {frame, proof: {
    gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    base, sdk, handle: value, bytes: FRAME_BYTES,
    resultOffset: RESULT_OFFSET,
    closeOffset: FUNCTIONS.closeFile.offset,
    entryOffset: FUNCTIONS.longjmp.offset,
    status: 'offline close-file worker candidate; nn::fs::CloseFile on a worker thread unverified',
  }};
}

module.exports = {FRAME_BYTES, FUNCTIONS, RESULT_OFFSET, RESULT_SENTINEL,
  verifyImage, buildFrameLayout, buildCloseLayout, buildCloseFileLayout, buildVerifiedFrame};
