#!/usr/bin/env node
// Offline tests for the generic restore path.
//
//   node tests/test_restore_manifest.cjs
//
// A restore is only safe if the manifest describes exactly the bytes that go back, and
// only general if it copes with what real saves contain (nested files, an existing
// manifest of our own, files with odd names). None of that needs a console, and all of
// it is what a BOTW-sized save would depend on.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'manifest-from-dir.cjs');
let passes = 0, failures = 0;
const test = (name, fn) => {
  try { fn(); passes++; console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + '\n      ' + error.message); }
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
  fs.writeFileSync(path.join(dir, 'game_data.sav'), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(dir, 'tracker.sav'), Buffer.from('tracker'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"ours":true}');
  fs.mkdirSync(path.join(dir, '0'));
  fs.writeFileSync(path.join(dir, '0', 'slot.sav'), Buffer.from('nested'));
  return dir;
}

const build = dir => {
  const out = path.join(dir, 'out.json');
  execFileSync(process.execPath, [TOOL, dir, out], {encoding: 'utf8'});
  return JSON.parse(fs.readFileSync(out, 'utf8'));
};

test('the manifest lists every save file with a sha256 and replace:true', () => {
  const dir = fixture();
  const manifest = build(dir);
  const paths = manifest.files.map(f => f.path).sort();
  assert.deepStrictEqual(paths, ['/0/slot.sav', '/game_data.sav', '/tracker.sav']);
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(file.replace, true);
    assert.strictEqual(file.size, fs.statSync(file.local).size);
  }
});

test('our own manifest.json is not treated as save data', () => {
  const dir = fixture();
  const manifest = build(dir);
  assert.ok(!manifest.files.some(f => f.path === '/manifest.json'));
});

test('nested files are listed and warned about (the write stage creates dirs)', () => {
  const dir = fixture();
  const result = spawnSync(process.execPath, [TOOL, dir, path.join(dir, 'out.json')],
    {encoding: 'utf8'});
  assert.strictEqual(result.status, 0);
  assert.match(result.stderr, /in subdirectories/);
});

test('an empty directory is refused rather than restoring nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-empty-'));
  const result = spawnSync(process.execPath, [TOOL, dir, path.join(dir, 'out.json')],
    {encoding: 'utf8'});
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /nothing to restore/);
});

test('--restore without --confirm-restore is refused before anything is opened', () => {
  // The flag check runs before any engine file is read, so this needs no console.
  const result = spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'save-write-stage.cjs'), 'no-such-run', '010042d022aea000',
      '00'.repeat(16), '/tmp', '/tmp/none.json', '--restore'], {encoding: 'utf8'});
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /confirm-restore/);
});

test('save-restore.sh --dry-run writes nothing and prints the plan', () => {
  const dir = fixture();
  const result = spawnSync('sh',
    [path.join(ROOT, 'tools', 'save-restore.sh'), 'no-such-run', '010042d022aea000',
      '00'.repeat(16), dir, '--dry-run'], {encoding: 'utf8'});
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /restore plan/);
  assert.match(result.stdout, /dry run: nothing has been written/);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
