const test = require('node:test');
const assert = require('node:assert/strict');
const candidate = require('./valid-parent-positive.cjs');

const scratch = '/NS2_GAP_1234567890123';

test('matched sources have exact 0x700 suffix, 0x7ff NUL, and one separator difference', () => {
  const {negative, positive, changedByteOffset} = candidate.matched(scratch);
  assert.equal(changedByteOffset, 34);
  assert.equal(negative.payload.length, 0x2441);
  assert.equal(positive.payload.length, 0x2441);
  assert.equal(negative.payload[changedByteOffset], 0x2f);
  assert.equal(positive.payload[changedByteOffset], 0x5c);
  assert.equal(negative.payload[0x7ff], 0);
  assert.equal(positive.payload[0x7ff], 0);
  assert.equal(negative.payload[0x2440], 0);
  assert.equal(positive.payload[0x2440], 0);
  assert.equal(positive.payload.subarray(0x700,
    0x700 + Buffer.byteLength(scratch + '/selected')).toString(), scratch + '/selected');
  assert.ok(positive.payload.subarray(0, 0x7ff).every(byte => byte !== 0));
  assert.ok(negative.payload.subarray(0, 0x7ff).every(byte => byte !== 0));
  assert.equal(negative.firstDescriptorSha256,
    '6bff918969ed2715a5cfa8d55f34c526cf45258f4eaf293396f76aea3ffb727e');
  assert.equal(positive.firstDescriptorSha256,
    '29671d1f1b3cb4c875f6cccdff9541e426dc031967dc63d7ce4b00e7a6ced4e5');
  assert.equal(negative.payloadSha256,
    '7a552912ab44c3a89c492bc1a0dd76d8cc04c721c5162fd5d6b1b15ae8294523');
  assert.equal(positive.payloadSha256,
    '11c6a91e15bc139b23e0d94c2196eb35c98832722f88e51aebca076db93ea342');
});

test('short controls use the tested two-parent spelling with equal-length absent suffix', () => {
  const controls = candidate.shortControls(scratch);
  assert.equal(controls.forward.selected,
    `${scratch}/selected/../../${scratch}/selected`);
  assert.equal(controls.backslash.selected,
    `${scratch}/selected/..\\../${scratch}/selected`);
  assert.equal(controls.forward.selected.length, controls.forward.absent.length);
  assert.equal(controls.backslash.selected.length, controls.backslash.absent.length);
  assert.ok(Object.values(controls).every(pair =>
    Buffer.byteLength(pair.selected) + 1 <= 0x300 &&
    Buffer.byteLength(pair.absent) + 1 <= 0x300));
  assert.throws(() => candidate.matched('/other'), /owned scratch root/);
});

function reportFixture(includePositive = true) {
  const matched = candidate.matched(scratch);
  const selected = {result: 0, type: 0};
  const absent = {result: 0x202, type: null};
  const shortPaths = candidate.shortControls(scratch);
  const short = Object.fromEntries(Object.entries(shortPaths).map(([kind, pair]) => [kind,
    {selected: {path: pair.selected, ...selected}, absent: {path: pair.absent, ...absent}}]));
  const longShape = {descriptorBytes: 0x800, suffixOffset: 0x700, terminatorOffset: 0x7ff};
  const side = () => ({short, longForward: {
    selected: {...selected, ...longShape, sha256: matched.negative.firstDescriptorSha256},
    absent: {...absent, ...longShape,
      sha256: candidate.source(scratch, 'absent').firstDescriptorSha256}}});
  const cases = ['negative', ...(includePositive ? ['positive'] : [])].map(profile => ({
    profile, preparedFirstXInputSha256: matched[profile].firstDescriptorSha256,
    preparedPayloadSha256: matched[profile].payloadSha256,
    pathTerminatorOffset: 0x7ff, firstXSuffixOffset: 0x700,
    firstXSeparatorOffset: matched.changedByteOffset,
    firstXPositiveOffset: profile === 'positive' ? 0x700 : undefined,
    extent: 0x2440,
    canaryResult: 0, canaryType: 1, changedPaths: []}));
  return {target: 'gravcirc', scratch, markerOffset: 0x700, extent: 0x2440,
    firstXPositiveEnabled: true, firstXSlashSplitEnabled: true,
    firstXTerminatedEnabled: true, firstXTailSpacingEnabled: true,
    firstXEdgeOffsetEnabled: false, validParentPositiveEnabled: true,
    validParentPositive: {enabled: true, offset: 0x700, descriptorBytes: 0x800,
      terminatorOffset: 0x7ff, changedByteOffset: matched.changedByteOffset,
      negativeFirstDescriptorSha256: matched.negative.firstDescriptorSha256,
      negativePayloadSha256: matched.negative.payloadSha256,
      positiveFirstDescriptorSha256: includePositive ?
        matched.positive.firstDescriptorSha256 : null,
      positivePayloadSha256: includePositive ? matched.positive.payloadSha256 : null,
      controls: {before: side(), after: side()}, markerBytesRetrieved: false,
      canaryObservation: includePositive ? {originalType: 1, result: 0,
        observedType: 1, changedPaths: [], qualifiedTypeTransition: false,
        markerBytesRetrieved: false} : null},
    cases};
}

test('evidence accepts only exact controls, hashes, and one bounded positive layout', () => {
  const report = reportFixture();
  const result = candidate.verifyEvidence(report, report.cases[1]);
  assert.equal(result.variant, 'valid-parent-one-byte-positive');
  assert.equal(result.offset, 0x700);
  assert.equal(result.changedByteOffset, 34);
  assert.equal(candidate.verifyEvidence(reportFixture(false), null)
    .positiveFirstDescriptorSha256, null);
  assert.throws(() => candidate.verifyEvidence({...report,
    validParentPositive: {...report.validParentPositive,
      positiveFirstDescriptorSha256: '0'.repeat(64)}}, report.cases[1]), /input evidence differs/);
  assert.throws(() => candidate.verifyEvidence({...report,
    cases: [report.cases[0], {...report.cases[1], preparedFirstXInputSha256: '0'.repeat(64)}]},
  report.cases[1]), /wave input hash/);
  assert.throws(() => candidate.verifyEvidence({...report,
    validParentPositive: {...report.validParentPositive,
      controls: {...report.validParentPositive.controls,
        after: {...report.validParentPositive.controls.after,
          short: {...report.validParentPositive.controls.after.short,
            backslash: {selected: {result: 0x202, type: null},
              absent: {result: 0x202, type: null}}}}}}},
  report.cases[1]), /owned-path controls differ/);
});
