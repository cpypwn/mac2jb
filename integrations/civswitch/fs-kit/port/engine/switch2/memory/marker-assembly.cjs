'use strict';

const path = require('node:path');
const ladder = require('./extent-ladder.cjs');
const boundary = require('./marker-boundary.cjs');

const OFFSET = 0x233f;
const LAYOUTS = Object.freeze([
  Object.freeze({name: 'baseline', lastSegmentOffset: 3 * ladder.CHUNK_BYTES}),
  Object.freeze({name: 'shifted', lastSegmentOffset: 4 * ladder.CHUNK_BYTES}),
]);
const ABSENT_ATTEMPTS = 2;
const MARKER_ATTEMPTS = 3;

function profileInfo(profile) {
  const match = /^marker-assembly-(baseline|shifted)-(absent|marker)-9023$/.exec(profile);
  if (!match) return null;
  const layout = LAYOUTS.find(item => item.name === match[1]);
  return {layout: layout.name, kind: match[2], offset: OFFSET,
    lastSegmentOffset: layout.lastSegmentOffset};
}

function verifyReport(report, session) {
  if (!report || report.session !== session || report.target !== 'gravcirc' ||
      report.markerBoundaryEnabled !== true || report.markerMatchedAbsentEnabled !== true ||
      report.markerAssemblyEnabled !== true || report.extentLadderEnabled === true ||
      report.markerAssembly?.mode !== 'final-segment-placement' ||
      report.markerAssembly.completed !== true || report.completed !== true ||
      report.cleanedUp !== true || report.error || report.cleanupError ||
      report.placementUncertain || report.stopped ||
      !Array.isArray(report.cases) || report.canaryWaveLimit !== 16 ||
      report.cases.length > report.canaryWaveLimit)
    throw Error('Marker assembly diagnostic did not finish with clean resources');
  const control = report.extentMarkerControl;
  if (!control || [control.original, control.cloned, control.padded].some(item =>
    item?.result !== 0 || item.type !== 1) ||
    !report.cases.some(row => row.profile === 'abort-control' && row.triggerAborted === true) ||
    !report.cases.some(row => row.profile === 'abort-hole-control' && row.triggerAborted === true) ||
    !report.cases.some(row => row.profile === 'extent-absent' && row.selectedMarker === false &&
      Array.isArray(row.changedPaths) && row.changedPaths.length === 0) ||
    report.markerAssembly.absentPathControl?.original !== 0x202 ||
    report.markerAssembly.absentPathControl?.cloned !== 0x202 ||
    report.markerAssembly.absentPathControl.path !==
      path.posix.join(path.posix.dirname(control.path), boundary.ABSENT_NAME))
    throw Error('Marker assembly owned-path controls did not verify');
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) || retained.handles.length ||
      !Array.isArray(retained.threads) || retained.threads.length ||
      !Array.isArray(retained.created) || retained.created.length ||
      retained.group || retained.cacheNeedsRestore || retained.released !== true)
    throw Error('Marker assembly diagnostic retained native resources');
  const rows = report.cases.filter(row => profileInfo(row.profile));
  if (report.cases.some(row => !['abort-control', 'abort-hole-control', 'extent-absent'].includes(row.profile) &&
      !profileInfo(row.profile)))
    throw Error('Marker assembly diagnostic contains an unexpected wave');
  let previousLayout = -1;
  const assessed = rows.map(row => {
    const info = profileInfo(row.profile);
    const layoutIndex = LAYOUTS.findIndex(item => item.name === info.layout);
    if (layoutIndex < previousLayout || row.pathTerminatorOffset !== OFFSET ||
        row.lastSegmentOffset !== info.lastSegmentOffset)
      throw Error('Marker assembly diagnostic changed more than the final segment placement');
    previousLayout = layoutIndex;
    const result = ladder.assessRow(row);
    if (info.kind === 'absent' && result.markerHit)
      throw Error('Marker assembly absent path selected the owned marker');
    return {...info, ...result};
  });
  const hitIndex = assessed.findIndex(row => row.kind === 'marker' && row.markerHit);
  if (hitIndex >= 0 && hitIndex !== assessed.length - 1)
    throw Error('Marker assembly diagnostic continued after a verified marker hit');
  const levels = LAYOUTS.map(layout => {
    const levelRows = assessed.filter(row => row.layout === layout.name);
    const kinds = levelRows.map(row => row.kind);
    const absentRows = levelRows.filter(row => row.kind === 'absent');
    const markerRows = levelRows.filter(row => row.kind === 'marker');
    if (levelRows.length && (absentRows.length !== ABSENT_ATTEMPTS ||
        markerRows.length < 1 || markerRows.length > MARKER_ATTEMPTS ||
        kinds.slice(0, ABSENT_ATTEMPTS).some(kind => kind !== 'absent') ||
        kinds.slice(ABSENT_ATTEMPTS).some(kind => kind !== 'marker') ||
        !absentRows.some(row => row.qualified) || !markerRows.some(row => row.qualified)))
      throw Error('Marker assembly comparison lacks paired qualified controls');
    return {layout: layout.name, lastSegmentOffset: layout.lastSegmentOffset,
      absentAttempts: absentRows.length, absentQualified: absentRows.filter(row => row.qualified).length,
      markerAttempts: markerRows.length, markerQualified: markerRows.filter(row => row.qualified).length,
      markerHits: markerRows.filter(row => row.markerHit).length};
  });
  if (!levels[0].markerAttempts || hitIndex < 0 &&
      levels.some(level => level.markerAttempts !== MARKER_ATTEMPTS) ||
      hitIndex >= 0 && assessed[hitIndex].layout === 'shifted' &&
        levels[0].markerAttempts !== MARKER_ATTEMPTS ||
      Boolean(report.markerAssembly.stoppedOnHit) !== (hitIndex >= 0))
    throw Error('Marker assembly comparison is incomplete');
  return {diagnostic: 'marker-assembly', session, offset: OFFSET,
    hitLayout: hitIndex >= 0 ? assessed[hitIndex].layout : null, levels, cleanedUp: true};
}

module.exports = {OFFSET, LAYOUTS, ABSENT_ATTEMPTS, MARKER_ATTEMPTS,
  profileInfo, verifyReport};
