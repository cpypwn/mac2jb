const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {TERMINATOR_OFFSET, ATTEMPTS_PER_KIND, ABSENT_NAME,
  kindFromProfile, payload, verifyReport} = require('./marker-first-descriptor.cjs');
const {EXTENT} = require('./extent-ladder.cjs');
const {main} = require('../../run.cjs');

const scratch = '/NS2_GAP_1234567890123';
const segments = ['S0_1234567890123', 'S1_1234567890123', 'S2_1234567890123'];
const marker = 'SPAN_MARKER';

test('matched first-descriptor paths end before the four tail chunks', () => {
  const present = payload(scratch, segments, marker, marker);
  const absent = payload(scratch, segments, marker, ABSENT_NAME);
  for (const item of [present, absent]) {
    assert.equal(item.bytes.length, EXTENT + 1);
    assert.equal(item.bytes.indexOf(0), TERMINATOR_OFFSET);
    assert.equal(item.bytes[EXTENT], 0);
    assert.equal(item.terminatorOffset, TERMINATOR_OFFSET);
    assert.equal(path.posix.normalize(item.bytes.subarray(0, TERMINATOR_OFFSET).toString()), item.path);
    assert.equal(item.bytes.subarray(TERMINATOR_OFFSET + 1, EXTENT).every(byte => byte === 0x2f), true);
  }
  assert.equal(present.path, path.posix.join(scratch, ...segments, marker));
  assert.equal(absent.path, path.posix.join(scratch, ...segments, ABSENT_NAME));
  assert.equal(present.bytes.subarray(0, TERMINATOR_OFFSET).toString().replace(marker, ABSENT_NAME),
    absent.bytes.subarray(0, TERMINATOR_OFFSET).toString());
  assert.equal(kindFromProfile('marker-first-descriptor-marker'), 'marker');
  assert.equal(kindFromProfile('marker-first-descriptor-absent'), 'absent');
  assert.equal(kindFromProfile('marker-assembly-baseline-marker-9023'), null);
  assert.throws(() => payload(scratch, segments, marker, 'WRONG'), /matched/);
});

test('first-descriptor mode rejects unrelated or unbounded modes before connecting', async () => {
  const names = ['NS2_MARKER_FIRST_DESCRIPTOR', 'NS2_MARKER_BOUNDARY'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.NS2_MARKER_FIRST_DESCRIPTOR = '1';
    await assert.rejects(main(['--target', 'gravcirc', '10.0.0.205']),
      /First-descriptor diagnostic requires Gravity Circuit canary-only mode/);
    process.env.NS2_MARKER_BOUNDARY = '1';
    await assert.rejects(main(['--target', 'gravcirc', '--canary-only', '10.0.0.205']),
      /First-descriptor diagnostic requires Gravity Circuit canary-only mode/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

function fixture(markerResult = {result: 0, type: 1}, absentResult = {result: 0x202, type: null}) {
  const base = {changedPaths: [], restored: true, triggerAborted: false,
    allPending: true, receiveOrderMarginUs: 400, preReleaseUsed: 0x2700,
    selectedMarker: false};
  const cases = [
    {...base, profile: 'abort-control', triggerAborted: true},
    {...base, profile: 'abort-hole-control', triggerAborted: true},
    {...base, profile: 'extent-absent'},
  ];
  const attempts = [];
  for (let index = 0; index < ATTEMPTS_PER_KIND; index++) {
    for (const kind of ['marker', 'absent']) {
      const value = kind === 'marker' ? markerResult : absentResult;
      const selectedMarker = value.result === 0 && value.type === 1;
      const inline = Buffer.alloc(16);
      inline.writeUInt32LE(value.type ?? 0);
      cases.push({...base, profile: `marker-first-descriptor-${kind}`,
        pathTerminatorOffset: TERMINATOR_OFFSET, extent: EXTENT,
        selectedMarker,
        rows: [{role: 'trigger', result: value.result,
          inline: inline.toString('hex')}]});
      attempts.push({caseIndex: cases.length - 1, kind, triggerResult: value.result,
        triggerType: value.type, qualified: true, markerHit: selectedMarker});
    }
  }
  return {session: 'same', target: 'gravcirc', markerFirstDescriptorEnabled: true,
    markerBoundaryEnabled: false, markerAssemblyEnabled: false, extentLadderEnabled: false,
    markerFirstDescriptor: {mode: 'matched-first-descriptor', completed: true,
      directControls: {before: {marker: {result: 0, type: 1}, absent: 0x202},
        after: {marker: {result: 0, type: 1}, absent: 0x202}},
      attempts},
    completed: true, cleanedUp: true, canaryWaveLimit: 16, cases,
    extentMarkerControl: {original: {result: 0, type: 1},
      cloned: {result: 0, type: 1}, padded: {result: 0, type: 1}},
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false, released: true}};
}

test('matched native wave reports a file hit and missing sibling', () => {
  const summary = verifyReport(fixture(), 'same');
  assert.equal(summary.markerHits, ATTEMPTS_PER_KIND);
  assert.equal(summary.absentMisses, ATTEMPTS_PER_KIND);
  assert.equal(summary.cleanedUp, true);
});

test('directory responses remain diagnostic rather than a verified marker', () => {
  const summary = verifyReport(fixture({result: 0, type: 0}, {result: 0, type: 0}), 'same');
  assert.equal(summary.markerHits, 0);
  assert.equal(summary.absentMisses, 0);
});

test('report rejects incomplete, unqualified or changed-path waves', () => {
  const good = fixture();
  assert.throws(() => verifyReport({...good, cleanedUp: false}, 'same'), /clean resources/);
  assert.throws(() => verifyReport({...good, retained: {...good.retained, threads: [1]}}, 'same'),
    /retained native resources/);
  assert.throws(() => verifyReport({...good, cases: good.cases.slice(0, -1)}, 'same'),
    /clean resources/);
  const unqualified = {...good, cases: good.cases.map(row => row.profile ===
    'marker-first-descriptor-absent' ? {...row, receiveOrderMarginUs: 0} : row)};
  assert.throws(() => verifyReport(unqualified, 'same'), /attempt report differs|no qualified/);
  const changed = [...good.cases];
  changed[3] = {...changed[3], changedPaths: ['canary']};
  assert.throws(() => verifyReport({...good, cases: changed}, 'same'), /path integrity/);
  const falseFile = fixture({result: 0, type: 1}, {result: 0, type: 1});
  assert.throws(() => verifyReport(falseFile, 'same'), /absent path selected/);
});
