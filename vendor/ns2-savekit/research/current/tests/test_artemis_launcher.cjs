#!/usr/bin/env node
// Offline tests for the Artemis Launcher installer: staging safety, the
// immutable original baseline, update transactions, legacy migration, backup
// integrity and rollback planning.
//
//   node tests/test_artemis_launcher.cjs
//
// No console and no network: fixtures are synthetic and every console-shaped
// command in the tests must fail before it opens one.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'artemis-launcher.cjs');
const launcher = require(TOOL);
const {validateBackup} = require(path.join(ROOT, 'tools/lib/artemis-backup.cjs'));
const staging = require(path.join(ROOT, 'tools/lib/artemis-staging.cjs'));
const receipts = require(path.join(ROOT, 'tools/lib/artemis-receipt.cjs'));

let passes = 0, failures = 0;
const test = async (name, fn) => {
  try { await fn(); passes++; console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + '\n      ' + (error && error.stack || error)); }
};

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const UID = 'a'.repeat(32);
const TITLE = '010042d022aea000';
const TITLE_OBJ = () => launcher.titleFor(TITLE);

async function withState(fn) {
  const previous = process.env.ARTEMIS_STATE;
  const dir = tmp('artemis-state-');
  process.env.ARTEMIS_STATE = dir;
  try { return await fn(dir); }
  finally {
    if (previous === undefined) delete process.env.ARTEMIS_STATE;
    else process.env.ARTEMIS_STATE = previous;
  }
}

// A minimal valid BOWS v1002 container used by the trigger fixtures.
function bowsFixture(script = 'save:/game.asb') {
  const fields = Buffer.alloc(0x50);
  fields.writeUInt32LE(0, 0x00);
  fields.writeUInt32LE(0, 0x04);
  const text = Buffer.from(script);
  fields.writeUInt32LE(text.length, 0x08);
  text.copy(fields, 0x0c);
  fields.writeUInt32LE(0, 0x20);
  const groups = [[0x00, [[3, 0x40], [4, 0x20]]],
    [0x40, [[1, 0x00], [3, 0x08], [4, 0x04]]]];
  const parts = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(groups.length, 0);
  for (const [base, entries] of groups) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(base, 0);
    head.writeUInt32LE(entries.length, 4);
    parts.push(head);
    for (const [key, offset] of entries) {
      const row = Buffer.alloc(8);
      row.writeUInt32LE(key, 0);
      row.writeUInt32LE(offset, 4);
      parts.push(row);
    }
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(fields.length, 0);
  const body = Buffer.concat([...parts, tail]);
  const header = Buffer.alloc(12);
  header.write('BOWS', 0, 'latin1');
  header.writeUInt32LE(1002, 4);
  header.writeUInt32LE(body.length, 8);
  return Buffer.concat([header, zlib.deflateSync(body, {level: 9})]);
}

function upstreamFixture() {
  const dir = tmp('artemis-upstream-');
  for (const overlay of ['seedsow_save', 'nora2_save']) {
    fs.mkdirSync(path.join(dir, overlay), {recursive: true});
    fs.writeFileSync(path.join(dir, overlay, 'core.lua'), 'fixture core ' + overlay);
  }
  fs.mkdirSync(path.join(dir, 'common'));
  for (const name of ['inject.iet', 'inject.lua', 'http.lua', 'exploita.lua', 'proggy.ttf']) {
    fs.writeFileSync(path.join(dir, 'common', name), 'fixture ' + name);
  }
  return dir;
}

function backupFixture({identity = true, partial = false, failed = [], extra = [],
  trigger = true, titleId = TITLE, uid = UID, corrupt = false, mutate,
  realTrigger = false, contents = {}} = {}) {
  const dir = tmp('artemis-backup-');
  const entries = [];
  const add = (name, bytes) => {
    fs.writeFileSync(path.join(dir, name), bytes);
    entries.push({path: '/' + name, size: bytes.length, sha256: sha(bytes)});
  };
  add('system.dat', Buffer.from('sys!'));
  add('saveg.dat', Buffer.from('savg'));
  if (trigger) add('save9999.dat', realTrigger ? bowsFixture() : Buffer.from('game suspend save'));
  for (const name of ['ns2jb.asb', 'ns2jb.lua', 'ssedit1.lua', 'sed01.asb']) add(name, 'x' + name);
  for (const name of extra) add(name, 'editor ' + name);
  for (const [name, bytes] of Object.entries(contents)) add(name, bytes);
  if (corrupt) fs.writeFileSync(path.join(dir, 'system.dat'), 'corrupt');
  const manifest = {
    archive: 'space=User type=Account rank=0 index=0 uid=' + String(uid).slice(0, 16),
    files: entries.length,
    bytes: entries.reduce((n, e) => n + e.size, 0),
    partial,
    failed,
    entries,
  };
  if (identity) { manifest.programId = titleId; manifest.uid = uid; }
  if (mutate) mutate(manifest);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

async function loadValid(dir) {
  const backup = await validateBackup(dir, {trigger: 'save9999.dat'});
  assert.strictEqual(backup.ok, true, backup.problems.join('; '));
  return backup;
}

function planFixture() {
  const files = launcher.LAUNCHER_FILES.map(name => ({
    path: '/' + name, local: name, size: 10, sha256: sha(Buffer.from(name)),
    replace: false,
  }));
  files.push({path: '/save9999.dat', local: 'save9999.dat', size: 20,
    sha256: sha(Buffer.from('installed trigger')), replace: true});
  return {files, manifest: {}, conflicts: []};
}

async function originalFixture({backupDir, plan = planFixture()} = {}) {
  const backup = await loadValid(backupDir || backupFixture());
  return {record: launcher.originalRecord({title: TITLE_OBJ(), uid: UID, backup, plan}),
    backup, plan};
}

function liveFixture(files) {
  return {entries: files.map(file => ({path: file.path, size: file.size,
    sha256: file.sha256}))};
}

function snapshotFixture(files) {
  return {
    dir: '/tmp/snapshot',
    manifestSha256: sha(Buffer.from('snapshot-manifest')),
    entries: files.map(file => ({path: file.path, size: file.size, sha256: file.sha256})),
    identity: null,
  };
}

const pin = name => sha(Buffer.from('pinned ' + name));

function migrationPinned() {
  const pinned = {};
  for (const name of launcher.LAUNCHER_FILES) pinned['/' + name] = pin(name);
  return pinned;
}

function migrationSnapshot(pinned, triggerHash) {
  const files = Object.entries(pinned).map(([p, hash]) => ({
    path: p, size: 10, sha256: hash,
  }));
  files.push({path: '/save9999.dat', size: 20, sha256: triggerHash});
  return snapshotFixture(files);
}

async function stageFixture({upstream = upstreamFixture(), backup, out,
  retarget = (input, output) => fs.copyFileSync(input, output)} = {}) {
  const title = TITLE_OBJ();
  const staged = await launcher.stageTo({title, upstream, backup, outDir: out, retarget});
  const plan = await launcher.buildManifest({title, outDir: staged.build, backup});
  await launcher.writeManifest(staged.build, plan.manifest);
  await staging.promoteBuild(staged.build, staged.target, title.id);
  return {plan, out: staged.target};
}

async function run() {
  // ------------------------------------------------------------- titles/pins --
  await test('the two supported demo ids select their own overlay', () => {
    assert.strictEqual(launcher.titleFor('010042d022aea000').overlay, 'seedsow_save');
    assert.strictEqual(launcher.titleFor('0x010012900d38a000').overlay, 'nora2_save');
  });

  await test('an unsupported title is refused with exit 5', () => {
    for (const id of ['0100ee5021c9e000', '01005eb012fe2000', '', null]) {
      assert.throws(() => launcher.titleFor(id), error =>
        error instanceof launcher.Failure && error.code === launcher.EXIT.unsupported);
    }
  });

  await test('pinned files exclude upstream game state and match expectedHashes', () => {
    const seedsow = TITLE_OBJ();
    const pinned = launcher.pinnedFor(seedsow);
    assert.ok(!Object.keys(pinned).some(n => /saveg\.dat|system\.dat|save9999\.dat/.test(n)));
    assert.deepStrictEqual(Object.keys(launcher.expectedHashes(seedsow)).sort(),
      launcher.LAUNCHER_FILES.map(n => '/' + n).sort());
  });

  // ----------------------------------------------------------------- staging --
  await test('staging writes seven files with a deterministic manifest', async () => {
    const backup = await loadValid(backupFixture());
    const out = path.join(tmp('artemis-stage-'), 'payload');
    const {plan} = await stageFixture({backup, out});
    assert.deepStrictEqual(plan.files.map(f => f.path), [
      '/core.lua', '/exploita.lua', '/http.lua', '/inject.iet', '/inject.lua',
      '/proggy.ttf', '/save9999.dat']);
    assert.strictEqual(plan.files.filter(f => f.replace).length, 1);
    for (const file of plan.files) {
      assert.strictEqual(file.local, path.basename(file.local));
      assert.strictEqual(sha(fs.readFileSync(path.join(out, file.local))), file.sha256);
    }
    assert.ok(fs.existsSync(path.join(out, staging.MARKER)));
  });

  await test('rebuilding the same staging directory is byte-identical', async () => {
    const backup = await loadValid(backupFixture());
    const out = path.join(tmp('artemis-det-'), 'payload');
    const once = async () => JSON.stringify((await stageFixture({backup, out})).plan.manifest);
    assert.strictEqual(await once(), await once());
  });

  await test('dangerous staging destinations are refused', async () => {
    for (const out of ['/', os.homedir(), ROOT, path.join(ROOT, 'tools'),
      path.join(ROOT, 'staging')]) {
      await assert.rejects(staging.assertSafeTarget(out, {titleId: TITLE, repo: ROOT}),
        error => error.code === 'EUNSAFE');
    }
  });

  await test('an unrelated existing directory is not deleted', async () => {
    const dir = tmp('artemis-unrelated-');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
    await assert.rejects(staging.assertSafeTarget(dir, {titleId: TITLE, repo: ROOT}),
      error => error.code === 'EUNSAFE');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'keep');
  });

  await test('a symlinked staging target is refused', async () => {
    const link = path.join(tmp('artemis-link-'), 'payload');
    fs.symlinkSync(tmp('artemis-real-'), link);
    await assert.rejects(staging.assertSafeTarget(link, {titleId: TITLE, repo: ROOT}),
      error => error.code === 'EUNSAFE');
  });

  await test('a failed build leaves the previous staged payload untouched', async () => {
    const backup = await loadValid(backupFixture());
    const out = path.join(tmp('artemis-keep-'), 'payload');
    await stageFixture({backup, out});
    const before = fs.readFileSync(path.join(out, 'core.lua'));
    await assert.rejects(launcher.stageTo({title: TITLE_OBJ(), upstream: upstreamFixture(),
      backup, outDir: out, retarget: () => { throw new Error('simulated failure'); }}));
    assert.deepStrictEqual(fs.readFileSync(path.join(out, 'core.lua')), before);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(out))
      .filter(n => n.startsWith('.artemis-build-')), []);
  });

  // -------------------------------------------------- legacy staging adoption --
  await test('a valid unmarked staging directory can be adopted by content', async () => {
    const dir = tmp('artemis-legacy-stage-');
    const expected = {};
    for (const name of launcher.LAUNCHER_FILES) {
      fs.writeFileSync(path.join(dir, name), 'legacy ' + name);
      expected['/' + name] = sha(Buffer.from('legacy ' + name));
    }
    fs.writeFileSync(path.join(dir, 'save9999.dat'), 'legacy trigger');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"old":true}');
    const verdict = await launcher.verifyLegacyStaging(dir, TITLE_OBJ(), {
      expected, checkTrigger: async () => ({ok: true}),
    });
    assert.deepStrictEqual(verdict.problems, []);
    await staging.assertSafeTarget(dir, {titleId: TITLE, repo: ROOT, adopt: () => verdict});
    assert.ok(fs.existsSync(path.join(dir, staging.MARKER)));
  });

  await test('a legacy staging directory with a modified or extra file is refused', async () => {
    const dir = tmp('artemis-legacy-bad-');
    const expected = {};
    for (const name of launcher.LAUNCHER_FILES) {
      fs.writeFileSync(path.join(dir, name), 'legacy ' + name);
      expected['/' + name] = sha(Buffer.from('legacy ' + name));
    }
    fs.writeFileSync(path.join(dir, 'save9999.dat'), 'trigger');
    fs.writeFileSync(path.join(dir, 'core.lua'), 'edited');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    const verdict = await launcher.verifyLegacyStaging(dir, TITLE_OBJ(), {
      expected, checkTrigger: async () => ({ok: true}),
    });
    assert.strictEqual(verdict.ok, false);
    await assert.rejects(staging.assertSafeTarget(dir, {
      titleId: TITLE, repo: ROOT, adopt: () => verdict,
    }), error => error.code === 'EUNSAFE');
    assert.ok(!fs.existsSync(path.join(dir, staging.MARKER)));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'mine');
  });

  // ------------------------------------------------------------ backup rules --
  await test('a complete backup validates and exposes identity', async () => {
    const backup = await loadValid(backupFixture());
    assert.deepStrictEqual(backup.identity, {programId: TITLE, uid: UID});
    assert.ok(backup.names.has('/save9999.dat'));
  });

  await test('partial, failed, inconsistent and duplicate manifests are refused', async () => {
    const cases = [
      {partial: true},
      {failed: [{path: '/x', result: '0x202'}]},
      {mutate: m => { m.files = m.entries.length + 1; }},
      {mutate: m => { m.bytes = m.bytes + 1; }},
      {mutate: m => { m.entries.push({...m.entries[0]}); }},
      {mutate: m => { m.entries[0].path = '../escape'; }},
      {mutate: m => { m.entries[0].sha256 = 'nope'; }},
      {corrupt: true},
      {trigger: false},
    ];
    for (const options of cases) {
      const backup = await validateBackup(backupFixture(options), {trigger: 'save9999.dat'});
      assert.strictEqual(backup.ok, false, JSON.stringify(options));
    }
  });

  await test('a symlinked backup file is refused', async () => {
    const dir = backupFixture();
    fs.writeFileSync(path.join(dir, 'real.bin'), 'outside');
    fs.unlinkSync(path.join(dir, 'system.dat'));
    fs.symlinkSync(path.join(dir, 'real.bin'), path.join(dir, 'system.dat'));
    const backup = await validateBackup(dir, {trigger: 'save9999.dat'});
    assert.strictEqual(backup.ok, false);
  });

  await test('identity is required on demand and the archive prefix is not identity', async () => {
    const legacy = backupFixture({identity: false});
    assert.strictEqual((await validateBackup(legacy, {trigger: 'save9999.dat'})).identity, null);
    const refused = await validateBackup(legacy, {trigger: 'save9999.dat', requireIdentity: true});
    assert.strictEqual(refused.ok, false);
    const wrong = await validateBackup(backupFixture(), {trigger: 'save9999.dat',
      requireIdentity: true, titleId: TITLE, uid: 'b'.repeat(32)});
    assert.strictEqual(wrong.ok, false);
  });

  // ----------------------------------------------------- original baseline ---
  await test('the original record is immutable once written', async () => {
    await withState(async () => {
      const {record} = await originalFixture();
      const file = receipts.originalPath(TITLE, UID);
      await receipts.writeImmutable(file, record);
      const before = fs.readFileSync(file);
      await assert.rejects(receipts.writeImmutable(file, {...record, origin: 'second'}),
        error => error.code === 'EIMMUTABLE');
      assert.deepStrictEqual(fs.readFileSync(file), before);
    });
  });

  await test('a legacy single receipt is adopted as the original, not re-estimated', async () => {
    const {record} = await originalFixture();
    const legacy = {...record, kind: receipts.KIND_RECEIPT, status: 'installed'};
    const adopted = receipts.adoptLegacyReceipt(legacy, {launcherFiles: launcher.LAUNCHER_FILES});
    assert.deepStrictEqual(adopted.problems, []);
    assert.strictEqual(adopted.record.kind, receipts.KIND_ORIGINAL);
    assert.deepStrictEqual(adopted.record.installed, legacy.installed);
    assert.strictEqual(adopted.record.backup.manifestSha256, legacy.backup.manifestSha256);
  });

  await test('an update transaction never modifies the original baseline', async () => {
    await withState(async () => {
      const {record} = await originalFixture();
      const file = receipts.originalPath(TITLE, UID);
      await receipts.writeImmutable(file, record);
      const before = fs.readFileSync(file);
      const live = snapshotFixture(planFixture().files);
      const tx = launcher.transactionRecord({title: TITLE_OBJ(), uid: UID, original: record,
        originalSha: sha(before), live, plan: planFixture()});
      await receipts.writeTransaction(tx);
      assert.deepStrictEqual(fs.readFileSync(file), before);
      assert.strictEqual(tx.originalSha256, sha(before));
      assert.strictEqual((await receipts.listTransactions(TITLE, UID)).length, 1);
    });
  });

  await test('successful and failed updates both leave the original baseline intact', async () => {
    await withState(async () => {
      const {record} = await originalFixture();
      const file = receipts.originalPath(TITLE, UID);
      await receipts.writeImmutable(file, record);
      const before = fs.readFileSync(file);
      const live = snapshotFixture(planFixture().files);
      const base = launcher.transactionRecord({title: TITLE_OBJ(), uid: UID, original: record,
        originalSha: sha(before), live, plan: planFixture()});
      const failed = {...base, id: 'update-failed', status: 'install-failed',
        error: 'simulated write failure'};
      const ok = {...base, id: 'update-ok', status: 'installed'};
      await receipts.writeTransaction(failed);
      await receipts.writeTransaction(ok);
      const list = await receipts.listTransactions(TITLE, UID);
      assert.deepStrictEqual(list.map(t => t.status).sort(), ['install-failed', 'installed']);
      assert.deepStrictEqual(fs.readFileSync(file), before,
        'no update may rewrite the original baseline');
      assert.strictEqual(list.find(t => t.status === 'installed').originalSha256, sha(before));
    });
  });

  await test('a post-install backup is refused as a pre-install baseline', async () => {
    const expected = {};
    for (const name of launcher.LAUNCHER_FILES) expected['/' + name] = pin(name);
    const contents = {};
    for (const name of launcher.LAUNCHER_FILES) contents[name] = Buffer.from('pinned ' + name);
    const backup = await loadValid(backupFixture({contents}));
    const problems = launcher.preinstallProblems(backup, TITLE_OBJ(), expected);
    assert.ok(problems.length > 0);
    const clean = await loadValid(backupFixture());
    assert.deepStrictEqual(launcher.preinstallProblems(clean, TITLE_OBJ(), expected), []);
  });

  await test('installed entries record add and replace kinds from the plan', async () => {
    const {backup} = await originalFixture();
    const entries = launcher.installedEntries({plan: planFixture(), backup});
    assert.strictEqual(entries.length, 7);
    assert.strictEqual(entries.find(e => e.path === '/save9999.dat').kind, 'replace');
    assert.strictEqual(entries.find(e => e.path === '/save9999.dat').originalSha256,
      backup.entries.find(e => e.path === '/save9999.dat').sha256);
    assert.strictEqual(entries.filter(e => e.kind === 'add').length, 6);
  });

  await test('state matching accepts an exact live state and rejects one changed byte', async () => {
    const plan = planFixture();
    const live = liveFixture(plan.files);
    assert.strictEqual(launcher.stateMatchesLive(live, plan.files), true);
    live.entries.find(e => e.path === '/http.lua').sha256 = sha(Buffer.from('edited'));
    assert.strictEqual(launcher.stateMatchesLive(live, plan.files), false);
  });

  await test('the restore target is the first-install pre-state, not a later snapshot', async () => {
    const {record, backup} = await originalFixture();
    const target = launcher.restoreTarget(record, backup);
    assert.strictEqual(target.triggerSha256, record.backup.triggerSha256);
    assert.deepStrictEqual(target.deletePaths.sort(),
      launcher.LAUNCHER_FILES.map(n => '/' + n).sort());
  });

  // ------------------------------------------------------- restore analysis --
  await test('restore preflight accepts an untouched installation', async () => {
    const {record, backup} = await originalFixture();
    const target = launcher.restoreTarget(record, backup);
    const analysis = launcher.analyzeRestore({
      live: liveFixture(record.installed), expectedFiles: record.installed,
      original: record, progress: {trigger: 'pending', deleted: []},
      deletePaths: target.deletePaths,
    });
    assert.deepStrictEqual(analysis.problems, []);
  });

  await test('restore refuses to delete a modified launcher file', async () => {
    const {record, backup} = await originalFixture();
    const target = launcher.restoreTarget(record, backup);
    const live = liveFixture(record.installed);
    live.entries.find(e => e.path === '/http.lua').sha256 = sha(Buffer.from('user edit'));
    const analysis = launcher.analyzeRestore({live, expectedFiles: record.installed,
      original: record, progress: {trigger: 'pending', deleted: []},
      deletePaths: target.deletePaths});
    assert.ok(analysis.problems.some(p => /\/http\.lua was modified/.test(p)));
  });

  await test('restore reports missing and unexpected launcher files', async () => {
    const {record, backup} = await originalFixture();
    const target = launcher.restoreTarget(record, backup);
    const live = liveFixture(record.installed.filter(e => e.path !== '/proggy.ttf'));
    live.entries.push({path: '/core2.lua', size: 1, sha256: sha(Buffer.from('update'))});
    const analysis = launcher.analyzeRestore({live, expectedFiles: record.installed,
      original: record, progress: {trigger: 'pending', deleted: []},
      deletePaths: target.deletePaths});
    assert.ok(analysis.problems.some(p => /proggy\.ttf is missing/.test(p)));
    assert.ok(analysis.unexpected.some(p => /core2\.lua/.test(p)));
  });

  await test('restore resumes after deletions made before the receipt update', async () => {
    const {record, backup} = await originalFixture();
    const target = launcher.restoreTarget(record, backup);
    const live = liveFixture(record.installed.filter(e =>
      !['/core.lua', '/http.lua'].includes(e.path)));
    live.entries.find(e => e.path === '/save9999.dat').sha256 = record.backup.triggerSha256;
    const analysis = launcher.analyzeRestore({live, expectedFiles: record.installed,
      original: record, progress: {trigger: 'done', deleted: []},
      deletePaths: target.deletePaths});
    assert.deepStrictEqual(analysis.problems, []);
    assert.deepStrictEqual(analysis.deleted.sort(), ['/core.lua', '/http.lua']);
  });

  await test('a restored save analyses as a no-op on a second restore', async () => {
    const {record, backup} = await originalFixture();
    const target = launcher.restoreTarget(record, backup);
    const live = {entries: [{path: '/save9999.dat', size: 20,
      sha256: record.backup.triggerSha256}]};
    const analysis = launcher.analyzeRestore({live, expectedFiles: record.installed,
      original: record, progress: {trigger: 'done',
        deleted: target.deletePaths}, deletePaths: target.deletePaths});
    assert.deepStrictEqual(analysis.problems, []);
    assert.strictEqual(analysis.triggerAlreadyRestored, true);
  });

  await test('post-restore verification requires the original trigger and absent adds', async () => {
    const {record, backup} = await originalFixture();
    const target = launcher.restoreTarget(record, backup);
    const view = {backup: {triggerSha256: record.backup.triggerSha256},
      installed: target.deletePaths.map(p => ({path: p, kind: 'add'}))};
    const clean = {entries: [{path: '/save9999.dat', size: 20,
      sha256: record.backup.triggerSha256}]};
    assert.deepStrictEqual(launcher.postRestoreProblems({post: clean, receipt: view, backup}), []);
    const lingering = {entries: [...clean.entries, {path: '/http.lua', size: 1,
      sha256: sha(Buffer.from('x'))}]};
    assert.ok(launcher.postRestoreProblems({post: lingering, receipt: view, backup}).length);
  });

  // -------------------------------------------------------------- migration --
  await test('legacy migration builds an attestation without touching the backup', async () => {
    const originalBackup = await loadValid(backupFixture({identity: false}));
    const pinned = migrationPinned();
    const snapshot = migrationSnapshot(pinned, pin('trigger'));
    const built = launcher.buildMigrationRecord({
      title: TITLE_OBJ(), uid: UID, originalBackup, snapshot, pinned,
      expectedTrigger: pin('trigger'), identityEvidence: ['config/uids.json'],
    });
    assert.deepStrictEqual(built.problems, []);
    const record = built.record;
    assert.strictEqual(record.kind, receipts.KIND_ORIGINAL);
    assert.strictEqual(record.origin, 'migrated-legacy');
    assert.strictEqual(record.backup.path, path.resolve(originalBackup.dir));
    assert.strictEqual(record.backup.manifestSha256, originalBackup.manifestSha256);
    assert.deepStrictEqual(record.account, {uid: UID});
    assert.strictEqual(record.installed.length, 7);
    assert.strictEqual(record.installed.find(e => e.path === '/save9999.dat').kind, 'replace');
    assert.deepStrictEqual(record.attestation.identityEvidence, ['config/uids.json']);
    assert.strictEqual((await loadValid(originalBackup.dir)).manifestSha256,
      originalBackup.manifestSha256);
  });

  await test('migration refuses a wrong pinned payload, wrong trigger or no identity', async () => {
    const originalBackup = await loadValid(backupFixture({identity: false}));
    const pinned = migrationPinned();
    const good = migrationSnapshot(pinned, pin('trigger'));
    const wrongPayload = migrationSnapshot({...pinned, '/http.lua': pin('other')}, pin('trigger'));
    const wrongTrigger = migrationSnapshot(pinned, pin('other-trigger'));
    for (const [snapshot, evidence] of [[wrongPayload, ['config']], [wrongTrigger, ['config']],
      [good, []]]) {
      const built = launcher.buildMigrationRecord({
        title: TITLE_OBJ(), uid: UID, originalBackup, snapshot, pinned,
        expectedTrigger: pin('trigger'), identityEvidence: evidence,
      });
      assert.ok(built.problems.length > 0, JSON.stringify({evidence}));
    }
  });

  await test('the full install/update/restore lifecycle keeps the original intact', async () => {
    await withState(async () => {
      const {record, backup, plan} = await originalFixture();
      assert.strictEqual(launcher.installMode(null, liveFixture(plan.files), plan), 'first');
      const file = receipts.originalPath(TITLE, UID);
      await receipts.writeImmutable(file, record);
      const baseline = fs.readFileSync(file);

      // reinstall identical bytes -> no-op; no transaction
      const live = liveFixture(plan.files);
      assert.strictEqual(launcher.installMode(record, live, plan), 'noop');
      assert.deepStrictEqual(fs.readFileSync(file), baseline);
      assert.strictEqual((await receipts.listTransactions(TITLE, UID)).length, 0);

      // update -> separate transaction; original untouched
      const txOk = launcher.transactionRecord({title: TITLE_OBJ(), uid: UID, original: record,
        originalSha: sha(baseline), live: snapshotFixture(plan.files), plan});
      txOk.status = 'installed';
      await receipts.writeTransaction(txOk);

      // interrupted update -> install-failed transaction; original untouched
      const liveChanged = liveFixture(plan.files);
      liveChanged.entries.find(e => e.path === '/http.lua').sha256 = sha(Buffer.from('new build'));
      assert.strictEqual(launcher.installMode(record, liveChanged, plan), 'update');
      const txBad = launcher.transactionRecord({title: TITLE_OBJ(), uid: UID, original: record,
        originalSha: sha(baseline),
        live: {...liveChanged, dir: '/tmp/live-changed',
          manifestSha256: sha(Buffer.from('live-changed'))}, plan});
      txBad.id = 'interrupted';
      txBad.status = 'install-failed';
      await receipts.writeTransaction(txBad);
      assert.deepStrictEqual(fs.readFileSync(file), baseline);
      const txs = await receipts.listTransactions(TITLE, UID);
      assert.deepStrictEqual(txs.map(t => t.status).sort(), ['install-failed', 'installed']);

      // restore preflight accepts the original installed state and the tx pre-state
      const candidates = launcher.candidateStates(record, txs);
      assert.ok(candidates.some(state => launcher.stateMatchesLive(live, state.files)));
      assert.ok(candidates.some(state => launcher.stateMatchesLive(liveChanged, state.files)));

      // restore to the pre-first-install state
      const target = launcher.restoreTarget(record, backup);
      const restored = {entries: [{path: '/save9999.dat', size: 20,
        sha256: record.backup.triggerSha256}]};
      const analysis = launcher.analyzeRestore({live: restored, expectedFiles: record.installed,
        original: record, progress: {trigger: 'done', deleted: target.deletePaths},
        deletePaths: target.deletePaths});
      assert.deepStrictEqual(analysis.problems, []);
      assert.strictEqual(analysis.triggerAlreadyRestored, true);
      const view = {backup: {triggerSha256: record.backup.triggerSha256},
        installed: target.deletePaths.map(p => ({path: p, kind: 'add'}))};
      assert.deepStrictEqual(launcher.postRestoreProblems({post: restored, receipt: view, backup}), []);
      assert.deepStrictEqual(fs.readFileSync(file), baseline);
    });
  });

  await test('a non-trigger replace file is not deleted by restore', async () => {
    const {record, backup} = await originalFixture();
    const custom = JSON.parse(JSON.stringify(record));
    custom.installed.find(e => e.path === '/http.lua').kind = 'replace';
    custom.installed.find(e => e.path === '/http.lua').originalSha256 = 'a'.repeat(64);
    const target = launcher.restoreTarget(custom, backup);
    assert.ok(!target.deletePaths.includes('/http.lua'));
  });

  await test('a malformed legacy receipt is refused rather than adopted', async () => {
    const {record} = await originalFixture();
    const broken = {...record, kind: receipts.KIND_RECEIPT, status: 'installed'};
    broken.backup = {...broken.backup, manifestSha256: 'nope'};
    const adopted = receipts.adoptLegacyReceipt(broken, {launcherFiles: launcher.LAUNCHER_FILES});
    assert.ok(adopted.problems.length > 0);
    assert.strictEqual(adopted.record, undefined);
  });

  // ------------------------------------------- restore staging path (cwd) --
  await test('restore staging uses a cwd-relative manifest for every baseline', async () => {
    const cases = [
      {name: 'modern', backup: await loadValid(backupFixture())},
      {name: 'migrated', backup: await loadValid(backupFixture({identity: false}))},
      {name: 'legacy', backup: await loadValid(backupFixture({identity: false}))},
    ];
    for (const item of cases) {
      const work = tmp('artemis-stage-' + item.name + '-');
      const beforeManifest = fs.readFileSync(path.join(item.backup.dir, 'manifest.json'));
      const beforeTrigger = fs.readFileSync(path.join(item.backup.dir, 'save9999.dat'));
      const staged = await launcher.stageTriggerForRestore({backupDir: item.backup.dir,
        work, title: TITLE_OBJ()});
      assert.strictEqual(staged.manifest.files[0].local, 'save9999.dat',
        item.name + ': manifest local must stay relative to the staging cwd');
      assert.deepStrictEqual(fs.readFileSync(path.join(work, 'save9999.dat')),
        beforeTrigger, item.name + ': staged trigger is the backup trigger');
      let captured = null;
      const result = await launcher.writeRestoreTrigger({session: 'unused',
        title: TITLE_OBJ(), uid: UID, backupDir: item.backup.dir, work,
        run: (script, args, options) => {
          const manifest = JSON.parse(fs.readFileSync(args[4], 'utf8'));
          const bytes = fs.readFileSync(path.resolve(options.cwd, manifest.files[0].local));
          captured = {script, args, options, manifest, bytes};
          return {status: 0};
        }});
      assert.strictEqual(result.status, 0);
      assert.strictEqual(captured.script, 'save-write-stage.cjs');
      assert.strictEqual(captured.options.cwd, path.resolve(work),
        item.name + ': writer must run in the staging directory');
      assert.strictEqual(captured.args[4], path.join(work, 'manifest.json'));
      assert.strictEqual(captured.manifest.files[0].local, 'save9999.dat');
      assert.strictEqual(captured.manifest.files[0].sha256, sha(beforeTrigger));
      assert.deepStrictEqual(captured.bytes, beforeTrigger,
        item.name + ': writer reads the staged copy, not the backup copy');
      assert.ok(!fs.existsSync(work), item.name + ': staging is cleaned up');
      assert.deepStrictEqual(fs.readFileSync(path.join(item.backup.dir, 'manifest.json')),
        beforeManifest, 'backup manifest untouched');
      assert.deepStrictEqual(fs.readFileSync(path.join(item.backup.dir, 'save9999.dat')),
        beforeTrigger, 'backup trigger untouched');
    }
  });

  await test('the real child resolves the staged trigger only with the staging cwd', async () => {
    const backup = await loadValid(backupFixture());
    const work = tmp('artemis-child-');
    const unrelated = tmp('artemis-unrelated-cwd-');
    const staged = await launcher.stageTriggerForRestore({backupDir: backup.dir, work,
      title: TITLE_OBJ()});
    const mock = path.join(ROOT, 'tests', 'helpers', 'restore-writer-mock.cjs');
    const good = spawnSync(process.execPath, [mock, staged.manifestPath],
      {cwd: work, encoding: 'utf8'});
    assert.strictEqual(good.status, 0, good.stderr);
    const parsed = JSON.parse(good.stdout);
    assert.strictEqual(parsed.files[0].ok, true);
    assert.strictEqual(parsed.files[0].local, 'save9999.dat');
    // The old bug: run the same writer from an unrelated directory and the
    // relative local cannot be read.
    const bad = spawnSync(process.execPath, [mock, staged.manifestPath],
      {cwd: unrelated, encoding: 'utf8'});
    assert.strictEqual(bad.status, 3, 'without cwd the relative local must fail');
    assert.match(bad.stdout, /"error":"ENOENT"/);
  });

  await test('missing or altered staged triggers fail closed', async () => {
    const backup = await loadValid(backupFixture());
    const mock = path.join(ROOT, 'tests', 'helpers', 'restore-writer-mock.cjs');
    const missingWork = tmp('artemis-missing-');
    const missing = await launcher.stageTriggerForRestore({backupDir: backup.dir,
      work: missingWork, title: TITLE_OBJ()});
    fs.rmSync(path.join(missingWork, 'save9999.dat'));
    const missingRun = spawnSync(process.execPath, [mock, missing.manifestPath],
      {cwd: missingWork, encoding: 'utf8'});
    assert.strictEqual(missingRun.status, 3);

    const alteredWork = tmp('artemis-altered-');
    const altered = await launcher.stageTriggerForRestore({backupDir: backup.dir,
      work: alteredWork, title: TITLE_OBJ()});
    fs.appendFileSync(path.join(alteredWork, 'save9999.dat'), Buffer.from([0]));
    const alteredRun = spawnSync(process.execPath, [mock, altered.manifestPath],
      {cwd: alteredWork, encoding: 'utf8'});
    assert.strictEqual(alteredRun.status, 3);
  });

  await test('writer failure and exceptions propagate and still clean the staging dir', async () => {
    const backup = await loadValid(backupFixture());
    const failedWork = tmp('artemis-writer-fail-');
    const failed = await launcher.writeRestoreTrigger({session: 'unused',
      title: TITLE_OBJ(), uid: UID, backupDir: backup.dir, work: failedWork,
      run: () => ({status: 9})});
    assert.strictEqual(failed.status, 9);
    assert.ok(!fs.existsSync(failedWork), 'failed writer staging cleaned up');

    const throwWork = tmp('artemis-writer-throw-');
    await assert.rejects(launcher.writeRestoreTrigger({session: 'unused',
      title: TITLE_OBJ(), uid: UID, backupDir: backup.dir, work: throwWork,
      run: () => { throw new Error('simulated transport loss'); }}),
      /simulated transport loss/);
    assert.ok(!fs.existsSync(throwWork), 'exception staging cleaned up');
  });

  // -------------------------------------- restore baseline (modern + migrated) --
  await test('a migrated legacy baseline passes restore preflight', async () => {
    const originalBackup = await loadValid(backupFixture({identity: false}));
    const pinned = launcher.expectedHashes(TITLE_OBJ());
    const trigger = sha(Buffer.from('retargeted trigger'));
    const snapshot = snapshotFixture([
      ...Object.entries(pinned).map(([p, hash]) => ({path: p, size: 10, sha256: hash})),
      {path: '/save9999.dat', size: 20, sha256: trigger},
    ]);
    const built = launcher.buildMigrationRecord({title: TITLE_OBJ(), uid: UID, originalBackup,
      snapshot, pinned, expectedTrigger: trigger, identityEvidence: ['config/uids.json']});
    assert.deepStrictEqual(built.problems, []);
    const retarget = async (input, output) => fs.writeFileSync(output, 'retargeted trigger');
    const loaded = await launcher.loadOriginalBackupForRestore(built.record, TITLE_OBJ(), UID,
      {retarget});
    assert.deepStrictEqual(loaded.problems, []);
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.backup.manifestSha256, originalBackup.manifestSha256);
  });

  await test('migrated restore refuses a missing attestation or bad identity evidence', async () => {
    const originalBackup = await loadValid(backupFixture({identity: false}));
    const pinned = launcher.expectedHashes(TITLE_OBJ());
    const trigger = sha(Buffer.from('retargeted trigger'));
    const snapshot = snapshotFixture([
      ...Object.entries(pinned).map(([p, hash]) => ({path: p, size: 10, sha256: hash})),
      {path: '/save9999.dat', size: 20, sha256: trigger},
    ]);
    const built = launcher.buildMigrationRecord({title: TITLE_OBJ(), uid: UID, originalBackup,
      snapshot, pinned, expectedTrigger: trigger, identityEvidence: ['config/uids.json']});
    const retarget = async (input, output) => fs.writeFileSync(output, 'retargeted trigger');
    for (const mutate of [
      r => { delete r.attestation; },
      r => { r.attestation.identityEvidence = []; },
      r => { r.attestation.pinnedUpstream = 'f'.repeat(40); },
      r => { r.attestation.verifiedTriggerSha256 = 'f'.repeat(64); },
      r => { r.installed.find(e => e.path === '/core.lua').sha256 = 'f'.repeat(64); },
    ]) {
      const record = JSON.parse(JSON.stringify(built.record));
      mutate(record);
      const loaded = await launcher.loadOriginalBackupForRestore(record, TITLE_OBJ(), UID,
        {retarget});
      assert.strictEqual(loaded.ok, false, mutate.toString());
    }
  });

  await test('migrated restore refuses a wrong account, title or changed backup', async () => {
    const originalBackup = await loadValid(backupFixture({identity: false}));
    const pinned = launcher.expectedHashes(TITLE_OBJ());
    const trigger = sha(Buffer.from('retargeted trigger'));
    const snapshot = snapshotFixture([
      ...Object.entries(pinned).map(([p, hash]) => ({path: p, size: 10, sha256: hash})),
      {path: '/save9999.dat', size: 20, sha256: trigger},
    ]);
    const built = launcher.buildMigrationRecord({title: TITLE_OBJ(), uid: UID, originalBackup,
      snapshot, pinned, expectedTrigger: trigger, identityEvidence: ['config/uids.json']});
    const retarget = async (input, output) => fs.writeFileSync(output, 'retargeted trigger');
    assert.strictEqual((await launcher.loadOriginalBackupForRestore(built.record, TITLE_OBJ(),
      'b'.repeat(32), {retarget})).ok, false, 'wrong account');
    assert.strictEqual((await launcher.loadOriginalBackupForRestore(built.record,
      launcher.titleFor('010012900d38a000'), UID, {retarget})).ok, false, 'wrong title');
    fs.writeFileSync(path.join(originalBackup.dir, 'system.dat'), 'changed');
    assert.strictEqual((await launcher.loadOriginalBackupForRestore(built.record, TITLE_OBJ(),
      UID, {retarget})).ok, false, 'changed file');
    // A valid manifest with different bytes for the trigger is still refused
    // because it no longer matches the record.
    const dir2 = backupFixture({identity: false});
    const backup2 = await loadValid(dir2);
    const built2 = launcher.buildMigrationRecord({title: TITLE_OBJ(), uid: UID,
      originalBackup: backup2, snapshot, pinned, expectedTrigger: trigger,
      identityEvidence: ['config/uids.json']});
    fs.writeFileSync(path.join(dir2, 'save9999.dat'), 'other trigger');
    assert.strictEqual((await launcher.loadOriginalBackupForRestore(built2.record, TITLE_OBJ(),
      UID, {retarget})).ok, false, 'changed trigger');
    fs.appendFileSync(path.join(dir2, 'manifest.json'), '\n');
    assert.strictEqual((await launcher.loadOriginalBackupForRestore(built2.record, TITLE_OBJ(),
      UID, {retarget})).ok, false, 'changed manifest');
  });

  await test('the modern identity-bearing baseline still validates unchanged', async () => {
    const expected = launcher.expectedHashes(TITLE_OBJ());
    const pinnedPlan = {
      files: launcher.LAUNCHER_FILES.map(name => ({path: '/' + name, local: name,
        size: 10, sha256: expected['/' + name], replace: false})).concat([
        {path: '/save9999.dat', local: 'save9999.dat', size: 20,
          sha256: sha(Buffer.from('installed trigger')), replace: true}]),
      manifest: {}, conflicts: [],
    };
    const {record} = await originalFixture({plan: pinnedPlan});
    const retarget = async (input, output) => fs.writeFileSync(output, 'installed trigger');
    const loaded = await launcher.loadOriginalBackupForRestore(record, TITLE_OBJ(), UID, {retarget});
    assert.deepStrictEqual(loaded.problems, []);
    assert.strictEqual(loaded.ok, true);
    const noIdentity = await originalFixture({backupDir: backupFixture({identity: false})});
    const refused = await launcher.loadOriginalBackupForRestore(noIdentity.record, TITLE_OBJ(),
      UID, {retarget});
    assert.strictEqual(refused.ok, false, 'a modern record cannot use an identity-less backup');
  });

  // -------------------------------------------------- editor/ns2jb compat --
  await test('editor and ns2jb files in the backup are untouched by the plan', async () => {
    const backup = await loadValid(backupFixture({extra: ['sscode004.lua']}));
    const out = path.join(tmp('artemis-compat-'), 'payload');
    const {plan} = await stageFixture({backup, out});
    assert.deepStrictEqual(plan.conflicts, []);
    const touched = plan.files.map(f => f.path);
    for (const name of ['/ssedit1.lua', '/sed01.asb', '/sscode004.lua', '/ns2jb.asb', '/ns2jb.lua']) {
      assert.ok(!touched.includes(name));
    }
  });

  // ---------------------------------------------------------- CLI behaviour --
  await test('install refuses without --confirm before pulling or staging', () => {
    const result = spawnSync(process.execPath, [TOOL, 'install', 'no-such-run',
      '--title', TITLE, '--uid', UID], {encoding: 'utf8',
      env: {...process.env, ARTEMIS_STATE: tmp('artemis-state-')}});
    assert.strictEqual(result.status, launcher.EXIT.usage, result.stderr);
    assert.match(result.stderr, /--confirm/);
  });

  await test('migrate-legacy requires an explicit confirmation flag', () => {
    const result = spawnSync(process.execPath, [TOOL, 'migrate-legacy', '--title', TITLE,
      '--uid', UID, '--backup', '/tmp/none'], {encoding: 'utf8',
      env: {...process.env, ARTEMIS_STATE: tmp('artemis-state-')}});
    assert.strictEqual(result.status, launcher.EXIT.usage, result.stderr);
    assert.match(result.stderr, /confirm-migration/);
  });

  await test('restore without a record and without --adopt-legacy is refused', () => {
    const result = spawnSync(process.execPath, [TOOL, 'restore', 'no-such-run',
      '--title', TITLE, '--uid', UID, '--backup', backupFixture(), '--confirm-restore'],
      {encoding: 'utf8', env: {...process.env, ARTEMIS_STATE: tmp('artemis-state-')}});
    assert.strictEqual(result.status, launcher.EXIT.usage, result.stderr);
    assert.match(result.stderr, /migrate-legacy|adopt-legacy/);
  });

  await test('a bad uid and an unknown option exit 2', () => {
    assert.strictEqual(spawnSync(process.execPath, [TOOL, 'install', 'x', '--title', TITLE,
      '--uid', 'zz'], {encoding: 'utf8'}).status, launcher.EXIT.usage);
    assert.strictEqual(spawnSync(process.execPath, [TOOL, 'stage', '--nope'],
      {encoding: 'utf8'}).status, launcher.EXIT.usage);
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

run().catch(error => { console.error(error); process.exit(1); });
