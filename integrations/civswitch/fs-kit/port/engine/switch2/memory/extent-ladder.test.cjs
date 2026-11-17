const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {CHUNK_BYTES, EXTENT, CHUNKS, markerPath, payloadForChunk, chunkFromProfile, assessRow,
  verifyReport} =
  require('./extent-ladder.cjs');

const scratch = '/NS2_GAP_1234567890123';
const segments = ['S0_1234567890123', 'S1_1234567890123', 'S2_1234567890123'];
const marker = 'SPAN_MARKER';

test('each bounded ladder path ends at an owned marker in the requested chunk', () => {
  for (const chunk of CHUNKS) {
    const result = payloadForChunk(scratch, segments, marker, chunk);
    const {bytes, terminatorOffset} = result;
    assert.equal(bytes.length, EXTENT + 1);
    assert.equal(terminatorOffset, chunk * CHUNK_BYTES - 1);
    assert.equal(bytes.indexOf(0), terminatorOffset);
    assert.equal(bytes[EXTENT], 0);
    assert.deepEqual([...bytes.subarray(0, terminatorOffset)].filter(value => value === 0), []);
    assert.equal(path.posix.normalize(bytes.subarray(0, terminatorOffset).toString()),
      path.posix.join(scratch, ...segments.slice(0, chunk - 1), marker));
    assert.equal(result.path, markerPath(scratch, segments, marker, chunk));
    assert.equal(bytes.subarray(terminatorOffset - marker.length, terminatorOffset).toString(), marker);
    assert.equal(bytes.subarray(0, CHUNK_BYTES).includes(0), false);
    assert.equal(bytes.subarray(terminatorOffset + 1, EXTENT).includes(0), false);
  }
});

test('ladder paths are limited to chunks two through four', () => {
  assert.equal(chunkFromProfile('extent-ladder-2'), 2);
  assert.equal(chunkFromProfile('extent-ladder-4'), 4);
  assert.equal(chunkFromProfile('extent-present'), null);
  assert.equal(chunkFromProfile('extent-ladder-5'), null);
  assert.throws(() => payloadForChunk(scratch, segments, marker, 5), /Invalid extent ladder target/);
  assert.throws(() => payloadForChunk(scratch, segments, 'bad/name', 2), /Invalid extent ladder target/);
  assert.throws(() => payloadForChunk(scratch, segments, 'nonasciié', 2), /exceeds its chunk/);
  assert.throws(() => payloadForChunk('/' + 'x'.repeat(CHUNK_BYTES), segments, marker, 2),
    /exceeds its chunk/);
});

test('marker hits require an unchanged, restored, qualified window', () => {
  const row = {changedPaths: [], restored: true, triggerAborted: false, allPending: true,
    receiveOrderMarginUs: 310, preReleaseUsed: 0x2600, selectedMarker: true};
  assert.deepEqual(assessRow(row), {qualified: true, markerHit: true});
  assert.deepEqual(assessRow({...row, selectedMarker: false}), {qualified: true, markerHit: false});
  assert.deepEqual(assessRow({...row, triggerAborted: true, selectedMarker: false}),
    {qualified: false, markerHit: false});
  assert.throws(() => assessRow({...row, receiveOrderMarginUs: 299}), /without a qualified window/);
  assert.throws(() => assessRow({...row, changedPaths: ['canary']}), /preserve owned paths/);
  assert.throws(() => assessRow({...row, restored: false}), /preserve owned paths/);
});

test('the diagnostic report proves only observed marker depth after clean shutdown', () => {
  const row = {changedPaths: [], restored: true, triggerAborted: false, allPending: true,
    receiveOrderMarginUs: 310, preReleaseUsed: 0x2600, selectedMarker: false};
  const report = {session: 'same', target: 'gravcirc', extentLadderEnabled: true,
    extentLadder: {mode: 'owned-marker-terminator', completed: true},
    extentLadderControls: CHUNKS.map(chunk => ({chunk,
      original: {result: 0, type: 1}, cloned: {result: 0, type: 1},
      padded: {result: 0, type: 1}})),
    completed: true, cleanedUp: true, canaryWaveLimit: 16,
    cases: CHUNKS.map(chunk => ({...row, profile: `extent-ladder-${chunk}`,
      pathTerminatorOffset: chunk * CHUNK_BYTES - 1, selectedMarker: chunk === 2})),
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false, released: true}};
  assert.deepEqual(verifyReport(report, 'same'), {
    diagnostic: 'extent-terminator-ladder', session: 'same', deepestMarkerHit: 2,
    levels: CHUNKS.map(chunk => ({chunk, attempts: 1, qualifiedWindows: 1,
      markerHits: chunk === 2 ? 1 : 0})), cleanedUp: true});
  assert.throws(() => verifyReport(report, 'other'), /did not finish/);
  assert.throws(() => verifyReport({...report, cleanedUp: false}, 'same'), /did not finish/);
  assert.throws(() => verifyReport({...report, retained: {...report.retained, handles: [1]}}, 'same'),
    /retained native resources/);
  assert.throws(() => verifyReport({...report, retained: {...report.retained, released: false}}, 'same'),
    /retained native resources/);
  assert.throws(() => verifyReport({...report, cases: report.cases.slice(0, 2)}, 'same'),
    /incomplete levels/);
  assert.throws(() => verifyReport({...report,
    extentLadderControls: report.extentLadderControls.slice(1)}, 'same'), /owned marker controls/);
  assert.throws(() => verifyReport({...report,
    cases: [...report.cases, {...row, profile: 'positive'}]}, 'same'), /did not finish/);
});
