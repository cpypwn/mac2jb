#!/usr/bin/env node
// Offline tests for save-delete-root's result handling.
//
//   node tests/test_delete_result.cjs
//
// The delete tool used to print a filesystem result and then trust the commit,
// so a refused DeleteFile could look like success. These tests pin the mapping
// and the command's fail-closed behaviour; console calls themselves are not
// made here.
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {
  EXIT, classifyFsResult, exitForClass, decideDelete, isGone, exitForErrorText,
} = require(path.join(__dirname, '..', 'tools/lib/delete-result.cjs'));

const TOOL = path.join(__dirname, '..', 'tools', 'save-delete-root.cjs');
let passes = 0, failures = 0;
const test = (name, fn) => {
  try { fn(); passes++; console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + '\n      ' + error.message); }
};

test('a zero result is the only successful deletion', () => {
  assert.strictEqual(classifyFsResult(0), 'deleted');
  assert.strictEqual(exitForClass('deleted'), EXIT.ok);
  assert.strictEqual(isGone(EXIT.ok), true);
});

test('the canonical FS not-found result is 0x202, not a bare 0x2', () => {
  assert.strictEqual(classifyFsResult(0x202), 'not-found');
  assert.strictEqual(classifyFsResult(0x2), 'failed',
    'a description without the FS module must fail closed');
  assert.strictEqual(exitForClass('not-found'), EXIT.notFound);
  assert.notStrictEqual(EXIT.notFound, 0);
  assert.strictEqual(isGone(EXIT.notFound), true, 'already absent is safe to skip');
});

test('every other filesystem result is a failure', () => {
  for (const value of [0x1, 0x2, 0x6400, 0x7d402, 0x2ee002]) {
    assert.strictEqual(classifyFsResult(value), 'failed', '0x' + value.toString(16));
    assert.strictEqual(exitForClass('failed'), EXIT.failed);
    assert.strictEqual(isGone(exitForClass('failed')), false);
  }
});

test('a delete cannot be reported successful before the reopen verifies it', () => {
  const decision = decideDelete({fsResult: 0, commitResult: 0, stillPresent: null});
  assert.strictEqual(decision.reason, 'unverified');
  assert.strictEqual(decision.code, EXIT.other);
  assert.strictEqual(isGone(decision.code), false);
});

test('a successful delete needs commit 0 and a verified-absent reopen', () => {
  const decision = decideDelete({fsResult: 0, commitResult: 0, stillPresent: false});
  assert.strictEqual(decision.reason, 'deleted');
  assert.strictEqual(decision.code, EXIT.ok);
  const stillThere = decideDelete({fsResult: 0, commitResult: 0, stillPresent: true});
  assert.strictEqual(stillThere.code, EXIT.failed);
  assert.strictEqual(isGone(stillThere.code), false);
});

test('a missing commit result is never success, even if the file is absent', () => {
  const decision = decideDelete({fsResult: 0, commitResult: null, stillPresent: false});
  assert.strictEqual(decision.reason, 'commit-missing');
  assert.strictEqual(decision.code, EXIT.other);
  assert.strictEqual(isGone(decision.code), false);
});

test('already-absent needs no commit but still needs a verified read-back', () => {
  const unverified = decideDelete({fsResult: 0x202, commitResult: null, stillPresent: null});
  assert.strictEqual(unverified.code, EXIT.other);
  const gone = decideDelete({fsResult: 0x202, commitResult: null, stillPresent: false});
  assert.strictEqual(gone.reason, 'already-absent');
  assert.strictEqual(gone.code, EXIT.notFound);
});

test('a failed read-back never reports success', () => {
  const decision = decideDelete({fsResult: 0, commitResult: 0, stillPresent: true});
  assert.strictEqual(decision.reason, 'still-present');
  assert.strictEqual(decision.code, EXIT.failed);
});

test('a commit failure is a commit exit even when the FS accepted the delete', () => {
  const decision = decideDelete({fsResult: 0, commitResult: 0x2ee002, stillPresent: false});
  assert.strictEqual(decision.reason, 'commit-failed');
  assert.strictEqual(decision.code, EXIT.commit);
  assert.strictEqual(decision.verify, false);
});

test('not-found is only accepted when the reopen agrees it is absent', () => {
  const gone = decideDelete({fsResult: 0x202, commitResult: 0, stillPresent: false});
  assert.strictEqual(gone.code, EXIT.notFound);
  assert.strictEqual(isGone(gone.code), true);
  const contradiction = decideDelete({fsResult: 0x202, commitResult: 0, stillPresent: true});
  assert.strictEqual(contradiction.code, EXIT.failed);
});

test('commit failure is a distinct non-zero exit and never "gone"', () => {
  assert.strictEqual(EXIT.commit, 12);
  assert.notStrictEqual(EXIT.commit, 0);
  assert.strictEqual(isGone(EXIT.commit), false);
});

test('transport failures are classified separately from filesystem failures', () => {
  assert.strictEqual(exitForErrorText('ENOENT: no such file, open memory.sock'), EXIT.noHost);
  assert.strictEqual(exitForErrorText('transport failed 0xf601'), EXIT.sessionLost);
  assert.strictEqual(exitForErrorText('something else'), EXIT.other);
});

test('the command exits 2 without arguments', () => {
  const result = spawnSync(process.execPath, [TOOL], {encoding: 'utf8'});
  assert.strictEqual(result.status, EXIT.usage);
  assert.match(result.stderr, /usage:/);
});

test('the command fails closed on a run directory that does not exist', () => {
  const result = spawnSync(process.execPath, [TOOL, '/tmp/definitely-not-a-run-' + process.pid,
    '010042d022aea000', 'a'.repeat(32), '/proggy.ttf',
    '/tmp/definitely-not-a-backup-' + process.pid], {encoding: 'utf8'});
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /FAILED:/);
});

test('upstream and legacy backups pass delete identity checks', () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-delete-proof-'));
  try {
    const engine = path.join(run, 'switch2');
    const root = path.join(engine, 'ro/root');
    const app = path.join(engine, 'app');
    const shared = path.join(run, 'shared');
    const backup = path.join(run, 'backup');
    for (const dir of [root, app, shared, backup]) fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(engine, 'current-acquisition.json'),
      JSON.stringify({session: 'test', socketPath: path.join(run, 'missing-memory.sock')}));
    fs.writeFileSync(path.join(root, 'current-root.json'),
      JSON.stringify({session: 'test', pid: 1, rootHandle: 1}));
    for (const file of [path.join(app, 'session.cjs'), path.join(app, 'domain.cjs'),
      path.join(app, 'filesystem.cjs'), path.join(shared, 'ipc.cjs')]) {
      fs.writeFileSync(file, 'module.exports = {}');
    }
    const uid = 'a'.repeat(32), title = '010042d022aea000';
    const bytes = Buffer.from('original save');
    const entry = {path: '/save.dat', size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
    const upstream = {archive: 'space=User type=Account rank=0 index=0 uid=' + uid.slice(0, 16),
      programId: title, uid, space: 1, type: 1, rank: 0, index: 0,
      files: 1, bytes: bytes.length, partial: false, failed: [], entries: [entry]};
    const invoke = manifest => {
      fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest));
      return spawnSync(process.execPath, [TOOL, run, title, uid, '/save.dat', backup],
        {encoding: 'utf8'});
    };
    fs.writeFileSync(path.join(backup, 'save.dat'), bytes);
    assert.match(invoke(upstream).stderr, /ENOENT.*missing-memory\.sock/);
    const legacy = {titleId: title, selection: {space: 1, type: 1,
      rank: 0, index: 0, staticId: 0, uid}, archive: upstream.archive,
    files: 1, entries: [entry]};
    assert.match(invoke(legacy).stderr, /ENOENT.*missing-memory\.sock/);
    assert.match(invoke({...upstream, programId: '010012900d38a000'}).stderr,
      /backup does not prove the selected title/);
    assert.match(invoke({...upstream, partial: true}).stderr, /partial or incomplete/);
    assert.match(invoke({...upstream, failed: ['/other.dat']}).stderr, /partial or incomplete/);
    assert.match(invoke({...upstream, files: 2}).stderr, /partial or incomplete/);
    fs.writeFileSync(path.join(backup, 'save.dat'), 'changed bytes');
    assert.match(invoke(upstream).stderr, /SHA-256 verification/);
  } finally {
    fs.rmSync(run, {recursive: true, force: true});
  }
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
