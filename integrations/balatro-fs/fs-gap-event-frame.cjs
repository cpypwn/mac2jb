'use strict';

// One event-gated native frame for a verified owner layout. The layout can
// describe a single smoke role, four protected negative roles, or 13 gap roles.
// This builds an app-side call chain only; it does not start a worker or
// establish FS heap placement, a path alias, or an FS memory stage.
const {createHash} = require('node:crypto');
const profile = require('./sdk-profile.v1.0.1f.json');
const {RESULT_SENTINEL} = require('./worker-frame.cjs');
const {buildChainLayout, RESULT_OFFSET, TABLE_OFFSET, STACK_OFFSET,
  CALL_STRIDE} = require('./worker-chain.cjs');
const {PACKET_OFFSET, PACKET_BYTES, SERVICE_HANDLE_OFFSET} =
  require('./fs-counter-overlap.cjs');
const {ROLES, OWNER_BYTES, FRAME_BYTES} =
  require('./fs-gap-port-layout.cjs');
const {WORKER_KIND: PROTECTED_LAYOUT_KIND,
  ROLES: PROTECTED_ROLES} = require('./fs-protected-event-layout.cjs');

const EVENT_OFFSET = 0x180000;
const MAX_DELAY_NS = 5000000;
const CALLS = Object.freeze(['nn::os::WaitLightEvent',
  'nn::os::SleepThread', 'nn::os::GetSystemTick', 'svcSend',
  'nn::os::GetSystemTick']);
const RESULT_OFFSETS = Object.freeze({wait: RESULT_OFFSET,
  sleep: RESULT_OFFSET + 8, startTick: RESULT_OFFSET + 16,
  transportResult: RESULT_OFFSET + 24,
  endTick: RESULT_OFFSET + 32});

function check(value, reason) {
  if (!value) throw Error(`Balatro gap event frame: ${reason}`);
}

function symbol(name) {
  const value = profile.symbols[name];
  check(value && Number.isSafeInteger(value.offset) &&
    value.offset >= 0 && value.offset < profile.sdkCode.size &&
    value.offset % 4 === 0 &&
    /^[0-9a-f]{8,}$/.test(value.bytes || ''),
  `${name} is absent from the pinned SDK`);
  return value;
}

function buildGapEventFrame({layout, role, handle, request, delayNs = 0}) {
  const roles = layout?.workerKind === PROTECTED_LAYOUT_KIND ?
    PROTECTED_ROLES : ROLES;
  check(['balatro-gap-13-layout-only', PROTECTED_LAYOUT_KIND]
    .includes(layout?.workerKind) &&
    layout.frameLayoutNonoverlapVerified === true &&
    layout.nativeFrameHandlesVerified === false &&
    layout.positiveAttemptAllowed === false &&
    layout.owner?.sdkCodeSha256 === profile.sdkCode.sha256 &&
    layout.owner.arenaBytes === OWNER_BYTES &&
    Array.isArray(layout.frames) && layout.frames.length === roles.length &&
    roles.includes(role),
  'fresh event layout and exact role are required');
  const frame = layout.frames[roles.indexOf(role)];
  const arena = layout.owner.arenaBase;
  const sdk = layout.owner.sdkBase;
  const gateAddress = arena + EVENT_OFFSET;
  check(frame?.role === role &&
    Number.isSafeInteger(frame.address) &&
    frame.address % 0x1000 === 0 &&
    frame.end === frame.address + FRAME_BYTES &&
    frame.address >= layout.frameBase &&
    frame.end <= arena + OWNER_BYTES &&
    gateAddress % 8 === 0 &&
    gateAddress + 8 < arena + OWNER_BYTES &&
    gateAddress >= layout.frames.at(-1).end &&
    layout.scratch?.end <= layout.frameBase &&
    Number.isInteger(handle) && handle > 0 && handle < 0xffff8000 &&
    Buffer.isBuffer(request) && request.length === 256 &&
    Number.isInteger(delayNs) && delayNs >= 0 &&
    delayNs <= MAX_DELAY_NS &&
    SERVICE_HANDLE_OFFSET === STACK_OFFSET + 0x30 +
      CALL_STRIDE - 0x10,
  'event, frame, packet, handle, or bounded delay changed');
  const chain = buildChainLayout({base: frame.address, sdk,
    calls: Array(CALLS.length).fill('systemTick')}).frame;
  check(chain.length === PACKET_OFFSET &&
    PACKET_OFFSET + PACKET_BYTES === FRAME_BYTES,
  'verified chain no longer fits the gap frame');
  const bytes = Buffer.alloc(FRAME_BYTES);
  chain.copy(bytes);
  CALLS.forEach((name, index) => {
    const entry = symbol(name);
    bytes.writeBigUInt64LE(BigInt(sdk + entry.offset),
      TABLE_OFFSET + index * 8);
  });
  // The first call receives x25 from the longjmp frame at +0x30. Each
  // following call receives its x0/x1/x2 arguments from the prior stack slot.
  bytes.writeBigUInt64LE(BigInt(gateAddress), 0x30);
  const sleepArgs = STACK_OFFSET + 0x30;
  bytes.writeBigUInt64LE(BigInt(delayNs), sleepArgs + 0x78);
  const sendArgs = STACK_OFFSET + 0x30 + 2 * CALL_STRIDE;
  bytes.writeBigUInt64LE(BigInt(frame.address + PACKET_OFFSET),
    sendArgs + 0x78);
  bytes.writeBigUInt64LE(BigInt(PACKET_BYTES), sendArgs + 0x80);
  bytes.writeBigUInt64LE(BigInt(handle), sendArgs + 0xf0);
  request.copy(bytes, PACKET_OFFSET);
  check(Object.values(RESULT_OFFSETS).every(offset =>
    bytes.readBigUInt64LE(offset) === RESULT_SENTINEL) &&
    bytes.readBigUInt64LE(TABLE_OFFSET + 3 * 8) ===
      BigInt(sdk + profile.symbols.svcSend.offset) &&
    bytes.readBigUInt64LE(sendArgs + 0xf0) === BigInt(handle),
  'event chain result, transport, or owned handle changed');
  return Object.freeze({role, index: frame.index, address: frame.address,
    gateAddress, handle, delayNs, packetAddress: frame.packetAddress,
    bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
    requestSha256: createHash('sha256').update(request).digest('hex'),
    resultOffsets: RESULT_OFFSETS,
    nativeEventFrameQualified: false,
    fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false});
}

module.exports = {EVENT_OFFSET, MAX_DELAY_NS, CALLS, RESULT_OFFSETS,
  buildGapEventFrame};
