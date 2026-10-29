const test = require('node:test');
const assert = require('node:assert/strict');
const {qualifyOverlap} = require('./wave-overlap.cjs');

function wave({heldEnd = 25, throughEnd = 25, heldStart = 5} = {}) {
  return [
    {role: 'trigger', startUs: 10, endUs: 20},
    ...['canary', 'filler0', 'filler1', 'guard0', 'guard1'].map(role =>
      ({role, startUs: heldStart, endUs: heldEnd})),
    ...['commit', 'tail0', 'tail1', 'tail2', 'tail3'].map(role =>
      ({role, startUs: 5, endUs: throughEnd})),
  ];
}

test('save-only fallback requires held paths at trigger entry and tails through completion', () => {
  assert.deepEqual(qualifyOverlap(wave({heldEnd: 15})),
    {qualified: true, mode: 'trigger-entry'});
  assert.equal(qualifyOverlap(wave({heldEnd: 9})).qualified, false);
  assert.equal(qualifyOverlap(wave({heldStart: 11})).qualified, false);
  assert.equal(qualifyOverlap(wave({throughEnd: 19})).qualified, false);
});

test('missing timing roles never qualify', () => {
  assert.equal(qualifyOverlap(wave().filter(row => row.role !== 'canary')).qualified, false);
  assert.equal(qualifyOverlap(wave().filter(row => row.role !== 'trigger')).qualified, false);
});
