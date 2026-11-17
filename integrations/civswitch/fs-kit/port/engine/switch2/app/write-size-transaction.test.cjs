const test = require('node:test');
const assert = require('node:assert/strict');
const {GEOMETRY_SIZES, selectedGeometrySizes, removeEmptyScratch, probeGeometryFile,
  verifiesBoundedWrite, verifiesGeometryWrite} =
  require('./write-size-transaction.cjs');

function actions(overrides = {}) {
  const calls = [];
  const defaults = {
    create: async size => {calls.push(`create:${size}`); return 0;},
    openWrite: async () => {calls.push('open');},
    write: async () => {calls.push('write'); return {result: 0, canonicalResult: 0};},
    close: async () => {calls.push('close');},
    commitWrite: async () => {calls.push('commit-write'); return 0;},
    readBack: async () => {calls.push('read-back'); return {result: 0, matches: true};},
    delete: async () => {calls.push('delete'); return 0;},
    commitDelete: async () => {calls.push('commit-delete'); return 0;},
  };
  return {calls, operations: {...defaults, ...overrides}};
}

test('geometry sizes grow through small bounded writes before the 8 MiB requirement', () => {
  assert.deepEqual(GEOMETRY_SIZES, [4096, 65536, 262144, 524288,
    1048576, 4194304, 8388608]);
  assert.deepEqual(selectedGeometrySizes('0x80000', true), [4096, 65536, 262144, 524288]);
  assert.deepEqual(selectedGeometrySizes('524288', true), [4096, 65536, 262144, 524288]);
  assert.throws(() => selectedGeometrySizes(undefined, true), /enumerated/);
  assert.throws(() => selectedGeometrySizes('524289', true), /enumerated/);
  assert.throws(() => selectedGeometrySizes('1e6', true), /enumerated/);
});

test('only a verified empty owned directory is removed and committed', async () => {
  const calls = [];
  const row = await removeEmptyScratch('NS2_GAP_WSP_123', {
    statType: async () => {calls.push('stat'); return 0;},
    listContents: async () => {calls.push('list'); return [];},
    deleteDir: async () => {calls.push('delete'); return 0;},
    commitDelete: async () => {calls.push('commit'); return 0;},
    verifyAbsent: async () => {calls.push('verify'); return true;},
  });
  assert.deepEqual(calls, ['stat', 'list', 'delete', 'commit', 'verify']);
  assert.equal(row.verifiedAbsent, true);
});

test('nonempty scratch stops before any mutation', async () => {
  const calls = [];
  await assert.rejects(removeEmptyScratch('NS2_GAP_WSP_123', {
    statType: async () => 0,
    listContents: async () => ['probe_data'],
    deleteDir: async () => {calls.push('delete'); return 0;},
  }), /not empty/);
  assert.deepEqual(calls, []);
});

test('failed scratch commit is reported without a second mutation', async () => {
  const calls = [];
  await assert.rejects(removeEmptyScratch('NS2_GAP_WSP_123', {
    statType: async () => 0, listContents: async () => [],
    deleteDir: async () => {calls.push('delete'); return 0;},
    commitDelete: async () => {calls.push('commit'); return 0xe2346402;},
    verifyAbsent: async () => {calls.push('verify'); return false;},
  }), error => {
    assert.equal(error.scratchRow.commitResult, 0xe2346402);
    return true;
  });
  assert.deepEqual(calls, ['delete', 'commit']);
  await assert.rejects(removeEmptyScratch('NS2_GAP_WSP_fake', {}), /not owned/);
});

test('a committed 8 MiB write is reread before a separate delete commit', async () => {
  const {calls, operations} = actions();
  const row = await probeGeometryFile(0x800000, operations);
  assert.deepEqual(calls, ['create:8388608', 'open', 'write', 'close',
    'commit-write', 'read-back', 'delete', 'commit-delete']);
  assert.equal(row.writeCommitResult, 0);
  assert.equal(row.commitResult, 0);
  assert.deepEqual(row.readBack, {result: 0, matches: true});
  assert.ok(Number.isFinite(row.writeCommitMacWallMs));
  assert.ok(Number.isFinite(row.deleteCommitMacWallMs));
});

test('durable commit timings are Mac-side monotonic intervals', async () => {
  const ticks = [100, 112, 200, 203];
  const {calls, operations} = actions({now: () => ticks.shift()});
  const row = await probeGeometryFile(0x80000, operations);
  assert.equal(row.writeCommitMacWallMs, 12);
  assert.equal(row.deleteCommitMacWallMs, 3);
  assert.equal(row.commitTimingSource, 'Mac-side monotonic wall time');
  assert.deepEqual(row.readBack, {result: 0, matches: true});
  assert.ok(calls.indexOf('commit-write') < calls.indexOf('read-back'));
  assert.ok(calls.indexOf('read-back') < calls.indexOf('delete'));
  assert.equal(ticks.length, 0);
});

test('a failed write commit stops without deleting or retrying', async () => {
  const {calls, operations} = actions({commitWrite: async () => {calls.push('commit-write'); return 0xe2346402;}});
  await assert.rejects(probeGeometryFile(0x100000, operations), error => {
    assert.match(error.message, /Write commit failed/);
    assert.equal(error.probeRow.writeCommitResult, 0xe2346402);
    return true;
  });
  assert.deepEqual(calls, ['create:1048576', 'open', 'write', 'close', 'commit-write']);
});

test('a failed write closes the file and skips both commits', async () => {
  const {calls, operations} = actions({write: async () => {
    calls.push('write'); return {result: 7, canonicalResult: 7};
  }});
  await assert.rejects(probeGeometryFile(0x1000, operations), error => {
    assert.equal(error.probeRow.result, 7);
    return true;
  });
  assert.deepEqual(calls, ['create:4096', 'open', 'write', 'close']);
});

test('a mismatched committed tail stops before deleting the evidence', async () => {
  const {calls, operations} = actions({readBack: async () => {
    calls.push('read-back'); return {result: 0, matches: false};
  }});
  await assert.rejects(probeGeometryFile(0x800000, operations), /tail differs/);
  assert.deepEqual(calls, ['create:8388608', 'open', 'write', 'close',
    'commit-write', 'read-back']);
});

test('a failed delete commit is reported once', async () => {
  const {calls, operations} = actions({commitDelete: async () => {
    calls.push('commit-delete'); return 0xe2346402;
  }});
  await assert.rejects(probeGeometryFile(0x40000, operations), error => {
    assert.equal(error.probeRow.commitResult, 0xe2346402);
    return true;
  });
  assert.equal(calls.filter(call => call === 'commit-delete').length, 1);
});

test('Gravity Circuit geometry gate requires bounded commits, readback and cleanup', () => {
  const sizes = selectedGeometrySizes('524288', true);
  const rows = sizes.map(size => ({size, createResult: 0, result: 0, closed: 0,
    writeCommitResult: 0, writeCommitMacWallMs: 1, deleteCommitMacWallMs: 1,
    commitTimingSource: 'Mac-side monotonic wall time', deleteResult: 0, commitResult: 0,
    ...(size === 0x80000 ? {readBack: {result: 0, matches: true}} : {})}));
  const proof = {verified: true, cleanedUp: true, maxSize: 0x80000,
    scratchCreateCommitResult: 0, scratchDeleteResult: 0, scratchCommitResult: 0,
    results: rows};
  assert.equal(verifiesGeometryWrite(proof, 'gravcirc'), true);
  assert.equal(verifiesGeometryWrite({...proof, results: rows.map((row, index) =>
    index === 3 ? {...row, writeCommitResult: undefined} : row)},
    'gravcirc'), false);
  assert.equal(verifiesGeometryWrite({...proof, results: rows.map((row, index) =>
    index === 3 ? {...row, commitResult: 0xe2346402} : row)},
    'gravcirc'), false);
  assert.equal(verifiesGeometryWrite({...proof, scratchCreateCommitResult: undefined}, 'gravcirc'), false);
  assert.equal(verifiesGeometryWrite({...proof, results: rows.map((row, index) =>
    index === 3 ? {...row, readBack: {result: 0, matches: false}} : row)},
    'gravcirc'), false);
  assert.equal(verifiesGeometryWrite(proof, 'civ7'), false);
  assert.equal(verifiesGeometryWrite({verified: true, cleanedUp: true,
    scratchDeleteResult: 0, scratchCommitResult: 0,
    results: [{size: 0x800000, result: 0, readBack: {result: 0, matches: true},
      closed: 0, deleteResult: 0, commitResult: 0}]}, 'civ7'), true);
});

test('bounded diagnostic requires exactly the selected candidates and committed cleanup', () => {
  const sizes = selectedGeometrySizes('524288', true);
  const rows = sizes.map(size => ({size, createResult: 0, result: 0, closed: 0,
    writeCommitResult: 0, writeCommitMacWallMs: 1, deleteCommitMacWallMs: 1,
    commitTimingSource: 'Mac-side monotonic wall time', deleteResult: 0, commitResult: 0}));
  const proof = {verified: true, cleanedUp: true, maxSize: 524288,
    scratchCreateCommitResult: 0, scratchDeleteResult: 0, scratchCommitResult: 0,
    results: rows};
  assert.equal(verifiesBoundedWrite(proof, 'gravcirc', 524288), true);
  assert.equal(verifiesBoundedWrite(proof, 'civ7', 524288), false);
  assert.equal(verifiesBoundedWrite({...proof, maxSize: 1048576}, 'gravcirc', 1048576), false);
  assert.equal(verifiesBoundedWrite({...proof, results: rows.slice(0, -1)}, 'gravcirc', 524288), false);
  assert.equal(verifiesBoundedWrite({...proof, results: rows.map((row, index) =>
    index === 2 ? {...row, writeCommitResult: 0xe2346402} : row)}, 'gravcirc', 524288), false);
  assert.equal(verifiesBoundedWrite({...proof, scratchCommitResult: 1}, 'gravcirc', 524288), false);
});
