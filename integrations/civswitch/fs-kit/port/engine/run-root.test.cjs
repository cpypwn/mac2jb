const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {prepareRunRoot} = require('./run.cjs');

test('opt-in run root creates a private directory under a canonical writable parent', async t => {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'lovera1n-root-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const root = path.join(parent, 'state', 'runs');
  assert.equal(await prepareRunRoot(root), root);
  assert.equal((await fs.lstat(root)).isDirectory(), true);
  assert.equal(await prepareRunRoot(root), root);
});

test('opt-in run root rejects relative paths, parent traversal and symlinked components', async t => {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'lovera1n-root-'));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  await assert.rejects(prepareRunRoot('relative/runs'), /normalized absolute/);
  await assert.rejects(prepareRunRoot(`${parent}${path.sep}..${path.sep}other`),
    /normalized absolute/);
  await assert.rejects(prepareRunRoot(''), /normalized absolute/);
  await assert.rejects(prepareRunRoot(path.parse(parent).root), /normalized absolute/);
  const target = path.join(parent, 'target');
  await fs.mkdir(target);
  const link = path.join(parent, 'link');
  try {
    await fs.symlink(target, link, 'dir');
    await assert.rejects(prepareRunRoot(path.join(link, 'runs')), /symlink or non-directory/);
    await assert.rejects(fs.lstat(path.join(target, 'runs')), {code: 'ENOENT'});
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  const file = path.join(parent, 'file');
  await fs.writeFile(file, 'keep');
  await assert.rejects(prepareRunRoot(path.join(file, 'runs')), /symlink or non-directory/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep');
});
