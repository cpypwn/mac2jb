'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {verifyCanaryReport, verifyRetainedCanaryReport} = require('./canary-checkpoint.cjs');

const positive = firstCaseIndex => ({profile: 'positive', status: 'selected', firstCaseIndex,
  markerHits: 1, restorationFailures: 0, unexpectedChanges: 0, unknownExecution: 0});
const report = () => ({session: 'this-boot', file: '/tmp/canary.json',
  canaryCheckpoint: {verified: true, markerSelected: true, markerReproduced: true},
  markerSelected: true, markerReproduced: true, cleanedUp: true,
  retryBatches: [positive(0), {profile: 'extent-present', status: 'selected'}, positive(3)],
  retained: {base: 0, handles: [], threads: [], created: [], group: null,
    cacheNeedsRestore: false}});

test('accepts two qualified marker hits separated by an extent control and complete cleanup', () => {
  const verified = verifyCanaryReport(report(), 'this-boot');
  assert.equal(verified.checkpoint, 'repeated-positive-canary');
  assert.equal(verified.cleanedUp, true);
});

test('rejects a stale session, missing repeat, or failed extent control', () => {
  assert.throws(() => verifyCanaryReport(report(), 'other-boot'), /another session/);
  const one = report(); one.retryBatches.pop();
  assert.throws(() => verifyCanaryReport(one, one.session), /two positive/);
  const extent = report(); extent.retryBatches[1].status = 'exhausted';
  assert.throws(() => verifyCanaryReport(extent, extent.session), /extent control/);
});

test('rejects uncertain placement, unclean resources, and unqualified marker batches', () => {
  for (const change of [
    value => {value.placementUncertain = true;},
    value => {value.cleanedUp = false;},
    value => {value.retained.threads = [42];},
    value => {value.retryBatches[2].unexpectedChanges = 1;},
  ]) {
    const value = report(); change(value);
    assert.throws(() => verifyCanaryReport(value, value.session));
  }
});

function retainedReport() {
  const value = report();
  value.cleanedUp = false;
  Object.assign(value.canaryCheckpoint,
    {session: value.session, retained: true, nextStage: 'memory-acquisition'});
  value.memoryControl = {ready: true, socketPath: '/tmp/gc-memory.sock'};
  return value;
}

test('live canary checkpoint permits same-session acquisition with repeated marker retained', () => {
  const value = retainedReport();
  const verified = verifyRetainedCanaryReport(value, value.session);
  assert.equal(verified.retained, true);
  assert.equal(verified.checkpoint, 'repeated-positive-canary');
});

test('live canary checkpoint rejects cleanup, another session, missing marker or endpoint', () => {
  for (const change of [
    value => {value.canaryCheckpoint.session = 'other-boot';},
    value => {value.cleanedUp = true;},
    value => {value.canaryCheckpoint.retained = false;},
    value => {value.canaryCheckpoint.nextStage = 'cleanup';},
    value => {value.memoryControl.ready = false;},
    value => {value.memoryControl.socketPath = null;},
    value => {value.retryBatches.pop();},
    value => {value.retryBatches[1].status = 'failed';},
    value => {value.placementUncertain = true;},
  ]) {
    const value = retainedReport(); change(value);
    assert.throws(() => verifyRetainedCanaryReport(value, value.session));
  }
});
