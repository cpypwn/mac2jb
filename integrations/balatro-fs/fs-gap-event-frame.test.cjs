'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {RESULT_SENTINEL} = require('./worker-frame.cjs');
const {TABLE_OFFSET, STACK_OFFSET, CALL_STRIDE} =
  require('./worker-chain.cjs');
const {ROLES, FRAME_BYTES, FRAME_BASE_OFFSET} =
  require('./fs-gap-port-layout.cjs');
const {FRAME_SPACING} = require('./fs-counter-overlap.cjs');
const {EVENT_OFFSET, CALLS, RESULT_OFFSETS,
  buildGapEventFrame} = require('./fs-gap-event-frame.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;

function layout() {
  const frameBase = arena + FRAME_BASE_OFFSET;
  return {workerKind: 'balatro-gap-13-layout-only',
    frameLayoutNonoverlapVerified: true,
    nativeFrameHandlesVerified: false,
    positiveAttemptAllowed: false,
    owner: {arenaBase: arena, arenaBytes: 0x200000, sdkBase: sdk,
      sdkCodeSha256: profile.sdkCode.sha256},
    scratch: {end: arena + 0x90000}, frameBase,
    frames: ROLES.map((role, index) => {
      const address = frameBase + index * FRAME_SPACING;
      return {role, index, address, end: address + FRAME_BYTES,
        packetAddress: address + 0x2000};
    })};
}

test('all 13 event-gated frames fit after fixed scratch with exact call arguments', () => {
  const plan = layout();
  const requests = ROLES.map((role, index) => {
    const packet = Buffer.alloc(256, index + 1);
    return buildGapEventFrame({layout: plan, role,
      handle: 300 + index, request: packet,
      delayNs: index * 150000});
  });
  assert.equal(requests.length, 13);
  assert.equal(requests.at(-1).address + FRAME_BYTES < arena + EVENT_OFFSET,
    true);
  assert.equal(requests.every(frame => frame.bytes.length === FRAME_BYTES),
    true);
  for (const frame of requests) {
    assert.equal(frame.gateAddress, arena + EVENT_OFFSET);
    assert.equal(frame.address, plan.frames[frame.index].address);
    assert.equal(frame.packetAddress, frame.address + 0x2000);
    assert.deepEqual(frame.bytes.subarray(0x2000, 0x2100),
      Buffer.alloc(256, frame.index + 1));
    assert.equal(frame.bytes.readBigUInt64LE(0x30),
      BigInt(frame.gateAddress));
    assert.equal(frame.bytes.readBigUInt64LE(STACK_OFFSET + 0x30 + 0x78),
      BigInt(frame.delayNs));
    const sendArgs = STACK_OFFSET + 0x30 + 2 * CALL_STRIDE;
    assert.equal(frame.bytes.readBigUInt64LE(sendArgs + 0x78),
      BigInt(frame.packetAddress));
    assert.equal(frame.bytes.readBigUInt64LE(sendArgs + 0x80), 4096n);
    assert.equal(frame.bytes.readBigUInt64LE(sendArgs + 0xf0),
      BigInt(frame.handle));
    CALLS.forEach((name, index) => assert.equal(
      frame.bytes.readBigUInt64LE(TABLE_OFFSET + index * 8),
      BigInt(sdk + profile.symbols[name].offset)));
    Object.values(RESULT_OFFSETS).forEach(offset => assert.equal(
      frame.bytes.readBigUInt64LE(offset), RESULT_SENTINEL));
    assert.equal(frame.sha256,
      createHash('sha256').update(frame.bytes).digest('hex'));
    assert.equal(frame.nativeEventFrameQualified, false);
    assert.equal(frame.markerHitVerified, false);
    assert.equal(frame.fsStageVerified, false);
  }
});

test('event frame refuses moved layout, unbounded delay, handle, or packet', () => {
  const plan = layout();
  const args = {layout: plan, role: 'canary', handle: 314,
    request: Buffer.alloc(256), delayNs: 150000};
  assert.throws(() => buildGapEventFrame({...args,
    layout: {...plan, positiveAttemptAllowed: true}}), /fresh event layout/);
  assert.throws(() => buildGapEventFrame({...args,
    layout: {...plan, scratch: {end: plan.frameBase + 1}}}),
  /event, frame, packet/);
  assert.throws(() => buildGapEventFrame({...args, handle: 0}),
    /event, frame, packet/);
  assert.throws(() => buildGapEventFrame({...args,
    request: Buffer.alloc(255)}), /event, frame, packet/);
  assert.throws(() => buildGapEventFrame({...args, delayNs: 5000001}),
    /event, frame, packet/);
  assert.throws(() => buildGapEventFrame({...args, role: 'unknown'}),
    /fresh event layout/);
});
