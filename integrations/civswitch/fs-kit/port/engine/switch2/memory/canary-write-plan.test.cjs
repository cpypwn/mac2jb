const test = require('node:test');
const assert = require('node:assert/strict');
const {canaryWritePlan} = require('./canary-write-plan.cjs');

test('Gravity Circuit uses a committed 512 KiB candidate with room in its 4 MiB save', () => {
  const plan = canaryWritePlan({name: 'gravcirc'});
  assert.equal(plan.writeSize, 0x80000);
  assert.equal(plan.requiredSaveSpace, 0x190000);
  assert.ok(plan.requiredSaveSpace < 3293184);
});

test('existing targets retain their 8 MiB timing file and save-space gate', () => {
  for (const name of ['civ7', 'smilebasic']) {
    const plan = canaryWritePlan({name});
    assert.equal(plan.writeSize, 0x800000);
    assert.equal(plan.requiredSaveSpace, 0xc10000);
  }
});
