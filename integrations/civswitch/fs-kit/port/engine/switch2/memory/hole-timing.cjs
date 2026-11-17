'use strict';

const READ_SIZES = [0x20000, 0x40000, 0x80000];
const INITIAL_PIN_READ_SIZE = 0x80000;

function rowFor(caseRow, role) {
  return caseRow?.rows?.find(row => row.role === role);
}

function window(caseRow) {
  const hole = rowFor(caseRow, 'hole');
  const release = rowFor(caseRow, 'release');
  const guard = rowFor(caseRow, 'guard1');
  const canary = rowFor(caseRow, 'canary');
  const filler = rowFor(caseRow, 'filler0');
  if (![hole, release, guard, canary, filler].every(Boolean)) throw Error('Missing timing row');
  for (const row of [hole, release, guard, canary, filler]) {
    if (!Number.isFinite(row.startUs) || !Number.isFinite(row.endUs) ||
        row.endUs < row.startUs) throw Error('Invalid timing row');
  }
  const holeBeforeRelease = hole.startUs < release.startUs;
  const holePastGuard = hole.endUs > guard.startUs + 300;
  const canaryBeforeFiller = canary.startUs < filler.startUs;
  return {holeStartUs: hole.startUs, holeEndUs: hole.endUs,
    releaseStartUs: release.startUs, guardStartUs: guard.startUs,
    canaryStartUs: canary.startUs, fillerStartUs: filler.startUs,
    holeBeforeRelease, holePastGuard, canaryBeforeFiller,
    usable: hole.result === 0 && holeBeforeRelease && holePastGuard && canaryBeforeFiller};
}

function safeControl(caseRow) {
  if (caseRow?.profile !== 'abort-control' ||
      caseRow.triggerAborted !== true || caseRow.nativeGuard?.completed !== 1 ||
      caseRow.restored !== true || caseRow.canaryResult !== 0 ||
      caseRow.canaryType !== 1 || !Array.isArray(caseRow.changedPaths) ||
      caseRow.changedPaths.length !== 0 || !Array.isArray(caseRow.rows) ||
      caseRow.rows.some(row => row.role === 'hole' && row.result !== 0))
    throw Error('Owned abort control did not preserve the canary and heap');
  return window(caseRow);
}

function verifyReport(report, session) {
  const timing = report?.holeTiming;
  if (report?.session !== session || report.target !== 'gravcirc' ||
      report.holeTimingEnabled !== true || timing?.completed !== true ||
      report.completed !== true || report.cleanedUp !== true ||
      report.error || report.cleanupError || report.placementUncertain || report.stopped ||
      report.canaryWaveLimit !== 16 || !Array.isArray(report.cases) ||
      report.cases.length > report.canaryWaveLimit ||
      report.holeTimingPreflight?.verified !== true ||
      report.holeTimingPreflight.readSize !== 0x80000 ||
      report.holeTimingPreflight.baseline?.result !== 0 ||
      report.holeTimingPreflight.large?.result !== 0 ||
      report.holeTimingPreflight.tail?.result !== 0 ||
      report.holeTimingPreflight.baseline.offset !== 0 ||
      report.holeTimingPreflight.baseline.size !== 0x10000 ||
      report.holeTimingPreflight.large.offset !== 0 ||
      report.holeTimingPreflight.large.size !== 0x80000 ||
      report.holeTimingPreflight.tail.offset !== 0x80000 - 64 ||
      report.holeTimingPreflight.tail.size !== 64 ||
      report.holeTimingPreflight.baseline.first64Hex !==
        report.holeTimingPreflight.large.first64Hex ||
      report.holeTimingPreflight.large.last64Hex !==
        report.holeTimingPreflight.tail.first64Hex ||
      report.holeTimingPreflight.baseline.first64Hex === 'a5'.repeat(64) ||
      report.holeTimingPreflight.large.first64Hex === '5a'.repeat(64) ||
      report.holeTimingPreflight.large.last64Hex === '5a'.repeat(64) ||
      report.holeTimingPreflight.tail.first64Hex === 'a5'.repeat(64) ||
      !['window-found', 'no-window', 'pin-not-overlapped'].includes(timing.status) ||
      !Array.isArray(timing.observations) || timing.observations.length < 1 ||
      timing.observations.length > READ_SIZES.length)
    throw Error('Hole timing diagnostic did not complete with clean resource release');
  const retained = report.retained;
  if (!retained || retained.base !== 0 || !Array.isArray(retained.handles) ||
      retained.handles.length || !Array.isArray(retained.threads) ||
      retained.threads.length || !Array.isArray(retained.created) ||
      retained.created.length || retained.group || retained.cacheNeedsRestore ||
      retained.released !== true)
    throw Error('Hole timing diagnostic retained native resources');
  const initial = report.cases[timing.initialPinCaseIndex];
  const hole = rowFor(initial, 'hole');
  const pin = rowFor(initial, 'pin');
  const pinDuringRead = Number.isFinite(hole?.startUs) && Number.isFinite(hole?.endUs) &&
    Number.isFinite(pin?.startUs) && hole.startUs < pin.startUs && pin.startUs < hole.endUs;
  if (!Number.isInteger(timing.initialPinCaseIndex) ||
      initial?.profile !== 'abort-control' || initial.pinWindowOk !== true ||
      initial.pinCostOk !== true || !initial.triggerAborted ||
      initial.readSize !== INITIAL_PIN_READ_SIZE ||
      !hole || !pin || timing.initialPinCreatedDuringRead !== pinDuringRead ||
      !report.cases.some(row => row.profile === 'abort-hole-control' && row.triggerAborted) ||
      report.cases.some(row => !['abort-control', 'abort-hole-control'].includes(row.profile)))
    throw Error('Hole timing initial pin or abort controls differ');
  const observed = timing.observations.map((item, index) => {
    if (item.readSize !== READ_SIZES[index] ||
        !Number.isInteger(item.caseIndex) || item.caseIndex <= timing.initialPinCaseIndex ||
        item.caseIndex >= report.cases?.length) throw Error('Hole timing case index differs');
    if (index && item.caseIndex !== timing.observations[index - 1].caseIndex + 1)
      throw Error('Hole timing case sequence differs');
    const row = report.cases[item.caseIndex];
    if (row.readSize !== item.readSize) throw Error('Hole timing read size differs');
    const result = safeControl(row);
    if (JSON.stringify(result) !== JSON.stringify(item.window))
      throw Error('Hole timing observation differs from measured rows');
    return result;
  });
  const observedWindow = observed.some(item => item.usable);
  if (timing.status === 'pin-not-overlapped') {
    if (pinDuringRead) throw Error('Hole timing initial pin status differs');
  } else if (!pinDuringRead || (timing.status === 'window-found') !== observedWindow) {
    throw Error('Hole timing status differs from measured window');
  }
  if (observed.slice(0, -1).some(item => item.usable))
    throw Error('Hole timing continued after a usable window');
  return {session, diagnostic: 'hole-timing', status: timing.status,
    observations: timing.observations, cleanedUp: true};
}

module.exports = {READ_SIZES, INITIAL_PIN_READ_SIZE, window, safeControl, verifyReport};
