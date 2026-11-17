'use strict';

const {positiveOutcome} = require('./wave-history.cjs');

function verifyMarkerEvidence(report, session) {
  const check = (condition, message) => {if (!condition) throw Error(message);};
  check(report?.session === session, 'Canary report belongs to another session');
  check(!report.error && !report.cleanupError && !report.placementUncertain && !report.stopped,
    'Canary report has an error or uncertain native state');
  check(report?.canaryCheckpoint?.verified === true &&
    report.canaryCheckpoint.markerSelected === true &&
    report.canaryCheckpoint.markerReproduced === true &&
    report.markerSelected === true && report.markerReproduced === true,
  'Repeated positive canary marker did not verify');
  const batches = report.retryBatches || [];
  const positives = batches.map((batch, index) => ({batch, index}))
    .filter(({batch}) => batch.profile === 'positive');
  check(positives.length >= 2, 'Canary report lacks two positive marker batches');
  const [first, repeated] = positives.slice(-2);
  check(batches.slice(first.index + 1, repeated.index).some(batch =>
    batch.profile === 'extent-present' && batch.status === 'selected'),
  'Canary report lacks the repeated extent control');
  for (const {batch} of [first, repeated])
    check(batch.status === 'selected' && positiveOutcome(batch).verified,
      'A positive canary batch did not verify');
  return {first, repeated};
}

function verifyCanaryReport(report, session) {
  const {first, repeated} = verifyMarkerEvidence(report, session);
  const check = (condition, message) => {if (!condition) throw Error(message);};
  check(report.cleanedUp === true && !report.error && !report.cleanupError &&
    !report.placementUncertain && !report.stopped,
  'Canary resources did not clean up');
  const retained = report.retained;
  check(retained?.base === 0 && Array.isArray(retained.handles) && !retained.handles.length &&
    Array.isArray(retained.threads) && !retained.threads.length &&
    Array.isArray(retained.created) && !retained.created.length && !retained.group &&
    !retained.cacheNeedsRestore,
  'Canary report retains native resources');
  return {verified: true, checkpoint: 'repeated-positive-canary', session,
    report: report.file, firstPositive: first.batch, repeatedPositive: repeated.batch,
    cleanedUp: true};
}

function verifyRetainedCanaryReport(report, session) {
  const {first, repeated} = verifyMarkerEvidence(report, session);
  const checkpoint = report.canaryCheckpoint;
  if (checkpoint.session !== session || checkpoint.retained !== true ||
      checkpoint.nextStage !== 'memory-acquisition' || report.cleanedUp === true ||
      report.memoryControl?.ready !== true || !report.memoryControl.socketPath)
    throw Error('Live same-session canary checkpoint is not retained for memory acquisition');
  return {verified: true, checkpoint: 'repeated-positive-canary', session,
    report: report.file, firstPositive: first.batch, repeatedPositive: repeated.batch,
    retained: true};
}

module.exports = {verifyCanaryReport, verifyRetainedCanaryReport};
