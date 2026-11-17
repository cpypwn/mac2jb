'use strict';

function verifyGeometryReport(report, session) {
  const check = (condition, message) => {if (!condition) throw Error(message);};
  check(report?.session === session, 'Geometry report belongs to another session');
  const measured = report?.geometryOnly;
  const cases = report?.cases;
  const row = cases?.at(-1);
  check(report.completed === true && measured && Array.isArray(cases) &&
    cases.length >= 1 && cases.length <= 30 && measured.attempts === cases.length &&
    (report.geometryRetries || 0) === cases.length - 1 &&
    row.profile === 'abort-control' && row.triggerAborted === true &&
    row.nativeGuard?.completed === 1,
  'Bounded allocation control did not complete');
  check(cases.slice(0, -1).every(prior =>
    prior.profile === 'abort-control' && prior.triggerAborted === true &&
    prior.nativeGuard?.completed === 1 && prior.restored === true &&
    prior.pinCostOk === true && prior.pinReleasedAfterRetry === true &&
    (prior.pinWindowOk !== true || prior.allPending !== true) &&
    prior.changedPaths?.length === 0 && prior.canaryResult === 0 &&
    prior.canaryType === 1),
  'A missed geometry pin was not released before retry');
  check(Number.isInteger(measured.pinningAllocationBytes) &&
    measured.pinningAllocationBytes === row.newPersistentBytes &&
    measured.pinningAllocationBytes > 0 &&
    row.restored === true && row.pinCostOk === true &&
    row.changedPaths?.length === 0 && row.canaryResult === 0 &&
    row.canaryType === 1 &&
    Number.isFinite(measured.baseline) && Number.isFinite(measured.after) &&
    measured.baseline - measured.after === measured.pinningAllocationBytes,
  'Pinning storage cost was not measured from the owned save');
  check(measured.pinWindowOk === true && row.pinWindowOk === true &&
    row.allPending === true,
  'Owned save requests did not overlap the measured pinning window');
  check(report.cleanedUp === true && !report.error && !report.cleanupError &&
    !report.placementUncertain && !report.stopped,
  'Geometry resources did not clean up');
  const retained = report.retained;
  check(retained?.base === 0 && Array.isArray(retained.handles) &&
    !retained.handles.length && Array.isArray(retained.threads) &&
    !retained.threads.length && Array.isArray(retained.created) &&
    !retained.created.length && !retained.group && !retained.cacheNeedsRestore,
  'Geometry report retains native resources');
  return {verified: true, session, pinningAllocationBytes: measured.pinningAllocationBytes,
    pinWindowOk: measured.pinWindowOk === true, report: report.file, cleanedUp: true};
}

module.exports = {verifyGeometryReport};
