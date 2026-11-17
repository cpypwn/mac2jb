'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const firstX = require('./first-x-positive.cjs');

const scratch = '/NS2_GAP_1794577529783';

test('candidate sits beyond 0x301 and wholly inside the live accepted 0x800 descriptor', () => {
  const {bytes, selectedDirectory} = firstX.expectedFirstX(scratch);
  assert.equal(bytes.length, 0x800);
  assert.equal(bytes.subarray(0, 4).toString(), '/..\\');
  assert.equal(bytes.indexOf(0), -1);
  assert.ok(firstX.OFFSET > firstX.NORMALIZE_BUFFER_BYTES);
  assert.ok(firstX.OFFSET + Buffer.byteLength(selectedDirectory) < firstX.X_DESCRIPTOR_BYTES);
  assert.equal(bytes.subarray(firstX.OFFSET,
    firstX.OFFSET + selectedDirectory.length).toString(), selectedDirectory);
  const payload = Buffer.alloc(0x2441, '/');
  bytes.copy(payload);
  payload[payload.length - 1] = 0;
  const evidence = firstX.qualifyInput(payload, scratch);
  assert.equal(evidence.offset, 0x340);
  assert.match(evidence.firstDescriptorSha256, /^[0-9a-f]{64}$/);
  payload[firstX.OFFSET] = 'X'.charCodeAt();
  assert.throws(() => firstX.qualifyInput(payload, scratch), /bytes differ/);
});

test('evidence rejects an invented positive wave or changed input digest', () => {
  const {bytes} = firstX.expectedFirstX(scratch);
  const payload = Buffer.alloc(0x2441, '/');
  bytes.copy(payload);
  payload[payload.length - 1] = 0;
  const evidence = firstX.qualifyInput(payload, scratch);
  const report = {target: 'gravcirc', scratch, extent: 0x2440,
    markerOffset: firstX.OFFSET, firstXPositiveEnabled: true,
    firstXPositive: evidence};
  const positive = {profile: 'positive', firstXPositiveOffset: firstX.OFFSET};
  assert.deepEqual(firstX.verifyEvidence(report, positive),
    {variant: 'first-x-positive', offset: firstX.OFFSET});
  assert.throws(() => firstX.verifyEvidence(report), /recorded without a positive wave/);
  assert.throws(() => firstX.verifyEvidence({...report,
    firstXPositive: {...evidence, firstDescriptorSha256: '0'.repeat(64)}}, positive),
  /input hash/);
  assert.throws(() => firstX.verifyEvidence({...report, markerOffset: 0x2340}, positive),
  /mode or geometry/);
});

test('slash split changes only filler components and is bound to the report mode', () => {
  const original = firstX.expectedFirstX(scratch).bytes;
  const split = firstX.expectedFirstX(scratch, true).bytes;
  const separatorOffsets = [0xf0, 0x1e1, 0x2d2];
  const changed = [];
  for (let at = 0; at < original.length; at++)
    if (original[at] !== split[at]) changed.push(at);
  assert.deepEqual(changed, separatorOffsets);
  assert.equal(split.subarray(4, firstX.OFFSET).toString().split('/')
    .every(component => component.length <= firstX.FILL_SEGMENT_BYTES), true);
  const payload = Buffer.alloc(0x2441, '/');
  split.copy(payload);
  payload[payload.length - 1] = 0;
  const evidence = firstX.qualifyInput(payload, scratch, true);
  assert.equal(evidence.fillSegmentBytes, firstX.FILL_SEGMENT_BYTES);
  assert.throws(() => firstX.qualifyInput(payload, scratch), /bytes differ/);
  const report = {target: 'gravcirc', scratch, extent: 0x2440,
    markerOffset: firstX.OFFSET, firstXPositiveEnabled: true,
    firstXSlashSplitEnabled: true, firstXPositive: evidence};
  const positive = {profile: 'positive', firstXPositiveOffset: firstX.OFFSET};
  assert.deepEqual(firstX.verifyEvidence(report, positive),
    {variant: 'first-x-slash-split', offset: firstX.OFFSET});
  assert.throws(() => firstX.verifyEvidence({...report,
    firstXSlashSplitEnabled: false}, positive), /evidence differs/);
});

test('edge placement fits inside the first descriptor and binds an exact digest', () => {
  const {bytes, selectedDirectory} = firstX.expectedFirstX(scratch, true,
    firstX.EDGE_OFFSET);
  assert.equal(firstX.EDGE_OFFSET, 0x7c0);
  assert.equal(bytes.length, firstX.X_DESCRIPTOR_BYTES);
  assert.equal(bytes.subarray(firstX.EDGE_OFFSET,
    firstX.EDGE_OFFSET + selectedDirectory.length).toString(), selectedDirectory);
  assert.equal(bytes.subarray(firstX.EDGE_OFFSET + selectedDirectory.length)
    .every(value => value === '/'.charCodeAt()), true);
  const payload = Buffer.alloc(0x2441, '/');
  bytes.copy(payload);
  payload[payload.length - 1] = 0;
  const evidence = firstX.qualifyInput(payload, scratch, true, firstX.EDGE_OFFSET);
  assert.equal(evidence.firstDescriptorSha256,
    'a099eba4952bf7928b4ea06d476a4bb54d6b5779a995e72b5868399f37024f4f');
  const report = {target: 'gravcirc', scratch, extent: 0x2440,
    markerOffset: firstX.EDGE_OFFSET, firstXPositiveEnabled: true,
    firstXSlashSplitEnabled: true, firstXEdgeOffsetEnabled: true,
    firstXPositive: evidence};
  const positive = {profile: 'positive', firstXPositiveOffset: firstX.EDGE_OFFSET};
  assert.deepEqual(firstX.verifyEvidence(report, positive),
    {variant: 'first-x-edge-slash-split', offset: firstX.EDGE_OFFSET});
  assert.throws(() => firstX.verifyEvidence({...report,
    firstXEdgeOffsetEnabled: false}, positive), /mode or geometry/);
  assert.throws(() => firstX.verifyEvidence({...report,
    firstXSlashSplitEnabled: false}, positive), /slash-split mode/);
  assert.throws(() => firstX.qualifyInput(payload, scratch, true, firstX.OFFSET),
    /bytes differ/);
});

test('terminated comparison changes only byte 0x7ff and binds that fact', () => {
  const prior = firstX.expectedFirstX(scratch, true).bytes;
  const terminated = firstX.expectedFirstX(scratch, true, firstX.OFFSET, true).bytes;
  const changed = [];
  for (let at = 0; at < prior.length; at++)
    if (prior[at] !== terminated[at]) changed.push(at);
  assert.deepEqual(changed, [0x7ff]);
  assert.equal(terminated.subarray(0, 0x7ff).includes(0), false);
  assert.equal(terminated[0x7ff], 0);
  const payload = Buffer.alloc(0x2441, '/');
  terminated.copy(payload);
  payload[payload.length - 1] = 0;
  const evidence = firstX.qualifyInput(payload, scratch, true, firstX.OFFSET, true);
  assert.equal(evidence.terminatorOffset, 0x7ff);
  assert.equal(evidence.firstDescriptorSha256,
    '8bd4d7c2da3a977eecade52d14e3ba88d180da2ed1cc4144cbf422e4b5a3e0c5');
  const report = {target: 'gravcirc', scratch, extent: 0x2440,
    markerOffset: firstX.OFFSET, firstXPositiveEnabled: true,
    firstXSlashSplitEnabled: true, firstXTerminatedEnabled: true,
    firstXPositive: evidence};
  const positive = {profile: 'positive', firstXPositiveOffset: firstX.OFFSET,
    pathTerminatorOffset: 0x7ff};
  assert.deepEqual(firstX.verifyEvidence(report, positive),
    {variant: 'first-x-terminated-slash-split', offset: firstX.OFFSET});
  assert.throws(() => firstX.verifyEvidence({...report,
    firstXTerminatedEnabled: false}, positive), /evidence differs/);
  assert.throws(() => firstX.verifyEvidence({...report,
    firstXEdgeOffsetEnabled: true, markerOffset: firstX.EDGE_OFFSET}, positive),
  /slash-split mode/);
});

test('tail-spacing placement preserves the original terminator distance', () => {
  const {bytes, selectedDirectory} = firstX.expectedFirstX(scratch, true,
    firstX.TAIL_SPACING_OFFSET, true);
  assert.equal(firstX.TAIL_SPACING_OFFSET, 0x700);
  assert.equal(0x7ff - firstX.TAIL_SPACING_OFFSET, 0xff);
  assert.equal(0x2440 - firstX.REFERENCE_OFFSET, 0x100);
  assert.equal(bytes.subarray(firstX.TAIL_SPACING_OFFSET,
    firstX.TAIL_SPACING_OFFSET + selectedDirectory.length).toString(),
  selectedDirectory);
  assert.equal(bytes.subarray(0, 0x7ff).includes(0), false);
  assert.equal(bytes[0x7ff], 0);
  const payload = Buffer.alloc(0x2441, '/');
  bytes.copy(payload);
  payload[payload.length - 1] = 0;
  const evidence = firstX.qualifyInput(payload, scratch, true,
    firstX.TAIL_SPACING_OFFSET, true);
  assert.equal(evidence.firstDescriptorSha256,
    '844d1c563fbe34d3ace53fb7d0c93996c4fcb079826b277a3bd5f3ab5d896cd6');
  const report = {target: 'gravcirc', scratch, extent: 0x2440,
    markerOffset: firstX.TAIL_SPACING_OFFSET, firstXPositiveEnabled: true,
    firstXSlashSplitEnabled: true, firstXTerminatedEnabled: true,
    firstXTailSpacingEnabled: true, firstXPositive: evidence};
  const positive = {profile: 'positive',
    firstXPositiveOffset: firstX.TAIL_SPACING_OFFSET, pathTerminatorOffset: 0x7ff};
  assert.deepEqual(firstX.verifyEvidence(report, positive),
    {variant: 'first-x-tail-spacing-terminated', offset: firstX.TAIL_SPACING_OFFSET});
  assert.throws(() => firstX.verifyEvidence({...report,
    firstXTailSpacingEnabled: false}, positive), /mode or geometry/);
  assert.throws(() => firstX.verifyEvidence({...report,
    firstXTerminatedEnabled: false}, positive), /slash-split mode/);
});
