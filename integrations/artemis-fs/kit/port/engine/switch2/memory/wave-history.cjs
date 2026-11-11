'use strict';

function hasWindow(row) {
  return row?.restored === true && row.triggerAborted === false && row.allPending === true &&
    Number.isFinite(row.receiveOrderMarginUs) && row.receiveOrderMarginUs >= 300 &&
    Number.isFinite(row.preReleaseUsed) && row.preReleaseUsed >= 0x2600;
}

function markerHit(row) {
  return hasWindow(row) && row.canaryResult === 0 && row.canaryType === 0 &&
    Array.isArray(row.changedPaths) && row.changedPaths.length === 1 && row.changedPaths[0] === 'canary';
}

function summarize(rows) {
  const result = {measuredWaves: rows.length, aborted: 0, executed: 0, unknownExecution: 0,
    qualifiedWindows: 0, markerHits: 0, executedWithoutMarker: 0, restorationFailures: 0, unexpectedChanges: 0};
  for (const row of rows) {
    if (row.triggerAborted === true) result.aborted++;
    else if (row.triggerAborted === false) result.executed++;
    else result.unknownExecution++;
    if (hasWindow(row)) result.qualifiedWindows++;
    const hit = markerHit(row);
    if (hit) result.markerHits++;
    if (row.triggerAborted === false && !hit) result.executedWithoutMarker++;
    if (row.restored !== true) result.restorationFailures++;
    if (!Array.isArray(row.changedPaths) || row.changedPaths.some(name => name !== 'canary') ||
        row.triggerAborted === true && row.changedPaths.length > 0) result.unexpectedChanges++;
  }
  return result;
}

function positiveOutcome(summary) {
  const verified = summary.markerHits > 0 && summary.restorationFailures === 0 &&
    summary.unexpectedChanges === 0 && summary.unknownExecution === 0;
  return {verified, retainResources: !verified && (summary.executedWithoutMarker > 0 ||
    summary.unknownExecution > 0 || summary.restorationFailures > 0 || summary.unexpectedChanges > 0)};
}

function describe(summary) {
  return summary.measuredWaves + ' measured/' + (summary.attemptsStarted ?? summary.measuredWaves) +
    ' started, ' + summary.qualifiedWindows + ' qualified windows, ' + summary.aborted +
    ' aborted, ' + summary.markerHits + ' verified marker hits';
}

function lastPositiveBatch(report) {
  const recorded = report.retryBatches?.filter(batch => batch.profile === 'positive').at(-1);
  if (recorded) return recorded.status === 'running' && Number.isInteger(recorded.firstCaseIndex)
    ? {...recorded, ...summarize((report.cases || []).slice(recorded.firstCaseIndex))} : recorded;
  // Older reports have no batch journal. Recover the last contiguous positive group.
  const cases = report.cases || [];
  let end = cases.length - 1;
  while (end >= 0 && cases[end].profile !== 'positive') end--;
  if (end < 0) return report.active?.profile === 'positive'
    ? {profile: 'positive', ...summarize([]), attemptsStarted: 1, status: 'failed', inferredFromCases: true} : null;
  let start = end;
  while (start > 0 && cases[start - 1].profile === 'positive') start--;
  const rows = cases.slice(start, end + 1), pending = report.active?.profile === 'positive' ? 1 : 0;
  return {profile: 'positive', ...summarize(rows), attemptsStarted: rows.length + pending,
    status: pending ? 'failed' : 'recorded', inferredFromCases: true};
}

function failureSummary(report, error) {
  const positive = lastPositiveBatch(report);
  const worker = error?.workerFailure || report.workerFailure;
  const text = error?.message || String(report.error || '').split('\n')[0].replace(/^Error: /, '');
  const active = report.active;
  const role = active?.workers?.find(row => row.label === worker?.label)?.role || null;
  const unjoinedThreads = report.retained?.threads?.length || 0;
  let kind, message;
  if (worker?.observed === 'not-terminated' || /Native batch did not terminate/.test(text)) {
    kind = 'native-worker-timeout';
    message = (active?.profile || 'native') + ': worker ' + (role || worker?.label || 'unknown') +
      ' did not terminate' + (worker?.timeoutMs ? ' within ' + worker.timeoutMs + 'ms' : '') +
      '; executing step unknown; ' + unjoinedThreads + ' tracked unjoined threads';
  } else if (report.allocationMismatch) {
    kind = 'allocation-profile-mismatch'; message = text;
  } else if (/timed out|timeout/i.test(text)) {
    kind = 'console-or-native-timeout'; message = text;
  } else if (positive && !positiveOutcome(positive).verified) {
    kind = positiveOutcome(positive).retainResources ? 'canary-placement-miss' : 'positive-window-exhausted';
    message = 'positive: ' + describe(positive) + (kind === 'canary-placement-miss'
      ? '; no verified placement, retain resources' : '; no verified marker, cleanup must still be proven');
  } else {kind = 'acquisition-error'; message = text || 'Acquisition did not become ready';}
  const retainResources = report.placementUncertain === true || unjoinedThreads > 0 ||
    !!(positive && positiveOutcome(positive).retainResources);
  return {kind, message: message + (kind === 'native-worker-timeout' && positive ? '; positive: ' + describe(positive) : ''),
    ...(positive ? {positive} : {}),
    ...(worker ? {worker: {label: worker.label, role, observed: worker.observed, timeoutMs: worker.timeoutMs,
      executingStep: null, planIsNotExecutionProof: true}} : {}),
    ...(active ? {activeWave: {profile: active.profile, wave: active.wave, diagnosticKind: 'planned'}} : {}),
    resources: {unjoinedThreads, handles: report.retained?.handles?.length || 0},
    retainResources, cleanupReported: report.cleanedUp === true,
    inconsistentCleanup: retainResources && report.cleanedUp === true};
}

module.exports = {hasWindow, markerHit, summarize, positiveOutcome, describe, failureSummary};
