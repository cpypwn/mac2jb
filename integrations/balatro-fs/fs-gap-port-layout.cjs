'use strict';

// Pure layout check for a future Balatro 13-role wave. It stages no memory,
// opens no handles, and does not qualify the Gravity Circuit FS sequence.
const profile = require('./sdk-profile.v1.0.1f.json');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {FRAME_SPACING, PACKET_OFFSET, PACKET_BYTES} =
  require('./fs-counter-overlap.cjs');

const ROLES = Object.freeze(['commit', 'hole', 'tail0', 'tail1', 'tail2',
  'tail3', 'canary', 'filler0', 'filler1', 'release', 'guard0', 'guard1',
  'trigger']);
const OWNER_BYTES = 0x200000;
const SCRATCH_OFFSET = 0x10000;
const SCRATCH_BYTES = 0x80000;
const FRAME_BASE_OFFSET = 0x100000;
const FRAME_BYTES = PACKET_OFFSET + PACKET_BYTES;
const UNRESOLVED = Object.freeze([
  'fresh 13-role native worker and thread lifecycle',
  'same-boot event initialization, wait, signal, and finalization',
  'owned fsp-srv domain reservation and release accounting',
  'bounded 512 KiB content-storage hole read and tail controls',
  'target-specific path packet and guard result controls',
  'Balatro pinning cost, heap jitter, and receive-order window',
  'nonce-bound FS-side path alias or readback',
]);

function check(condition, reason) {
  if (!condition) throw Error(`Balatro gap port layout: ${reason}`);
}

function address(value, label) {
  let number;
  try {number = Number(BigInt(value));}
  catch {throw Error(`Balatro gap port layout: ${label} is not an exact address`);}
  check(Number.isSafeInteger(number) && number >= 0x1000 &&
    number % 0x1000 === 0 && number < 2 ** 39,
  `${label} is outside the pinned user range`);
  return number;
}

function planGapPortLayout({preflight, prepared}) {
  const transport = prepared?.transport;
  check(preflight?.gameProfile === profile.gameProfile &&
    preflight.markerHitVerified === false &&
    preflight.fsStageVerified === false &&
    preflight.exactAllocationBytes === null &&
    /^[0-9a-f]{16}$/.test(preflight.arenaNonce || '') &&
    /^[0-9a-f]{16}$/.test(preflight.markerNonce || '') &&
    prepared?.arenaNonce === preflight.arenaNonce &&
    prepared.markerNonce === preflight.markerNonce &&
    prepared.sdkBase === preflight.sdkBase &&
    prepared.markerWrittenAndVerified === true &&
    prepared.borrowedSession === 'preserved' &&
    prepared.ownedHandlesOpen === true &&
    prepared.explicitSaveWrites === 1 &&
    prepared.root?.role === 'root' && prepared.root.closed === false &&
    transport instanceof BalatroCloneTransport &&
    transport.evidence.sdkBase === preflight.sdkBase &&
    transport.evidence.sdkCodeSha256 === profile.sdkCode.sha256 &&
    transport.ownedHandles.has(prepared.clone?.handle) &&
    transport.ownedHandles.has(prepared.file?.handle) &&
    !transport.ownedHandles.has(prepared.root.handle) &&
    !transport.ownedHandles.has(
      transport.evidence.sessionManager.borrowedHandle),
  'fresh pinned owner and retained owned handles are required');
  const arena = address(preflight.arenaBase, 'owner arena');
  const sdk = address(preflight.sdkBase, 'SDK');
  const scratch = arena + SCRATCH_OFFSET;
  check(arena + OWNER_BYTES < 2 ** 39 &&
    sdk + profile.sdkCode.size < 2 ** 39 &&
    transport.scratch === scratch &&
    transport.native.addresses?.scratch === scratch &&
    transport.native.addresses?.sdk === sdk &&
    prepared.context?.arena === BigInt(arena) &&
    prepared.context.sdk === BigInt(sdk) &&
    prepared.context.scratch === BigInt(scratch) &&
    prepared.context.nonce === preflight.arenaNonce &&
    prepared.pathAddress === scratch + 0x20000 &&
    prepared.receiveAddress === scratch + 0x22000 &&
    FRAME_SPACING === 0x4000 && FRAME_BYTES === 0x3000,
  'native scratch or worker frame ABI changed');
  const scratchEnd = scratch + SCRATCH_BYTES;
  const frameBase = arena + FRAME_BASE_OFFSET;
  const frames = ROLES.map((role, index) => {
    const start = frameBase + index * FRAME_SPACING;
    const end = start + FRAME_BYTES;
    return Object.freeze({role, index, address: start, end,
      packetAddress: start + PACKET_OFFSET,
      packetEnd: start + PACKET_OFFSET + PACKET_BYTES});
  });
  check(scratchEnd <= frameBase &&
    frames[0].address >= scratchEnd &&
    frames.at(-1).end <= arena + OWNER_BYTES &&
    frames.every((frame, index) =>
      frame.address % 0x1000 === 0 &&
      frame.end <= arena + OWNER_BYTES &&
      frame.packetAddress >= frame.address &&
      frame.packetEnd === frame.end &&
      (index === 0 || frames[index - 1].end <= frame.address)),
  '13 frame intervals overlap scratch, each other, or the owner guard');
  return Object.freeze({workerKind: 'balatro-gap-13-layout-only',
    owner: Object.freeze({arenaNonce: preflight.arenaNonce,
      markerNonce: preflight.markerNonce, arenaBase: arena,
      arenaBytes: OWNER_BYTES, sdkBase: sdk,
      sdkCodeSha256: profile.sdkCode.sha256}),
    scratch: Object.freeze({address: scratch, bytes: SCRATCH_BYTES,
      end: scratchEnd}),
    frames, frameBase, frameSpacing: FRAME_SPACING,
    frameBytes: FRAME_BYTES,
    minimumScratchToFrameGapBytes: frameBase - scratchEnd,
    frameLayoutNonoverlapVerified: true,
    nativeFrameHandlesVerified: false,
    targetWorkerQualified: false,
    fsHeapPinAddress: null, exactPinAllocationBytes: null,
    unresolved: UNRESOLVED,
    positiveAttemptAllowed: false, fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false});
}

module.exports = {ROLES, OWNER_BYTES, SCRATCH_OFFSET, SCRATCH_BYTES,
  FRAME_BASE_OFFSET, FRAME_BYTES, UNRESOLVED, planGapPortLayout};
