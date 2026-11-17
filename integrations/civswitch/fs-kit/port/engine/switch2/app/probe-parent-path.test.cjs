const test = require('node:test');
const assert = require('node:assert/strict');
const probe = require('./probe-parent-path.cjs');

const scratch = '/NS2_GAP_PARENT_012345abcdef';
const marker = {result: 0, canonicalResult: 0, type: 1};
const absent = {result: 0x202, canonicalResult: 0x202, type: null};
const directory = {result: 0, canonicalResult: 0, type: 0};

function fixture() {
  const lookups = probe.plan(scratch).map(row => ({...row,
    ...(row.id === 'direct' ? row.kind === 'marker' ? marker : absent :
      {result: 0x2eec02, canonicalResult: 0x2eec02, type: null})}));
  return {target: 'gravcirc', session: 'owned-session', scratch,
    before: {marker, absent}, after: {marker, absent}, lookups,
    pairs: probe.classify(lookups), scratchAbsent: true, cleanedUp: true};
}

test('parent-path plan compares each exact marker and absent spelling within short input bound', () => {
  const rows = probe.plan(scratch);
  assert.equal(rows.length, 12);
  assert.deepEqual([...new Set(rows.map(row => row.id))], [
    'direct', 'slash-parent', 'backslash-parent', 'backslash-parent-slash',
    'root-backslash-parent', 'root-slash-parent']);
  assert.deepEqual(rows.map(row => row.kind), Array(6).fill(['marker', 'absent']).flat());
  assert.equal(rows[4].path, scratch + '/selected/..\\MARKER');
  assert.equal(rows[8].path, '/..\\' + scratch.slice(1) + '/MARKER');
  assert.ok(rows.every(row => row.pathBytes === Buffer.byteLength(row.path) + 1 &&
    row.pathBytes <= 0x300));
  assert.throws(() => probe.plan('/other'), /Invalid owned scratch/);
});

test('report qualifies direct controls and cleanup while retaining experimental results', () => {
  const report = fixture();
  assert.equal(probe.assess(report), true);
  assert.equal(report.pairs[0].selectedOwnedMarker, true);
  assert.equal(report.pairs[2].selectedOwnedMarker, false);
  report.lookups[4] = {...report.lookups[4], ...marker};
  report.lookups[5] = {...report.lookups[5], ...absent};
  report.pairs = probe.classify(report.lookups);
  assert.equal(probe.assess(report), true);
  assert.equal(report.pairs[2].selectedOwnedMarker, true);
});

test('report rejects changed controls, unowned paths, and incomplete cleanup', () => {
  const report = fixture();
  assert.equal(probe.assess({...report, after: {marker: absent, absent}}), false);
  assert.equal(probe.assess({...report, scratchAbsent: false}), false);
  assert.equal(probe.assess({...report, cleanedUp: false}), false);
  assert.equal(probe.assess({...report, cleanupError: 'failed'}), false);
  assert.equal(probe.assess({...report, scratch: '/other'}), false);
  assert.equal(probe.assess({...report, pairs: []}), false);
  const changed = {...report, lookups: report.lookups.map((row, index) =>
    index === 4 ? {...row, path: '/unowned'} : row)};
  assert.equal(probe.assess(changed), false);
});

test('observation retains exact raw result and reads type only on success', () => {
  assert.deepEqual(probe.observation({result: 0, canonicalResult: 0,
    data: Buffer.from([1, 0, 0, 0])}), marker);
  assert.deepEqual(probe.observation({result: 0x2eec02, canonicalResult: 0x2eec02,
    data: Buffer.alloc(0)}), {result: 0x2eec02, canonicalResult: 0x2eec02, type: null});
  assert.throws(() => probe.observation({result: 0, canonicalResult: 0,
    data: Buffer.alloc(0)}), /lacks an entry type/);
});

test('two-parent plan compares full owned selected path with equal-length absent path', () => {
  const rows = probe.twoParentPlan(scratch);
  assert.equal(rows.length, 8);
  assert.deepEqual([...new Set(rows.map(row => row.id))], [
    'forward', 'backslash-slash', 'backslash-direct', 'backslash-double']);
  assert.equal(rows[0].path, `${scratch}/selected/../../${scratch}/selected`);
  assert.equal(rows[2].path, `${scratch}/selected/..\\/../${scratch}/selected`);
  assert.equal(rows[4].path, `${scratch}/selected/..\\../${scratch}/selected`);
  assert.equal(rows[6].path, `${scratch}/selected/..\\..\\${scratch}/selected`);
  assert.ok(rows.every(row => row.pathBytes <= 0x300));
  assert.ok(rows.every((row, index) => index % 2 === 0 ||
    row.pathBytes === rows[index - 1].pathBytes));
});

test('two-parent report preserves experimental outcomes and enforces direct controls', () => {
  const report = fixture();
  const lookups = probe.twoParentPlan(scratch).map(row => ({...row,
    ...(row.kind === 'selected' ? directory : absent)}));
  const twoParent = {enabled: true, scratch,
    before: {selected: directory, absent}, after: {selected: directory, absent},
    lookups, pairs: probe.classifyTwoParent(lookups)};
  assert.equal(probe.assessTwoParent(twoParent), true);
  assert.equal(probe.assess({...report, twoParentEnabled: true, twoParent}), true);
  const miss = {...twoParent, lookups: lookups.map((row, index) =>
    index === 2 ? {...row, ...absent} : row)};
  miss.pairs = probe.classifyTwoParent(miss.lookups);
  assert.equal(probe.assess({...report, twoParentEnabled: true, twoParent: miss}), true);
  assert.equal(miss.pairs[1].selectedOwnedDirectory, false);
  assert.equal(probe.assess({...report, twoParentEnabled: true,
    twoParent: {...twoParent, after: {selected: absent, absent}}}), false);
});

test('long forward-path sources keep the owned suffix at byte 0x700 in one accepted X descriptor', () => {
  const selected = probe.longForwardBytes(scratch, 'selected');
  const absentSource = probe.longForwardBytes(scratch, 'absent');
  assert.equal(selected.bytes.length, 0x800);
  assert.equal(selected.bytes[0x7ff], 0);
  assert.equal(selected.bytes.subarray(0x700,
    0x700 + Buffer.byteLength(scratch + '/selected')).toString(), scratch + '/selected');
  assert.ok(selected.bytes.subarray(0, 0x7ff).every(byte => byte !== 0));
  assert.ok(selected.path.includes('/selected/../../'));
  assert.equal(selected.path.includes('\\'), false);
  assert.equal(absentSource.bytes.subarray(0x700,
    0x700 + Buffer.byteLength(scratch + '/UNOWNEDX')).toString(), scratch + '/UNOWNEDX');
  assert.equal(selected.pathBytes, 0x800);
  assert.equal(selected.suffixOffset, 0x700);
  assert.equal(absentSource.suffixOffset, 0x700);
  assert.throws(() => probe.longForwardBytes(scratch, 'other'), /Invalid long forward-path kind/);
});

test('long forward-path report requires exact owned directory, absent, hash, and unchanged controls', () => {
  const lookups = ['selected', 'absent'].map(kind => {
    const {bytes, ...source} = probe.longForwardBytes(scratch, kind);
    return {...source, ...(kind === 'selected' ? directory : absent)};
  });
  const longForward = {enabled: true, scratch, before: {selected: directory, absent},
    lookups, after: {selected: directory, absent}};
  assert.equal(probe.assessLongForward(longForward), true);
  assert.equal(probe.assessLongForward({...longForward, lookups: [
    {...lookups[0], sha256: '0'.repeat(64)}, lookups[1]]}), false);
  assert.equal(probe.assessLongForward({...longForward, after: {selected: absent, absent}}), false);
  assert.equal(probe.assessLongForward({...longForward, lookups: [
    {...lookups[0], ...absent}, lookups[1]]}), false);
});
