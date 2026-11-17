'use strict';

const {hasWindow, markerHit} = require('./wave-history.cjs');
const first = require('./marker-first-descriptor.cjs');

const MAX_ATTEMPTS = 3;
const MAX_POSITIVE_ATTEMPTS = 8;

function triggerType(row) {
  const trigger = row?.rows?.find(item => item.role === 'trigger');
  if (!trigger || !Number.isInteger(trigger.result))
    throw Error('Single-positive trigger result is missing');
  if (trigger.result === 0 && !/^[0-9a-f]{8,}$/i.test(trigger.inline || ''))
    throw Error('Single-positive trigger type is missing');
  return {result: trigger.result,
    type: trigger.result === 0 ? Buffer.from(trigger.inline, 'hex').readUInt32LE() : null};
}

function pathControl(row, kind) {
  const trigger = triggerType(row);
  if (row.profile !== `marker-first-descriptor-${kind}` ||
      row.pathTerminatorOffset !== first.TERMINATOR_OFFSET ||
      !Array.isArray(row.changedPaths) || row.changedPaths.length ||
      row.restored !== true && row.triggerAborted !== true ||
      row.selectedMarker !== (trigger.result === 0 && trigger.type === 1) ||
      row.selectedMarker && !hasWindow(row))
    throw Error('Single-positive path control integrity differs');
  const qualified = hasWindow(row);
  if (kind === 'absent' && row.selectedMarker)
    throw Error('Absent path selected the owned marker');
  return {kind, qualified, selectedMarker: row.selectedMarker, ...trigger};
}

function negativeControl(row) {
  if (row.profile !== 'negative' || !Array.isArray(row.changedPaths) ||
      row.changedPaths.length || row.selectedMarker ||
      row.canaryResult !== 0 || row.canaryType !== 1)
    throw Error('Single-positive negative control changed an owned path');
  return {qualified: hasWindow(row)};
}

function positiveOutcome(row) {
  if (row?.profile !== 'positive' || !Array.isArray(row.changedPaths) ||
      row.changedPaths.some(name => name !== 'canary'))
    return {status: 'uncertain', markerHit: false, retrySafe: false};
  if (markerHit(row)) return {status: 'marker-hit', markerHit: true, retrySafe: false};
  if (row.changedPaths.length === 0 && row.restored === true &&
      (row.triggerAborted === true || row.triggerAborted === false && row.allPending === true) &&
      row.canaryResult === 0 && row.canaryType === 1)
    return {status: 'safe-miss', markerHit: false, retrySafe: true};
  return {status: 'uncertain', markerHit: false, retrySafe: false};
}

function verifyReport(report, session) {
  const diagnostic = report?.singlePositive;
  if (report?.session !== session || report.target !== 'gravcirc' ||
      report.singlePositiveEnabled !== true || diagnostic?.completed !== true ||
      report.completed !== true || report.cleanedUp !== true ||
      report.error || report.cleanupError || report.placementUncertain || report.stopped ||
      report.canaryWaveLimit !== 16 || !Array.isArray(report.cases) ||
      report.cases.length > report.canaryWaveLimit)
    throw Error('Single-positive diagnostic did not finish with clean resources');
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) ||
      retained.handles.length || !Array.isArray(retained.threads) ||
      retained.threads.length || !Array.isArray(retained.created) ||
      retained.created.length || retained.group || retained.cacheNeedsRestore ||
      retained.released !== true)
    throw Error('Single-positive diagnostic retained native resources');
  const owned = report.extentMarkerControl;
  if (!owned || [owned.original, owned.cloned, owned.padded].some(item =>
    item?.result !== 0 || item.type !== 1) ||
      !report.cases.some(row => row.profile === 'abort-control' && row.triggerAborted) ||
      !report.cases.some(row => row.profile === 'abort-hole-control' && row.triggerAborted) ||
      !report.cases.some(row => row.profile === 'extent-absent' &&
        row.selectedMarker === false && row.changedPaths?.length === 0))
    throw Error('Single-positive owned-path controls did not verify');
  for (const side of [diagnostic.directControls?.before,
    diagnostic.directControls?.after])
    if (side?.marker?.result !== 0 || side.marker.type !== 1 ||
        side.absent !== 0x202)
      throw Error('Single-positive direct-path controls changed');
  const controls = report.cases.map((row, index) => ({row, index}));
  const marker = controls.filter(({row}) => row.profile === 'marker-first-descriptor-marker');
  const absent = controls.filter(({row}) => row.profile === 'marker-first-descriptor-absent');
  const negative = controls.filter(({row}) => row.profile === 'negative');
  const positive = controls.filter(({row}) => row.profile === 'positive');
  if (!marker.length || marker.length > MAX_ATTEMPTS ||
      absent.length > MAX_ATTEMPTS || negative.length > MAX_ATTEMPTS ||
      positive.length > MAX_POSITIVE_ATTEMPTS ||
      positive.length !== diagnostic.positiveCaseIndices?.length ||
      report.cases.some(row => !['abort-control', 'abort-hole-control',
        'extent-absent', 'marker-first-descriptor-marker',
        'marker-first-descriptor-absent', 'negative', 'positive'].includes(row.profile)))
    throw Error('Single-positive wave count or profile differs');
  const markerRows = marker.map(({row}) => pathControl(row, 'marker'));
  const absentRows = absent.map(({row}) => pathControl(row, 'absent'));
  const qualifiedControls = markerRows.some(item => item.qualified && item.selectedMarker) &&
    absentRows.some(item => item.qualified && item.result === 0x202) &&
    negative.some(({row}) => negativeControl(row).qualified);
  if (diagnostic.status === 'controls-inconclusive') {
    if (qualifiedControls || positive.length)
      throw Error('Single-positive control outcome differs');
    return {diagnostic: 'single-positive', session, status: 'controls-inconclusive',
      markerHit: false, positiveCases: 0, qualifiedPositiveExecutions: 0,
      markerOffset: report.markerOffset,
      cleanedUp: true};
  }
  if (!absent.length || !negative.length || !positive.length)
    throw Error('Single-positive controls were not attempted');
  if (!qualifiedControls) throw Error('Single-positive qualified controls did not verify');
  const indices = [marker.at(-1).index, absent.at(-1).index,
    negative.at(-1).index, positive[0].index];
  if (!(indices[0] < indices[1] && indices[1] < indices[2] &&
        indices[2] < indices[3]) || positive.at(-1).index !== report.cases.length - 1 ||
      positive.some(({index}, attempt) => index !== diagnostic.positiveCaseIndices[attempt]))
    throw Error('Single-positive wave order differs');
  const outcomes = positive.map(({row}) => positiveOutcome(row));
  const terminal = outcomes.at(-1);
  if (outcomes.slice(0, -1).some(outcome => !outcome.retrySafe) ||
      !terminal.markerHit && !terminal.retrySafe)
    throw Error('Single-positive outcome is uncertain');
  const qualifiedPositiveExecutions = positive.filter(({row}) => hasWindow(row)).length;
  const status = terminal.markerHit ? 'marker-hit' :
    qualifiedPositiveExecutions ? 'qualified-miss' : 'no-qualified-window';
  if (diagnostic.status !== status ||
      diagnostic.qualifiedPositiveExecutions !== qualifiedPositiveExecutions)
    throw Error('Single-positive outcome summary differs');
  return {diagnostic: 'single-positive', session, status,
    markerHit: terminal.markerHit, positiveCases: positive.length,
    qualifiedPositiveExecutions,
    markerOffset: report.markerOffset, cleanedUp: true};
}

module.exports = {MAX_ATTEMPTS, MAX_POSITIVE_ATTEMPTS, triggerType, pathControl, negativeControl,
  positiveOutcome, verifyReport};
