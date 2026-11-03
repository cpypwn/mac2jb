const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {manifestFor, verifySource, operation, cacheFor} = require('./gui-nup.cjs');

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

test('pinned NUP source manifest and support files are present', async () => {
  const root = path.resolve(__dirname, '..');
  const manifest = await manifestFor(root);
  assert.equal(manifest.commit.length, 40);
  assert.equal(manifest.zstandard.version, '0.25.0');
  await fs.access(path.join(root, 'integrations/nup-support/site-packages/zstandard/backend_c.cpython-313-darwin.so'));
});

test('NUP source integrity, atomic output and path checks', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-nup-test-'));
  t.after(() => fs.rm(base, {recursive: true, force: true}));
  const prior = process.env.MAC2JB_NUP_TEST_CACHE;
  process.env.MAC2JB_NUP_TEST_CACHE = path.join(base, 'cache');
  t.after(() => {
    if (prior === undefined) delete process.env.MAC2JB_NUP_TEST_CACHE;
    else process.env.MAC2JB_NUP_TEST_CACHE = prior;
  });
  const root = path.join(base, 'runtime');
  await fs.mkdir(path.join(root, 'packaging'), {recursive: true});
  await fs.mkdir(path.join(root, 'homebrew/python/bin'), {recursive: true});
  await fs.mkdir(path.join(root, 'integrations/nup-support/site-packages'), {recursive: true});
  const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../packaging/NUP-source.json')));
  for (const name of Object.keys(manifest.modules)) manifest.modules[name] = digest(name);
  await fs.writeFile(path.join(root, 'packaging/NUP-source.json'), JSON.stringify(manifest));
  const source = cacheFor(manifest);
  await fs.mkdir(path.join(source, 'nup'), {recursive: true});
  for (const name of Object.keys(manifest.modules)) {
    await fs.writeFile(path.join(source, 'nup', name), name);
  }
  assert.equal(await verifySource(source, manifest), path.join(source, 'nup'));
  const python = path.join(root, 'homebrew/python/bin/python3');
  await fs.writeFile(python, '#!/bin/sh\ncase "$3" in\npack) printf sample > "$5";;\nverify) test -f "$4" || exit 1;;\nesac\nprintf "ok\\n"\n');
  await fs.chmod(python, 0o700);
  const input = path.join(base, 'dump');
  await fs.mkdir(input);
  const output = path.join(base, 'game.nup');
  assert.match(await operation(root, 'pack', input, output), /Saved/);
  assert.equal(await fs.readFile(output, 'utf8'), 'sample');
  await assert.rejects(operation(root, 'pack', input, output), /already exists/);
  await assert.rejects(operation(root, 'pack', input, path.join(base, 'bad.txt')), /new .nup/);
  assert.match(await operation(root, 'verify', output), /ok/);
  await fs.writeFile(path.join(source, 'nup/cli.py'), 'changed');
  await assert.rejects(verifySource(source, manifest), /changed/);
});
