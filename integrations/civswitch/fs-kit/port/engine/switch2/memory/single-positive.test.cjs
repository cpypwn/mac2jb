'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const one = require('./single-positive.cjs');

const session = 'switch2-test';
const window = {restored: true, triggerAborted: false, allPending: true,
  receiveOrderMarginUs: 650, preReleaseUsed: 0x2700};

function row(profile, result, type, extra = {}) {
  return {...window, profile, selectedMarker: result === 0 && type === 1,
    changedPaths: [], canaryResult: 0, canaryType: 1,
    rows: [{role: 'trigger', result, inline: type === null ? '' :
      Buffer.from(Uint32Array.of(type).buffer).toString('hex')}], ...extra};
}

function report(positive = true) {
  const cases = [row('abort-control', 0x202, null, {triggerAborted: true}),
    row('abort-hole-control', 0x202, null, {triggerAborted: true}),
    row('extent-absent', 0x202, null),
    row('marker-first-descriptor-marker', 0, 1,
      {pathTerminatorOffset: 0x7ff}),
    row('marker-first-descriptor-absent', 0x202, null,
      {pathTerminatorOffset: 0x7ff})];
  if (positive) {
    cases.push(row('negative', 0x2eec02, null, {selectedMarker: false}));
    cases.push(row('positive', 0x2eec02, null, {selectedMarker: false,
      changedPaths: ['canary'], canaryType: 0}));
  }
  return {session, target: 'gravcirc', singlePositiveEnabled: true,
    singlePositive: {status: positive ? 'marker-hit' : 'controls-inconclusive',
      positiveCaseIndices: positive ? [6] : [],
      qualifiedPositiveExecutions: positive ? 1 : 0, completed: true,
      directControls: {before: {marker: {result: 0, type: 1}, absent: 0x202},
        after: {marker: {result: 0, type: 1}, absent: 0x202}}},
    completed: true, cleanedUp: true, canaryWaveLimit: 16, cases,
    extentMarkerControl: {original: {result: 0, type: 1},
      cloned: {result: 0, type: 1}, padded: {result: 0, type: 1}},
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false, released: true}, markerOffset: 0x2340};
}

test('requires a qualified owned marker and intact cleanup before reporting a hit', () => {
  const value = report();
  assert.equal(one.verifyReport(value, session).markerHit, true);
  value.retained.released = false;
  assert.throws(() => one.verifyReport(value, session), /retained native resources/);
  value.retained.released = true;
  value.cases[6].changedPaths = ['canary', 'guard0'];
  assert.throws(() => one.verifyReport(value, session), /uncertain/);
});

test('an unchanged owned canary can be retried without claiming a marker', () => {
  const value = report();
  value.cases[6].changedPaths = [];
  value.cases[6].canaryType = 1;
  assert.equal(one.positiveOutcome(value.cases[6]).retrySafe, true);
  assert.throws(() => one.verifyReport(value, session), /summary differs/);
  value.singlePositive.status = 'qualified-miss';
  assert.equal(one.verifyReport(value, session).markerHit, false);
});

test('an aborted positive may precede one qualified marker hit', () => {
  const value = report();
  value.cases.splice(6, 0, row('positive', 0x202, null,
    {selectedMarker: false, triggerAborted: true, allPending: false}));
  value.singlePositive.positiveCaseIndices = [6, 7];
  assert.equal(one.verifyReport(value, session).positiveCases, 2);
});

test('unexpected owned-path changes stop retry and retain state', () => {
  const value = report();
  value.cases[6].changedPaths = ['guard0'];
  assert.equal(one.positiveOutcome(value.cases[6]).retrySafe, false);
  assert.throws(() => one.verifyReport(value, session), /uncertain/);
});

test('an inconclusive control sequence does not report FS progress', () => {
  const value = report(false);
  value.cases.pop();
  assert.deepEqual(one.verifyReport(value, session), {
    diagnostic: 'single-positive', session, status: 'controls-inconclusive',
    markerHit: false, positiveCases: 0, qualifiedPositiveExecutions: 0,
    markerOffset: 0x2340,
    cleanedUp: true});
});

test('the absent matched path cannot count as marker selection', () => {
  const value = report();
  value.cases[4] = row('marker-first-descriptor-absent', 0, 1,
    {pathTerminatorOffset: 0x7ff});
  assert.throws(() => one.verifyReport(value, session), /Absent path selected/);
});

test('a partial positive start cannot pass report verification', () => {
  const value = report();
  value.placementUncertain = true;
  assert.throws(() => one.verifyReport(value, session), /clean resources/);
});
