'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {validateModsFolder, stage} = require('./gui-modloader.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-modloader-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const run = path.join(root, 'switch2-test'), mods = path.join(root, 'mods');
  fs.mkdirSync(run, {mode: 0o700});
  fs.mkdirSync(path.join(mods, 'contents', '0400f5802371e000', 'romfs'), {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(mods, 'contents', '0400f5802371e000', 'romfs', 'test.bin'), 'mod data');
  return {root, run, mods};
}

test('stages only a validated unpacked mod tree beside the held run', t => {
  const {run, mods} = fixture(t);
  assert.equal(validateModsFolder(mods), mods);
  const result = stage(run, mods);
  assert.deepEqual(result.games, ['0400f5802371e000']);
  assert.equal(result.patches, 0);
  assert.equal(fs.readFileSync(path.join(result.staging, 'contents', '0400f5802371e000', 'romfs', 'test.bin'), 'utf8'), 'mod data');
  assert.equal(fs.existsSync(path.join(result.staging, 'install.cjs')), true);
  assert.equal(fs.existsSync(path.join(result.staging, 'native', 'prebuilt', 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(result.staging, 'state')), false);
  assert.equal(path.dirname(result.staging), run);
});

test('refuses a linked top-level contents folder', t => {
  const {root, mods} = fixture(t);
  fs.renameSync(path.join(mods, 'contents'), path.join(root, 'external'));
  fs.symlinkSync(path.join(root, 'external'), path.join(mods, 'contents'));
  assert.throws(() => validateModsFolder(mods), /real directory/);
});

test('refuses a dangling top-level mod link', t => {
  const {mods} = fixture(t);
  fs.symlinkSync(path.join(mods, 'missing'), path.join(mods, 'exefs_patches'));
  assert.throws(() => validateModsFolder(mods), /real directory/);
});

test('refuses a linked file inside a mod and unrelated runtime components', t => {
  const {root, mods} = fixture(t);
  const romfs = path.join(mods, 'contents', '0400f5802371e000', 'romfs');
  fs.symlinkSync(path.join(root, 'outside'), path.join(romfs, 'linked.bin'));
  assert.throws(() => validateModsFolder(mods), /regular files and directories/);
  fs.unlinkSync(path.join(romfs, 'linked.bin'));
  fs.mkdirSync(path.join(mods, 'contents', '0400f5802371e000', 'cheats'));
  assert.throws(() => validateModsFolder(mods), /Unsupported component/);
});

test('refuses empty folders before creating a stage', t => {
  const {run, mods} = fixture(t);
  fs.rmSync(path.join(mods, 'contents'), {recursive: true});
  assert.throws(() => stage(run, mods), /No mods found/);
  assert.deepEqual(fs.readdirSync(run), []);
});
