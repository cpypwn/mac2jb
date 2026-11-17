'use strict';

const crypto = require('node:crypto');
const {markerHit} = require('./wave-history.cjs');

const X_BYTES = 0x800;
const SUFFIX_OFFSET = 0x700;
const TERMINATOR_OFFSET = 0x7ff;
const EXTENT = 0x2440;
// shw2Po's 1.1 ms abort control had a +259.648 us hole/guard margin,
// just 40.352 us below the required +300 us. Its hole ended at 3620.8 us,
// matching cHZrl0's qualified 3622.272 us; guard launch drifted +241.792 us.
// Try one later abort-only control on a fresh process if 1.1 ms fails. The
// later control must independently qualify before any positive request.
const TIMING_DELAYS_NS = Object.freeze([1100000, 1300000]);

function names(scratch) {
  if (!/^\/NS2_GAP_\d+$/.test(scratch))
    throw Error('Valid-parent candidate requires an owned scratch root');
  const selectedDirectory = scratch + '/selected';
  const absentDirectory = scratch + '/UNOWNEDX';
  if (Buffer.byteLength(selectedDirectory) !== Buffer.byteLength(absentDirectory))
    throw Error('Valid-parent selected and absent suffixes differ in length');
  const forwardPrefix = `${scratch}/selected/../../`;
  const backslashPrefix = `${scratch}/selected/..\\../`;
  if (forwardPrefix.length !== backslashPrefix.length ||
      [...forwardPrefix].filter((char, i) => char !== backslashPrefix[i]).length !== 1 ||
      forwardPrefix.indexOf('/') !== 0 ||
      forwardPrefix.length >= SUFFIX_OFFSET ||
      SUFFIX_OFFSET + selectedDirectory.length >= TERMINATOR_OFFSET)
    throw Error('Valid-parent matched prefixes or placement differ');
  return {selectedDirectory, absentDirectory, forwardPrefix, backslashPrefix};
}

function source(scratch, kind) {
  if (!['negative', 'positive', 'absent'].includes(kind))
    throw Error('Invalid valid-parent source kind');
  const parts = names(scratch);
  const prefix = kind === 'positive' ? parts.backslashPrefix : parts.forwardPrefix;
  const suffix = kind === 'absent' ? parts.absentDirectory : parts.selectedDirectory;
  const payload = Buffer.alloc(EXTENT + 1, '/');
  payload.write(prefix, 0, 'ascii');
  payload.write(suffix, SUFFIX_OFFSET, 'ascii');
  payload[TERMINATOR_OFFSET] = 0;
  payload[EXTENT] = 0;
  const first = payload.subarray(0, X_BYTES);
  if (first.subarray(0, TERMINATOR_OFFSET).includes(0) ||
      first.subarray(prefix.length, SUFFIX_OFFSET).some(byte => byte !== 0x2f) ||
      first.subarray(SUFFIX_OFFSET + suffix.length, TERMINATOR_OFFSET).some(byte => byte !== 0x2f))
    throw Error('Valid-parent path has an early terminator or non-slash filler');
  return {kind, payload, selectedDirectory: parts.selectedDirectory,
    firstDescriptorSha256: crypto.createHash('sha256').update(first).digest('hex'),
    payloadSha256: crypto.createHash('sha256').update(payload).digest('hex'),
    separatorOffset: scratch.length + '/selected/..'.length,
    suffixOffset: SUFFIX_OFFSET, terminatorOffset: TERMINATOR_OFFSET,
    descriptorBytes: X_BYTES};
}

function matched(scratch) {
  const negative = source(scratch, 'negative');
  const positive = source(scratch, 'positive');
  const differences = [];
  for (let i = 0; i < negative.payload.length; i++)
    if (negative.payload[i] !== positive.payload[i]) differences.push(i);
  if (differences.length !== 1 || negative.payload[differences[0]] !== 0x2f ||
      positive.payload[differences[0]] !== 0x5c)
    throw Error('Valid-parent positive differs from the matched negative by more than one separator');
  return {negative, positive, changedByteOffset: differences[0]};
}

function shortControls(scratch) {
  const parts = names(scratch);
  const pair = prefix => ({selected: prefix + parts.selectedDirectory,
    absent: prefix + parts.absentDirectory});
  return {forward: pair(parts.forwardPrefix), backslash: pair(parts.backslashPrefix),
    direct: {selected: parts.selectedDirectory, absent: parts.absentDirectory}};
}

function verifyControls(scratch, side) {
  const expectedShort = shortControls(scratch);
  if (!side || ['direct', 'forward', 'backslash'].some(kind =>
    side.short?.[kind]?.selected?.path !== expectedShort[kind].selected ||
    side.short[kind].absent?.path !== expectedShort[kind].absent ||
    side.short?.[kind]?.selected?.result !== 0 ||
    side.short[kind].selected.type !== 0 ||
    side.short[kind].absent?.result !== 0x202 ||
    side.short[kind].absent.type !== null) ||
    side.longForward?.selected?.result !== 0 ||
    side.longForward.selected.type !== 0 ||
    side.longForward.absent?.result !== 0x202 ||
    side.longForward.absent.type !== null ||
    ['selected', 'absent'].some(kind =>
      side.longForward[kind].descriptorBytes !== X_BYTES ||
      side.longForward[kind].suffixOffset !== SUFFIX_OFFSET ||
      side.longForward[kind].terminatorOffset !== TERMINATOR_OFFSET) ||
    side.longForward.selected.sha256 !== source(scratch, 'negative').firstDescriptorSha256 ||
    side.longForward.absent.sha256 !== source(scratch, 'absent').firstDescriptorSha256)
    throw Error('Valid-parent short or long owned-path controls differ');
  return true;
}

function verifyEvidence(report, positiveCase) {
  const diagnostic = report?.validParentPositive;
  if (report?.target !== 'gravcirc' || report.validParentPositiveEnabled !== true ||
      report.firstXPositiveEnabled !== true || report.firstXSlashSplitEnabled !== true ||
      report.firstXTerminatedEnabled !== true || report.firstXTailSpacingEnabled !== true ||
      report.firstXEdgeOffsetEnabled === true || report.markerOffset !== SUFFIX_OFFSET ||
      report.extent !== EXTENT || report.firstXPositive ||
      diagnostic?.enabled !== true || diagnostic.offset !== SUFFIX_OFFSET ||
      diagnostic.descriptorBytes !== X_BYTES ||
      diagnostic.terminatorOffset !== TERMINATOR_OFFSET ||
      diagnostic.markerBytesRetrieved !== false)
    throw Error('Valid-parent candidate mode or geometry differs');
  const expected = matched(report.scratch);
  if (diagnostic.changedByteOffset !== expected.changedByteOffset ||
      diagnostic.negativeFirstDescriptorSha256 !==
        (report.cases.some(row => row.profile === 'negative') ?
          expected.negative.firstDescriptorSha256 : null) ||
      diagnostic.negativePayloadSha256 !==
        (report.cases.some(row => row.profile === 'negative') ?
          expected.negative.payloadSha256 : null) ||
      diagnostic.positiveFirstDescriptorSha256 !==
        (positiveCase ? expected.positive.firstDescriptorSha256 : null) ||
      diagnostic.positivePayloadSha256 !==
        (positiveCase ? expected.positive.payloadSha256 : null))
    throw Error('Valid-parent matched input evidence differs');
  for (const kind of ['negative', 'positive']) {
    const source = expected[kind];
    for (const row of report.cases.filter(row => row.profile === kind)) {
      if (row.preparedFirstXInputSha256 !== source.firstDescriptorSha256 ||
          row.preparedPayloadSha256 !== source.payloadSha256 ||
          row.extent !== EXTENT ||
          row.pathTerminatorOffset !== TERMINATOR_OFFSET ||
          row.firstXSuffixOffset !== SUFFIX_OFFSET ||
          row.firstXSeparatorOffset !== expected.changedByteOffset ||
          kind === 'positive' && row.firstXPositiveOffset !== SUFFIX_OFFSET)
        throw Error('Valid-parent wave input hash or placement differs');
    }
  }
  const controls = diagnostic.controls;
  verifyControls(report.scratch, controls?.before);
  verifyControls(report.scratch, controls?.after);
  const observation = diagnostic.canaryObservation;
  if (positiveCase ? observation?.originalType !== 1 ||
      observation.result !== positiveCase.canaryResult ||
      observation.observedType !== positiveCase.canaryType ||
      JSON.stringify(observation.changedPaths) !== JSON.stringify(positiveCase.changedPaths) ||
      observation.qualifiedTypeTransition !== markerHit(positiveCase) ||
      observation.markerBytesRetrieved !== false : observation !== null)
    throw Error('Valid-parent held-canary type or marker-byte evidence differs');
  return {variant: 'valid-parent-one-byte-positive', offset: SUFFIX_OFFSET,
    changedByteOffset: expected.changedByteOffset,
    negativeFirstDescriptorSha256: report.cases.some(row => row.profile === 'negative') ?
      expected.negative.firstDescriptorSha256 : null,
    negativePayloadSha256: report.cases.some(row => row.profile === 'negative') ?
      expected.negative.payloadSha256 : null,
    positiveFirstDescriptorSha256: positiveCase ?
      expected.positive.firstDescriptorSha256 : null,
    positivePayloadSha256: positiveCase ? expected.positive.payloadSha256 : null,
    canaryOriginalType: 1, canaryObservedType: positiveCase ? positiveCase.canaryType : null,
    canaryTypeTransition: positiveCase ? markerHit(positiveCase) : false,
    markerBytesRetrieved: false};
}

module.exports = {X_BYTES, SUFFIX_OFFSET, TERMINATOR_OFFSET, EXTENT, TIMING_DELAYS_NS,
  names, source, matched, shortControls, verifyControls, verifyEvidence};
