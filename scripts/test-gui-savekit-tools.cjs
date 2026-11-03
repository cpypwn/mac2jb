const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {request, archive, archiveArgs, selectedArchiveArgs, verifyPull,
  stageFiles, stageRestoredFiles, parseListing, parseInventory, parseTitleNames} =
  require('./gui-savekit-tools.cjs');
const {assertPreservedFiles, assertMatchingFiles, verifyBackupFiles, safeRootName} =
  require('../vendor/ns2-savekit/tools/save-delete-root.cjs');
const {listApplications} = require('../vendor/ns2-savekit/tools/list-apps.cjs');
const {listSystem} = require('../vendor/ns2-savekit/overlay/engine/switch2/ro/ncm.cjs');
const saveTree = require('../vendor/ns2-savekit/tools/lib/save-tree.cjs');

test('save traversal rejects directory names that could escape an export', async () => {
  const api = {list: async () => [{name: '..', type: saveTree.DIRECTORY, size: 0}]};
  await assert.rejects(saveTree.walk({}, '/', api, {file: async () => {}}), /unsafe file name/);
});

test('title names require a confirmed cleanup and stay within the title inventory', () => {
  const title = '010012900d38a000';
  const sentinel = value => 'Getting games list..\nMAC2JB_TITLE_NAMES ' + JSON.stringify(value) + '\n';
  assert.deepEqual(parseTitleNames(sentinel({cleanupConfirmed: true,
    titles: [{titleId: title, name: 'Nora Princess 2'}]}), [title]),
  {[title]: 'Nora Princess 2'});
  assert.deepEqual(parseTitleNames(sentinel({cleanupConfirmed: true, titles: []}), [title]), {});
  assert.throws(() => parseTitleNames('Getting games list..\n', [title]), /did not confirm/);
  assert.throws(() => parseTitleNames(sentinel({cleanupConfirmed: false, titles: []}), [title]),
    /did not confirm/);
  assert.throws(() => parseTitleNames(sentinel({cleanupConfirmed: true,
    titles: [{titleId: '0'.repeat(16), name: 'Foreign'}]}), [title]), /invalid game label/);
  assert.throws(() => parseTitleNames(sentinel({cleanupConfirmed: true,
    titles: [{titleId: title, name: 'Bad\nname'}]}), [title]), /invalid game label/);
  assert.throws(() => parseTitleNames(sentinel({cleanupConfirmed: true,
    titles: [{titleId: title, name: 'Bad\u202eName'}]}), [title]), /invalid game label/);
});

function listed(ids, total = ids.length) {
  return {total, written: ids.length, complete: total === ids.length,
    keys: ids.map(id => ({id: '0x' + id}))};
}

test('title inventory combines internal, SD and game-card applications', async () => {
  const calls = [];
  const replies = new Map([
    [4, listed(['010012900d38a000'])],
    [5, listed(['010042d022aea000', '010012900d38a000'])],
    [2, listed(['0100ee5021c9e000', '01005eb012fe2000'])]
  ]);
  const inventory = await listApplications({request: async command => {
    calls.push(command);
    return replies.get(command.storage);
  }}, 9);
  assert.deepEqual(calls.map(call => call.storage), [4, 5, 2]);
  assert.ok(calls.every(call => call.command === 'root-native-ncm-list-system' &&
    call.handle === 9 && call.metaType === 0x80 && call.installType === 0));
  assert.deepEqual(inventory.titles, ['0x010012900d38a000', '0x010042d022aea000',
    '0x01005eb012fe2000', '0x0100ee5021c9e000']);
  assert.deepEqual(inventory.inactive, []);
});

test('title inventory tolerates only matching inactive SD and game-card databases', async () => {
  const inventory = await listApplications({request: async command => {
    if (command.storage === 4) return listed(['010012900d38a000']);
    throw Error('NCM metadata database ' + command.storage + ' open failed: 0x' +
      (command.storage === 5 ? '21005' : '20a05'));
  }}, 9);
  assert.deepEqual(inventory.titles, ['0x010012900d38a000']);
  assert.deepEqual(inventory.inactive, ['SdCard', 'GameCard']);
  for (const message of ['NCM metadata database 5 open failed: 0x12345',
    'NCM metadata database 5 open failed: 0x20a05',
    'Memory request timed out; it was not replayed']) {
    await assert.rejects(listApplications({request: async command => {
      if (command.storage === 4) return listed([]);
      throw Error(message);
    }}, 9), error => error.message === message);
  }
});

test('title inventory rejects truncated metadata and deduplicates versions', async () => {
  await assert.rejects(listApplications({request: async command =>
    command.storage === 4 ? listed(['010012900d38a000'], 1025) : listed([])}, 9),
  /incomplete/);
  const inventory = await listApplications({request: async command =>
    command.storage === 4 ? listed(['010012900d38a000', '010012900d38a000']) : listed([])}, 9);
  assert.deepEqual(inventory.titles, ['0x010012900d38a000']);
  assert.equal(inventory.counts[0].records, 2);
});

test('NCM open errors preserve the canonical result for inactive storage handling', async () => {
  const context = {s: {handles: new Set([9]), threads: new Set(),
    ipc: async () => ({result: 0x20a05, canonicalResult: 0x20a05})},
  live: {}, save: async () => {}};
  await assert.rejects(listSystem(context, {handle: 9, storage: 2, metaType: 0x80},
    {services: [{name: 'ncm', handle: 9}]}),
  /NCM metadata database 2 open failed: 0x20a05/);
});

test('developer requests keep title, account and archive parameters bounded', () => {
  const titleId = '010012900d38a000', uid = 'a'.repeat(32);
  assert.deepEqual(request({action: 'backup', titleId, uid}),
    {action: 'backup', titleId, uid, archive: {space: 1, type: 1, rank: 0,
      index: 0, staticId: 0}, archiveSelection: {space: 1, type: 1, rank: 0,
      index: 0, staticId: 0}, all: false});
  assert.deepEqual(archiveArgs(archive({space: 4, type: 3, rank: 1, index: 4})),
    ['--space', '4', '--type', '3', '--rank', '1', '--index', '4', '--static-id', '0']);
  assert.equal(request({action: 'write', titleId: '01002eb00ce48000', uid,
    sourceFolder: '/tmp/nora1', allowReplace: true}).titleId, '01002eb00ce48000');
  assert.equal(request({action: 'write', titleId: '0400f5802371e000', uid,
    sourceFolder: '/tmp/elden-ring'}).titleId, '0400f5802371e000');
  assert.throws(() => request({action: 'backup', titleId, uid: 'zz'}), /account ID/);
  const sweep = request({action: 'backup', titleId, uid, all: true});
  assert.deepEqual(sweep.archiveSelection, {});
  assert.deepEqual(selectedArchiveArgs(sweep.archiveSelection, true), []);
  const narrowed = request({action: 'inspect', titleId, uid, all: true,
    archive: {space: 1, type: 1}});
  assert.deepEqual(selectedArchiveArgs(narrowed.archiveSelection, true),
    ['--space', '1', '--type', '1']);
  assert.deepEqual(selectedArchiveArgs(narrowed.archive, false),
    ['--space', '1', '--type', '1', '--rank', '0', '--index', '0', '--static-id', '0']);
  assert.throws(() => request({action: 'backup', titleId, uid, archive: {rank: 2}}), /rank/);
  assert.throws(() => request({action: 'write', titleId, uid, sourceFolder: 'relative'}), /absolute/);
  assert.equal(request({action: 'write', titleId, uid, sourceFolder: '/tmp/demo',
    allowReplace: true}).allowReplace, true);
  assert.equal(request({action: 'write', titleId, uid, sourceFolder: '/tmp/demo'}).allowReplace,
    false);
  assert.throws(() => request({action: 'delete', titleId, uid,
    fileName: 'save.dat'}), /Confirm/);
  assert.throws(() => request({action: 'delete', titleId, uid,
    fileName: '../save.dat', confirmDelete: true}), /save root/);
  assert.throws(() => request({action: 'delete', titleId, uid,
    fileName: 'save\n.dat', confirmDelete: true}), /save root/);
  assert.equal(request({action: 'delete', titleId, uid,
    fileName: 'save.dat', confirmDelete: true}).fileName, 'save.dat');
  assert.throws(() => request({action: 'inspect', titleId, uid, arbitrary: true}), /Unknown field/);
  assert.deepEqual(request({action: 'inventory'}), {action: 'inventory'});
  assert.deepEqual(request({action: 'restore', titleId: '0100c9100b06a000', uid,
    sourceFolder: '/tmp/backup', confirmRestore: true}).archive,
  {space: 1, type: 1, rank: 0, index: 0, staticId: 0});
  assert.throws(() => request({action: 'restore', titleId, uid,
    sourceFolder: '/tmp/backup'}), /Confirm/);
  assert.throws(() => request({action: 'restore', titleId, uid,
    sourceFolder: '/tmp/backup', confirmRestore: true, archive: {rank: 1}}), /rank 0/);
});

test('an arbitrary title reaches backup verification in the staged writer', async t => {
  const titleId = '0400f5802371e000';
  const uid = 'a'.repeat(32);
  assert.equal(request({action: 'write', titleId, uid, sourceFolder: '/tmp/nora1'}).titleId,
    titleId);

  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-savekit-title-'));
  t.after(() => fs.rm(run, {recursive: true, force: true}));
  const engine = path.join(run, 'switch2');
  const app = path.join(engine, 'app');
  const root = path.join(engine, 'ro/root');
  const backup = path.join(run, 'backup');
  await Promise.all([fs.mkdir(app, {recursive: true}), fs.mkdir(root, {recursive: true}),
    fs.mkdir(backup)]);
  await Promise.all([
    fs.writeFile(path.join(engine, 'current-acquisition.json'), JSON.stringify({session: 'test',
      socketPath: path.join(run, 'missing-memory.sock')})),
    fs.writeFile(path.join(root, 'current-root.json'), JSON.stringify({session: 'test',
      pid: 1, rootHandle: 1})),
    fs.writeFile(path.join(app, 'session.cjs'), 'module.exports = {}'),
    fs.writeFile(path.join(app, 'filesystem.cjs'), 'module.exports = {}'),
    fs.writeFile(path.join(app, 'domain.cjs'), 'module.exports = {}'),
    fs.writeFile(path.join(backup, 'manifest.json'), '{}'),
    fs.writeFile(path.join(run, 'staged.dat'), 'test')
  ]);
  const staged = path.join(run, 'staged.dat');
  const manifest = path.join(run, 'write.json');
  await fs.writeFile(manifest, JSON.stringify({files: [{path: '/nora_01.dat',
    local: staged, replace: true}]}));
  const writer = path.join(__dirname, '../vendor/ns2-savekit/tools/save-write-stage.cjs');
  const invoke = id => spawnSync(process.execPath,
    [writer, run, id, uid, backup, manifest], {encoding: 'utf8'});
  for (const id of [titleId, '0100000000000000']) {
    const result = invoke(id);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /The backup does not prove the selected title/);
  }
  const bytes = Buffer.from('test');
  const entry = {path: '/nora_01.dat', size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
  const upstream = {archive: 'space=User type=Account rank=0 index=0 uid=' + uid.slice(0, 16),
    programId: titleId, uid, space: 1, type: 1, rank: 0, index: 0,
    files: 1, bytes: bytes.length, partial: false, failed: [], entries: [entry]};
  await fs.writeFile(path.join(backup, 'nora_01.dat'), bytes);
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(upstream));
  assert.match(invoke(titleId).stderr, /ENOENT.*missing-memory\.sock/);
  const legacy = {titleId, selection: {space: 1, type: 1, rank: 0,
    index: 0, staticId: 0, uid}, archive: upstream.archive, files: 1,
  entries: [entry]};
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(legacy));
  assert.match(invoke(titleId).stderr, /ENOENT.*missing-memory\.sock/);
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({...upstream,
    archive: 'space=User type=Account rank=0 index=0 uid=bbbbbbbbbbbbbbbb'}));
  assert.match(invoke(titleId).stderr, /The backup does not prove the selected title/);
});

test('pulled manifests are hash-verified and reject path traversal', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-savekit-pull-'));
  t.after(() => fs.rm(folder, {recursive: true, force: true}));
  const bytes = Buffer.from('save content');
  await fs.writeFile(path.join(folder, 'save.dat'), bytes);
  const good = {titleId: '010012900d38a000',
    archive: 'space=User type=Account rank=0 index=0 uid=' + 'a'.repeat(16),
    selection: {space: 1, type: 1, rank: 0, index: 0, staticId: 0, uid: 'a'.repeat(32)},
    files: 1, bytes: bytes.length,
    entries: [{path: '/save.dat', size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')}]};
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(good));
  assert.deepEqual((await verifyPull(folder, {titleId: good.titleId, uid: 'a'.repeat(32),
    selection: {space: 1, type: 1, rank: 0, index: 0, staticId: 0}})).entries, good.entries);
  const compatible = {...good, programId: good.titleId,
    uid: good.selection.uid, space: 1, type: 1, rank: 0, index: 0};
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(compatible));
  await verifyPull(folder);
  const upstream = {archive: good.archive, programId: good.titleId,
    uid: good.selection.uid, space: 1, type: 1, rank: 0, index: 0,
    files: good.files, bytes: good.bytes, partial: false, failed: [],
    entries: good.entries};
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(upstream));
  const verified = await verifyPull(folder, {titleId: good.titleId, uid: good.selection.uid,
    selection: good.selection});
  assert.equal(verified.titleId, good.titleId);
  assert.deepEqual(verified.selection, good.selection);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')),
    upstream);
  await assert.rejects(verifyPull(folder, {selection: {...good.selection, staticId: 7}}),
    /selected staticId/);
  const trusted = await verifyPull(folder, {selection: {...good.selection, staticId: 7},
    trustedStaticId: 7});
  assert.equal(trusted.selection.staticId, 7);
  for (const change of [{programId: '010042d022aea000'}, {uid: 'b'.repeat(32)}, {type: 3}]) {
    await fs.writeFile(path.join(folder, 'manifest.json'),
      JSON.stringify({...compatible, ...change}));
    await assert.rejects(verifyPull(folder), /conflicting/);
  }
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(good));
  await assert.rejects(verifyPull(folder, {titleId: '010042d022aea000'}), /program ID/);
  await assert.rejects(verifyPull(folder, {selection: {type: 3}}), /selected type/);
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({...good,
    partial: true, failed: [{path: '/missing.dat'}]}));
  await assert.rejects(verifyPull(folder), /incomplete manifest/);
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(good));
  await fs.writeFile(path.join(folder, 'save.dat'), 'changed');
  await assert.rejects(verifyPull(folder), /invalid file|SHA-256/);
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({...good,
    entries: [{...good.entries[0], path: '/../save.dat'}]}));
  await assert.rejects(verifyPull(folder), /unsafe path/);
});

test('save inventory accepts archive identities and rejects malformed records', () => {
  const entry = {id: '123', applicationId: '0x010012900d38a000', uid: 'a'.repeat(32),
    space: 1, type: 1, rank: 0, index: 0, size: '1536'};
  const report = {rootPid: 1, spaces: {1: {error: null}}, entries: [entry]};
  assert.deepEqual(parseInventory(report), {entries: [{id: '123', titleId: '010012900d38a000',
    uid: 'a'.repeat(32), space: 1, type: 1, rank: 0, index: 0, size: '1536'}], failedSpaces: 0});
  assert.throws(() => parseInventory({...report, entries: [{...entry, uid: '../bad'}]}),
    /invalid record/);
  assert.throws(() => parseInventory({...report, rootPid: 2}), /incomplete/);
});

test('restore staging preserves nested paths and rejects a changed backup', async t => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-savekit-restore-'));
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-savekit-stage-'));
  const changedStage = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-savekit-stage-'));
  t.after(async () => {
    await fs.rm(source, {recursive: true, force: true});
    await fs.rm(stage, {recursive: true, force: true});
    await fs.rm(changedStage, {recursive: true, force: true});
  });
  await fs.mkdir(path.join(source, 'debug/lua'), {recursive: true});
  await fs.writeFile(path.join(source, 'debug/lua/index.lua'), 'return 1');
  const digest = crypto.createHash('sha256').update('return 1').digest('hex');
  const manifest = {entries: [{path: '/debug/lua/index.lua', size: 8, sha256: digest}]};
  const files = await stageRestoredFiles(source, stage, manifest);
  assert.equal(files[0].path, '/debug/lua/index.lua');
  assert.equal(await fs.readFile(files[0].local, 'utf8'), 'return 1');
  await fs.writeFile(path.join(source, 'debug/lua/index.lua'), 'return 2');
  await assert.rejects(stageRestoredFiles(source, changedStage, manifest),
    /changed while preparing/);
});

test('delete verification catches changed, missing and newly added save files', () => {
  const before = [
    {path: '/selected.dat', size: 3, sha256: 'a'.repeat(64)},
    {path: '/profile.dat', size: 5, sha256: 'b'.repeat(64)},
    {path: '/nested/state.bin', size: 7, sha256: 'c'.repeat(64)}
  ];
  assertPreservedFiles(before, before.slice(1), '/selected.dat');
  assert.throws(() => assertPreservedFiles(before,
    [{...before[1], sha256: 'd'.repeat(64)}, before[2]], '/selected.dat'),
  /Another save file changed/);
  assert.throws(() => assertPreservedFiles(before, [before[1]], '/selected.dat'),
    /Other save files changed/);
  assert.throws(() => assertPreservedFiles(before,
    [...before.slice(1), {path: '/new.dat', size: 1, sha256: 'e'.repeat(64)}],
    '/selected.dat'), /Other save files changed/);
  assert.throws(() => assertPreservedFiles(before, before, '/selected.dat'),
    /still present/);
  assert.equal(safeRootName('save\r.dat'), false);
});

test('delete preflight requires a complete and unchanged backup', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-savekit-delete-'));
  t.after(() => fs.rm(folder, {recursive: true, force: true}));
  await fs.writeFile(path.join(folder, 'save.dat'), 'original');
  const entry = {path: '/save.dat', size: 8,
    sha256: crypto.createHash('sha256').update('original').digest('hex')};
  const valid = {files: 1, bytes: 8, partial: false, failed: [], entries: [entry]};
  await verifyBackupFiles(folder, valid);
  await assert.rejects(verifyBackupFiles(folder, {...valid, partial: true}), /partial or incomplete/);
  await assert.rejects(verifyBackupFiles(folder, {...valid, failed: ['/other.dat']}),
    /partial or incomplete/);
  await assert.rejects(verifyBackupFiles(folder, {...valid, files: 2}), /partial or incomplete/);
  await assert.rejects(verifyBackupFiles(folder, {...valid, entries: [entry, entry], files: 2}),
    /invalid file/);
  await fs.writeFile(path.join(folder, 'save.dat'), 'modified');
  await assert.rejects(verifyBackupFiles(folder, valid), /SHA-256 verification/);
});

test('delete preflight compares every live save file before mutation', () => {
  const before = [
    {path: '/selected.dat', size: 3, sha256: 'a'.repeat(64)},
    {path: '/other.dat', size: 5, sha256: 'b'.repeat(64)}
  ];
  assertMatchingFiles(before, before.slice().reverse());
  assert.throws(() => assertMatchingFiles(before, before.slice(0, 1)), /file list differs/);
  assert.throws(() => assertMatchingFiles(before,
    [before[0], {...before[1], sha256: 'c'.repeat(64)}]), /live save differs/);
  assert.throws(() => assertMatchingFiles(before,
    [before[0], {path: '/new.dat', size: 5, sha256: 'b'.repeat(64)}]), /live save differs/);
});

test('a full archive listing keeps each file associated with its archive', () => {
  const output = 'archive space=User type=Account rank=0 index=0 uid=aaaaaaaaaaaaaaaa\n' +
    '        3  /data.bin\nlisted 1 files, 3 bytes (read-only, nothing written)\n' +
    'archive space=User type=Device rank=1 index=0 uid=0000000000000000\n' +
    '    <dir>  /settings/\n        5  /settings/data.bin\n' +
    'listed 1 files, 5 bytes (read-only, nothing written)\n';
  const listing = parseListing(output, true);
  assert.equal(listing.archives.length, 2);
  assert.equal(listing.files, 2);
  assert.equal(listing.bytes, 8);
  assert.equal(listing.entries[0].archive, listing.archives[0].archive);
  assert.equal(listing.entries[2].archive, listing.archives[1].archive);
  assert.throws(() => parseListing('archive space=User type=Account\n', true),
    /no complete archive listing/);
});

test('local write staging copies flat files and excludes Finder metadata', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-savekit-source-'));
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-savekit-stage-'));
  t.after(async () => {
    await fs.rm(folder, {recursive: true, force: true});
    await fs.rm(stage, {recursive: true, force: true});
  });
  await fs.writeFile(path.join(folder, 'game save.dat'), 'original');
  await fs.writeFile(path.join(folder, '.DS_Store'), 'metadata');
  await fs.writeFile(path.join(folder, '.nx_save_meta.bin'), 'metadata');
  const files = await stageFiles(folder, stage);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'game save.dat');
  await fs.writeFile(path.join(folder, 'game save.dat'), 'changed');
  assert.equal(await fs.readFile(files[0].path, 'utf8'), 'original');
  await fs.rm(files[0].path);
  await fs.mkdir(path.join(folder, 'nested'));
  await assert.rejects(stageFiles(folder, stage), /unsupported file/);
});
