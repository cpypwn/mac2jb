'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const release = require('../tools/lib/balatro-release.cjs');
const {createLauncher, parseArgs} = require('../tools/balatro-launcher.cjs');
const {sha256, loadBackup, safeSavePath} = require('../tools/lib/balatro-backup.cjs');

const UID = 'a'.repeat(32);
const TITLE = release.TITLE_ID;
const temporary = [];
test.after(async () => { for (const dir of temporary) await fs.rm(dir, {recursive: true, force: true}); });

async function root() {
  const dir = await fs.mkdtemp(path.join(require('node:fs').realpathSync(os.tmpdir()), 'balatro-launcher-test-'));
  temporary.push(dir);
  return dir;
}

async function backup(directory, files, overrides = {}) {
  await fs.mkdir(directory, {recursive: true});
  const entries = [];
  for (const [filename, bytes] of files) {
    const local = path.join(directory, filename.slice(1));
    await fs.mkdir(path.dirname(local), {recursive: true});
    await fs.writeFile(local, bytes);
    entries.push({path: filename, size: bytes.length, sha256: sha256(bytes)});
  }
  const manifest = {programId: TITLE, uid: UID, space: 1, type: 1, partial: false,
    failed: [], files: entries.length, bytes: entries.reduce((sum, item) => sum + item.size, 0),
    entries, ...overrides};
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return directory;
}

async function system(settings = {}) {
  const directory = await root();
  const live = new Map([
    ['/.lovegame/1/profile.jkr', Buffer.from('original profile')],
    ['/.lovegame/settings.jkr', Buffer.from('original settings')],
    ['/outside.dat', Buffer.from('unrelated file')],
  ]);
  const payload = new Map(release.INSTALL_PATHS.map(filename => [filename, Buffer.from('fixture:' + filename)]));
  const config = {...release.CONFIG, files: [...payload].map(([filename, bytes]) =>
    ({path: filename, size: bytes.length, sha256: sha256(bytes)}))};
  const calls = [];
  const obtained = [];
  const log = [];
  const fakeRelease = {...release, CONFIG: config,
    async obtainArchive(options) { obtained.push(options); return '/fixture.zip'; },
    async stageArchive(_archive, output) {
      await fs.mkdir(output);
      const files = [];
      for (const item of config.files) {
        const local = path.join(output, item.path.slice(1));
        await fs.mkdir(path.dirname(local), {recursive: true});
        await fs.writeFile(local, payload.get(item.path));
        files.push({...item, local, replace: false});
      }
      return {directory: output, files};
    },
  };
  const run = async (script, args) => {
    calls.push({script, args});
    if (script === 'save-pull-root.cjs') {
      assert.equal(args[1], TITLE);
      assert.equal(args[3], UID);
      await backup(args[2], live, settings.incomplete ? {partial: true} : {});
    } else if (script === 'save-write-stage.cjs') {
      const manifest = JSON.parse(await fs.readFile(args[4], 'utf8'));
      const receiptPath = path.join(path.dirname(args[4]), 'receipt.json');
      const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
      assert.equal(receipt.baseline.directory, args[3], 'original receipt exists before write');
      await loadBackup(args[3], {titleId: TITLE, uid: UID});
      if (settings.writeFailure) throw Error('simulated lost session during write');
      for (const item of manifest.files) {
        assert.equal(item.replace, false);
        assert.equal(live.has(item.path), false);
        const bytes = await fs.readFile(item.local);
        assert.equal(sha256(bytes), item.sha256);
        live.set(item.path, bytes);
      }
      if (settings.corruptPayload) live.set(release.INSTALL_PATHS[0], Buffer.from('wrong payload'));
      if (settings.corruptProfile) live.set('/.lovegame/1/profile.jkr', Buffer.from('wrong profile'));
    } else if (script === 'balatro-remove.cjs') {
      assert.equal(args[1], UID);
      assert.equal(args[3], '--confirm');
      const manifest = JSON.parse(await fs.readFile(args[2], 'utf8'));
      const before = await loadBackup(manifest.backup, {titleId: TITLE, uid: UID});
      assert.equal(before.manifestSha256, manifest.backupManifestSha256);
      for (const item of manifest.files) {
        assert.ok(release.INSTALL_PATHS.includes(item.path));
        assert.equal(sha256(live.get(item.path)), item.sha256);
        live.delete(item.path);
      }
      if (settings.leaveTarget) live.set(release.INSTALL_PATHS[0], Buffer.from('still here'));
    } else throw Error('Unexpected child: ' + script);
  };
  const controller = createLauncher({release: fakeRelease, run, log: line => log.push(line)});
  const options = {run: '/fake/run', uid: UID, 'state-dir': path.join(directory, 'state'), confirm: true};
  return {directory, live, controller, options, calls, obtained, log, payload};
}

test('install preserves gameplay, records original before write, and verifies all payload files', async () => {
  const s = await system();
  const original = new Map(s.live);
  const result = await s.controller.install(s.options);
  assert.equal(s.calls.filter(item => item.script === 'save-write-stage.cjs').length, 1);
  assert.equal(s.calls.filter(item => item.script === 'save-pull-root.cjs').length, 2);
  for (const [filename, bytes] of original) assert.deepEqual(s.live.get(filename), bytes);
  for (const [filename, bytes] of s.payload) assert.deepEqual(s.live.get(filename), bytes);
  assert.equal(s.live.has('/.nx_save_meta.bin'), false);
  await assert.rejects(fs.writeFile(result.receiptPath, 'replace', {flag: 'wx'}), {code: 'EEXIST'});
  await s.controller.verify({...s.options, receipt: result.receiptPath});
});

test('install and restore dry-runs are offline and never download or invoke child tools', async () => {
  const s = await system();
  const source = await backup(path.join(s.directory, 'source'), s.live);
  await s.controller.install({...s.options, confirm: false, 'dry-run': true, backup: source});
  assert.equal(s.calls.length, 0);
  assert.equal(s.obtained.length, 0);
  const installed = await s.controller.install(s.options);
  const current = await backup(path.join(s.directory, 'current'), s.live);
  s.calls.length = 0;
  s.obtained.length = 0;
  const plan = await s.controller.restore({...s.options, receipt: installed.receiptPath,
    'dry-run': true, backup: current});
  assert.equal(plan.files.length, 20);
  assert.equal(s.calls.length, 0);
  assert.equal(s.obtained.length, 0);
});

test('unsupported editions and unconfirmed writes are refused before any console access', async () => {
  const s = await system();
  await assert.rejects(s.controller.install({...s.options, title: '0400000000000000'}), /Switch 1 edition/);
  await assert.rejects(s.controller.install({...s.options, confirm: false}), /--confirm/);
  await assert.rejects(s.controller.install({...s.options, uid: '0'.repeat(32)}), /nonzero/);
  assert.equal(s.calls.length, 0);
  assert.equal(s.obtained.length, 0);
});

test('preexisting launcher, probe, and script collisions are refused without writes', async () => {
  for (const filename of ['/.lovegame/main.lua', '/.lovegame/bl_probe.lua', '/.lovegame/bl/custom.txt', '/.lovegame/custom.lua']) {
    const s = await system();
    s.live.set(filename, Buffer.from('user data'));
    await assert.rejects(s.controller.install(s.options), /collision/);
    assert.equal(s.calls.some(item => item.script === 'save-write-stage.cjs'), false);
    assert.equal(s.live.get(filename).toString(), 'user data');
  }
});

test('a partial live backup or stale supplied baseline cannot authorize installation', async () => {
  const partial = await system({incomplete: true});
  await assert.rejects(partial.controller.install(partial.options), /incomplete/);
  assert.equal(partial.calls.some(item => item.script === 'save-write-stage.cjs'), false);
  const stale = await system();
  const before = await backup(path.join(stale.directory, 'older'), stale.live);
  stale.live.set('/.lovegame/settings.jkr', Buffer.from('new settings'));
  await assert.rejects(stale.controller.install({...stale.options, backup: before}), /differs from --backup/);
  assert.equal(stale.calls.some(item => item.script === 'save-write-stage.cjs'), false);
});

test('payload or preserved-profile mismatches make postwrite verification fail', async () => {
  for (const settings of [{corruptPayload: true}, {corruptProfile: true}]) {
    const s = await system(settings);
    await assert.rejects(s.controller.install(s.options), /Install verification failed/);
    const writer = s.calls.find(item => item.script === 'save-write-stage.cjs');
    const receipt = path.join(path.dirname(writer.args[4]), 'receipt.json');
    await s.controller.readReceipt(receipt, UID);
  }
});

test('interrupted writes retain the original backup and immutable rollback receipt', async () => {
  const s = await system({writeFailure: true});
  await assert.rejects(s.controller.install(s.options), /lost session/);
  const writer = s.calls.find(item => item.script === 'save-write-stage.cjs');
  const receiptPath = path.join(path.dirname(writer.args[4]), 'receipt.json');
  const record = await s.controller.readReceipt(receiptPath, UID);
  assert.equal(record.baseline.entries.length, 3);
  const restored = await s.controller.restore({...s.options, receipt: receiptPath, 'confirm-restore': true});
  assert.equal(restored.removed, 0);
  assert.equal(s.calls.some(item => item.script === 'balatro-remove.cjs'), false);
});

test('rollback backs up modified owned files and preserves profiles, logs, and unknown FTP files', async () => {
  const s = await system();
  const installed = await s.controller.install(s.options);
  const immutable = await fs.readFile(installed.receiptPath);
  s.live.set('/.lovegame/main.lua', Buffer.from('user modified launcher'));
  s.live.set('/.lovegame/1/profile.jkr', Buffer.from('newer user profile'));
  s.live.set('/.lovegame/bl_log.txt', Buffer.from('diagnostics'));
  s.live.set('/.lovegame/bl/user.lua', Buffer.from('user FTP file'));
  const restored = await s.controller.restore({...s.options, receipt: installed.receiptPath, 'confirm-restore': true});
  assert.equal(restored.removed, 20);
  for (const filename of release.INSTALL_PATHS) assert.equal(s.live.has(filename), false);
  assert.equal(s.live.get('/.lovegame/1/profile.jkr').toString(), 'newer user profile');
  assert.equal(s.live.get('/.lovegame/bl_log.txt').toString(), 'diagnostics');
  assert.equal(s.live.get('/.lovegame/bl/user.lua').toString(), 'user FTP file');
  assert.equal((await fs.readFile(path.join(restored.before.dir, '.lovegame/main.lua'))).toString(), 'user modified launcher');
  assert.deepEqual(await fs.readFile(installed.receiptPath), immutable);
});

test('changed original baseline or tampered receipt cannot authorize removal', async () => {
  const s = await system();
  const installed = await s.controller.install(s.options);
  await fs.appendFile(path.join(installed.before.dir, 'manifest.json'), '\n');
  const calls = s.calls.length;
  await assert.rejects(s.controller.restore({...s.options, receipt: installed.receiptPath,
    'confirm-restore': true}), /baseline manifest changed/);
  assert.equal(s.calls.length, calls);
  const t = await system();
  const other = await t.controller.install(t.options);
  const record = JSON.parse(await fs.readFile(other.receiptPath));
  record.files.push({path: '/.lovegame/1/profile.jkr', size: 0, sha256: '0'.repeat(64)});
  await fs.writeFile(other.receiptPath, JSON.stringify(record));
  await assert.rejects(t.controller.restore({...t.options, receipt: other.receiptPath,
    'confirm-restore': true}), /file ownership/);
  assert.equal(t.calls.some(item => item.script === 'balatro-remove.cjs'), false);
});

test('rollback never reports success while a launcher target survives', async () => {
  const s = await system({leaveTarget: true});
  const installed = await s.controller.install(s.options);
  await assert.rejects(s.controller.restore({...s.options, receipt: installed.receiptPath,
    'confirm-restore': true}), /still present/);
});

test('operation output cannot be placed inside supplied or original backups', async () => {
  const s = await system();
  const supplied = await backup(path.join(s.directory, 'supplied'), s.live);
  await assert.rejects(s.controller.install({...s.options, backup: supplied, 'state-dir': supplied}), /outside backup/);
  assert.equal(s.calls.length, 0);
  await loadBackup(supplied, {titleId: TITLE, uid: UID});

  // A raw state directory outside the backup is still unsafe when the title
  // and account suffix put the computed work parent inside the backup.
  const base = path.join(s.directory, 'suffix-state');
  const nested = await backup(path.join(base, TITLE, UID), s.live);
  await assert.rejects(s.controller.install({...s.options, backup: nested, 'state-dir': base}), /outside backup/);
  assert.equal(s.calls.length, 0);
  await loadBackup(nested, {titleId: TITLE, uid: UID});

  const installed = await s.controller.install(s.options);
  const before = await fs.readFile(path.join(installed.before.dir, 'manifest.json'));
  const calls = s.calls.length;
  for (const action of ['verify', 'restore']) {
    await assert.rejects(s.controller[action]({...s.options, receipt: installed.receiptPath,
      'state-dir': installed.before.dir, 'confirm-restore': true}), /outside backup/);
    assert.equal(s.calls.length, calls);
    await loadBackup(installed.before.dir, {titleId: TITLE, uid: UID});
    assert.deepEqual(await fs.readFile(path.join(installed.before.dir, 'manifest.json')), before);
  }
});

test('backup checks reject symlink parents, unlisted files, mismatched identity, and traversal', async () => {
  const s = await system();
  const dir = await backup(path.join(s.directory, 'backup'), s.live);
  await fs.rename(path.join(dir, '.lovegame'), path.join(s.directory, 'outside'));
  await fs.symlink(path.join(s.directory, 'outside'), path.join(dir, '.lovegame'), 'dir');
  await assert.rejects(loadBackup(dir, {titleId: TITLE, uid: UID}), /Symlink/);
  const other = await backup(path.join(s.directory, 'other'), s.live);
  await fs.writeFile(path.join(other, 'unlisted'), 'data');
  await assert.rejects(loadBackup(other, {titleId: TITLE, uid: UID}), /unlisted/);
  await assert.rejects(loadBackup(other, {titleId: TITLE, uid: 'b'.repeat(32)}), /different account/);
  for (const value of ['/../foo', '/.lovegame/../foo', '/a//b', '/a\\b', '/a\0b', '/.lovegame/.'])
    assert.equal(safeSavePath(value), false, value);
});

test('argument parsing rejects unknown and repeated flags', () => {
  assert.throws(() => parseArgs(['install', '--force']), /Unknown/);
  assert.throws(() => parseArgs(['stage', '--out', 'a', '--out', 'b']), /Repeated/);
  assert.throws(() => parseArgs(['restore', '--receipt']), /requires a value/);
});
