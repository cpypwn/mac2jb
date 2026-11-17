const net = require('node:net');
const {identify} = require('./identify-image-readonly.cjs');
const {checkArena} = require('./ffi-arena-live.cjs');
const {takeSnapshot} = require('./rpc-log-snapshot.cjs');
const {runNativeOrderLive, validNativeOrderResult} =
  require('./fs-native-order-live.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const ARENA_BYTES = 0x200000;
const MISSING_RESULT = '0x00000202';
// One Balatro save block. A single autosave writes exactly one save block, so
// a 0x4000 free-space decline while the localization itself stays read-only
// (nativeOrderSaveWrites === 0) is attributable to that autosave — but only
// when the RPC log also grew (the autosave's own log write). A silent or
// non-block-aligned decline still fails closed below.
const SAVE_BLOCK_BYTES = 0x4000;
// The candidate diagnostic cost is the general-heap delta measured when the
// owned content storage is opened. It is a live Switch-2 save-health reading,
// not a compile-time constant: it can legitimately drift between retained
// boots. The gate below accepts the measured value within the same strict bound
// the native-order and pinning-staircase assessors already enforce, and the
// measured value is later cross-checked against the independent staircase
// measurement before any attempt is assembled.
const MAX_DIAGNOSTIC_BYTES = 0x10000;

function assess({before, after, arenaBefore, arenaAfter, snapshotBefore,
  snapshotAfter, order, nonce}) {
  const sameImage = before?.state === 'serving' &&
    before.metadataVersion === profile.runtimeVersion &&
    before.codeHeadProfile === '1.0.1f' &&
    before.sdkBase === after?.sdkBase &&
    before.mainBase === after?.mainBase &&
    before.sampleFingerprintSha256 === after?.sampleFingerprintSha256 &&
    after.state === before.state &&
    after.metadataVersion === before.metadataVersion &&
    after.codeHeadProfile === before.codeHeadProfile;
  if (!sameImage || !/^0x[0-9a-f]+$/.test(before.sdkBase || '')) {
    throw Error('Balatro image changed or is not the pinned 1.0.1f image');
  }
  if (arenaBefore?.phase !== 'inspect' || arenaAfter?.phase !== 'inspect' ||
      arenaBefore.nonce !== nonce || arenaAfter.nonce !== nonce ||
      arenaBefore.gameProfile !== profile.gameProfile ||
      arenaAfter.gameProfile !== profile.gameProfile ||
      arenaBefore.bytes !== ARENA_BYTES || arenaAfter.bytes !== ARENA_BYTES ||
      !/^0x[0-9a-f]+$/.test(arenaBefore.base || '') ||
      arenaBefore.base !== arenaAfter.base) {
    throw Error('Balatro retained arena changed during marker preflight');
  }
  const first = snapshotBefore?.readonly;
  const last = snapshotAfter?.readonly;
  const firstLog = snapshotBefore?.log;
  const lastLog = snapshotAfter?.log;
  if (first?.gameProfile !== profile.gameProfile ||
      last?.gameProfile !== profile.gameProfile ||
      first.absentPathResult !== MISSING_RESULT ||
      last.absentPathResult !== MISSING_RESULT ||
      !Number.isSafeInteger(first.freeBytes) ||
      !Number.isSafeInteger(last.freeBytes) ||
      firstLog?.sourcePinned !== true || lastLog?.sourcePinned !== true ||
      firstLog.loggerSourceSha256 !== lastLog.loggerSourceSha256 ||
      !Number.isSafeInteger(firstLog.sizeBytes) ||
      !Number.isSafeInteger(lastLog.sizeBytes) ||
      lastLog.sizeBytes < firstLog.sizeBytes ||
      firstLog.phaseSizeBytes !== lastLog.phaseSizeBytes) {
    const detail = {
      freeBytesBefore: first?.freeBytes,
      freeBytesAfter: last?.freeBytes,
      absentPathBefore: first?.absentPathResult,
      absentPathAfter: last?.absentPathResult,
      logSizeBefore: firstLog?.sizeBytes,
      logSizeAfter: lastLog?.sizeBytes,
      phaseSizeBefore: firstLog?.phaseSizeBytes,
      phaseSizeAfter: lastLog?.phaseSizeBytes,
    };
    throw Error(`Balatro save snapshot, logger, or absent path changed: ${JSON.stringify(detail)}`);
  }
  const freeDriftBytes = first.freeBytes - last.freeBytes;
  const logGrowthBytes = lastLog.sizeBytes - firstLog.sizeBytes;
  if (freeDriftBytes !== 0 &&
      !(freeDriftBytes === SAVE_BLOCK_BYTES && logGrowthBytes > 0)) {
    const detail = {freeBytesBefore: first.freeBytes,
      freeBytesAfter: last.freeBytes,
      freeDriftBytes,
      logSizeBefore: firstLog.sizeBytes,
      logSizeAfter: lastLog.sizeBytes,
      logGrowthBytes};
    throw Error(`Balatro free-space drift is not attributable to a single logged autosave block: ${JSON.stringify(detail)}`);
  }
  const candidateCost = order.assessment.candidateDiagnosticCostBytes;
  if (!validNativeOrderResult(order) ||
      order.gameProfile !== profile.gameProfile || order.nonce !== nonce ||
      order.arenaBase !== arenaBefore.base ||
      !Number.isSafeInteger(candidateCost) || candidateCost <= 0 ||
      candidateCost > MAX_DIAGNOSTIC_BYTES ||
      order.assessment.overlapQualified !== false ||
      order.assessment.markerHitVerified !== false) {
    throw Error('Balatro native order control did not verify this retained boot');
  }
  return {
    gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkBase: before.sdkBase,
    arenaBase: arenaBefore.base,
    arenaNonce: nonce,
    nativeCounterFrequencyVerified: order.clock.nativeCounterFrequencyVerified,
    serialReceiveOrderVerified: order.assessment.serialReceiveOrderVerified,
    candidateDiagnosticCostBytes: candidateCost,
    saveFreeBytesBefore: first.freeBytes,
    saveFreeBytesAfter: last.freeBytes,
    saveFreeBytesDriftBytes: freeDriftBytes,
    autosaveBlockAttributed: freeDriftBytes === SAVE_BLOCK_BYTES,
    savedataLogGrowthBytes: logGrowthBytes,
    logAllocationAttributed: false,
    nativeOrderSaveWrites: 0,
    saveScratchCapacityVerified: false,
    absentPathResult: MISSING_RESULT,
    exactAllocationBytes: null,
    pinAddress: null,
    concurrentOverlapMeasured: false,
    markerHitVerified: false,
    fsStageVerified: false,
    nextGate: 'Build a Balatro FS-acquisition readback with measured pin placement and overlapping native request lifetimes',
  };
}

async function runMarkerLocalization({host, macIp, nonce,
  inspectImage = identify, inspectArena = checkArena,
  inspectSnapshot = takeSnapshot, runOrder = runNativeOrderLive,
  onPhase = () => {}}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !/^[0-9a-f]{16}$/.test(nonce || '') ||
      [inspectImage, inspectArena, inspectSnapshot, runOrder, onPhase]
        .some(item => typeof item !== 'function')) {
    throw new TypeError('Balatro marker preflight needs two IPv4 addresses, a retained arena nonce, and qualified probes');
  }
  onPhase('image-before');
  const before = await inspectImage(host);
  if (before.state !== 'serving' ||
      before.metadataVersion !== profile.runtimeVersion ||
      before.codeHeadProfile !== '1.0.1f') {
    throw Error('Balatro image is not the pinned 1.0.1f image');
  }
  onPhase('arena-before');
  const arenaBefore = await inspectArena({host, phase: 'inspect', nonce});
  if (arenaBefore.nonce !== nonce || arenaBefore.bytes !== ARENA_BYTES ||
      arenaBefore.gameProfile !== profile.gameProfile) {
    throw Error('Balatro retained arena is absent or belongs to another boot');
  }
  onPhase('save-log-before');
  const snapshotBefore = await inspectSnapshot({host});
  if (snapshotBefore.readonly?.absentPathResult !== MISSING_RESULT ||
      snapshotBefore.log?.sourcePinned !== true) {
    throw Error('Balatro save and RPC logger control failed before the native probe');
  }
  onPhase('native-order');
  const order = await runOrder({host, macIp, nonce, onPhase});
  if (!validNativeOrderResult(order) || order.nonce !== nonce ||
      order.arenaBase !== arenaBefore.base) {
    throw Error('Balatro native order control did not verify this boot');
  }
  onPhase('arena-after');
  const arenaAfter = await inspectArena({host, phase: 'inspect', nonce});
  onPhase('image-after');
  const after = await inspectImage(host);
  onPhase('save-log-after');
  const snapshotAfter = await inspectSnapshot({host});
  return assess({before, after, arenaBefore, arenaAfter,
    snapshotBefore, snapshotAfter, order, nonce});
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node marker-localization-live.cjs <switch-ipv4> <mac-ipv4> <retained-arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runMarkerLocalization({host: argv[0], macIp: argv[1],
      nonce: argv[2], onPhase: phase => process.stderr.write(`${phase}\n`)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry or marker wave was attempted.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {ARENA_BYTES, MISSING_RESULT, MAX_DIAGNOSTIC_BYTES,
  SAVE_BLOCK_BYTES, assess, runMarkerLocalization, main};
