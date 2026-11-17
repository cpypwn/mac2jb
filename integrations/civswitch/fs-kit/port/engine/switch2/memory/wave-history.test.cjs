const test = require('node:test');
const assert = require('node:assert/strict');
const {receiveOrderAbort, holeDelayForProfile, canaryWorkerDelayNs} = require('./wave-history.cjs');

test('only Gravity Circuit starts the canary worker half a millisecond later', () => {
  assert.equal(canaryWorkerDelayNs('gravcirc'), 2200000);
  assert.equal(canaryWorkerDelayNs('balatro'), 1700000);
  assert.equal(canaryWorkerDelayNs('civswitch'), 1700000);
  assert.equal(canaryWorkerDelayNs('smilebasic'), 1700000);
});

test('abort controls use the baseline hole delay while extent tests use the configured delay', () => {
  assert.equal(holeDelayForProfile('abort-control', 3400000), 300000);
  assert.equal(holeDelayForProfile('abort-hole-control', 3400000), 300000);
  assert.equal(holeDelayForProfile('extent-present', 3400000), 3400000);
  assert.equal(holeDelayForProfile('positive', 3400000), 3400000);
  assert.throws(() => holeDelayForProfile('extent-present', 3400001), /Invalid hole-read delay/);
});

const early = margin => ({profile: 'extent-present', triggerAborted: true,
  nativeGuard: {completed: 0, earlyHole: 1, minimumSpacing: 1},
  changedPaths: [], receiveOrderMarginUs: margin});

test('three repeatable receive-order misses stop a focused canary sweep', () => {
  assert.equal(receiveOrderAbort([early(-2200), early(-2500)], 3), null);
  assert.deepEqual(receiveOrderAbort([early(-2200), early(-2500), early(-2100)], 3),
    {count: 3, bestMarginUs: -2100, worstMarginUs: -2500});
});

test('a qualified or changed wave prevents the timing-only cutoff', () => {
  assert.equal(receiveOrderAbort([early(-2200), early(420), early(-2100)], 3), null);
  assert.equal(receiveOrderAbort([early(-2200), {...early(-2500), changedPaths: ['canary']}, early(-2100)], 3), null);
  assert.equal(receiveOrderAbort([early(-2200), {...early(-2500), nativeGuard: {completed: 1, earlyHole: 1}}, early(-2100)], 3), null);
});

test('only consecutive extent-present misses count', () => {
  assert.equal(receiveOrderAbort([early(-2200), {...early(-2500), profile: 'negative'}, early(-2100)], 3), null);
  assert.deepEqual(receiveOrderAbort([early(400), early(-2200), early(-2500), early(-2100)], 3),
    {count: 3, bestMarginUs: -2100, worstMarginUs: -2500});
});
