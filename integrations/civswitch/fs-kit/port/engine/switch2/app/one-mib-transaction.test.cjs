const test = require('node:test');
const assert = require('node:assert/strict');
const {SIZE, parseOneShotSize, clearOwnedScratch, attemptOneMiB,
  verifiesOneMiBRetry} = require('./one-mib-transaction.cjs');

function scratchActions(contents = []) {
  const calls = [];
  return {calls, actions: {
    statType: async () => {calls.push('stat'); return 0;},
    listContents: async () => {calls.push('list'); return contents;},
    deleteFile: async () => {calls.push('delete-file'); return 0;},
    commitFileDelete: async () => {calls.push('commit-file'); return 0;},
    verifyFileAbsent: async () => {calls.push('verify-file'); return true;},
    deleteDirectory: async () => {calls.push('delete-dir'); return 0;},
    commitDirectoryDelete: async () => {calls.push('commit-dir'); return 0;},
    verifyDirectoryAbsent: async () => {calls.push('verify-dir'); return true;},
  }};
}

function retryActions(overrides = {}) {
  const calls = [];
  const actions = {
    freeBytes: async () => {calls.push('space'); return 0x800000n;},
    createDirectory: async () => {calls.push('create-dir'); return 0;},
    commitDirectoryCreate: async () => {calls.push('commit-dir-create'); return 0;},
    createFile: async size => {calls.push(`create-file:${size}`); return 0;},
    openWrite: async () => {calls.push('open-write');},
    write: async size => {calls.push(`write:${size}`); return 0;},
    close: async () => {calls.push('close');},
    commitWrite: async () => {calls.push('commit-write'); return 0;},
    readBack: async () => {calls.push('read-back'); return {result: 0, matches: true};},
    deleteFile: async () => {calls.push('delete-file'); return 0;},
    commitFileDelete: async () => {calls.push('commit-file-delete'); return 0;},
    verifyFileAbsent: async () => {calls.push('verify-file'); return true;},
    deleteDirectory: async () => {calls.push('delete-dir'); return 0;},
    commitDirectoryDelete: async () => {calls.push('commit-dir-delete'); return 0;},
    verifyDirectoryAbsent: async () => {calls.push('verify-dir'); return true;},
  };
  return {calls, actions: {...actions, ...overrides}};
}

test('one-shot retry accepts only explicit one or two MiB candidates', () => {
  assert.equal(parseOneShotSize(undefined), SIZE);
  assert.equal(parseOneShotSize('1m'), SIZE);
  assert.equal(parseOneShotSize('2m'), 0x200000);
  assert.equal(parseOneShotSize('2097152'), 0x200000);
  for (const value of ['0', '512k', '3m', '1048577', '-1'])
    assert.throws(() => parseOneShotSize(value), /1m or 2m/);
});

test('old owned probe file is deleted, committed, and verified before its directory', async () => {
  const {calls, actions} = scratchActions([{name: 'probe_data', type: 1, size: '1048576'}]);
  const row = await clearOwnedScratch('NS2_GAP_WSP_12345', actions);
  assert.equal(row.fileVerifiedAbsent, true);
  assert.equal(row.verifiedAbsent, true);
  assert.deepEqual(calls, ['stat', 'list', 'delete-file', 'commit-file', 'verify-file',
    'delete-dir', 'commit-dir', 'verify-dir']);
});

test('empty owned scratch uses nonrecursive delete and verified commit', async () => {
  const {calls, actions} = scratchActions();
  await clearOwnedScratch('NS2_GAP_WSP_12345', actions);
  assert.deepEqual(calls, ['stat', 'list', 'delete-dir', 'commit-dir', 'verify-dir']);
});

test('unexpected scratch path or content stops before any delete', async () => {
  for (const [name, contents] of [
    ['NS2_GAP_WSP_other', []],
    ['NS2_GAP_WSP_123', [{name: 'game_data', type: 1, size: '12'}]],
    ['NS2_GAP_WSP_123', [{name: 'probe_data', type: 0, size: '12'}]],
    ['NS2_GAP_WSP_123', [{name: 'probe_data', type: 1, size: '16777217'}]],
    ['NS2_GAP_WSP_123', [{name: 'probe_data', type: 1, size: '12'},
      {name: 'other', type: 1, size: '12'}]],
  ]) {
    const {calls, actions} = scratchActions(contents);
    await assert.rejects(clearOwnedScratch(name, actions));
    assert.equal(calls.filter(value => value.startsWith('delete')).length, 0);
  }
});

test('uncertain old file commit prevents directory deletion and retry', async () => {
  const {calls, actions} = scratchActions([{name: 'probe_data', type: 1, size: '1048576'}]);
  actions.commitFileDelete = async () => {calls.push('commit-file'); return 0xe2346402;};
  await assert.rejects(clearOwnedScratch('NS2_GAP_WSP_123', actions), error => {
    assert.equal(error.scratchRow.fileCommitResult, 0xe2346402);
    return true;
  });
  assert.deepEqual(calls, ['stat', 'list', 'delete-file', 'commit-file']);
});

test('one 1 MiB candidate commits before readback, then verifies both deletions', async () => {
  const {calls, actions} = retryActions();
  const row = await attemptOneMiB(actions);
  assert.equal(row.size, SIZE);
  assert.equal(row.freeBytes, '8388608');
  assert.equal(row.readBack.matches, true);
  assert.equal(row.verifiedAbsent, true);
  assert.deepEqual(calls, ['space', 'create-dir', 'commit-dir-create',
    'create-file:1048576', 'open-write', 'write:1048576', 'close', 'commit-write',
    'read-back', 'delete-file', 'commit-file-delete', 'verify-file', 'delete-dir',
    'commit-dir-delete', 'verify-dir']);
});

test('2 MiB remains one selected candidate with no automatic smaller attempt', async () => {
  const {calls, actions} = retryActions();
  const row = await attemptOneMiB(actions, 0x200000);
  assert.equal(row.size, 0x200000);
  assert.equal(calls.filter(value => value.startsWith('create-file:')).length, 1);
  assert.ok(calls.includes('create-file:2097152'));
});

test('low free space stops before creating scratch', async () => {
  const {calls, actions} = retryActions({freeBytes: async () => {calls.push('space'); return 0xfffffn;}});
  await assert.rejects(attemptOneMiB(actions), /free space/);
  assert.deepEqual(calls, ['space']);
});

test('failed write commit stops before readback, deletion, or another candidate', async () => {
  const {calls, actions} = retryActions({commitWrite: async () => {
    calls.push('commit-write'); return 0xe2346402;
  }});
  await assert.rejects(attemptOneMiB(actions), error => {
    assert.equal(error.retryRow.writeCommitResult, 0xe2346402);
    return true;
  });
  assert.deepEqual(calls, ['space', 'create-dir', 'commit-dir-create',
    'create-file:1048576', 'open-write', 'write:1048576', 'close', 'commit-write']);
});

test('readback mismatch retains file for inspection instead of deleting', async () => {
  const {calls, actions} = retryActions({readBack: async () => {
    calls.push('read-back'); return {result: 0, matches: false};
  }});
  await assert.rejects(attemptOneMiB(actions), /differs/);
  assert.equal(calls.includes('delete-file'), false);
});

test('proof gate requires committed write, readback, both committed deletes, and cleanup', async () => {
  const row = await attemptOneMiB(retryActions().actions);
  const proof = {mode: 'one-mib-retry', verified: true, cleanedUp: true,
    leftovers: [{verifiedAbsent: true}], attempt: row};
  assert.equal(verifiesOneMiBRetry(proof, 'gravcirc'), true);
  assert.equal(verifiesOneMiBRetry(proof, 'civ7'), false);
  assert.equal(verifiesOneMiBRetry(proof, 'gravcirc', 0x200000), false);
  assert.equal(verifiesOneMiBRetry({...proof, attempt: {...row, fileVerifiedAbsent: false}}, 'gravcirc'), false);
  assert.equal(verifiesOneMiBRetry({...proof, attempt: {...row, writeCommitResult: 1}}, 'gravcirc'), false);
  assert.equal(verifiesOneMiBRetry({...proof, leftovers: [{verifiedAbsent: false}]}, 'gravcirc'), false);
});
