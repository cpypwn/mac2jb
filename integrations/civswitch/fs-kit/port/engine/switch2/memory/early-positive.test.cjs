'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const early = require('./early-positive.cjs');
const firstX = require('./first-x-positive.cjs');
const validParent = require('./valid-parent-positive.cjs');

const session = 'switch2-early-test';
const readSize = 0x80000;

function rows(result = 0x2eec02, type = null) {
  const encoded = Buffer.alloc(4);
  if (type !== null) encoded.writeUInt32LE(type);
  return [
    {role: 'hole', result: 0, startUs: 300, endUs: 3600},
    {role: 'release', result: 0, startUs: 2800, endUs: 2850},
    {role: 'guard1', result: 0x202, startUs: 3100, endUs: 3200},
    {role: 'canary', result: 0, startUs: 1700, endUs: 4000},
    {role: 'filler0', result: 0x202, startUs: 2000, endUs: 3000},
    {role: 'pin', result: 0, startUs: 2500, endUs: 2700},
    {role: 'trigger', result, inline: type === null ? '' : encoded.toString('hex'),
      startUs: 3650, endUs: 3800},
  ];
}

function wave(profile, result = 0x2eec02, type = null, extra = {}) {
  return {profile, readSize, holeDelayNs: early.HOLE_DELAY_NS,
    pinRequestOpcode: 1009, restored: true, triggerAborted: false,
    allPending: true, receiveOrderMarginUs: 500, preReleaseUsed: 0x2700,
    selectedMarker: result === 0 && type === 1, changedPaths: [],
    canaryResult: 0, canaryType: 1, rows: rows(result, type), ...extra};
}

function report() {
  const selected = (profile, result, type, extra = {}) =>
    wave(profile, result, type, {holeDelayNs: early.TIMING_DELAYS_NS[1], ...extra});
  const cases = [
    wave('abort-control', 0x202, null, {readSize: 0x80000,
      pinRequestOpcode: 200, triggerAborted: true,
      nativeGuard: {completed: 1}, pinWindowOk: true, pinCostOk: true}),
    wave('abort-hole-control', 0x202, null, {readSize: 0x10000,
      triggerAborted: true, nativeGuard: {earlyHole: 1, minimumSpacing: 1}}),
    wave('abort-control', 0x202, null, {readSize: 0x80000, triggerAborted: true,
      rows: rows(0x202).map(row => row.role === 'hole' ? {...row, endUs: 3300} : row),
      nativeGuard: {completed: 1}}),
    wave('abort-control', 0x202, null, {readSize: 0x80000, triggerAborted: true,
      holeDelayNs: early.TIMING_DELAYS_NS[1],
      rows: rows(0x202).map(row => row.role === 'hole' ? {...row, startUs: 700} : row),
      nativeGuard: {completed: 1}}),
    selected('extent-absent', 0x202),
    selected('marker-first-descriptor-marker', 0, 1, {pathTerminatorOffset: 0x7ff}),
    selected('marker-first-descriptor-absent', 0x202, null, {pathTerminatorOffset: 0x7ff}),
    selected('negative'),
    selected('positive', 0x2eec02, null, {changedPaths: ['canary'], canaryType: 0}),
  ];
  return {session, target: 'gravcirc', earlyPositiveEnabled: true,
    earlyPositive: {status: 'marker-hit', completed: true, initialPinCaseIndex: 0,
      timingCaseIndices: [2, 3], timingControlCaseIndex: 3,
      selectedHoleDelayNs: early.TIMING_DELAYS_NS[1], positiveCaseIndex: 8,
      directControls: {before: {marker: {result: 0, type: 1}, absent: 0x202},
        after: {marker: {result: 0, type: 1}, absent: 0x202}}},
    completed: true, cleanedUp: true, canaryWaveLimit: 16,
    workerDelaysNs: [0, 300000, 350000, 450000, 550000, 650000,
      early.CANARY_DELAY_NS], cases,
    holeTimingPreflight: {verified: true, readSize: 0x80000,
      baseline: {result: 0, offset: 0, size: 0x10000,
        first64Hex: '66'.repeat(64)},
      large: {result: 0, offset: 0, size: 0x80000,
        first64Hex: '66'.repeat(64), last64Hex: '66'.repeat(64)},
      tail: {result: 0, offset: 0x80000 - 64, size: 64,
        first64Hex: '66'.repeat(64)}},
    extentMarkerControl: {original: {result: 0, type: 1},
      cloned: {result: 0, type: 1}, padded: {result: 0, type: 1}},
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false, released: true}};
}

test('accepts one marker hit after matched early controls and clean cleanup', () => {
  assert.deepEqual(early.verifyReport(report(), session), {
    session, diagnostic: 'early-positive', status: 'marker-hit', markerHit: true,
    positiveCases: 1, timingControlCaseIndex: 3, readSize, cleanedUp: true});
});

test('uses the first 512 KiB control when its 300 microsecond schedule qualifies', () => {
  const value = report();
  value.cases[2].rows.find(row => row.role === 'hole').endUs = 3600;
  value.cases.splice(3, 1);
  for (const row of value.cases.slice(3)) row.holeDelayNs = early.TIMING_DELAYS_NS[0];
  value.earlyPositive.timingCaseIndices = [2];
  value.earlyPositive.timingControlCaseIndex = 2;
  value.earlyPositive.selectedHoleDelayNs = early.TIMING_DELAYS_NS[0];
  value.earlyPositive.positiveCaseIndex = 7;
  assert.equal(early.verifyReport(value, session).markerHit, true);
});

test('stops cleanly without a positive when both bounded 512 KiB controls miss', () => {
  const value = report();
  value.cases[3].rows.find(row => row.role === 'hole').endUs = 3300;
  value.cases.splice(4);
  value.earlyPositive.status = 'timing-inconclusive';
  value.earlyPositive.timingControlCaseIndex = null;
  value.earlyPositive.selectedHoleDelayNs = null;
  value.earlyPositive.positiveCaseIndex = null;
  assert.deepEqual(early.verifyReport(value, session), {
    session, diagnostic: 'early-positive', status: 'timing-inconclusive',
    markerHit: false, positiveCases: 0, timingControlCaseIndex: null,
    readSize: null, cleanedUp: true});
});

test('rejects continuing to a second timing control after the first qualified', () => {
  const value = report();
  value.cases[2].rows.find(row => row.role === 'hole').endUs = 3600;
  assert.throws(() => early.verifyReport(value, session), /continued after a usable timing window/);
});

test('accepts a qualified miss without calling it a marker hit', () => {
  const value = report();
  value.cases[8].changedPaths = [];
  value.cases[8].canaryType = 1;
  value.earlyPositive.status = 'qualified-miss';
  assert.equal(early.verifyReport(value, session).markerHit, false);
});

test('first-X variant requires the bounded input and does not promote a safe miss', () => {
  const value = report();
  // The first-X variant uses one fresh 1.1 ms timing control, then preserves
  // that exact schedule through the matched paths and single positive.
  value.cases.splice(2, 1);
  for (const row of value.cases.slice(2)) {
    row.holeDelayNs = firstX.HOLE_DELAY_NS;
    row.rows.find(item => item.role === 'hole').startUs = 1080;
  }
  value.earlyPositive.timingCaseIndices = [2];
  value.earlyPositive.timingControlCaseIndex = 2;
  value.earlyPositive.selectedHoleDelayNs = firstX.HOLE_DELAY_NS;
  value.earlyPositive.positiveCaseIndex = 7;
  const scratch = '/NS2_GAP_1794577529783';
  const {bytes} = firstX.expectedFirstX(scratch);
  const payload = Buffer.alloc(0x2441, '/');
  bytes.copy(payload);
  payload[payload.length - 1] = 0;
  value.scratch = scratch;
  value.extent = 0x2440;
  value.markerOffset = firstX.OFFSET;
  value.firstXPositiveEnabled = true;
  value.firstXPositive = firstX.qualifyInput(payload, scratch);
  value.cases[7].firstXPositiveOffset = firstX.OFFSET;
  value.cases[7].changedPaths = [];
  value.cases[7].canaryType = 1;
  value.earlyPositive.status = 'qualified-miss';
  assert.deepEqual(early.verifyReport(value, session), {
    session, diagnostic: 'early-positive', status: 'qualified-miss', markerHit: false,
    positiveCases: 1, timingControlCaseIndex: 2, readSize, cleanedUp: true,
    variant: 'first-x-positive', offset: firstX.OFFSET});
  value.cases[7].firstXPositiveOffset = firstX.OFFSET + 0x20;
  assert.throws(() => early.verifyReport(value, session), /input hash or wave offset/);
});

test('first-X positive schedule accepts only its measured hole delay', () => {
  const row = wave('positive', 0x2eec02, null,
    {holeDelayNs: firstX.HOLE_DELAY_NS});
  row.rows.find(item => item.role === 'hole').startUs = 1080;
  assert.equal(early.schedule(row, readSize, firstX.HOLE_DELAY_NS,
    firstX.TIMING_DELAYS_NS).usable, true);
  assert.throws(() => early.schedule(row, readSize, firstX.HOLE_DELAY_NS),
    /schedule or read size/);
  assert.throws(() => early.schedule(row, readSize, firstX.PRIOR_HOLE_DELAY_NS,
    firstX.TIMING_DELAYS_NS), /schedule or read size/);
});

test('valid-parent one-byte variant preserves the canary type and marker-byte distinction', () => {
  const value = report();
  value.cases.splice(2, 1);
  for (const row of value.cases.slice(2)) {
    row.holeDelayNs = firstX.HOLE_DELAY_NS;
    row.rows.find(item => item.role === 'hole').startUs = 1080;
  }
  value.earlyPositive.timingCaseIndices = [2];
  value.earlyPositive.timingControlCaseIndex = 2;
  value.earlyPositive.selectedHoleDelayNs = firstX.HOLE_DELAY_NS;
  value.earlyPositive.positiveCaseIndex = 7;
  value.earlyPositive.status = 'qualified-miss';
  const scratch = '/NS2_GAP_1794577529783';
  const matched = validParent.matched(scratch);
  const selected = {result: 0, type: 0};
  const absent = {result: 0x202, type: null};
  const names = validParent.shortControls(scratch);
  const short = Object.fromEntries(Object.entries(names).map(([kind, pair]) => [kind,
    {selected: {path: pair.selected, ...selected},
      absent: {path: pair.absent, ...absent}}]));
  const shape = {descriptorBytes: 0x800, suffixOffset: 0x700, terminatorOffset: 0x7ff};
  const side = () => ({short, longForward: {
    selected: {...selected, ...shape, sha256: matched.negative.firstDescriptorSha256},
    absent: {...absent, ...shape,
      sha256: validParent.source(scratch, 'absent').firstDescriptorSha256}}});
  value.scratch = scratch;
  value.extent = 0x2440;
  value.markerOffset = 0x700;
  value.firstXPositiveEnabled = true;
  value.firstXSlashSplitEnabled = true;
  value.firstXTerminatedEnabled = true;
  value.firstXTailSpacingEnabled = true;
  value.validParentPositiveEnabled = true;
  value.validParentPositive = {enabled: true, offset: 0x700, descriptorBytes: 0x800,
    terminatorOffset: 0x7ff, changedByteOffset: matched.changedByteOffset,
    negativeFirstDescriptorSha256: matched.negative.firstDescriptorSha256,
    negativePayloadSha256: matched.negative.payloadSha256,
    positiveFirstDescriptorSha256: matched.positive.firstDescriptorSha256,
    positivePayloadSha256: matched.positive.payloadSha256,
    markerBytesRetrieved: false,
    canaryObservation: {originalType: 1, result: 0, observedType: 1,
      changedPaths: [], qualifiedTypeTransition: false, markerBytesRetrieved: false},
    controls: {before: side(), after: side()}};
  for (const kind of ['negative', 'positive']) {
    const row = value.cases.find(row => row.profile === kind);
    const source = matched[kind];
    row.preparedFirstXInputSha256 = source.firstDescriptorSha256;
    row.preparedPayloadSha256 = source.payloadSha256;
    row.firstXSuffixOffset = 0x700;
    row.firstXSeparatorOffset = matched.changedByteOffset;
    row.pathTerminatorOffset = 0x7ff;
    row.extent = 0x2440;
    if (kind === 'positive') row.firstXPositiveOffset = 0x700;
    row.rows.find(item => item.role === 'trigger').result = 0;
    row.rows.find(item => item.role === 'trigger').inline = '00000000';
  }
  value.cases[7].changedPaths = [];
  value.cases[7].canaryType = 1;
  const miss = early.verifyReport(value, session);
  assert.equal(miss.markerHit, false);
  assert.equal(miss.canaryTypeTransition, false);
  assert.equal(miss.markerBytesRetrieved, false);
  assert.deepEqual(validParent.TIMING_DELAYS_NS, [1100000, 1300000]);
  const ladder = structuredClone(value);
  const firstTiming = ladder.cases[2];
  firstTiming.rows.find(item => item.role === 'hole').endUs = 3350;
  const laterTiming = structuredClone(value.cases[2]);
  laterTiming.holeDelayNs = 1300000;
  laterTiming.rows.find(item => item.role === 'hole').startUs = 1280;
  laterTiming.rows.find(item => item.role === 'hole').endUs = 3800;
  ladder.cases.splice(3, 0, laterTiming);
  for (const row of ladder.cases.slice(4)) {
    row.holeDelayNs = 1300000;
    row.rows.find(item => item.role === 'hole').startUs = 1280;
    row.rows.find(item => item.role === 'hole').endUs = 3800;
  }
  ladder.earlyPositive.timingCaseIndices = [2, 3];
  ladder.earlyPositive.timingControlCaseIndex = 3;
  ladder.earlyPositive.selectedHoleDelayNs = 1300000;
  ladder.earlyPositive.positiveCaseIndex = 8;
  assert.equal(early.verifyReport(ladder, session).status, 'qualified-miss');
  value.cases[7].changedPaths = ['canary'];
  value.cases[7].canaryType = 0;
  value.earlyPositive.status = 'marker-hit';
  value.validParentPositive.canaryObservation = {originalType: 1, result: 0,
    observedType: 0, changedPaths: ['canary'], qualifiedTypeTransition: true,
    markerBytesRetrieved: false};
  const transition = early.verifyReport(value, session);
  assert.equal(transition.markerHit, true);
  assert.equal(transition.canaryTypeTransition, true);
  assert.equal(transition.markerBytesRetrieved, false);
  value.validParentPositive.markerBytesRetrieved = true;
  assert.throws(() => early.verifyReport(value, session), /mode or geometry differs/);
});

test('edge first-X placement keeps the timing and cleanup gates', () => {
  const value = report();
  value.cases.splice(2, 1);
  for (const row of value.cases.slice(2)) {
    row.holeDelayNs = firstX.HOLE_DELAY_NS;
    row.rows.find(item => item.role === 'hole').startUs = 1080;
  }
  value.earlyPositive.timingCaseIndices = [2];
  value.earlyPositive.timingControlCaseIndex = 2;
  value.earlyPositive.selectedHoleDelayNs = firstX.HOLE_DELAY_NS;
  value.earlyPositive.positiveCaseIndex = 7;
  const scratch = '/NS2_GAP_1794577529783';
  const {bytes} = firstX.expectedFirstX(scratch, true, firstX.EDGE_OFFSET);
  const payload = Buffer.alloc(0x2441, '/');
  bytes.copy(payload);
  payload[payload.length - 1] = 0;
  value.scratch = scratch;
  value.extent = 0x2440;
  value.markerOffset = firstX.EDGE_OFFSET;
  value.firstXPositiveEnabled = true;
  value.firstXSlashSplitEnabled = true;
  value.firstXEdgeOffsetEnabled = true;
  value.firstXPositive = firstX.qualifyInput(payload, scratch, true,
    firstX.EDGE_OFFSET);
  value.cases[7].firstXPositiveOffset = firstX.EDGE_OFFSET;
  value.cases[7].changedPaths = [];
  value.cases[7].canaryType = 1;
  value.earlyPositive.status = 'qualified-miss';
  assert.deepEqual(early.verifyReport(value, session), {
    session, diagnostic: 'early-positive', status: 'qualified-miss', markerHit: false,
    positiveCases: 1, timingControlCaseIndex: 2, readSize, cleanedUp: true,
    variant: 'first-x-edge-slash-split', offset: firstX.EDGE_OFFSET});
  value.retained.cacheNeedsRestore = true;
  assert.throws(() => early.verifyReport(value, session), /retained native resources/);
});

test('terminated first-X input still needs matched controls and cleanup', () => {
  const value = report();
  value.cases.splice(2, 1);
  for (const row of value.cases.slice(2)) {
    row.holeDelayNs = firstX.HOLE_DELAY_NS;
    row.rows.find(item => item.role === 'hole').startUs = 1080;
  }
  value.earlyPositive.timingCaseIndices = [2];
  value.earlyPositive.timingControlCaseIndex = 2;
  value.earlyPositive.selectedHoleDelayNs = firstX.HOLE_DELAY_NS;
  value.earlyPositive.positiveCaseIndex = 7;
  const scratch = '/NS2_GAP_1794577529783';
  const {bytes} = firstX.expectedFirstX(scratch, true, firstX.OFFSET, true);
  const payload = Buffer.alloc(0x2441, '/');
  bytes.copy(payload);
  payload[payload.length - 1] = 0;
  value.scratch = scratch;
  value.extent = 0x2440;
  value.markerOffset = firstX.OFFSET;
  value.firstXPositiveEnabled = true;
  value.firstXSlashSplitEnabled = true;
  value.firstXTerminatedEnabled = true;
  value.firstXPositive = firstX.qualifyInput(payload, scratch, true,
    firstX.OFFSET, true);
  value.cases[7].firstXPositiveOffset = firstX.OFFSET;
  value.cases[7].pathTerminatorOffset = 0x7ff;
  value.cases[7].changedPaths = [];
  value.cases[7].canaryType = 1;
  value.earlyPositive.status = 'qualified-miss';
  assert.equal(early.verifyReport(value, session).variant,
    'first-x-terminated-slash-split');
  value.cases[6].changedPaths = ['guard1'];
  assert.throws(() => early.verifyReport(value, session), /negative control changed/);
});

test('tail-spacing variant retains a one-positive bound and exact input', () => {
  const value = report();
  value.cases.splice(2, 1);
  for (const row of value.cases.slice(2)) {
    row.holeDelayNs = firstX.HOLE_DELAY_NS;
    row.rows.find(item => item.role === 'hole').startUs = 1080;
  }
  value.earlyPositive.timingCaseIndices = [2];
  value.earlyPositive.timingControlCaseIndex = 2;
  value.earlyPositive.selectedHoleDelayNs = firstX.HOLE_DELAY_NS;
  value.earlyPositive.positiveCaseIndex = 7;
  const scratch = '/NS2_GAP_1794577529783';
  const {bytes} = firstX.expectedFirstX(scratch, true,
    firstX.TAIL_SPACING_OFFSET, true);
  const payload = Buffer.alloc(0x2441, '/');
  bytes.copy(payload);
  payload[payload.length - 1] = 0;
  value.scratch = scratch;
  value.extent = 0x2440;
  value.markerOffset = firstX.TAIL_SPACING_OFFSET;
  value.firstXPositiveEnabled = true;
  value.firstXSlashSplitEnabled = true;
  value.firstXTerminatedEnabled = true;
  value.firstXTailSpacingEnabled = true;
  value.firstXPositive = firstX.qualifyInput(payload, scratch, true,
    firstX.TAIL_SPACING_OFFSET, true);
  value.cases[7].firstXPositiveOffset = firstX.TAIL_SPACING_OFFSET;
  value.cases[7].pathTerminatorOffset = 0x7ff;
  value.cases[7].changedPaths = [];
  value.cases[7].canaryType = 1;
  value.earlyPositive.status = 'qualified-miss';
  assert.deepEqual(early.verifyReport(value, session), {
    session, diagnostic: 'early-positive', status: 'qualified-miss', markerHit: false,
    positiveCases: 1, timingControlCaseIndex: 2, readSize, cleanedUp: true,
    variant: 'first-x-tail-spacing-terminated', offset: firstX.TAIL_SPACING_OFFSET});
  value.cases.push(wave('positive'));
  assert.throws(() => early.verifyReport(value, session), /one-positive bound/);
});

test('a canary change outside the measured timing window is not a qualified hit', () => {
  const value = report();
  value.cases[8].rows.find(row => row.role === 'hole').startUs = 3378;
  value.earlyPositive.status = 'unqualified-marker-hit';
  const result = early.verifyReport(value, session);
  assert.equal(result.markerHit, false);
  assert.equal(result.status, 'unqualified-marker-hit');
});

test('rejects a delayed positive despite otherwise qualified receive order', () => {
  const value = report();
  value.cases[8].holeDelayNs = 3400000;
  assert.throws(() => early.verifyReport(value, session), /schedule or read size/);
});

test('rejects a late hole or canary even with a good receive margin', () => {
  const value = report();
  value.cases[3].rows.find(row => row.role === 'hole').startUs = 3378;
  assert.throws(() => early.verifyReport(value, session), /timing control did not qualify|continued without a fresh timing window/);
  value.cases[3].rows.find(row => row.role === 'hole').startUs = 700;
  value.cases[3].rows.find(row => row.role === 'canary').startUs = 2188;
  assert.throws(() => early.verifyReport(value, session), /timing control did not qualify|continued without a fresh timing window/);
});

test('requires the positive read size to match the measured abort control', () => {
  const value = report();
  value.cases[8].readSize = 0x40000;
  assert.throws(() => early.verifyReport(value, session), /schedule or read size/);
});

test('does not mistake later counter samples for a new pin allocation', () => {
  const value = report();
  value.cases[8].pinRequestOpcode = 200;
  assert.throws(() => early.verifyReport(value, session), /schedule or read size/);
});

test('rejects a second positive and a control without a usable early window', () => {
  const value = report();
  value.cases.push(wave('positive'));
  assert.throws(() => early.verifyReport(value, session), /one-positive bound/);
  value.cases.pop();
  value.cases[3].rows.find(row => row.role === 'hole').endUs = 3300;
  assert.throws(() => early.verifyReport(value, session), /continued without a fresh timing window/);
});

test('requires a real initial pin and verified direct paths', () => {
  const value = report();
  value.cases[0].pinRequestOpcode = 1009;
  assert.throws(() => early.verifyReport(value, session), /initial pin/);
  value.cases[0].pinRequestOpcode = 200;
  value.earlyPositive.directControls.after.absent = 0;
  assert.throws(() => early.verifyReport(value, session), /direct marker or absent/);
});

test('rejects a failed large-read preflight before any positive claim', () => {
  const value = report();
  value.holeTimingPreflight.tail.first64Hex = '5a'.repeat(64);
  assert.throws(() => early.verifyReport(value, session), /large-read preflight/);
});

test('rejects uncertain owned-path changes and retained resources', () => {
  const value = report();
  value.cases[8].changedPaths = ['canary', 'guard1'];
  assert.throws(() => early.verifyReport(value, session), /uncertain/);
  value.cases[8].changedPaths = ['canary'];
  value.retained.handles.push(123);
  assert.throws(() => early.verifyReport(value, session), /retained native resources/);
});
