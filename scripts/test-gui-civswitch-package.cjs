'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const packageHelper = require('./gui-civswitch-package.cjs');

const ROOT = path.resolve(__dirname, '..');

function sample() {
  return {format: 'civswitch-app', version: 1, id: 'sample-app', name: 'Sample',
    metadata: {api: 1}, scripts: [{name: 'app/main.js', source: 'console.log("hello");'}]};
}

async function fixture(t, item = sample()) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-civ-package-'));
  t.after(() => fs.rm(folder, {recursive: true, force: true}));
  const file = path.join(folder, 'sample.civapp');
  await fs.writeFile(file, JSON.stringify(item));
  return file;
}

test('a user selected CivHomebrew package installs once into an idle launcher', async t => {
  const file = await fixture(t);
  const calls = [];
  const options = {
    probe: async () => ({state: {busy: false, closed: false, mode: 'launcher'}}),
    request: async (_address, operation) => {
      calls.push(operation);
      return {entry: {id: 'sample-app', name: 'Sample'}};
    }
  };
  const installed = await packageHelper.install('127.0.0.1', file, options);
  assert.equal(installed.id, 'sample-app');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'install');
  assert.equal(calls[0].package.scripts[0].source, 'console.log("hello");');
});

test('generic validation accepts both bundled CivHomebrew package shapes', async () => {
  for (const file of [
    'integrations/sw2nes/v1.0.1/sw2nes.civapp',
    'integrations/jellyfin/0.0.1/jellyfin-civswitch.civapp'
  ]) {
    const item = await packageHelper.readPackage(path.join(ROOT, file));
    assert.equal(item.format, 'civswitch-app');
    assert.ok(item.scripts.length > 0);
  }
});

test('invalid package metadata and script paths are rejected before sending', async () => {
  const alternateScript = {...sample(), scripts: [{name: 'app/bootstrap.mjs', source: 'export default 1;'}]};
  assert.equal(packageHelper.inspectPackage(Buffer.from(JSON.stringify(alternateScript))).id, 'sample-app');
  for (const change of [
    {format: 'other'}, {version: 2}, {id: '../bad'}, {scripts: []},
    {scripts: [{name: '../escape.js', source: 'x'}]},
    {scripts: [{name: 'same.js', source: 'x'}, {name: 'same.js', source: 'y'}]},
    {scripts: [{name: 'empty.js', source: ' '}]}]) {
    const item = {...sample(), ...change};
    assert.throws(() => packageHelper.inspectPackage(Buffer.from(JSON.stringify(item))),
      /not a supported|invalid script/);
  }
  assert.throws(() => packageHelper.inspectPackage(Buffer.from('not json')), /not valid JSON/);
});

test('symlinked and oversized packages are rejected before probing the console', async t => {
  const file = await fixture(t);
  const link = path.join(path.dirname(file), 'link.civapp');
  await fs.symlink(file, link);
  await assert.rejects(packageHelper.readPackage(link), /symbolic link/);
  const huge = path.join(path.dirname(file), 'huge.civapp');
  const handle = await fs.open(huge, 'w');
  await handle.truncate(packageHelper.MAX_PACKAGE_BYTES + 1);
  await handle.close();
  await assert.rejects(packageHelper.readPackage(huge), /smaller than 32 MiB/);
});

test('busy launcher and missing confirmation keep the package uninstalled', async t => {
  const file = await fixture(t);
  let requests = 0;
  await assert.rejects(packageHelper.install('127.0.0.1', file, {
    probe: async () => ({state: {busy: true, closed: false, mode: 'launcher'}}),
    request: async () => { requests++; return {}; }
  }), /Return to the CivHomebrew launcher/);
  assert.equal(requests, 0);
  await assert.rejects(packageHelper.install('127.0.0.1', file, {
    probe: async () => ({state: {busy: false, closed: false, mode: 'launcher'}}),
    request: async () => ({entry: {id: 'another-app'}})
  }), /did not confirm/);
});

test('CLI reports install status through the app event prefix', async t => {
  const file = await fixture(t);
  const events = [];
  await packageHelper.main(['install', ROOT, '127.0.0.1', file], {
    allowLoopback: true,
    emit: (type, fields) => events.push({type, ...fields}),
    probe: async () => ({state: {busy: false, closed: false, mode: 'launcher'}}),
    request: async () => ({entry: {id: 'sample-app'}})
  });
  assert.deepEqual(events.map(event => event.type), ['status', 'installed']);
  assert.match(events[1].message, /Sample installed/);
});

test('packaged helper self-test checks the installer dependencies', async () => {
  const events = [];
  await packageHelper.main(['--self-test', ROOT], {emit: (type, fields) => events.push({type, ...fields})});
  assert.equal(events[0].type, 'self-test');
});
