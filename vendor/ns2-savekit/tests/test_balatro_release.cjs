'use strict';
// Offline archive tests use synthetic Lua text, never upstream payload files.
// Set BALATRO_TEST_ARCHIVE to the downloaded pinned ZIP for the optional real
// packaging check; normal CI does not download or execute a launcher.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const release = require('../tools/lib/balatro-release.cjs');
const HELPER = path.resolve(__dirname, '../tools/balatro-archive.py');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'balatro-release-test-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  return dir;
}

const MAKE_FIXTURE = `
from pathlib import Path
import hashlib, json, stat, struct, sys, zipfile
root, kind = Path(sys.argv[1]), sys.argv[2]
data = {'.nx_save_meta.bin': b'metadata', '.lovegame/conf.lua': b'return {}', '.lovegame/main.lua': b'return 4'}
records = {name: {'path': name if name == '.nx_save_meta.bin' else '/' + name,
    'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()} for name, raw in data.items()}
config = {'metadata': records['.nx_save_meta.bin'],
    'files': [records[name] for name in data if name != '.nx_save_meta.bin']}
archive = root / 'fixture.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as zipped:
    for name, raw in data.items():
        entry = zipfile.ZipInfo(name)
        if kind == 'symlink' and name == '.lovegame/conf.lua':
            entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        zipped.writestr(entry, raw)
    if kind == 'duplicate': zipped.writestr('.lovegame/conf.lua', data['.lovegame/conf.lua'])
    if kind == 'traversal': zipped.writestr('../escape.lua', b'escape')
    if kind == 'extra': zipped.writestr('.lovegame/1/profile.jkr', b'not a launcher file')
raw = archive.read_bytes()
if kind == 'crc':
    with zipfile.ZipFile(archive) as zipped: offset = zipped.getinfo('.lovegame/conf.lua').header_offset
    name_len, extra_len = struct.unpack_from('<HH', raw, offset + 26)
    raw = bytearray(raw)
    raw[offset + 30 + name_len + extra_len] ^= 1
    raw = bytes(raw)
    archive.write_bytes(raw)
config['upstream'] = {'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
if kind == 'digest': config['upstream']['sha256'] = '0' * 64
if kind == 'file-hash': config['files'][0]['sha256'] = '0' * 64
if kind == 'oversize': config['files'][0]['size'] = 1024 * 1024 + 1
if kind == 'unsafe-pin': config['files'][0]['path'] = '/.lovegame/../escape.lua'
(root / 'fixture.json').write_text(json.dumps(config))
`;

function fixture(t, kind = 'valid') {
  const dir = temporary(t);
  const made = spawnSync('python3', ['-c', MAKE_FIXTURE, dir, kind], {encoding:'utf8'});
  assert.equal(made.status, 0, made.stderr);
  return {dir, archive:path.join(dir, 'fixture.zip'), config:path.join(dir, 'fixture.json'),
    out:path.join(dir, 'staged')};
}

function extract(item, out = item.out) {
  return spawnSync('python3', ['-c', `
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('balatro_archive', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = json.loads(Path(sys.argv[3]).read_text())
print(json.dumps(module.extract_archive(sys.argv[2], sys.argv[4], config)))
`, HELPER, item.archive, item.config, out], {encoding:'utf8'});
}

test('release pins the Switch 1 title and exactly twenty launcher files', () => {
  const {CONFIG, TITLE_ID, INSTALL_PATHS} = release;
  assert.equal(TITLE_ID, '0100cd801ce5e000');
  assert.equal(CONFIG.upstream.tag, 'v1.1.0');
  assert.equal(CONFIG.upstream.sha256, '2c8055ec080f3c7bd7b5392f4484dbe8247efaa712563b662dfabab1b616b704');
  assert.equal(CONFIG.upstream.size, 58223);
  assert.equal(INSTALL_PATHS.length, 20);
  assert.equal(new Set(INSTALL_PATHS).size, 20);
  assert.equal(CONFIG.files.reduce((total, entry) => total + entry.size, 0), 148240);
  for (const entry of CONFIG.files) {
    assert.match(entry.path, /^\/\.lovegame\//);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.size > 0 && entry.size < 1024 * 1024);
  }
  for (const required of ['/.lovegame/conf.lua', '/.lovegame/main.lua', '/.lovegame/bl/assets/OFL.txt'])
    assert.ok(INSTALL_PATHS.includes(required));
  assert.equal(INSTALL_PATHS.includes('/.nx_save_meta.bin'), false);
  assert.equal(CONFIG.metadata.path, '.nx_save_meta.bin');
  assert.equal(CONFIG.metadata.size, 86);
});

test('a valid archive stages only approved game files, excluding JKSV metadata', t => {
  const item = fixture(t);
  const result = extract(item);
  assert.equal(result.status, 0, result.stderr);
  const staged = JSON.parse(result.stdout);
  assert.equal(staged.directory, item.out);
  assert.deepEqual(staged.files.map(entry => entry.path), ['/.lovegame/conf.lua', '/.lovegame/main.lua']);
  assert.equal(fs.existsSync(path.join(item.out, '.nx_save_meta.bin')), false);
  for (const entry of staged.files) {
    assert.equal(entry.replace, false);
    assert.equal(entry.local, path.join(item.out, entry.path.slice(1)));
    assert.equal(sha(fs.readFileSync(entry.local)), entry.sha256);
  }
});

for (const [kind, message] of [
  ['digest', /SHA-256/], ['file-hash', /file SHA-256/], ['duplicate', /Duplicate ZIP/],
  ['traversal', /entry set/], ['extra', /entry set/], ['symlink', /Unsafe ZIP entry/],
  ['crc', /CRC/], ['oversize', /expanded file size/], ['unsafe-pin', /Unsafe configured payload path/],
]) {
  test('archive validation rejects ' + kind + ' before creating output', t => {
    const item = fixture(t, kind);
    const result = extract(item);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(fs.existsSync(item.out), false);
    assert.equal(fs.existsSync(path.join(item.dir, 'escape.lua')), false);
  });
}

test('existing staging directories and symlinks are never overwritten', t => {
  const item = fixture(t);
  fs.mkdirSync(item.out);
  const sentinel = path.join(item.out, 'keep.txt');
  fs.writeFileSync(sentinel, 'keep');
  assert.notEqual(extract(item).status, 0);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  const alias = path.join(item.dir, 'alias');
  fs.symlinkSync(item.out, alias, 'dir');
  assert.notEqual(extract(item, alias).status, 0);
  assert.notEqual(extract(item, path.join(alias, 'new')).status, 0);
  assert.equal(fs.existsSync(path.join(item.out, 'new')), false);
});

test('local and cached archives with wrong pins are refused without alteration or network', async t => {
  const dir = temporary(t);
  const bad = Buffer.alloc(release.CONFIG.upstream.size, 1);
  const file = path.join(dir, release.CACHE_NAME);
  fs.writeFileSync(file, bad);
  t.mock.method(global, 'fetch', async () => assert.fail('unexpected network access'));
  await assert.rejects(release.obtainArchive({archive:file}), /SHA-256/);
  await assert.rejects(release.obtainArchive({cacheDir:dir}), /SHA-256/);
  assert.deepEqual(fs.readFileSync(file), bad);
  const alias = path.join(dir, 'alias.zip');
  fs.symlinkSync(file, alias);
  await assert.rejects(release.verifyArchive(alias), /symlink/);
});

test('an oversized download cannot create a cache entry', async t => {
  const dir = temporary(t);
  t.mock.method(global, 'fetch', async url => ({ok:true, status:200, url,
    headers:new Headers(), body:new ReadableStream({start(controller) {
      controller.enqueue(new Uint8Array(release.CONFIG.upstream.size + 1));
      controller.close();
    }})}));
  await assert.rejects(release.obtainArchive({cacheDir:dir}), /larger than/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('real pinned upstream ZIP passes staging and remains unchanged', {
  skip:!process.env.BALATRO_TEST_ARCHIVE,
}, async t => {
  const archive = path.resolve(process.env.BALATRO_TEST_ARCHIVE);
  const before = sha(fs.readFileSync(archive));
  assert.equal(await release.obtainArchive({archive}), archive);
  const dir = temporary(t);
  const staged = await release.stageArchive(archive, path.join(dir, 'payload'));
  assert.equal(staged.files.length, 20);
  assert.equal(fs.existsSync(path.join(staged.directory, '.nx_save_meta.bin')), false);
  await assert.rejects(release.stageArchive(archive, staged.directory), /already exists/);
  assert.equal(sha(fs.readFileSync(archive)), before);
});
