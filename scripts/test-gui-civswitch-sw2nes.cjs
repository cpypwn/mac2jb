'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sw2nes = require('./gui-civswitch-sw2nes.cjs');

const ROOT = path.resolve(__dirname, '..');

function companion(entries = [], state = {}) {
  const calls = [];
  return {
    calls,
    probe: async () => ({entries, state: {mode: 'launcher', busy: false, closed: false, ...state}}),
    request: async (_address, operation) => {
      calls.push(operation);
      if (operation.op === 'install') return {entry: {id: 'sw2nes', name: 'SW2NES'}};
      if (operation.op === 'run') return {state: 'accepted', name: 'SW2NES'};
      throw Error('Unexpected operation');
    }
  };
}

test('official v1.0.1 package and GPL license are bundled and pinned', async () => {
  assert.equal(sw2nes.verifyPin().packageRelease, '1.0.1');
  const bundled = await sw2nes.readBundled(ROOT);
  assert.equal(bundled.package.id, 'sw2nes');
  assert.equal(bundled.package.scripts.length, 4);
  assert.equal(bundled.package.scripts[1].name, 'dist/runtime/quicknes.js');
  const license = await fs.readFile(path.join(ROOT, sw2nes.pin.bundledLicense), 'utf8');
  assert.match(license, /GNU GENERAL PUBLIC LICENSE/);
  const sourceRoot = path.join(ROOT, sw2nes.pin.bundledSource);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'LICENSE'), 'utf8'), license);
  assert.match(await fs.readFile(path.join(sourceRoot, 'native/bridge.cpp'), 'utf8'), /QuickNES/);
  assert.match(await fs.readFile(path.join(sourceRoot, 'tools/build.sh'), 'utf8'), /emcc/);
  assert.match(await fs.readFile(path.join(sourceRoot, 'third_party/QuickNES_Core/nes_emu/Nes_Emu.cpp'), 'utf8'), /Nes_Emu/);
});

test('tampered release bytes and symlinked package are rejected', async t => {
  const original = await fs.readFile(path.join(ROOT, sw2nes.pin.bundledPackage));
  const tampered = Buffer.from(original);
  tampered[100] ^= 1;
  assert.throws(() => sw2nes.inspectPackage(tampered), /checksum/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-sw2nes-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const packagePath = path.join(root, sw2nes.pin.bundledPackage);
  const licensePath = path.join(root, sw2nes.pin.bundledLicense);
  await fs.mkdir(path.dirname(packagePath), {recursive: true});
  await fs.symlink(path.join(ROOT, sw2nes.pin.bundledPackage), packagePath);
  await fs.copyFile(path.join(ROOT, sw2nes.pin.bundledLicense), licensePath);
  await assert.rejects(sw2nes.readBundled(root), /Unsafe bundled SW2NES file/);
});

test('install sends the verified package through the CivHomebrew companion once', async () => {
  const c = companion();
  const result = await sw2nes.install(ROOT, '127.0.0.1', c);
  assert.equal(result.entry.id, 'sw2nes');
  assert.deepEqual(c.calls.map(call => call.op), ['install']);
  assert.equal(c.calls[0].package.id, 'sw2nes');
  assert.equal(c.calls[0].package.metadata.release, '1.0.1');
});

test('busy launcher prevents install and missing app prevents launch', async () => {
  const busy = companion([], {busy: true});
  await assert.rejects(sw2nes.install(ROOT, '127.0.0.1', busy), /Return to the CivHomebrew launcher/);
  assert.equal(busy.calls.length, 0);
  const missing = companion();
  await assert.rejects(sw2nes.launch('127.0.0.1', missing), /Install SW2NES/);
  assert.equal(missing.calls.length, 0);
});

test('launch asks CivHomebrew to run an installed SW2NES app', async () => {
  const c = companion([{id: 'sw2nes', name: 'SW2NES'}]);
  await sw2nes.launch('127.0.0.1', c);
  assert.deepEqual(c.calls, [{op: 'run', id: 'sw2nes'}]);
});

test('offline self-test verifies the bundled package without a console', async () => {
  const events = [];
  await sw2nes.main(['--self-test', ROOT], {emit: (type, fields) => events.push({type, ...fields})});
  assert.equal(events[0].type, 'self-test');
  assert.equal(events[0].version, '1.0.1');
});
