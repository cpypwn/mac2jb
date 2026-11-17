const test = require('node:test');
const assert = require('node:assert/strict');
const {verifiesScratchCleanup} = require('./cleanup-scratch.cjs');

test('scratch cleanup requires every discovered path gone and fresh save space', () => {
  const proof = {cleanedUp: true, previous: [{name: 'save', path: '/NS2_GAP_old'}],
    removed: [{name: 'save', path: '/NS2_GAP_old'}], remaining: [],
    saveFreeBytes: '3260416'};
  assert.equal(verifiesScratchCleanup(proof), true);
  assert.equal(verifiesScratchCleanup({...proof, remaining: proof.previous}), false);
  assert.equal(verifiesScratchCleanup({...proof, removed: []}), false);
  assert.equal(verifiesScratchCleanup({...proof, saveFreeBytes: undefined}), false);
  assert.equal(verifiesScratchCleanup({...proof, cleanedUp: false}), false);
});
