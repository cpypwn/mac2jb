'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const seam = require('./marker-first-seam.cjs');
const first = require('./marker-first-descriptor.cjs');
const ladder = require('./extent-ladder.cjs');
const {pathPacket} = require('./paths.cjs');
const {main} = require('../../run.cjs');

const scratch = '/NS2_GAP_1234567890123';
const segments = ['S0_1234567890123', 'S1_1234567890123', 'S2_1234567890123'];
const marker = 'SPAN_MARKER';

test('matched seam basename begins in tail0 and uses legal X sizes', () => {
  const present = seam.payload(scratch, segments, marker, marker);
  const absent = seam.payload(scratch, segments, marker, first.ABSENT_NAME);
  for (const item of [present, absent]) {
    assert.equal(item.bytes.length, ladder.EXTENT + 1);
    assert.equal(item.bytes[0x7ff], 0x2f);
    assert.equal(item.bytes.indexOf(0), 0x80b);
    assert.equal(item.bytes[ladder.EXTENT], 0);
    assert.equal(path.posix.normalize(item.bytes.subarray(0, 0x80b).toString()), item.path);
    assert.equal(item.bytes.subarray(0x80c, ladder.EXTENT).every(byte => byte === 0x2f), true);
    assert.doesNotThrow(() => pathPacket(7, Buffer.alloc(0), 0x100000, 0x800));
    assert.doesNotThrow(() => pathPacket(1002, Buffer.alloc(0), 0x102000, 0x800));
    assert.throws(() => pathPacket(7, Buffer.alloc(0), 0x100000, 0x801), /descriptor size/);
  }
  assert.equal(present.bytes.subarray(0, 0x800).toString(),
    absent.bytes.subarray(0, 0x800).toString());
  assert.equal(present.path, path.posix.join(scratch, ...segments, marker));
  assert.equal(absent.path, path.posix.join(scratch, ...segments, first.ABSENT_NAME));
  assert.equal(seam.profileInfo('marker-first-seam-seam-marker').kind, 'marker');
  assert.equal(seam.profileInfo('marker-first-seam-control-absent').location, 'control');
  assert.equal(seam.profileInfo('marker-assembly-baseline-marker-9023'), null);
});

test('first-seam mode rejects other modes before connecting', async () => {
  const names = ['NS2_MARKER_FIRST_SEAM', 'NS2_MARKER_BOUNDARY'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.NS2_MARKER_FIRST_SEAM = '1';
    await assert.rejects(main(['--target', 'gravcirc', '10.0.0.205']), /First-seam diagnostic/);
    process.env.NS2_MARKER_BOUNDARY = '1';
    await assert.rejects(main(['--target', 'gravcirc', '--canary-only', '10.0.0.205']),
      /First-seam diagnostic/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

function fixture(seamMarker = {result: 0, type: 1}, seamAbsent = {result: 0x202, type: null}) {
  const base = {changedPaths: [], restored: true, triggerAborted: false,
    allPending: true, receiveOrderMarginUs: 400, preReleaseUsed: 0x2700,
    selectedMarker: false, extent: ladder.EXTENT};
  const cases = [
    {...base, profile: 'abort-control', triggerAborted: true},
    {...base, profile: 'abort-hole-control', triggerAborted: true},
    {...base, profile: 'extent-absent'},
  ];
  const observations = [];
  for (const [location, count] of [['control', seam.CONTROL_PAIRS], ['seam', seam.SEAM_PAIRS]]) {
    for (let attempt = 0; attempt < count; attempt++) {
      for (const kind of ['marker', 'absent']) {
        const value = kind === 'marker' ?
          location === 'control' ? {result: 0, type: 1} : seamMarker :
          location === 'control' ? {result: 0x202, type: null} : seamAbsent;
        const inline = Buffer.alloc(16);
        inline.writeUInt32LE(value.type ?? 0);
        const row = {...base, profile: `marker-first-seam-${location}-${kind}`,
          pathTerminatorOffset: location === 'control' ? 0x7ff : 0x80b,
          selectedMarker: value.result === 0 && value.type === 1,
          rows: [{role: 'trigger', result: value.result, inline: inline.toString('hex')}]};
        cases.push(row);
        observations.push(seam.observation(row, location, kind, marker));
      }
    }
  }
  return {session: 'same', target: 'gravcirc', markerFirstSeamEnabled: true,
    markerFirstSeam: {marker, completed: true, observations,
      directControls: {before: {marker: {result: 0, type: 1}, absent: 0x202},
        after: {marker: {result: 0, type: 1}, absent: 0x202}}},
    completed: true, cleanedUp: true, canaryWaveLimit: 16, cases,
    extentMarkerControl: {original: {result: 0, type: 1},
      cloned: {result: 0, type: 1}, padded: {result: 0, type: 1}},
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false, released: true}};
}

test('seam report distinguishes direct file hits from FS marker placement', () => {
  const summary = seam.verifyReport(fixture(), 'same');
  assert.equal(summary.controlFileHits, seam.CONTROL_PAIRS);
  assert.equal(summary.seamFileHits, seam.SEAM_PAIRS);
  assert.equal(summary.seamFsMarkerHits, 0);
  const missed = seam.verifyReport(fixture({result: 0, type: 0}), 'same');
  assert.equal(missed.seamFileHits, 0);
  assert.equal(missed.seamFsMarkerHits, 0);
});

test('seam report rejects absent hits, unqualified pairs and retained resources', () => {
  assert.throws(() => fixture({result: 0, type: 1}, {result: 0, type: 1}),
    /marker selection/);
  const clean = fixture();
  assert.throws(() => seam.verifyReport({...clean, cleanedUp: false}, 'same'), /clean resources/);
  assert.throws(() => seam.verifyReport({...clean, retained: {...clean.retained, threads: [1]}}, 'same'),
    /retained native resources/);
  const rows = clean.cases.map(row => row.profile.startsWith('marker-first-seam-seam-absent') ?
    {...row, receiveOrderMarginUs: 0} : row);
  assert.throws(() => seam.verifyReport({...clean, cases: rows}, 'same'), /qualified matched controls/);
});
