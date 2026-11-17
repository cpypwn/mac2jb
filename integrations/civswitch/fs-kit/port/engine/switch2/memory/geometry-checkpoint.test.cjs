const test = require('node:test');
const assert = require('node:assert/strict');
const {verifyGeometryReport} = require('./geometry-checkpoint.cjs');

function report() {
  return {session: 'owned-session', completed: true, cleanedUp: true, file: '/tmp/owned.json',
    geometryOnly: {pinningAllocationBytes: 6960, baseline: 100000, after: 93040,
      pinWindowOk: true, attempts: 1},
    cases: [{profile: 'abort-control', triggerAborted: true, nativeGuard: {completed: 1},
      newPersistentBytes: 6960, pinWindowOk: true, allPending: true,
      restored: true, pinCostOk: true, changedPaths: [], canaryResult: 0, canaryType: 1}],
    retained: {base: 0, handles: [], threads: [], created: [], group: null, cacheNeedsRestore: false}};
}

test('accepts only a measured, cleaned owned allocation control', () => {
  assert.deepEqual(verifyGeometryReport(report(), 'owned-session'),
    {verified: true, session: 'owned-session', pinningAllocationBytes: 6960,
      pinWindowOk: true, report: '/tmp/owned.json', cleanedUp: true});
});

test('rejects a pin outside the canary window or requests that miss the trigger', () => {
  const missedPin = report();
  missedPin.geometryOnly.pinWindowOk = false;
  missedPin.cases[0].pinWindowOk = false;
  assert.throws(() => verifyGeometryReport(missedPin, 'owned-session'), /did not overlap/);
  const missedRequest = report();
  missedRequest.cases[0].allPending = false;
  assert.throws(() => verifyGeometryReport(missedRequest, 'owned-session'), /did not overlap/);
});

test('accepts a bounded missed pin only when it was released before retry', () => {
  const measured = report();
  const missed = {...measured.cases[0], pinWindowOk: false,
    pinReleasedAfterRetry: true};
  measured.cases.unshift(missed);
  measured.geometryRetries = 1;
  measured.geometryOnly.attempts = 2;
  assert.equal(verifyGeometryReport(measured, 'owned-session').verified, true);
  missed.pinReleasedAfterRetry = false;
  assert.throws(() => verifyGeometryReport(measured, 'owned-session'), /not released/);
});

test('rejects another session or a mismatched allocation cost', () => {
  assert.throws(() => verifyGeometryReport(report(), 'other-session'), /another session/);
  const changed = report();
  changed.cases[0].newPersistentBytes++;
  assert.throws(() => verifyGeometryReport(changed, 'owned-session'), /cost was not measured/);
});

test('rejects retained native resources', () => {
  const changed = report();
  changed.retained.handles = [42];
  assert.throws(() => verifyGeometryReport(changed, 'owned-session'), /retains native resources/);
});
