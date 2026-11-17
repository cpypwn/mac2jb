const test = require('node:test');
const assert = require('node:assert/strict');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');

test('marker cleanup accepts verified deletion or verified neutralization', () => {
  assert.equal(markerCleanupVerified({markerRemoved: true}), true);
  assert.equal(markerCleanupVerified({markerRemoved: false,
    markerNeutralized: true}), true);
  assert.equal(markerCleanupVerified({markerRemoved: false,
    markerNeutralized: false}), false);
  assert.equal(markerCleanupVerified({markerNeutralized: true}), false);
  assert.equal(markerCleanupVerified(null), false);
});

test('cleanup summary preserves that a neutralized marker remains', () => {
  assert.deepEqual(markerCleanupSummary({markerNeutralized: true,
    markerRemoved: false}), {markerNeutralized: true, markerRemoved: false});
  assert.deepEqual(markerCleanupSummary({markerRemoved: true}),
    {markerNeutralized: false, markerRemoved: true});
  assert.throws(() => markerCleanupSummary({markerNeutralized: true}),
    /not verified/);
});
