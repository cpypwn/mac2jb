'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');

test('composite gamepad and keyboard HID descriptors match the pinned CivSwitch reports', () => {
  const upstream = fs.readFileSync(path.join(root, 'vendor/CivSwitch/PicoSwitch/include/SwitchConsts.h'), 'utf8');
  const helper = fs.readFileSync(path.join(root, 'civswitch-hid.c'), 'utf8');
  const descriptor = (source, name) => {
    const match = source.match(new RegExp(`(?:static const uint8_t )${name}\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    assert.ok(match, `missing ${name}`);
    const clean = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    return Buffer.from([...clean.matchAll(/0x[0-9a-fA-F]+|\b\d+\b/g)].map(value => Number(value[0])));
  };
  assert.deepEqual(descriptor(helper, 'gamepad_report_descriptor'),
    descriptor(upstream, 'switch_usb_report_descriptor'));
  assert.deepEqual(descriptor(helper, 'keyboard_report_descriptor'),
    descriptor(upstream, 'keyboard_usb_report_descriptor'));
});

test('CivSwitch composite HID helper validates the pinned macro without opening USB', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-civswitch-hid-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const executable = path.join(folder, 'mac2jb-civswitch-hid');
  execFileSync('xcrun', ['clang', '-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O2',
    '-Wall', '-Wextra', '-Werror', '-target', 'arm64-apple-macos14.0',
    '-I' + path.join(root, 'vendor/libusbd/include'), path.join(root, 'civswitch-hid.c'),
    '-L' + path.join(root, 'vendor/libusbd'), '-lusbd',
    '-Wl,-rpath,' + path.join(root, 'vendor/libusbd'),
    '-framework', 'CoreFoundation', '-framework', 'IOKit', '-o', executable]);
  const dryRun = (file) => spawnSync(executable, ['--payload', file, '--controller', 'auto', '--dry-run'],
    {encoding: 'utf8', env: {...process.env, MAC2JB_CONTROLLER: 'auto'}});
  const actual = dryRun(path.join(root, 'integrations/civswitch/payload.txt'));
  assert.equal(actual.status, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout.slice('MAC2JB_CIVSWITCH '.length)),
    {type: 'dry-run', total: 87, characters: 21675, estimatedMs: 1299100});

  const invalid = path.join(folder, 'invalid.txt');
  for (const sample of ['a\n\n', 'a'.repeat(255) + '\n', 'caf\u00e9\n']) {
    fs.writeFileSync(invalid, sample);
    const result = dryRun(invalid);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /"type":"failed"/);
  }
});
