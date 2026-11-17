'use strict';

const path = require('node:path');
const {hasWindow} = require('./wave-history.cjs');

const CHUNK_BYTES = 0x800;
const EXTENT = 0x2440;
const CHUNKS = Object.freeze([2, 3, 4]);

function validate(scratch, segments, marker, chunk) {
  if (typeof scratch !== 'string' || !scratch.startsWith('/') || scratch.endsWith('/') ||
      scratch.includes('\0') || !Array.isArray(segments) || segments.length !== 3 ||
      segments.some(part => typeof part !== 'string' || !part || part.includes('/') || part.includes('\0')) ||
      typeof marker !== 'string' || !marker || marker.includes('/') || marker.includes('\0') ||
      !CHUNKS.includes(chunk)) throw Error('Invalid extent ladder target');
  if (![scratch, ...segments, marker].every(part => /^[\x20-\x7e]+$/.test(part)) ||
      Buffer.byteLength(scratch + '/') >= CHUNK_BYTES ||
      segments.some(part => Buffer.byteLength('/' + part + '/') >= CHUNK_BYTES) ||
      Buffer.byteLength(marker) + 1 >= CHUNK_BYTES)
    throw Error('Extent ladder path component exceeds its chunk');
}

function markerPath(scratch, segments, marker, chunk) {
  validate(scratch, segments, marker, chunk);
  return path.posix.join(scratch, ...segments.slice(0, chunk - 1), marker);
}

function payloadForChunk(scratch, segments, marker, chunk) {
  validate(scratch, segments, marker, chunk);
  const terminatorOffset = chunk * CHUNK_BYTES - 1;
  const bytes = Buffer.alloc(EXTENT + 1, '/');
  bytes.write(scratch + '/');
  for (let i = 0; i < segments.length; i++)
    bytes.write('/' + segments[i] + '/', (i + 1) * CHUNK_BYTES);
  bytes.write(marker, terminatorOffset - marker.length);
  bytes[terminatorOffset] = 0;
  bytes[EXTENT] = 0;
  if (bytes.subarray(0, terminatorOffset).includes(0) ||
      path.posix.normalize(bytes.subarray(0, terminatorOffset).toString()) !==
      markerPath(scratch, segments, marker, chunk))
    throw Error('Extent ladder path differs from owned marker');
  return {bytes, terminatorOffset, path: markerPath(scratch, segments, marker, chunk)};
}

function chunkFromProfile(profile) {
  const match = /^extent-ladder-([234])$/.exec(profile);
  return match ? Number(match[1]) : null;
}

function assessRow(row) {
  if (!row || !Array.isArray(row.changedPaths) || row.changedPaths.length ||
      row.restored !== true && row.triggerAborted !== true)
    throw Error('Extent ladder wave did not preserve owned paths and heap state');
  const qualified = hasWindow(row);
  if (row.selectedMarker && !qualified)
    throw Error('Extent ladder marker selected without a qualified window');
  return {qualified, markerHit: qualified && row.selectedMarker === true};
}

function verifyReport(report, session) {
  if (!report || report.session !== session || report.target !== 'gravcirc' ||
      report.extentLadderEnabled !== true ||
      report.extentLadder?.mode !== 'owned-marker-terminator' ||
      report.extentLadder?.completed !== true || report.completed !== true ||
      report.cleanedUp !== true || report.error || report.cleanupError ||
      report.placementUncertain || report.stopped ||
      !Array.isArray(report.cases) || report.canaryWaveLimit !== 16 ||
      report.cases.length > report.canaryWaveLimit ||
      report.cases.some(row => row.profile === 'positive' || row.profile === 'extent-present'))
    throw Error('Extent ladder diagnostic did not finish with clean resources');
  if (!Array.isArray(report.extentLadderControls) || report.extentLadderControls.length !== CHUNKS.length ||
      report.extentLadderControls.some((control, index) => control.chunk !== CHUNKS[index] ||
        [control.original, control.cloned, control.padded].some(item =>
          item?.result !== 0 || item.type !== 1)))
    throw Error('Extent ladder owned marker controls did not verify');
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) || retained.handles.length ||
      !Array.isArray(retained.threads) || retained.threads.length ||
      !Array.isArray(retained.created) || retained.created.length ||
      retained.group || retained.cacheNeedsRestore || retained.released !== true)
    throw Error('Extent ladder diagnostic retained native resources');
  const levels = CHUNKS.map(chunk => {
    const rows = report.cases.filter(row => row.profile === `extent-ladder-${chunk}`);
    if (!rows.length || rows.length > 3 ||
        rows.some(row => row.pathTerminatorOffset !== chunk * CHUNK_BYTES - 1))
      throw Error('Extent ladder diagnostic has incomplete levels');
    const results = rows.map(assessRow);
    return {chunk, attempts: rows.length,
      qualifiedWindows: results.filter(result => result.qualified).length,
      markerHits: results.filter(result => result.markerHit).length};
  });
  return {diagnostic: 'extent-terminator-ladder', session,
    deepestMarkerHit: levels.filter(level => level.markerHits).at(-1)?.chunk ?? null,
    levels, cleanedUp: true};
}

module.exports = {CHUNK_BYTES, EXTENT, CHUNKS, markerPath, payloadForChunk, chunkFromProfile,
  assessRow, verifyReport};
