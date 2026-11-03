'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('pinned upstream browser scripts pass intact and reject altered files', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-webkit-check-'));
  t.after(() => fs.rmSync(temporary, {recursive: true, force: true}));
  for (const folder of ['scripts', 'packaging', 'vendor'])
    fs.mkdirSync(path.join(temporary, folder), {recursive: true});
  fs.copyFileSync(path.join(root, 'scripts/check-webkit-research.cjs'),
    path.join(temporary, 'scripts/check-webkit-research.cjs'));
  fs.copyFileSync(path.join(root, 'packaging/switch2-browser-research-provenance.json'),
    path.join(temporary, 'packaging/switch2-browser-research-provenance.json'));
  fs.cpSync(path.join(root, 'vendor/switch2-captive-portal-research'),
    path.join(temporary, 'vendor/switch2-captive-portal-research'), {recursive: true});
  const run = () => spawnSync(process.execPath,
    [path.join(temporary, 'scripts/check-webkit-research.cjs')], {encoding: 'utf8'});
  assert.equal(run().status, 0);
  const changed = path.join(temporary, 'vendor/switch2-captive-portal-research',
    'switch2-probes-webkit.js');
  fs.appendFileSync(changed, '\nmodified\n');
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /file changed: switch2-probes-webkit\.js/);
});
