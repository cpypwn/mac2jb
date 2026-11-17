'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {CHUNKS, markerPath} = require('./extent-ladder.cjs');
const {requestBytes, diagnosticPacket, verifyReport} = require('./direct-length.cjs');

const scratch = '/NS2_GAP_1234567890123';
const segments = ['S0_1234567890123', 'S1_1234567890123', 'S2_1234567890123'];

test('direct controls use equal-sized marker and absent paths at each boundary', () => {
  for (const chunk of CHUNKS) {
    const marker = requestBytes(scratch, segments, 'SPAN_MARKER', chunk);
    const absent = requestBytes(scratch, segments, 'SPAN_ABSENT', chunk);
    assert.equal(marker.bytes.length, chunk * 0x800);
    assert.equal(absent.bytes.length, marker.bytes.length);
    assert.equal(marker.bytes.indexOf(0), chunk * 0x800 - 1);
    assert.equal(absent.bytes.indexOf(0), chunk * 0x800 - 1);
    assert.equal(marker.filename, markerPath(scratch, segments, 'SPAN_MARKER', chunk));
    assert.equal(absent.filename, markerPath(scratch, segments, 'SPAN_ABSENT', chunk));
    assert.notEqual(marker.bytes.compare(absent.bytes), 0);
    const packet = diagnosticPacket(0x123456789n, marker.bytes.length);
    assert.equal(packet.readUInt32LE(8) >>> 16, marker.bytes.length);
    assert.equal(packet.readUInt32LE(12), 0x23456789);
  }
});

test('diagnostic descriptor refuses normal and out-of-range sizes', () => {
  assert.throws(() => diagnosticPacket(0x1000, 0x800), /bounded size/);
  assert.throws(() => diagnosticPacket(0x1000, 0x2001), /bounded size/);
});

test('report only accepts complete owned controls and clean shutdown', () => {
  const levels = CHUNKS.map(chunk => ({chunk, size: chunk * 0x800,
    terminatorOffset: chunk * 0x800 - 1,
    markerPath: markerPath(scratch, segments, 'SPAN_MARKER', chunk),
    absentPath: markerPath(scratch, segments, 'SPAN_ABSENT', chunk),
    before: {marker: {result: 0, type: 1}, absent: {result: 0x202, type: null}},
    direct: {marker: {result: 0x202, type: null},
      absent: {result: 0x202, type: null}},
    after: {marker: {result: 0, type: 1}, absent: {result: 0x202, type: null}},
  }));
  const report = {session: 'boot', target: 'gravcirc', scratch,
    directLengthEnabled: true, completed: true, cleanedUp: true,
    cases: [], directLength: {mode: 'bounded-direct-get-entry-type', segments,
      levels, completed: true},
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false}};
  assert.deepEqual(verifyReport(report, 'boot'), {diagnostic: 'direct-path-length',
    session: 'boot', levels: levels.map(level => ({chunk: level.chunk, size: level.size,
      marker: level.direct.marker, absent: level.direct.absent})), cleanedUp: true});
  assert.throws(() => verifyReport({...report, cleanedUp: false}, 'boot'), /clean resources/);
  assert.throws(() => verifyReport({...report, cases: [{}]}, 'boot'), /clean resources/);
  assert.throws(() => verifyReport({...report, retained: {...report.retained,
    handles: [1]}}, 'boot'), /retained native resources/);
  const badLevels = structuredClone(levels);
  badLevels[0].direct.absent = {result: 0, type: 1};
  assert.throws(() => verifyReport({...report, directLength: {...report.directLength,
    levels: badLevels}}, 'boot'), /owned path controls/);
});
