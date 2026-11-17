'use strict';

const path = require('node:path');
const ladder = require('./extent-ladder.cjs');
const {slashPaddedPath} = require('./paths.cjs');
const {hasWindow} = require('./wave-history.cjs');

const TERMINATOR_OFFSET = 0x7ff;
const ATTEMPTS_PER_KIND = 3;
const ABSENT_NAME = 'SPAN_ABSENT';

function kindFromProfile(profile) {
  const match = /^marker-first-descriptor-(marker|absent)$/.exec(profile);
  return match?.[1] ?? null;
}

function payload(scratch, segments, marker, name) {
  if (name !== marker && name !== ABSENT_NAME ||
      Buffer.byteLength(name) !== Buffer.byteLength(marker))
    throw Error('Invalid matched first-descriptor basename');
  const ownedPath = path.posix.join(scratch, ...segments, name);
  const text = slashPaddedPath([scratch, ...segments, name], TERMINATOR_OFFSET);
  const bytes = Buffer.alloc(ladder.EXTENT + 1, '/');
  bytes.write(text);
  bytes[TERMINATOR_OFFSET] = 0;
  bytes[ladder.EXTENT] = 0;
  if (path.posix.normalize(text) !== ownedPath ||
      bytes.subarray(0, TERMINATOR_OFFSET).includes(0))
    throw Error('First-descriptor path differs from owned path');
  return {bytes, path: ownedPath, terminatorOffset: TERMINATOR_OFFSET};
}

function verifyReport(report, session) {
  if (!report || report.session !== session || report.target !== 'gravcirc' ||
      report.markerFirstDescriptorEnabled !== true || report.markerAssemblyEnabled === true ||
      report.markerBoundaryEnabled === true || report.extentLadderEnabled === true ||
      report.markerFirstDescriptor?.mode !== 'matched-first-descriptor' ||
      report.markerFirstDescriptor.completed !== true || report.completed !== true ||
      report.cleanedUp !== true || report.error || report.cleanupError ||
      report.placementUncertain || report.stopped || report.canaryWaveLimit !== 16 ||
      !Array.isArray(report.cases) || report.cases.length !== 9)
    throw Error('First-descriptor diagnostic did not finish with clean resources');
  const control = report.extentMarkerControl;
  if (!control || [control.original, control.cloned, control.padded].some(item =>
    item?.result !== 0 || item.type !== 1) ||
    !report.cases.some(row => row.profile === 'abort-control' && row.triggerAborted === true) ||
    !report.cases.some(row => row.profile === 'abort-hole-control' && row.triggerAborted === true) ||
    !report.cases.some(row => row.profile === 'extent-absent' && row.selectedMarker === false &&
      Array.isArray(row.changedPaths) && row.changedPaths.length === 0))
    throw Error('First-descriptor owned-path controls did not verify');
  const direct = report.markerFirstDescriptor.directControls;
  if (direct?.before?.marker?.result !== 0 || direct?.before?.marker?.type !== 1 ||
      direct?.before?.absent !== 0x202 ||
      direct?.after?.marker?.result !== 0 || direct?.after?.marker?.type !== 1 ||
      direct?.after?.absent !== 0x202)
    throw Error('First-descriptor direct controls changed');
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) || retained.handles.length ||
      !Array.isArray(retained.threads) || retained.threads.length ||
      !Array.isArray(retained.created) || retained.created.length ||
      retained.group || retained.cacheNeedsRestore || retained.released !== true)
    throw Error('First-descriptor diagnostic retained native resources');
  const rows = report.cases.filter(row => kindFromProfile(row.profile));
  if (rows.length !== 2 * ATTEMPTS_PER_KIND ||
      report.cases.slice(0, 3).map(row => row.profile).join(',') !==
        'abort-control,abort-hole-control,extent-absent' ||
      !Array.isArray(report.markerFirstDescriptor.attempts) ||
      report.markerFirstDescriptor.attempts.length !== rows.length ||
      report.cases.some(row => !['abort-control', 'abort-hole-control', 'extent-absent'].includes(row.profile) &&
        !kindFromProfile(row.profile)))
    throw Error('First-descriptor diagnostic has an invalid wave count');
  const assessed = rows.map((row, index) => {
    const kind = kindFromProfile(row.profile);
    if (kind !== (index % 2 ? 'absent' : 'marker') ||
        row.pathTerminatorOffset !== TERMINATOR_OFFSET || row.extent !== ladder.EXTENT ||
        !Array.isArray(row.changedPaths) || row.changedPaths.length ||
        row.restored !== true && row.triggerAborted !== true)
      throw Error('First-descriptor wave order or path integrity changed');
    const trigger = row.rows?.find(item => item.role === 'trigger');
    if (!trigger) throw Error('First-descriptor trigger is missing');
    const type = trigger.result === 0 ? Buffer.from(trigger.inline, 'hex').readUInt32LE() : null;
    const qualified = hasWindow(row);
    if (row.selectedMarker !== (trigger.result === 0 && type === 1) ||
        row.selectedMarker && !qualified)
      throw Error('First-descriptor trigger result differs from marker selection');
    const recorded = report.markerFirstDescriptor.attempts[index];
    if (recorded.caseIndex !== index + 3 || recorded.kind !== kind ||
        recorded.triggerResult !== trigger.result || recorded.triggerType !== type ||
        recorded.qualified !== qualified ||
        recorded.markerHit !== (qualified && row.selectedMarker))
      throw Error('First-descriptor attempt report differs from its wave');
    const hit = qualified && kind === 'marker' && trigger.result === 0 && type === 1;
    if (kind === 'absent' && qualified && trigger.result === 0 && type === 1)
      throw Error('First-descriptor absent path selected an owned file');
    return {kind, qualified, result: trigger.result, type, hit};
  });
  if (['marker', 'absent'].some(kind => !assessed.some(row => row.kind === kind && row.qualified)))
    throw Error('First-descriptor diagnostic has no qualified matched pair');
  const marker = assessed.filter(row => row.kind === 'marker');
  const absent = assessed.filter(row => row.kind === 'absent');
  return {diagnostic: 'first-descriptor', session, terminatorOffset: TERMINATOR_OFFSET,
    markerAttempts: marker.length, markerQualified: marker.filter(row => row.qualified).length,
    markerHits: marker.filter(row => row.hit).length,
    absentAttempts: absent.length, absentQualified: absent.filter(row => row.qualified).length,
    absentMisses: absent.filter(row => row.qualified && row.result === 0x202).length,
    observations: assessed, cleanedUp: true};
}

module.exports = {TERMINATOR_OFFSET, ATTEMPTS_PER_KIND, ABSENT_NAME,
  kindFromProfile, payload, verifyReport};
