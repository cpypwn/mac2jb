'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

test('driver verification accepts the tested copy and rejects tampering, extra files and links', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-driver-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(repo, 'scripts/install-driver.sh'), path.join(root, 'scripts/install-driver.sh'));
  fs.cpSync(path.join(repo, 'drivers'), path.join(root, 'drivers'), {recursive: true});
  const verify = () => spawnSync('/bin/bash', [path.join(root, 'scripts/install-driver.sh'), '--verify'], {encoding: 'utf8'});
  assert.equal(verify().status, 0);
  const binary = path.join(root, 'drivers/usbgadget.kext/Contents/MacOS/usbgadget');
  const original = fs.readFileSync(binary);
  fs.appendFileSync(binary, 'tampered');
  assert.notEqual(verify().status, 0);
  fs.writeFileSync(binary, original);
  const extra = path.join(root, 'drivers/usbgadget.kext/Contents/extra');
  fs.writeFileSync(extra, 'unexpected signing metadata');
  assert.notEqual(verify().status, 0);
  fs.unlinkSync(extra);
  fs.symlinkSync(binary, extra);
  assert.notEqual(verify().status, 0);
});
