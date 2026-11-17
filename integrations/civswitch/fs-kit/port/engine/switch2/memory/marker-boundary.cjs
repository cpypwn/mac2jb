'use strict';

const path = require('node:path');
const ladder = require('./extent-ladder.cjs');

const OFFSETS = Object.freeze([0x233f, 0x243f]);
const ATTEMPTS_PER_OFFSET = 3;
const ABSENT_ATTEMPTS_PER_OFFSET = 2;
const ABSENT_NAME = 'SPAN_ABSENT';

function profileInfo(profile) {
  const match = /^marker-boundary-(absent-)?(9023|9279)$/.exec(profile);
  return match ? {kind: match[1] ? 'absent' : 'marker', offset: Number(match[2])} : null;
}

function offsetFromProfile(profile) {
  return profileInfo(profile)?.offset ?? null;
}

function payloadForOffset(scratch, segments, marker, offset, name = marker,
  lastSegmentOffset = 3 * ladder.CHUNK_BYTES) {
  if (!OFFSETS.includes(offset)) throw Error('Invalid marker boundary offset');
  if (![3, 4].map(index => index * ladder.CHUNK_BYTES).includes(lastSegmentOffset))
    throw Error('Invalid final path segment offset');
  if (name !== marker && name !== ABSENT_NAME ||
      Buffer.byteLength(name) !== Buffer.byteLength(marker))
    throw Error('Invalid matched marker basename');
  const ownedPath = name === marker ? ladder.markerPath(scratch, segments, marker, 4) :
    path.posix.join(scratch, ...segments, name);
  const bytes = Buffer.alloc(ladder.EXTENT + 1, '/');
  bytes.write(scratch + '/');
  for (let index = 0; index < segments.length; index++)
    bytes.write('/' + segments[index] + '/', index === segments.length - 1 ?
      lastSegmentOffset : (index + 1) * ladder.CHUNK_BYTES);
  bytes.write(name, offset - Buffer.byteLength(name));
  bytes[offset] = 0;
  bytes[ladder.EXTENT] = 0;
  if (bytes.subarray(0, offset).includes(0) ||
      path.posix.normalize(bytes.subarray(0, offset).toString()) !== ownedPath)
    throw Error('Marker boundary path differs from owned marker');
  return {bytes, terminatorOffset: offset, path: ownedPath};
}

function verifyReport(report, session) {
  if (!report || report.session !== session || report.target !== 'gravcirc' ||
      report.markerBoundaryEnabled !== true || report.extentLadderEnabled === true ||
      report.markerBoundary?.mode !== 'owned-marker-offset' ||
      Boolean(report.markerBoundary.matchedAbsent) !==
        Boolean(report.markerMatchedAbsentEnabled) ||
      report.markerBoundary?.completed !== true || report.completed !== true ||
      report.cleanedUp !== true || report.error || report.cleanupError ||
      report.placementUncertain || report.stopped ||
      !Array.isArray(report.cases) || report.canaryWaveLimit !== 16 ||
      report.cases.length > report.canaryWaveLimit)
    throw Error('Marker boundary diagnostic did not finish with clean resources');
  const control = report.extentMarkerControl;
  if (!control || [control.original, control.cloned, control.padded].some(item =>
    item?.result !== 0 || item.type !== 1) ||
    !report.cases.some(row => row.profile === 'abort-control' && row.triggerAborted === true) ||
    !report.cases.some(row => row.profile === 'abort-hole-control' && row.triggerAborted === true) ||
    !report.cases.some(row => row.profile === 'extent-absent' && row.selectedMarker === false &&
      Array.isArray(row.changedPaths) && row.changedPaths.length === 0))
    throw Error('Marker boundary owned-path controls did not verify');
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) || retained.handles.length ||
      !Array.isArray(retained.threads) || retained.threads.length ||
      !Array.isArray(retained.created) || retained.created.length ||
      retained.group || retained.cacheNeedsRestore || retained.released !== true)
    throw Error('Marker boundary diagnostic retained native resources');
  const matchedAbsent = report.markerMatchedAbsentEnabled === true;
  if (matchedAbsent && (report.markerBoundary.absentPathControl?.original !== 0x202 ||
      report.markerBoundary.absentPathControl?.cloned !== 0x202 ||
      report.markerBoundary.absentPathControl.path !==
        path.posix.join(path.posix.dirname(report.extentMarkerControl.path), ABSENT_NAME)))
    throw Error('Matched absent path was not absent on both owned mounts');
  const rows = report.cases.filter(row => profileInfo(row.profile));
  if (report.cases.some(row => !['abort-control', 'abort-hole-control', 'extent-absent'].includes(row.profile) &&
      offsetFromProfile(row.profile) === null))
    throw Error('Marker boundary diagnostic contains an unexpected wave');
  let previous = -1;
  const assessed = rows.map(row => {
    const info = profileInfo(row.profile);
    const index = OFFSETS.indexOf(info.offset);
    if (index < previous || row.pathTerminatorOffset !== OFFSETS[index])
      throw Error('Marker boundary diagnostic has invalid wave order or offset');
    previous = index;
    const result = ladder.assessRow(row);
    if (info.kind === 'absent' && (!matchedAbsent || result.markerHit))
      throw Error('Matched absent path selected an owned marker');
    return {offset: OFFSETS[index], kind: info.kind, ...result};
  });
  const hitIndex = assessed.findIndex(row => row.kind === 'marker' && row.markerHit);
  if (hitIndex >= 0 && hitIndex !== rows.length - 1)
    throw Error('Marker boundary diagnostic continued after a verified marker hit');
  const levels = OFFSETS.map(offset => {
    const markerRows = assessed.filter(row => row.offset === offset && row.kind === 'marker');
    const absentRows = assessed.filter(row => row.offset === offset && row.kind === 'absent');
    const result = {offset, attempts: markerRows.length,
      qualifiedWindows: markerRows.filter(row => row.qualified).length,
      markerHits: markerRows.filter(row => row.markerHit).length};
    if (matchedAbsent) {
      result.absentAttempts = absentRows.length;
      result.absentQualifiedWindows = absentRows.filter(row => row.qualified).length;
    }
    return result;
  });
  if (matchedAbsent && OFFSETS.some(offset => {
    const profiles = rows.filter(row => offsetFromProfile(row.profile) === offset)
      .map(row => profileInfo(row.profile).kind);
    const absentCount = profiles.filter(kind => kind === 'absent').length;
    return profiles.length && (absentCount !== ABSENT_ATTEMPTS_PER_OFFSET ||
      profiles.slice(0, absentCount).some(kind => kind !== 'absent') ||
      profiles.slice(absentCount).some(kind => kind !== 'marker'));
  })) throw Error('Matched absent path controls are incomplete or out of order');
  if (!levels[0].attempts || levels.some(level => level.attempts > ATTEMPTS_PER_OFFSET ||
      (level.attempts > 0 && level.qualifiedWindows === 0)) ||
      matchedAbsent && levels.some(level => level.attempts > 0 &&
        level.absentQualifiedWindows === 0) ||
      hitIndex < 0 && levels.some(level => level.attempts !== ATTEMPTS_PER_OFFSET) ||
      hitIndex >= 0 && assessed[hitIndex].offset === OFFSETS[1] &&
      levels[0].attempts !== ATTEMPTS_PER_OFFSET ||
      Boolean(report.markerBoundary.stoppedOnHit) !== (hitIndex >= 0))
    throw Error('Marker boundary diagnostic has incomplete levels');
  return {diagnostic: 'marker-boundary', session,
    markerHitOffset: hitIndex >= 0 ? assessed[hitIndex].offset : null,
    levels, cleanedUp: true};
}

module.exports = {OFFSETS, ATTEMPTS_PER_OFFSET, ABSENT_ATTEMPTS_PER_OFFSET, ABSENT_NAME,
  profileInfo, offsetFromProfile, payloadForOffset, verifyReport};
