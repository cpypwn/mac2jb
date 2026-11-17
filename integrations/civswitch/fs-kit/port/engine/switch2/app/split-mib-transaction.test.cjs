const test = require('node:test');
const assert = require('node:assert/strict');
const {SIZE, CHUNK_SIZE, attemptSplitMiB, verifiesSplitMiB} =
  require('./split-mib-transaction.cjs');

function probeActions(overrides = {}) {
  const calls = [];
  const actions = {
    freeBytes: async () => {calls.push('space'); return 0x400000n;},
    createDirectory: async () => {calls.push('create-dir'); return 0;},
    commitDirectoryCreate: async () => {calls.push('commit-dir-create'); return 0;},
    createFile: async size => {calls.push(`create-file:${size}`); return 0;},
    commitFileCreate: async () => {calls.push('commit-file-create'); return 0;},
    openWrite: async () => {calls.push('open-write');},
    writeChunk: async (offset, size, fill) => {
      calls.push(`write:${offset}:${size}:${fill}`); return 0;
    },
    close: async () => {calls.push('close');},
    commitWrite: async index => {calls.push(`commit-write:${index}`); return 0;},
    readBackChunk: async (offset, size, fill) => {
      calls.push(`read:${offset}:${size}:${fill}`);
      return {result: 0, matches: true,
        samples: [{offset, matches: true}, {offset: offset + size - 0x10, matches: true}]};
    },
    deleteFile: async () => {calls.push('delete-file'); return 0;},
    commitFileDelete: async () => {calls.push('commit-file-delete'); return 0;},
    verifyFileAbsent: async () => {calls.push('verify-file-absent'); return true;},
    deleteDirectory: async () => {calls.push('delete-dir'); return 0;},
    commitDirectoryDelete: async () => {calls.push('commit-dir-delete'); return 0;},
    verifyDirectoryAbsent: async () => {calls.push('verify-dir-absent'); return true;},
  };
  return {calls, actions: {...actions, ...overrides}};
}

test('1 MiB creation and each 512 KiB write commit and verify separately', async () => {
  const {calls, actions} = probeActions();
  const row = await attemptSplitMiB(actions);
  assert.equal(row.size, SIZE);
  assert.equal(row.chunks.length, 2);
  assert.equal(row.chunks[0].size, CHUNK_SIZE);
  assert.equal(row.verifiedAbsent, true);
  assert.deepEqual(calls, ['space', 'create-dir', 'commit-dir-create',
    'create-file:1048576', 'commit-file-create',
    'open-write', 'write:0:524288:102', 'close', 'commit-write:0', 'read:0:524288:102',
    'open-write', 'write:524288:524288:119', 'close', 'commit-write:1',
    'read:524288:524288:119', 'delete-file', 'commit-file-delete',
    'verify-file-absent', 'delete-dir', 'commit-dir-delete', 'verify-dir-absent']);
  const proof = {target: 'gravcirc', mode: 'split-mib', verified: true,
    cleanedUp: true, leftovers: [{verifiedAbsent: true}], attempt: row};
  assert.equal(verifiesSplitMiB(proof, 'gravcirc'), true);
  assert.equal(verifiesSplitMiB({...proof, attempt: {...row, createCommitResult: 1}}, 'gravcirc'), false);
  assert.equal(verifiesSplitMiB({...proof, cleanedUp: false}, 'gravcirc'), false);
  assert.equal(verifiesSplitMiB(proof, 'civ7'), false);
});

test('low free space stops before creating a scratch directory', async () => {
  const {calls, actions} = probeActions({freeBytes: async () => {
    calls.push('space'); return BigInt(SIZE - 1);
  }});
  await assert.rejects(attemptSplitMiB(actions), /free space/);
  assert.deepEqual(calls, ['space']);
});

test('failed file creation commit stops before the first write', async () => {
  const {calls, actions} = probeActions({commitFileCreate: async () => {
    calls.push('commit-file-create'); return 0xebb46402;
  }});
  await assert.rejects(attemptSplitMiB(actions), error => {
    assert.equal(error.splitRow.createCommitResult, 0xebb46402);
    return true;
  });
  assert.deepEqual(calls, ['space', 'create-dir', 'commit-dir-create',
    'create-file:1048576', 'commit-file-create']);
});

test('failed first chunk commit prevents readback, second write, and deletion', async () => {
  const {calls, actions} = probeActions({commitWrite: async index => {
    calls.push(`commit-write:${index}`); return 0xebb46402;
  }});
  await assert.rejects(attemptSplitMiB(actions), error => {
    assert.equal(error.splitRow.chunks.length, 1);
    assert.equal(error.splitRow.chunks[0].commitResult, 0xebb46402);
    return true;
  });
  assert.equal(calls.includes('delete-file'), false);
  assert.equal(calls.includes('read:0:524288:102'), false);
  assert.equal(calls.includes('write:524288:524288:119'), false);
});

test('failed second chunk commit preserves the committed first chunk and stops before deletion', async () => {
  const {calls, actions} = probeActions({commitWrite: async index => {
    calls.push(`commit-write:${index}`);
    return index === 1 ? 0xebb46402 : 0;
  }});
  await assert.rejects(attemptSplitMiB(actions), error => {
    assert.equal(error.splitRow.chunks.length, 2);
    assert.equal(error.splitRow.chunks[0].commitResult, 0);
    assert.equal(error.splitRow.chunks[0].readBack.matches, true);
    assert.equal(error.splitRow.chunks[1].commitResult, 0xebb46402);
    return true;
  });
  assert.equal(calls.includes('read:524288:524288:119'), false);
  assert.equal(calls.includes('delete-file'), false);
});

test('failed second chunk readback retains the probe file', async () => {
  const {calls, actions} = probeActions({readBackChunk: async (offset, size, fill) => {
    calls.push(`read:${offset}:${size}:${fill}`);
    return {result: 0, matches: offset === 0};
  }});
  await assert.rejects(attemptSplitMiB(actions), error => {
    assert.equal(error.splitRow.chunks.length, 2);
    assert.equal(error.splitRow.chunks[0].readBack.matches, true);
    assert.equal(error.splitRow.chunks[1].readBack.matches, false);
    return true;
  });
  assert.equal(calls.includes('delete-file'), false);
});

test('failed deletion commit stops before directory deletion', async () => {
  const {calls, actions} = probeActions({commitFileDelete: async () => {
    calls.push('commit-file-delete'); return 0xebb46402;
  }});
  await assert.rejects(attemptSplitMiB(actions), error => {
    assert.equal(error.splitRow.fileDeleteCommitResult, 0xebb46402);
    return true;
  });
  assert.equal(calls.includes('delete-dir'), false);
});
