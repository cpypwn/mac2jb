const test = require('node:test');
const assert = require('node:assert/strict');
const {measureGeometryControl} = require('./geometry-retry.cjs');

function row(pinWindowOk, allPending = true) {
  return {profile: 'abort-control', triggerAborted: true,
    nativeGuard: {completed: 1}, restored: true, pinCostOk: true,
    newPersistentBytes: 13616, changedPaths: [], canaryResult: 0,
    canaryType: 1, pinWindowOk, allPending};
}

test('releases each missed pin and accepts the first overlapping control', async () => {
  const rows = [row(false), row(true, false), row(true)];
  let next = 0;
  const released = [];
  const result = await measureGeometryControl({
    wave: async () => rows[next++],
    releasePin: async missed => released.push(missed),
  });
  assert.equal(result.row, rows[2]);
  assert.equal(result.attempts, 3);
  assert.deepEqual(released, rows.slice(0, 2));
});

test('exhaustion releases the last missed pin and never runs more than the budget', async () => {
  let waves = 0, releases = 0;
  await assert.rejects(() => measureGeometryControl({
    wave: async () => {waves++; return row(false);},
    releasePin: async () => {releases++;},
    attempts: 3,
  }), /in 3 attempts/);
  assert.equal(waves, 3);
  assert.equal(releases, 3);
});

test('unexpected native state stops before retrying', async () => {
  let releases = 0;
  const unexpected = row(false);
  unexpected.changedPaths = ['canary'];
  await assert.rejects(() => measureGeometryControl({
    wave: async () => unexpected,
    releasePin: async () => {releases++;},
  }), /allocation restoration failed/);
  assert.equal(releases, 0);
});
