const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {OFFSET, LAYOUTS, ABSENT_ATTEMPTS, MARKER_ATTEMPTS,
  profileInfo, verifyReport} = require('./marker-assembly.cjs');
const {payloadForOffset, ABSENT_NAME} = require('./marker-boundary.cjs');
const {EXTENT} = require('./extent-ladder.cjs');
const {main} = require('../../run.cjs');

const scratch = '/NS2_GAP_1234567890123';
const segments = ['S0_1234567890123', 'S1_1234567890123', 'S2_1234567890123'];
const marker = 'SPAN_MARKER';

test('matched paths vary only the final component placement at 9023', () => {
  const paths = LAYOUTS.map(layout => {
    const present = payloadForOffset(scratch, segments, marker, OFFSET, marker,
      layout.lastSegmentOffset);
    const absent = payloadForOffset(scratch, segments, marker, OFFSET, ABSENT_NAME,
      layout.lastSegmentOffset);
    for (const item of [present, absent]) {
      assert.equal(item.bytes.length, EXTENT + 1);
      assert.equal(item.bytes.indexOf(0), OFFSET);
      assert.equal(item.bytes[EXTENT], 0);
      assert.equal(path.posix.normalize(item.bytes.subarray(0, OFFSET).toString()), item.path);
      assert.equal(item.bytes.subarray(layout.lastSegmentOffset,
        layout.lastSegmentOffset + segments[2].length + 2).toString(), `/${segments[2]}/`);
    }
    assert.equal(present.path, path.posix.join(scratch, ...segments, marker));
    assert.equal(absent.path, path.posix.join(scratch, ...segments, ABSENT_NAME));
    return {present, absent};
  });
  assert.notDeepEqual(paths[0].present.bytes, paths[1].present.bytes);
  assert.notDeepEqual(paths[0].absent.bytes, paths[1].absent.bytes);
  assert.deepEqual(profileInfo('marker-assembly-baseline-absent-9023'),
    {layout: 'baseline', kind: 'absent', offset: OFFSET, lastSegmentOffset: 0x1800});
  assert.deepEqual(profileInfo('marker-assembly-shifted-marker-9023'),
    {layout: 'shifted', kind: 'marker', offset: OFFSET, lastSegmentOffset: 0x2000});
  assert.equal(profileInfo('marker-assembly-shifted-marker-9279'), null);
});

test('assembly flag is rejected before opening a listener without paired controls', async () => {
  const names = ['NS2_MARKER_ASSEMBLY', 'NS2_MARKER_BOUNDARY', 'NS2_MARKER_MATCHED_ABSENT'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.NS2_MARKER_ASSEMBLY = '1';
    delete process.env.NS2_MARKER_BOUNDARY;
    delete process.env.NS2_MARKER_MATCHED_ABSENT;
    await assert.rejects(main(['--target', 'gravcirc', '--canary-only', '10.0.0.205']),
      /Marker assembly requires matched absent boundary mode/);
    process.env.NS2_MARKER_BOUNDARY = '1';
    await assert.rejects(main(['--target', 'gravcirc', '--canary-only', '10.0.0.205']),
      /Marker assembly requires matched absent boundary mode/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

function report(hitAt = null) {
  const base = {changedPaths: [], restored: true, triggerAborted: false,
    allPending: true, receiveOrderMarginUs: 400, preReleaseUsed: 0x2700,
    selectedMarker: false};
  const cases = [
    {...base, profile: 'abort-control', triggerAborted: true},
    {...base, profile: 'abort-hole-control', triggerAborted: true},
    {...base, profile: 'extent-absent'},
  ];
  for (const layout of LAYOUTS) {
    for (let index = 0; index < ABSENT_ATTEMPTS; index++)
      cases.push({...base, profile: `marker-assembly-${layout.name}-absent-9023`,
        pathTerminatorOffset: OFFSET, lastSegmentOffset: layout.lastSegmentOffset});
    for (let index = 0; index < MARKER_ATTEMPTS; index++) {
      const selectedMarker = hitAt?.layout === layout.name && hitAt?.attempt === index;
      cases.push({...base, profile: `marker-assembly-${layout.name}-marker-9023`,
        pathTerminatorOffset: OFFSET, lastSegmentOffset: layout.lastSegmentOffset,
        selectedMarker});
      if (selectedMarker) break;
    }
    if (cases.at(-1).selectedMarker) break;
  }
  return {session: 'same', target: 'gravcirc', markerBoundaryEnabled: true,
    markerMatchedAbsentEnabled: true, markerAssemblyEnabled: true, extentLadderEnabled: false,
    markerAssembly: {mode: 'final-segment-placement', completed: true,
      stoppedOnHit: hitAt !== null,
      absentPathControl: {path: '/scratch/SPAN_ABSENT', original: 0x202, cloned: 0x202}},
    completed: true, cleanedUp: true, canaryWaveLimit: 16, cases,
    extentMarkerControl: {original: {result: 0, type: 1},
      cloned: {result: 0, type: 1}, padded: {result: 0, type: 1},
      path: '/scratch/SPAN_MARKER'},
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false, released: true}};
}

test('completed comparison requires qualified controls at each placement', () => {
  const clean = report();
  const verified = verifyReport(clean, 'same');
  assert.equal(verified.hitLayout, null);
  assert.equal(verified.cleanedUp, true);
  assert.deepEqual(verified.levels.map(level => [level.absentQualified, level.markerQualified]),
    [[2, 3], [2, 3]]);
  assert.throws(() => verifyReport({...clean, cleanedUp: false}, 'same'), /clean resources/);
  assert.throws(() => verifyReport({...clean, retained: {...clean.retained, threads: [1]}}, 'same'),
    /retained native resources/);
  assert.throws(() => verifyReport({...clean, cases: clean.cases.slice(0, -1)}, 'same'),
    /incomplete/);
  assert.throws(() => verifyReport({...clean, cases: clean.cases.map(row =>
    row.profile === 'marker-assembly-shifted-marker-9023' ?
      {...row, receiveOrderMarginUs: 0} : row)}, 'same'), /paired qualified controls/);
  assert.throws(() => verifyReport({...clean, cases: clean.cases.map(row =>
    row.profile === 'marker-assembly-shifted-absent-9023' ?
      {...row, selectedMarker: true} : row)}, 'same'), /absent path selected/);
});

test('verified hit stops the matched comparison immediately', () => {
  for (const layout of LAYOUTS) {
    const clean = report({layout: layout.name, attempt: 1});
    assert.equal(verifyReport(clean, 'same').hitLayout, layout.name);
    const afterHit = {...clean, cases: [...clean.cases,
      {...clean.cases.at(-1), selectedMarker: false}]};
    assert.throws(() => verifyReport(afterHit, 'same'), /continued after/);
  }
});

test('comparison rejects layout and control-order drift', () => {
  const clean = report();
  const misplaced = [...clean.cases];
  misplaced[3] = {...misplaced[3], lastSegmentOffset: 0x2000};
  assert.throws(() => verifyReport({...clean, cases: misplaced}, 'same'),
    /changed more than/);
  const swapped = [...clean.cases];
  [swapped[4], swapped[5]] = [swapped[5], swapped[4]];
  assert.throws(() => verifyReport({...clean, cases: swapped}, 'same'),
    /paired qualified controls/);
  const wrongOffset = [...clean.cases];
  wrongOffset[3] = {...wrongOffset[3], pathTerminatorOffset: 9279};
  assert.throws(() => verifyReport({...clean, cases: wrongOffset}, 'same'),
    /changed more than/);
});
