'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {manifestFor, packArguments, operation, verifyBinary, availableBinary} = require('./gui-nxformat.cjs');

const root = path.join(__dirname, '..');

async function fixture(t) {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac2jb-nxformat-'));
  t.after(() => fsp.rm(folder, {recursive: true, force: true}));
  return folder;
}

test('manifest pins the official macOS universal release and SHA-256', async () => {
  const manifest = await manifestFor(root);
  assert.equal(manifest.release, 'V1.0.3');
  assert.equal(manifest.archiveBytes, 63966246);
  assert.equal(manifest.archiveSha256,
    'b61fecfad224d2f0b6a040c23663e5f6915eb500be9fc36016e3ffcb0aa66e52');
});

test('the bundled NXConvert matches the pinned release and runs without a download', async t => {
  const manifest = await manifestFor(root);
  const binary = path.join(root, 'tools/nxformat/1.0.3/bin/nxconvert');
  assert.equal(await availableBinary(root, manifest), binary);
  assert.equal((await fsp.stat(binary)).size, 20898144);
  const folder = await fixture(t);
  const archive = path.join(folder, 'game.nx');
  await fsp.writeFile(archive, 'test archive');
  let invoked = false;
  await operation(root, 'verify', archive, undefined, {
    run: async (selected, args) => {
      assert.equal(selected, binary);
      assert.deepEqual(args, ['verify', archive]);
      invoked = true;
    },
  });
  assert.equal(invoked, true);
});

test('cached executable must match its pinned hash and be a regular file', async t => {
  const folder = await fixture(t);
  await fsp.mkdir(path.join(folder, 'bin'));
  const binary = path.join(folder, 'bin/nxconvert');
  await fsp.writeFile(binary, 'nxconvert-test', {mode: 0o700});
  const manifest = {binaryPath: 'bin/nxconvert',
    binarySha256: crypto.createHash('sha256').update('nxconvert-test').digest('hex')};
  assert.equal(await verifyBinary(folder, manifest), binary);
  await fsp.writeFile(binary, 'changed');
  await assert.rejects(verifyBinary(folder, manifest), /integrity check/);
  await fsp.rm(binary);
  await fsp.symlink('/usr/bin/true', binary);
  await assert.rejects(verifyBinary(folder, manifest), /integrity check/);
});

test('pack selects the correct Switch 2 import for folders and NUP', async t => {
  const folder = await fixture(t);
  const dump = path.join(folder, 'dump');
  const nup = path.join(folder, 'game.nup');
  const nx = path.join(folder, 'game.nx');
  await fsp.mkdir(dump);
  await fsp.writeFile(nup, 'nup');
  assert.deepEqual(await packArguments(dump, nx),
    ['pack-tree', dump, nx, '--platform', 'switch2', '--no-trail', '--frontend']);
  assert.deepEqual(await packArguments(nup, nx),
    ['pack-nup', nup, nx, '--platform', 'switch2', '--no-trail', '--frontend']);
  await assert.rejects(packArguments(path.join(folder, 'missing.nup'), nx));
  await fsp.writeFile(nx, 'previous');
  await assert.rejects(packArguments(dump, nx), /already exists/);
});

test('pack verifies before publication and preserves existing destinations', async t => {
  const folder = await fixture(t);
  const dump = path.join(folder, 'dump');
  const nx = path.join(folder, 'game.nx');
  await fsp.mkdir(dump);
  const calls = [];
  const run = async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'pack-tree') await fsp.writeFile(args[2], 'verified archive');
    if (args[0] === 'verify') assert.equal(await fsp.readFile(args[1], 'utf8'), 'verified archive');
  };
  assert.match(await operation(root, 'pack', dump, nx, {binary: '/fake/nxconvert', run}), /Saved/);
  assert.equal(await fsp.readFile(nx, 'utf8'), 'verified archive');
  assert.deepEqual(calls.map(args => args[0]), ['pack-tree', 'verify']);
  await assert.rejects(operation(root, 'pack', dump, nx, {binary: '/fake/nxconvert', run}),
    /already exists/);
  assert.equal(await fsp.readFile(nx, 'utf8'), 'verified archive');
  assert.equal((await fsp.readdir(folder)).filter(name => name.includes('.partial')).length, 0);
});

test('failed verification discards the temporary NX', async t => {
  const folder = await fixture(t);
  const nup = path.join(folder, 'game.nup');
  const nx = path.join(folder, 'game.nx');
  await fsp.writeFile(nup, 'nup');
  const run = async (_binary, args) => {
    if (args[0] === 'pack-nup') await fsp.writeFile(args[2], 'unverified');
    if (args[0] === 'verify') throw Error('integrity error');
  };
  await assert.rejects(operation(root, 'pack', nup, nx, {binary: '/fake/nxconvert', run}),
    /integrity error/);
  assert.deepEqual(await fsp.readdir(folder), ['game.nup']);
});

test('inspect commands accept only regular NX files', async t => {
  const folder = await fixture(t);
  const nx = path.join(folder, 'game.nx');
  await fsp.writeFile(nx, 'nx');
  const calls = [];
  const run = async (_binary, args) => {calls.push(args); return 'ok';};
  for (const action of ['info', 'contents', 'verify']) {
    assert.equal(await operation(root, action, nx, undefined, {binary: '/fake/nxconvert', run}), 'ok');
  }
  assert.deepEqual(calls, [['info', nx], ['contents', nx], ['verify', nx]]);
  await assert.rejects(operation(root, 'delete', nx, undefined, {binary: '/fake/nxconvert', run}),
    /Unknown NXFormat operation/);
});
