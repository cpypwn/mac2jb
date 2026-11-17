const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {OFFSETS, ATTEMPTS_PER_OFFSET, ABSENT_ATTEMPTS_PER_OFFSET, ABSENT_NAME,
  profileInfo, offsetFromProfile, payloadForOffset, verifyReport} =
  require('./marker-boundary.cjs');
const {EXTENT} = require('./extent-ladder.cjs');
const {main} = require('../../run.cjs');

const scratch = '/NS2_GAP_1234567890123';
const segments = ['S0_1234567890123', 'S1_1234567890123', 'S2_1234567890123'];
const marker = 'SPAN_MARKER';

test('both marker-boundary payloads resolve only to the owned full-depth marker', () => {
  for (const offset of OFFSETS) {
    const {bytes, terminatorOffset, path: ownedPath} =
      payloadForOffset(scratch, segments, marker, offset);
    assert.equal(bytes.length, EXTENT + 1);
    assert.equal(bytes.indexOf(0), offset);
    assert.equal(bytes[EXTENT], 0);
    assert.equal(terminatorOffset, offset);
    assert.equal(bytes.subarray(offset - marker.length, offset).toString(), marker);
    assert.equal(ownedPath, path.posix.join(scratch, ...segments, marker));
    assert.equal(path.posix.normalize(bytes.subarray(0, offset).toString()), ownedPath);
    const absent = payloadForOffset(scratch, segments, marker, offset, ABSENT_NAME);
    assert.equal(absent.bytes.length, bytes.length);
    assert.equal(absent.bytes.indexOf(0), offset);
    assert.equal(absent.path, path.posix.join(scratch, ...segments, ABSENT_NAME));
    assert.equal(path.posix.normalize(absent.bytes.subarray(0, offset).toString()), absent.path);
  }
  assert.equal(offsetFromProfile('marker-boundary-9023'), 9023);
  assert.equal(offsetFromProfile('marker-boundary-9279'), 9279);
  assert.equal(offsetFromProfile('marker-boundary-8191'), null);
  assert.deepEqual(profileInfo('marker-boundary-absent-9023'), {kind: 'absent', offset: 9023});
  assert.deepEqual(profileInfo('marker-boundary-9279'), {kind: 'marker', offset: 9279});
  assert.throws(() => payloadForOffset(scratch, segments, marker, 8191), /Invalid marker boundary/);
  assert.throws(() => payloadForOffset(scratch, segments, marker, 9023, 'OTHER'),
    /Invalid matched marker basename/);
});

test('marker-boundary flag is rejected outside a Gravity Circuit canary run', async () => {
  const previous = process.env.NS2_MARKER_BOUNDARY;
  try {
    process.env.NS2_MARKER_BOUNDARY = '1';
    await assert.rejects(main(['--target', 'civ7', '10.0.0.205']),
      /Marker boundary requires Gravity Circuit canary-only mode/);
    await assert.rejects(main(['--target', 'gravcirc', '10.0.0.205']),
      /Marker boundary requires Gravity Circuit canary-only mode/);
  } finally {
    if (previous === undefined) delete process.env.NS2_MARKER_BOUNDARY;
    else process.env.NS2_MARKER_BOUNDARY = previous;
  }
});

test('matched absent flag requires marker-boundary mode before opening a listener', async () => {
  const previous = process.env.NS2_MARKER_MATCHED_ABSENT;
  try {
    process.env.NS2_MARKER_MATCHED_ABSENT = '1';
    await assert.rejects(main(['--target', 'gravcirc', '--canary-only', '10.0.0.205']),
      /Matched absent path requires the marker boundary diagnostic/);
  } finally {
    if (previous === undefined) delete process.env.NS2_MARKER_MATCHED_ABSENT;
    else process.env.NS2_MARKER_MATCHED_ABSENT = previous;
  }
});

function report(hitAt = null, matchedAbsent = false) {
  const base = {changedPaths: [], restored: true, triggerAborted: false,
    allPending: true, receiveOrderMarginUs: 400, preReleaseUsed: 0x2700,
    selectedMarker: false};
  const controls = [
    {...base, profile: 'abort-control', triggerAborted: true},
    {...base, profile: 'abort-hole-control', triggerAborted: true},
    {...base, profile: 'extent-absent'},
  ];
  const cases = [...controls];
  for (const offset of OFFSETS) {
    if (matchedAbsent) for (let index = 0; index < ABSENT_ATTEMPTS_PER_OFFSET; index++)
      cases.push({...base, profile: `marker-boundary-absent-${offset}`,
        pathTerminatorOffset: offset});
    for (let index = 0; index < ATTEMPTS_PER_OFFSET; index++) {
      const selectedMarker = hitAt?.offset === offset && hitAt?.attempt === index;
      cases.push({...base, profile: `marker-boundary-${offset}`,
        pathTerminatorOffset: offset, selectedMarker});
      if (selectedMarker) break;
    }
    if (cases.at(-1).selectedMarker) break;
  }
  return {session: 'same', target: 'gravcirc', markerBoundaryEnabled: true,
    markerMatchedAbsentEnabled: matchedAbsent,
    extentLadderEnabled: false, markerBoundary: {mode: 'owned-marker-offset',
      matchedAbsent, completed: true, stoppedOnHit: hitAt !== null,
      ...(matchedAbsent ? {absentPathControl: {path: '/scratch/SPAN_ABSENT',
        original: 0x202, cloned: 0x202}} : {})}, completed: true,
    cleanedUp: true, canaryWaveLimit: 16, cases,
    extentMarkerControl: {original: {result: 0, type: 1},
      cloned: {result: 0, type: 1}, padded: {result: 0, type: 1},
      path: '/scratch/SPAN_MARKER'},
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false, released: true}};
}

test('diagnostic requires three clean attempts at each offset without a hit', () => {
  const clean = report();
  assert.deepEqual(verifyReport(clean, 'same'), {diagnostic: 'marker-boundary',
    session: 'same', markerHitOffset: null, cleanedUp: true,
    levels: OFFSETS.map(offset => ({offset, attempts: 3, qualifiedWindows: 3, markerHits: 0}))});
  assert.throws(() => verifyReport({...clean, cases: clean.cases.slice(0, -1)}, 'same'),
    /incomplete levels/);
  assert.throws(() => verifyReport({...clean, retained: {...clean.retained, threads: [1]}},
    'same'), /retained native resources/);
  assert.throws(() => verifyReport({...clean, cleanedUp: false}, 'same'), /did not finish/);
  assert.throws(() => verifyReport({...clean, extentMarkerControl: null}, 'same'),
    /owned-path controls/);
  assert.throws(() => verifyReport({...clean, cases: clean.cases.map(row =>
    row.profile === 'marker-boundary-9279' ? {...row, receiveOrderMarginUs: 0} : row)},
  'same'), /incomplete levels/);
});

test('matched absent controls remain paired with both marker offsets', () => {
  const clean = report(null, true);
  const verified = verifyReport(clean, 'same');
  assert.equal(verified.markerHitOffset, null);
  assert.deepEqual(verified.levels, OFFSETS.map(offset => ({offset, attempts: 3,
    qualifiedWindows: 3, markerHits: 0, absentAttempts: 2, absentQualifiedWindows: 2})));
  assert.throws(() => verifyReport({...clean, cases: clean.cases.filter((row, index) =>
    !(index === 3 && row.profile === 'marker-boundary-absent-9023'))}, 'same'),
  /Matched absent path controls/);
  assert.throws(() => verifyReport({...clean, cases: clean.cases.map(row =>
    row.profile === 'marker-boundary-absent-9279' ? {...row, selectedMarker: true} : row)},
  'same'), /Matched absent path selected/);
  assert.throws(() => verifyReport({...clean, markerMatchedAbsentEnabled: false}, 'same'),
    /did not finish/);
  assert.throws(() => verifyReport({...clean, markerBoundary: {...clean.markerBoundary,
    absentPathControl: {...clean.markerBoundary.absentPathControl, cloned: 0}}}, 'same'),
  /not absent on both owned mounts/);
  assert.throws(() => verifyReport({...clean, markerBoundary: {...clean.markerBoundary,
    absentPathControl: {...clean.markerBoundary.absentPathControl,
      path: '/other/SPAN_ABSENT'}}}, 'same'),
  /not absent on both owned mounts/);
  const outOfOrder = [...clean.cases];
  [outOfOrder[4], outOfOrder[5]] = [outOfOrder[5], outOfOrder[4]];
  assert.throws(() => verifyReport({...clean, cases: outOfOrder}, 'same'),
    /controls are incomplete or out of order/);
  const hit = verifyReport(report({offset: 9023, attempt: 0}, true), 'same');
  assert.equal(hit.markerHitOffset, 9023);
  assert.equal(hit.levels[0].absentAttempts, 2);
  assert.equal(hit.levels[1].attempts, 0);
});

test('verified marker stops the diagnostic before another attempt', () => {
  for (const offset of OFFSETS) {
    const clean = report({offset, attempt: 1});
    const verified = verifyReport(clean, 'same');
    assert.equal(verified.markerHitOffset, offset);
    assert.equal(verified.levels.find(level => level.offset === offset).attempts, 2);
    assert.throws(() => verifyReport({...clean, cases: [...clean.cases,
      {...clean.cases.at(-1), selectedMarker: false}]}, 'same'), /continued after/);
    assert.throws(() => verifyReport({...clean, cases: clean.cases.map((row, index) =>
      index === clean.cases.length - 1 ? {...row, receiveOrderMarginUs: 0} : row)}, 'same'),
    /without a qualified window/);
  }
});
