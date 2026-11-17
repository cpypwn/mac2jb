'use strict';

const path = require('node:path');
const ladder = require('./extent-ladder.cjs');
const firstDescriptor = require('./marker-first-descriptor.cjs');
const {slashPaddedPath} = require('./paths.cjs');
const {hasWindow, markerHit} = require('./wave-history.cjs');

const BASENAME_OFFSET = ladder.CHUNK_BYTES;
const SEAM_PAIRS = 3;
const CONTROL_PAIRS = 2;

function profileInfo(profile) {
  const match = /^marker-first-seam-(control|seam)-(marker|absent)$/.exec(profile);
  return match ? {location: match[1], kind: match[2]} : null;
}

function payload(scratch, segments, marker, name) {
  if (name !== marker && name !== firstDescriptor.ABSENT_NAME ||
      Buffer.byteLength(name) !== Buffer.byteLength(marker))
    throw Error('Invalid matched seam basename');
  const prefix = slashPaddedPath([scratch, ...segments], BASENAME_OFFSET - 1) + '/';
  const ownedPath = path.posix.join(scratch, ...segments, name);
  const bytes = Buffer.alloc(ladder.EXTENT + 1, '/');
  bytes.write(prefix);
  bytes.write(name, BASENAME_OFFSET);
  const terminatorOffset = BASENAME_OFFSET + Buffer.byteLength(name);
  bytes[terminatorOffset] = 0;
  bytes[ladder.EXTENT] = 0;
  if (bytes[BASENAME_OFFSET - 1] !== 0x2f || bytes.subarray(0, BASENAME_OFFSET).includes(0) ||
      bytes.subarray(BASENAME_OFFSET, terminatorOffset).toString() !== name ||
      path.posix.normalize(bytes.subarray(0, terminatorOffset).toString()) !== ownedPath)
    throw Error('Seam path differs from owned marker');
  return {bytes, path: ownedPath, terminatorOffset};
}

function observation(row, location, kind, marker) {
  if (row.profile !== `marker-first-seam-${location}-${kind}` ||
      !Array.isArray(row.changedPaths) || row.changedPaths.some(item => item !== 'canary') ||
      row.restored !== true && row.triggerAborted !== true || row.extent !== ladder.EXTENT ||
      row.pathTerminatorOffset !== (location === 'control' ?
        firstDescriptor.TERMINATOR_OFFSET : BASENAME_OFFSET + Buffer.byteLength(marker)))
    throw Error('First-seam wave integrity differs');
  const trigger = row.rows?.find(item => item.role === 'trigger');
  if (!trigger || typeof trigger.inline !== 'string') throw Error('First-seam trigger is missing');
  const type = trigger.result === 0 ? Buffer.from(trigger.inline, 'hex').readUInt32LE() : null;
  const qualified = hasWindow(row);
  const fileHit = qualified && trigger.result === 0 && type === 1;
  const fsMarkerHit = markerHit(row);
  if (row.selectedMarker !== (trigger.result === 0 && type === 1) ||
      row.selectedMarker && !qualified || kind === 'absent' && (fileHit || fsMarkerHit))
    throw Error('First-seam marker selection differs from the owned control');
  return {location, kind, qualified, triggerResult: trigger.result,
    triggerType: type, fileHit, fsMarkerHit};
}

function verifyReport(report, session) {
  if (!report || report.session !== session || report.target !== 'gravcirc' ||
      report.markerFirstSeamEnabled !== true || report.completed !== true ||
      report.markerFirstSeam?.completed !== true || report.cleanedUp !== true ||
      report.error || report.cleanupError || report.placementUncertain || report.stopped ||
      report.canaryWaveLimit !== 16 || !Array.isArray(report.cases) ||
      report.cases.length > report.canaryWaveLimit)
    throw Error('First-seam diagnostic did not finish with clean resources');
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) || retained.handles.length ||
      !Array.isArray(retained.threads) || retained.threads.length ||
      !Array.isArray(retained.created) || retained.created.length ||
      retained.group || retained.cacheNeedsRestore || retained.released !== true)
    throw Error('First-seam diagnostic retained native resources');
  const control = report.extentMarkerControl;
  if (!control || [control.original, control.cloned, control.padded].some(item =>
    item?.result !== 0 || item.type !== 1) ||
      !report.cases.some(row => row.profile === 'abort-control' && row.triggerAborted) ||
      !report.cases.some(row => row.profile === 'abort-hole-control' && row.triggerAborted) ||
      !report.cases.some(row => row.profile === 'extent-absent' && row.selectedMarker === false &&
        Array.isArray(row.changedPaths) && row.changedPaths.length === 0))
    throw Error('First-seam owned-path controls did not verify');
  const direct = report.markerFirstSeam.directControls;
  for (const side of [direct?.before, direct?.after])
    if (side?.marker?.result !== 0 || side.marker.type !== 1 || side.absent !== 0x202)
      throw Error('First-seam direct-path controls changed');
  const expected = [
    ...Array.from({length: CONTROL_PAIRS}, () => ['control-marker', 'control-absent']).flat(),
    ...Array.from({length: SEAM_PAIRS}, () => ['seam-marker', 'seam-absent']).flat(),
  ];
  const rows = report.cases.slice(3);
  if (report.cases.length !== 3 + expected.length ||
      rows.some((row, index) => row.profile !== `marker-first-seam-${expected[index]}`))
    throw Error('First-seam diagnostic wave order differs');
  const observations = rows.map(row => {
    const info = profileInfo(row.profile);
    return observation(row, info.location, info.kind, report.markerFirstSeam.marker);
  });
  if (['control', 'seam'].some(location =>
    ['marker', 'absent'].some(kind => !observations.some(row =>
      row.location === location && row.kind === kind && row.qualified))))
    throw Error('First-seam comparison lacks qualified matched controls');
  const recorded = report.markerFirstSeam.observations;
  if (!Array.isArray(recorded) || recorded.length !== observations.length ||
      recorded.some((row, index) => JSON.stringify(row) !== JSON.stringify(observations[index])))
    throw Error('First-seam recorded observations differ');
  return {diagnostic: 'marker-first-seam', session,
    controlFileHits: observations.filter(row => row.location === 'control' && row.fileHit).length,
    seamFileHits: observations.filter(row => row.location === 'seam' && row.fileHit).length,
    seamFsMarkerHits: observations.filter(row => row.location === 'seam' && row.fsMarkerHit).length,
    observations, cleanedUp: true};
}

module.exports = {BASENAME_OFFSET, CONTROL_PAIRS, SEAM_PAIRS,
  profileInfo, payload, observation, verifyReport};
