'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { TITLE_ID, INSTALL_PATHS } = require('../tools/lib/balatro-release.cjs');
const { removeTransaction, validateManifest } = require('../tools/balatro-remove.cjs');

const UID = '00112233445566778899aabbccddeeff';
const names = INSTALL_PATHS.slice(0, 2);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(options = {}) {
  const content = new Map(names.map((name, i) => [name, Buffer.from('launcher file ' + i)]));
  const manifest = { programId: TITLE_ID, uid: UID, space: 1, type: 1,
    files: [...content].map(([path, data]) => ({ path, size: data.length, sha256: digest(data) })) };
  if (options.missing) content.delete(names[0]);
  if (options.changed) content.set(names[0], Buffer.from('launcher FILE 0'));
  if (options.shortRead) content.set(names[0], Buffer.from('launcher file 0'));
  const events = [];
  const handles = new Map();
  let nextHandle = 100;
  let readMounts = 0;
  let commits = 0;
  let staged = new Set();
  const allocate = details => { const handle = nextHandle++; handles.set(handle, details); return handle; };
  const session = {
    async close(handle) {
      const item = handles.get(handle);
      assert.ok(item, 'close must use an open handle');
      events.push(['close', item.kind, item.mode || item.path]);
      handles.delete(handle);
      if (item.mode === 51) staged = new Set();
      if (options.closePrecheckError && item.mode === 53 && item.phase === 'pre') throw new Error('RO close failed');
    },
    async ipc(label, save, command) {
      assert.equal(handles.get(save).mode, 51);
      assert.equal(command, 10);
      commits++;
      events.push(['commit']);
      if (options.commitError) return { result: 0xe02 };
      for (const name of staged) if (!options.keepAfterCommit) content.delete(name);
      staged.clear();
      return { result: 0 };
    }
  };
  const openSave = async mode => {
    assert.ok(mode === 51 || mode === 53);
    assert.equal(handles.size, 0, 'earlier mount and files must close before mounting');
    const phase = mode === 53 && ++readMounts === 1 ? 'pre' : 'post';
    events.push(['mount', mode, phase]);
    return allocate({ kind: 'save', mode, phase });
  };
  const filesystem = {
    async openFile(s, save, path) {
      assert.equal(s, session);
      const mount = handles.get(save);
      assert.equal(mount.mode, 53);
      events.push(['open', mount.phase, path]);
      if (mount.phase === 'pre' && options.openError !== undefined) return { result: options.openError };
      if (mount.phase === 'pre' && options.invalidOpen) return {};
      if (mount.phase === 'post' && options.postError !== undefined) return { result: options.postError };
      if (!content.has(path)) return { result: options.notFoundCode ?? 0x202 };
      return { result: 0, handle: allocate({ kind: 'file', path }) };
    },
    async fileSize(s, handle) { return BigInt(content.get(handles.get(handle).path).length); },
    async readFile(s, handle, offset, length) {
      const bytes = content.get(handles.get(handle).path).subarray(offset, offset + length);
      return options.shortRead ? bytes.subarray(0, -1) : bytes;
    }
  };
  const deleteFile = async (save, path) => {
    assert.equal(handles.get(save).mode, 51);
    events.push(['delete', path]);
    if (options.deleteError && path === names[1]) return { result: 0xe02 };
    if (options.invalidDelete) return {};
    if (options.disappearBeforeDelete) { content.delete(path); return { result: 0x202 }; }
    staged.add(path);
    return { result: 0 };
  };
  const run = changes => removeTransaction({ session, filesystem, openSave, deleteFile,
    manifest, uid: UID, confirm: true, ...changes });
  return { manifest, content, events, handles, run, commits: () => commits };
}

function assertNoWrite(f) {
  assert.equal(f.events.some(event => event[0] === 'mount' && event[1] === 51), false);
  assert.equal(f.commits(), 0);
  assert.equal(f.handles.size, 0);
}

test('verifies all files, removes them in one RW transaction, and verifies absence', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { removed: 2, alreadyAbsent: 0, verifiedAbsent: 2 });
  assert.deepEqual(f.events.filter(event => event[0] === 'mount').map(event => event[1]), [53, 51, 53]);
  assert.deepEqual(f.events.filter(event => event[0] === 'delete').map(event => event[1]), names);
  assert.equal(f.commits(), 1);
  assert.equal(f.content.size, 0);
  assert.equal(f.handles.size, 0);
});

test('rejects changed contents before any RW mount', async () => {
  const f = fixture({ changed: true });
  await assert.rejects(f.run(), /changed since backup.*SHA-256/);
  assertNoWrite(f);
});

test('rejects changed size and short reads before any RW mount', async () => {
  const f = fixture();
  f.manifest.files[0].size++;
  await assert.rejects(f.run(), /changed since backup.*size/);
  assertNoWrite(f);
  const short = fixture({ shortRead: true });
  await assert.rejects(short.run(), /fewer bytes/);
  assertNoWrite(short);
});

test('rejects all non-not-found read errors, including bare 0x2', async () => {
  for (const openError of [0x2, 0xe02, 0xf601]) {
    const f = fixture({ openError });
    await assert.rejects(f.run(), /OpenFile .* failed/);
    assertNoWrite(f);
  }
});

test('rejects malformed open results rather than treating them as success', async () => {
  const f = fixture({ invalidOpen: true });
  await assert.rejects(f.run(), /invalid result/);
  assertNoWrite(f);
});

test('a deletion failure does not commit earlier staged deletions', async () => {
  const f = fixture({ deleteError: true });
  await assert.rejects(f.run(), /DeleteFile .* failed/);
  assert.equal(f.commits(), 0);
  assert.equal(f.content.size, 2);
  assert.equal(f.handles.size, 0);
});

test('malformed delete results fail without committing', async () => {
  const f = fixture({ invalidDelete: true });
  await assert.rejects(f.run(), /invalid result/);
  assert.equal(f.commits(), 0);
  assert.equal(f.handles.size, 0);
});

test('commit failure fails the operation and closes the mount', async () => {
  const f = fixture({ commitError: true });
  await assert.rejects(f.run(), /Commit failed/);
  assert.equal(f.commits(), 1);
  assert.equal(f.content.size, 2);
  assert.equal(f.handles.size, 0);
});

test('post-commit verification fails if a file remains and closes its handle', async () => {
  const f = fixture({ keepAfterCommit: true });
  await assert.rejects(f.run(), /still present after removal/);
  assert.equal(f.commits(), 1);
  assert.equal(f.handles.size, 0);
});

test('post-commit verification fails on errors other than canonical not-found', async () => {
  for (const postError of [0x2, 0xe02]) {
    const f = fixture({ postError });
    await assert.rejects(f.run(), /Verify absence .* failed/);
    assert.equal(f.commits(), 1);
    assert.equal(f.handles.size, 0);
  }
});

test('canonical not-found is resumable and already absent files are not deleted', async () => {
  const f = fixture({ missing: true, notFoundCode: 0x80000202 });
  assert.deepEqual(await f.run(), { removed: 1, alreadyAbsent: 1, verifiedAbsent: 2 });
  assert.deepEqual(f.events.filter(event => event[0] === 'delete').map(event => event[1]), [names[1]]);
  assert.equal(f.commits(), 1);
  assert.equal(f.handles.size, 0);
  const again = await f.run();
  assert.deepEqual(again, { removed: 0, alreadyAbsent: 2, verifiedAbsent: 2 });
  assert.equal(f.commits(), 1);
});

test('files already absent at deletion do not cause an unnecessary commit', async () => {
  const f = fixture({ disappearBeforeDelete: true });
  assert.deepEqual(await f.run(), { removed: 0, alreadyAbsent: 2, verifiedAbsent: 2 });
  assert.equal(f.commits(), 0);
  assert.equal(f.handles.size, 0);
});

test('failure to close the precheck RO mount prevents writable access', async () => {
  const f = fixture({ closePrecheckError: true });
  await assert.rejects(f.run(), /RO close failed/);
  assertNoWrite(f);
});

test('unsupported, traversal, runtime, and duplicate paths fail before console access', async () => {
  for (const path of ['/profile.jkr', '/.nx_save_meta.bin', '/.lovegame/bl_log.txt',
    '/.lovegame/bl_phase.txt', '/.lovegame/../profile.jkr', '/.lovegame//main.lua', '/.lovegame/main.lua\0']) {
    const f = fixture();
    f.manifest.files[0].path = path;
    await assert.rejects(f.run(), /Unsupported removal path/);
    assert.deepEqual(f.events, []);
  }
  const f = fixture();
  f.manifest.files[1] = { ...f.manifest.files[0] };
  await assert.rejects(f.run(), /Duplicate removal path/);
  assert.deepEqual(f.events, []);
});

test('confirmation, UID, title, save type and manifest metadata are validated before console access', async () => {
  for (const changes of [{ confirm: false }, { uid: '1234' }, { uid: '0'.repeat(32) }, { uid: 'f'.repeat(32) }]) {
    const f = fixture();
    await assert.rejects(f.run(changes));
    assert.deepEqual(f.events, []);
  }
  for (const patch of [{ programId: '0000000000000000' }, { space: 2 }, { type: 0 }]) {
    const f = fixture();
    Object.assign(f.manifest, patch);
    await assert.rejects(f.run());
    assert.deepEqual(f.events, []);
  }
  for (const patch of [{ size: -1 }, { size: 64 * 1024 * 1024 + 1 }, { sha256: 'invalid' }]) {
    const f = fixture();
    Object.assign(f.manifest.files[0], patch);
    await assert.rejects(f.run());
    assert.deepEqual(f.events, []);
  }
});

test('empty manifest performs no console operations and actual whitelist has twenty paths', async () => {
  assert.equal(INSTALL_PATHS.length, 20);
  const f = fixture();
  f.manifest.files = [];
  assert.deepEqual(await f.run(), { removed: 0, alreadyAbsent: 0, verifiedAbsent: 0 });
  assert.deepEqual(f.events, []);
  assert.deepEqual(validateManifest(f.manifest, UID.toUpperCase(), true), []);
});
