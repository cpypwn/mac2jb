const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {slashPaddedPath} = require('./paths.cjs');

function extentPieces(scratch, segments, basename) {
  const extent = 0x2440;
  const payload = Buffer.alloc(extent + 1, '/');
  payload.write(scratch + '/');
  for (let i = 0; i < segments.length; i++) payload.write('/' + segments[i] + '/', (i + 1) * 0x800);
  payload.write(basename, extent - basename.length);
  payload[extent] = 0;
  return Array.from({length: 5}, (_, i) => payload.subarray(i * 0x800, Math.min((i + 1) * 0x800, payload.length)));
}

test('five extent pieces assemble the marker path only after the final piece', () => {
  const scratch = '/NS2_GAP_1234567890123';
  const segments = ['S0_1234567890123', 'S1_1234567890123', 'S2_1234567890123'];
  const pieces = extentPieces(scratch, segments, 'SPAN_MARKER');
  assert.deepEqual(pieces.map(piece => piece.length), [0x800, 0x800, 0x800, 0x800, 0x441]);
  const joined = Buffer.concat(pieces);
  assert.equal(joined.length, 0x2441);
  assert.equal(joined.indexOf(0), joined.length - 1);
  assert.equal(path.posix.normalize(joined.subarray(0, -1).toString()),
    path.posix.join(scratch, ...segments, 'SPAN_MARKER'));
  assert.equal(path.posix.normalize(pieces[0].toString()), scratch + '/');
  assert.equal(path.posix.normalize(Buffer.concat(pieces.slice(0, 4)).toString()),
    path.posix.join(scratch, ...segments) + '/');
  assert.equal(pieces[4].includes(Buffer.from('SPAN_MARKER')), true);
});

test('the absent control changes only the final marker name', () => {
  const scratch = '/NS2_GAP_1234567890123';
  const segments = ['S0_1', 'S1_1', 'S2_1'];
  const present = extentPieces(scratch, segments, 'SPAN_MARKER');
  const absent = extentPieces(scratch, segments, 'SPAN_ABSENT');
  for (let i = 0; i < 4; i++) assert.deepEqual(present[i], absent[i]);
  assert.equal(path.posix.normalize(Buffer.concat(absent).subarray(0, 0x2440).toString()),
    path.posix.join(scratch, ...segments, 'SPAN_ABSENT'));
});

test('a single-descriptor padded lookup preserves the canonical marker path', () => {
  const components = ['/NS2_GAP_1234567890123', 'S0_1234567890123',
    'S1_1234567890123', 'S2_1234567890123', 'SPAN_MARKER'];
  const padded = slashPaddedPath(components, 0x7ff);
  assert.equal(padded.length, 0x7ff);
  assert.equal(Buffer.byteLength(padded + '\0'), 0x800);
  assert.equal(path.posix.normalize(padded), components.join('/'));
  assert.equal(padded.endsWith('SPAN_MARKER'), true);
  assert.equal((padded.match(/\/{2,}/g) || []).length, 4);
  assert.throws(() => slashPaddedPath(components, 0x800), /Invalid padded path length/);
});
