'use strict';

const timing = require('./hole-timing.cjs');
const single = require('./single-positive.cjs');
const firstX = require('./first-x-positive.cjs');
const validParent = require('./valid-parent-positive.cjs');
const {hasWindow} = require('./wave-history.cjs');

const HOLE_DELAY_NS = 300000;
const TIMING_DELAYS_NS = [HOLE_DELAY_NS, 700000];
const CANARY_DELAY_NS = 1700000;
const MAX_POSITIVE_ATTEMPTS = 1;

function rowFor(caseRow, role) {
  return caseRow?.rows?.find(row => row.role === role);
}

function schedule(row, readSize, holeDelayNs, allowedDelays = TIMING_DELAYS_NS) {
  if (!allowedDelays.includes(holeDelayNs) ||
      row?.holeDelayNs !== holeDelayNs || row.readSize !== readSize ||
      row.pinRequestOpcode !== 1009)
    throw Error('Early positive schedule or read size differs from its timing control');
  // Post-control waves may abort cleanly even when the same schedule qualified
  // in the fresh timing control. Only a marker-hit claim needs a live window.
  return timing.window(row);
}

function directControl(side) {
  if (side?.marker?.result !== 0 || side.marker.type !== 1 || side.absent !== 0x202)
    throw Error('Early positive direct marker or absent path differs');
}

function readPreflight(preflight) {
  if (preflight?.verified !== true || preflight.readSize !== 0x80000 ||
      preflight.baseline?.result !== 0 || preflight.baseline.offset !== 0 ||
      preflight.baseline.size !== 0x10000 || preflight.large?.result !== 0 ||
      preflight.large.offset !== 0 || preflight.large.size !== 0x80000 ||
      preflight.tail?.result !== 0 || preflight.tail.offset !== 0x80000 - 64 ||
      preflight.tail.size !== 64 ||
      preflight.baseline.first64Hex !== preflight.large.first64Hex ||
      preflight.large.last64Hex !== preflight.tail.first64Hex ||
      preflight.baseline.first64Hex === 'a5'.repeat(64) ||
      preflight.large.first64Hex === '5a'.repeat(64) ||
      preflight.large.last64Hex === '5a'.repeat(64) ||
      preflight.tail.first64Hex === 'a5'.repeat(64))
    throw Error('Early positive large-read preflight did not verify');
}

function verifyReport(report, session) {
  const diagnostic = report?.earlyPositive;
  if (report?.session !== session || report.target !== 'gravcirc' ||
      report.earlyPositiveEnabled !== true || diagnostic?.completed !== true ||
      report.completed !== true || report.cleanedUp !== true ||
      report.error || report.cleanupError || report.placementUncertain || report.stopped ||
      report.canaryWaveLimit !== 16 || !Array.isArray(report.cases) ||
      report.cases.length > report.canaryWaveLimit ||
      report.workerDelaysNs?.[6] !== CANARY_DELAY_NS)
    throw Error('Early positive diagnostic did not complete with clean timing');
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) ||
      retained.handles.length || !Array.isArray(retained.threads) ||
      retained.threads.length || !Array.isArray(retained.created) ||
      retained.created.length || retained.group || retained.cacheNeedsRestore ||
      retained.released !== true)
    throw Error('Early positive diagnostic retained native resources');
  const variant = report.validParentPositiveEnabled === true ?
    validParent.verifyEvidence(report, report.cases.find(row => row.profile === 'positive')) :
    report.firstXPositiveEnabled === true ?
      firstX.verifyEvidence(report, report.cases.find(row => row.profile === 'positive')) : null;
  if (!variant && report.firstXPositive)
    throw Error('First-X positive evidence exists outside its gated mode');
  if (report.validParentPositiveEnabled !== true && report.validParentPositive)
    throw Error('Valid-parent positive evidence exists outside its gated mode');
  readPreflight(report.holeTimingPreflight);
  const owned = report.extentMarkerControl;
  if (!owned || [owned.original, owned.cloned, owned.padded].some(item =>
    item?.result !== 0 || item.type !== 1))
    throw Error('Early positive owned marker controls did not verify');
  directControl(diagnostic.directControls?.before);
  directControl(diagnostic.directControls?.after);

  const indexed = report.cases.map((row, index) => ({row, index}));
  const initial = indexed[diagnostic.initialPinCaseIndex];
  const pin = rowFor(initial?.row, 'pin');
  const hole = rowFor(initial?.row, 'hole');
  if (diagnostic.initialPinCaseIndex !== 0 ||
      initial?.row?.profile !== 'abort-control' ||
      initial.row.pinRequestOpcode !== 200 || initial.row.pinWindowOk !== true ||
      initial.row.pinCostOk !== true || initial.row.triggerAborted !== true ||
      initial.row.readSize !== timing.INITIAL_PIN_READ_SIZE ||
      !Number.isFinite(hole?.startUs) || !Number.isFinite(hole?.endUs) ||
      !Number.isFinite(pin?.startUs))
    throw Error('Early positive initial pin was not created during the read');
  timing.safeControl(initial.row);
  const pinDuringRead = hole.startUs < pin.startUs && pin.startUs < hole.endUs;
  const holeAbort = indexed.filter(({row, index}) => index > initial.index &&
    row.profile === 'abort-hole-control' && row.triggerAborted === true &&
    row.nativeGuard?.earlyHole === 1 && row.nativeGuard.minimumSpacing === 1);
  if (holeAbort.length !== 1 || holeAbort[0].index !== initial.index + 1 ||
      holeAbort[0].row.pinRequestOpcode !== 1009 ||
      holeAbort[0].row.restored !== true ||
      holeAbort[0].row.canaryResult !== 0 || holeAbort[0].row.canaryType !== 1 ||
      holeAbort[0].row.changedPaths?.length !== 0)
    throw Error('Early positive receive-order abort control did not verify');

  const timingIndices = diagnostic.timingCaseIndices;
  const timingDelays = report.validParentPositiveEnabled === true ?
    validParent.TIMING_DELAYS_NS : variant ? firstX.TIMING_DELAYS_NS : TIMING_DELAYS_NS;
  if (!Array.isArray(timingIndices) || timingIndices.length < 1 ||
      timingIndices.length > timingDelays.length ||
      !timingIndices.every((index, position) => Number.isInteger(index) &&
        index > holeAbort[0].index &&
        (position || index === holeAbort[0].index + 1) &&
        (!position || index === timingIndices[position - 1] + 1)))
    throw Error('Early positive timing controls are missing or out of order');
  const windows = timingIndices.map((index, position) => {
    const row = report.cases[index];
    if (row?.readSize !== timing.INITIAL_PIN_READ_SIZE ||
        row.holeDelayNs !== timingDelays[position] || row.pinRequestOpcode !== 1009)
      throw Error('Early positive timing control schedule differs');
    return timing.safeControl(row);
  });
  if (windows.slice(0, -1).some(window => window.usable))
    throw Error('Early positive continued after a usable timing window');
  const selectedIndex = timingIndices.at(-1);
  const usable = pinDuringRead && windows.at(-1).usable;
  if (!usable) {
    if (diagnostic.timingControlCaseIndex !== null ||
        diagnostic.selectedHoleDelayNs !== null ||
        diagnostic.status !== 'timing-inconclusive' ||
        report.cases.length !== selectedIndex + 1 ||
        diagnostic.positiveCaseIndex !== null)
      throw Error('Early positive continued without a fresh timing window');
    return {session, diagnostic: 'early-positive', status: 'timing-inconclusive',
      markerHit: false, positiveCases: 0, timingControlCaseIndex: null,
      readSize: null, cleanedUp: true, ...(variant || {})};
  }
  if (diagnostic.timingControlCaseIndex !== selectedIndex)
    throw Error('Early positive selected a different timing control');
  const readSize = report.cases[selectedIndex].readSize;
  const selectedHoleDelayNs = report.cases[selectedIndex].holeDelayNs;
  if (diagnostic.selectedHoleDelayNs !== selectedHoleDelayNs)
    throw Error('Early positive selected a different hole delay');

  const absent = indexed.filter(({row}) => row.profile === 'extent-absent');
  const marker = indexed.filter(({row}) => row.profile === 'marker-first-descriptor-marker');
  const matchedAbsent = indexed.filter(({row}) => row.profile === 'marker-first-descriptor-absent');
  const negative = indexed.filter(({row}) => row.profile === 'negative');
  const positive = indexed.filter(({row}) => row.profile === 'positive');
  if (absent.length !== 1 || absent[0].row.selectedMarker !== false ||
      absent[0].row.changedPaths?.length !== 0 || marker.length > single.MAX_ATTEMPTS ||
      matchedAbsent.length > single.MAX_ATTEMPTS || negative.length > single.MAX_ATTEMPTS ||
      positive.length > MAX_POSITIVE_ATTEMPTS ||
      !(selectedIndex < absent[0].index))
    throw Error('Early positive controls or one-positive bound differ');
  if (report.cases.some((row, index) => index > selectedIndex &&
      !['extent-absent', 'marker-first-descriptor-marker',
        'marker-first-descriptor-absent', 'negative', 'positive'].includes(row.profile)))
    throw Error('Early positive contains an unexpected wave');
  for (const {row} of [...absent, ...marker, ...matchedAbsent, ...negative, ...positive])
    schedule(row, readSize, selectedHoleDelayNs, timingDelays);
  const markerQualified = marker.some(({row}) => {
    const result = single.pathControl(row, 'marker');
    return result.qualified && result.selectedMarker;
  });
  const absentQualified = matchedAbsent.some(({row}) => {
    const result = single.pathControl(row, 'absent');
    return result.qualified && result.result === 0x202;
  });
  const negativeQualified = negative.some(({row}) => single.negativeControl(row).qualified);
  if (marker.length && marker[0].index <= absent[0].index ||
      matchedAbsent.length && (!markerQualified || matchedAbsent[0].index <= marker.at(-1).index) ||
      negative.length && (!absentQualified || negative[0].index <= matchedAbsent.at(-1).index))
    throw Error('Early positive matched path control order differs');
  if (!positive.length) {
    if (diagnostic.status !== 'controls-inconclusive' ||
        diagnostic.positiveCaseIndex !== null ||
        markerQualified && absentQualified && negativeQualified)
      throw Error('Early positive controls were not proven before stopping');
    return {session, diagnostic: 'early-positive', status: 'controls-inconclusive',
      markerHit: false, positiveCases: 0,
      timingControlCaseIndex: selectedIndex, readSize, cleanedUp: true,
      ...(variant || {})};
  }
  if (!markerQualified || !absentQualified || !negativeQualified ||
      positive[0].index !== diagnostic.positiveCaseIndex ||
      positive[0].index !== report.cases.length - 1 ||
      positive[0].index <= negative.at(-1).index)
    throw Error('Early positive one-positive controls did not qualify');
  const outcome = single.positiveOutcome(positive[0].row);
  if (!outcome.markerHit && !outcome.retrySafe)
    throw Error('Early positive outcome is uncertain');
  const positiveWindow = schedule(positive[0].row, readSize, selectedHoleDelayNs,
    timingDelays);
  const status = outcome.markerHit ? positiveWindow.usable ? 'marker-hit' :
    'unqualified-marker-hit' : hasWindow(positive[0].row) && positiveWindow.usable ?
    'qualified-miss' : 'no-qualified-window';
  if (diagnostic.status !== status)
    throw Error('Early positive outcome summary differs');
  return {session, diagnostic: 'early-positive', status,
    markerHit: outcome.markerHit && positiveWindow.usable,
    positiveCases: 1, timingControlCaseIndex: selectedIndex, readSize,
    cleanedUp: true, ...(variant || {})};
}

module.exports = {HOLE_DELAY_NS, TIMING_DELAYS_NS, CANARY_DELAY_NS, MAX_POSITIVE_ATTEMPTS,
  schedule, directControl, readPreflight, verifyReport};
