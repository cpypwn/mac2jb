const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {FRAME_BYTES, FUNCTIONS, RESULT_OFFSET, RESULT_SENTINEL,
  verifyImage, buildFrameLayout, buildCloseLayout, buildCloseFileLayout,
  buildVerifiedFrame} = require('./worker-frame.cjs');

const BASE = 0x4a144f8000;
const SDK = 0x19618b4000;
const imagePath = process.env.BALATRO_SDK_IMAGE ||
  (process.env.BALATRO_PROFILE_DIR ?
    path.join(process.env.BALATRO_PROFILE_DIR, 'sdk-1.0.1f-code.bin') : null);

test('the read-only worker frame follows the pinned Balatro 1.0.1f continuation', () => {
  const {frame, proof} = buildFrameLayout({base: BASE, sdk: SDK});
  const word = offset => frame.readBigUInt64LE(offset);
  assert.equal(frame.length, FRAME_BYTES);
  assert.equal(word(0x10), BigInt(BASE + 0x300));
  assert.equal(word(0x20), BigInt(BASE + 0x500));
  assert.equal(word(0x48), BigInt(BASE + 0x508));
  assert.equal(word(0x58), BigInt(SDK + FUNCTIONS.loadTable.offset));
  assert.equal(word(0x68), BigInt(BASE + 0x1000));
  assert.equal(word(0x300), BigInt(SDK + FUNCTIONS.tickFrequency.offset));
  assert.equal(word(RESULT_OFFSET), RESULT_SENTINEL);
  assert.equal(word(0x1008), BigInt(SDK + FUNCTIONS.call4.offset));
  assert.equal(word(0x1020), 0n);
  assert.equal(word(0x1050), 0n);
  assert.equal(word(0x1058), 0n);
  assert.equal(word(0x1088), BigInt(SDK + FUNCTIONS.saveResult64.offset));
  assert.equal(word(0x10d8), BigInt(BASE + RESULT_OFFSET));
  assert.equal(word(0x10e8), BigInt(SDK + FUNCTIONS.exitThread.offset));
  assert.equal(proof.entryOffset, FUNCTIONS.longjmp.offset);
  assert.match(proof.status, /no live call/);
});

test('the frame refuses other calls and unaligned or out-of-range addresses', () => {
  assert.throws(() => buildFrameLayout({base: BASE, sdk: SDK,
    functionOffset: profile.symbols['nn::fs::CreateFile'].offset}), /only the read-only/);
  assert.throws(() => buildFrameLayout({base: BASE + 8, sdk: SDK}), /page-aligned/);
  assert.throws(() => buildFrameLayout({base: BASE, sdk: 2 ** 39}), /page-aligned/);
});

test('the close frame routes x0 = masked handle into svcCloseHandle and saves the raw result', () => {
  const handle = 0x0000abcd;
  const {frame, proof} = buildCloseLayout({base: BASE, sdk: SDK, handle});
  const word = offset => frame.readBigUInt64LE(offset);
  assert.equal(frame.length, FRAME_BYTES);
  // x25 lives at frame+0x30 and becomes x0 inside the call4 gadget.
  assert.equal(word(0x30), BigInt(handle & 0xffffffff));
  assert.equal(word(0x10), BigInt(BASE + 0x300));
  assert.equal(word(0x20), BigInt(BASE + 0x500));
  assert.equal(word(0x48), BigInt(BASE + 0x508));
  assert.equal(word(0x58), BigInt(SDK + FUNCTIONS.loadTable.offset));
  assert.equal(word(0x68), BigInt(BASE + 0x1000));
  assert.equal(word(0x300), BigInt(SDK + FUNCTIONS.closeHandle.offset));
  assert.equal(word(RESULT_OFFSET), RESULT_SENTINEL);
  assert.equal(word(0x1008), BigInt(SDK + FUNCTIONS.call4.offset));
  assert.equal(word(0x1088), BigInt(SDK + FUNCTIONS.saveResult64.offset));
  assert.equal(word(0x10d8), BigInt(BASE + RESULT_OFFSET));
  assert.equal(word(0x10e8), BigInt(SDK + FUNCTIONS.exitThread.offset));
  assert.equal(proof.closeOffset, FUNCTIONS.closeHandle.offset);
  assert.equal(proof.handle, handle & 0xffffffff);
});

test('the close frame rejects oversized, unaligned, or negative handles', () => {
  assert.throws(() => buildCloseLayout({base: BASE, sdk: SDK, handle: 0xffff8000}), /handle/);
  assert.throws(() => buildCloseLayout({base: BASE, sdk: SDK, handle: -1}), /handle/);
  assert.throws(() => buildCloseLayout({base: BASE + 8, sdk: SDK, handle: 4}), /page-aligned/);
});

test('the close-file frame passes a 64-bit FileAccessor* unmasked into nn::fs::CloseFile', () => {
  const handle = 0x4a144f8777n;  // a full 64-bit pointer, above the 32-bit range
  const {frame, proof} = buildCloseFileLayout({base: BASE, sdk: SDK, handle});
  const word = offset => frame.readBigUInt64LE(offset);
  assert.equal(frame.length, FRAME_BYTES);
  // x25 (frame+0x30) must carry the full pointer, NOT masked to 32 bits.
  assert.equal(word(0x30), handle);
  assert.equal(word(0x300), BigInt(SDK + FUNCTIONS.closeFile.offset));
  assert.equal(word(0x58), BigInt(SDK + FUNCTIONS.loadTable.offset));
  assert.equal(word(0x68), BigInt(BASE + 0x1000));
  assert.equal(word(RESULT_OFFSET), RESULT_SENTINEL);
  assert.equal(word(0x1008), BigInt(SDK + FUNCTIONS.call4.offset));
  assert.equal(word(0x1088), BigInt(SDK + FUNCTIONS.saveResult64.offset));
  assert.equal(word(0x10d8), BigInt(BASE + RESULT_OFFSET));
  assert.equal(word(0x10e8), BigInt(SDK + FUNCTIONS.exitThread.offset));
  assert.equal(proof.closeOffset, FUNCTIONS.closeFile.offset);
  assert.equal(proof.handle, handle);
  // A number handle is normalized to BigInt; zero and out-of-range are rejected.
  assert.equal(buildCloseFileLayout({base: BASE, sdk: SDK, handle: 0x7777}).proof.handle, 0x7777n);
  assert.throws(() => buildCloseFileLayout({base: BASE, sdk: SDK, handle: 0n}), /handle/);
  assert.throws(() => buildCloseFileLayout({base: BASE, sdk: SDK, handle: 1n << 39n}), /handle/);
  assert.throws(() => buildCloseFileLayout({base: BASE + 8, sdk: SDK, handle: 0x7777n}), /page-aligned/);
});

test('the worker signatures match the pinned full SDK capture',
  {skip: !imagePath || !fs.existsSync(imagePath)}, () => {
  const image = fs.readFileSync(imagePath);
  assert.equal(crypto.createHash('sha256').update(image).digest('hex'), profile.sdkCode.sha256);
  assert.equal(verifyImage(image), true);
  const {frame} = buildVerifiedFrame({base: BASE, sdk: SDK, sdkImage: image});
  assert.equal(frame.length, FRAME_BYTES);
  const corrupt = Buffer.from(image);
  corrupt[FUNCTIONS.call4.offset + 20] ^= 1;
  assert.throws(() => verifyImage(corrupt), /pinned profile/);
});
