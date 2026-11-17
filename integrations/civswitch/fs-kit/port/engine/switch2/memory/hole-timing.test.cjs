'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const timing = require('./hole-timing.cjs');

function row(role, startUs, endUs, result = 0) {
  return {role, startUs, endUs, result};
}

function control(readSize, found = true) {
  return {profile: 'abort-control', readSize, triggerAborted: true,
    nativeGuard: {completed: 1}, restored: true, canaryResult: 0,
    canaryType: 1, changedPaths: [], rows: [
      row('hole', found ? 275 : 3380, found ? 3790 : 3900),
      row('release', 2900, 2980), row('guard1', 3200, 3290),
      row('canary', found ? 1680 : 2190, found ? 1750 : 2260),
      row('filler0', 1990, 2060),
      row('pin', 2790, 7100),
    ]};
}

function report(found = true) {
  const initial = control(timing.INITIAL_PIN_READ_SIZE);
  initial.pinWindowOk = true;
  initial.pinCostOk = true;
  initial.rows[0] = row('hole', 280, 7730);
  const abortHole = {...control(0x10000), profile: 'abort-hole-control'};
  const measured = control(0x20000, found);
  const window = timing.window(measured);
  return {session: 'switch2-test', target: 'gravcirc', holeTimingEnabled: true,
    completed: true, cleanedUp: true, canaryWaveLimit: 16,
    retained: {base: 0, handles: [], threads: [], created: [], released: true},
    holeTimingPreflight: {verified: true, readSize: 0x80000,
      baseline: {result: 0, offset: 0, size: 0x10000,
        first64Hex: '00'.repeat(64)},
      large: {result: 0, offset: 0, size: 0x80000,
        first64Hex: '00'.repeat(64), last64Hex: '11'.repeat(64)},
      tail: {result: 0, offset: 0x80000 - 64, size: 64,
        first64Hex: '11'.repeat(64)}},
    cases: [initial, abortHole, measured],
    holeTiming: {completed: true, initialPinCaseIndex: 0,
      initialPinCreatedDuringRead: true,
      status: window.usable ? 'window-found' : 'no-window',
      observations: [{readSize: 0x20000, caseIndex: 2, window}]}};
}

test('timing conditions are recorded separately', () => {
  const good = timing.window(control(0x20000));
  assert.deepEqual([good.holeBeforeRelease, good.holePastGuard,
    good.canaryBeforeFiller, good.usable], [true, true, true, true]);
  const miss = timing.window(control(0x20000, false));
  assert.deepEqual([miss.holeBeforeRelease, miss.holePastGuard,
    miss.canaryBeforeFiller, miss.usable], [false, true, false, false]);
});

test('owned abort control must preserve the canary', () => {
  const item = control(0x20000);
  assert.equal(timing.safeControl(item).usable, true);
  item.changedPaths.push('canary');
  assert.throws(() => timing.safeControl(item));
});

test('clean bounded timing report verifies', () => {
  assert.equal(timing.verifyReport(report(), 'switch2-test').status, 'window-found');
  assert.equal(timing.verifyReport(report(false), 'switch2-test').status, 'no-window');
});

test('report requires large read preflight and released resources', () => {
  const item = report();
  item.holeTimingPreflight.tail.result = 0x202;
  assert.throws(() => timing.verifyReport(item, 'switch2-test'));
  const another = report();
  another.retained.handles.push(3);
  assert.throws(() => timing.verifyReport(another, 'switch2-test'));
});

test('initial pin control uses the full verified receive size', () => {
  const item = report();
  item.cases[0].readSize = 0x10000;
  assert.throws(() => timing.verifyReport(item, 'switch2-test'));
});

test('nonoverlapping initial pin is reported without a positive wave', () => {
  const item = report();
  item.cases[0].rows[0] = row('hole', 280, 980);
  item.holeTiming.initialPinCreatedDuringRead = false;
  item.holeTiming.status = 'pin-not-overlapped';
  assert.equal(timing.verifyReport(item, 'switch2-test').status, 'pin-not-overlapped');
  item.holeTiming.status = 'window-found';
  assert.throws(() => timing.verifyReport(item, 'switch2-test'));
});

test('report rejects changed timing and positive waves', () => {
  const item = report();
  item.cases[2].rows[0].startUs = 3500;
  assert.throws(() => timing.verifyReport(item, 'switch2-test'));
  const another = report();
  another.cases.push({...control(0x40000), profile: 'positive'});
  assert.throws(() => timing.verifyReport(another, 'switch2-test'));
});
