#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {redact, validStart, verifiedResult} = require('./gui-host.cjs');
function command(address = '192.0.2.1') {
  // Values are generated for every test run; no historical pairing is stored.
  return 'V=START(' + [39380, ...address.split('.'), ...Array.from({length: 4}, () => crypto.randomInt(1, 1000000))].join(',') + ')';
}
function fixture(t, sender, host) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-gui-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.mkdirSync(path.join(root, 'vendor/ns2jb'), {recursive: true});
  fs.copyFileSync(path.join(__dirname, 'gui-host.cjs'), path.join(root, 'scripts/gui-host.cjs'));
  fs.writeFileSync(path.join(root, 'assets/bootstrap.bas'), 'PRINT 1\n');
  if (sender) fs.writeFileSync(path.join(root, 'mac2jb-send'), '#!' + process.execPath + '\n' + sender, {mode: 0o700});
  if (host) fs.writeFileSync(path.join(root, 'vendor/ns2jb/run.cjs'), host);
  return root;
}
function run(root, args) {
  const child = spawn(process.execPath, [path.join(root, 'scripts/gui-host.cjs'), ...args], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = '', error = '';
  child.stdout.on('data', bytes => {output += bytes;});
  child.stderr.on('data', bytes => {error += bytes;});
  const done = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', code => resolve({code, output, error, events: output.trim().split('\n').filter(Boolean).map(JSON.parse)}));
  });
  return {child, done};
}
test('pairing validation and redaction do not expose session values', () => {
  const value = command();
  assert.equal(validStart(value, '192.0.2.1'), true);
  assert.equal(validStart(value, '192.0.2.2'), false);
  assert.equal(validStart(value + 'garbage', '192.0.2.1'), false);
  assert.equal(redact('Sending: ' + value), 'Sending: V=START(<private session>)');
});
test('success requires independent FS verification, restoration and cleanup', () => {
  assert.equal(verifiedResult({verified: true}), false);
  assert.equal(verifiedResult({verified: true, fs: {verified: true, restored: true, cleanup: {cleanedUp: false}}}), false);
  assert.equal(verifiedResult({verified: true, fs: {verified: true, restored: true, cleanup: {cleanedUp: true}}}), true);
});
test('only pre-enumeration failures probe another controller', async t => {
  const root = fixture(t, `
    if (process.env.MAC2JB_CONTROLLER === 'usb-drd0') {
      console.error('USB host did not enumerate a keyboard'); process.exitCode = 1;
    } else {console.log('Keyboard enumerated. Sending...'); process.stdout.write('\\rSent line 1');}
  `);
  const result = await run(root, ['hid', 'bootstrap', 'auto']).done;
  assert.equal(result.code, 0, result.error);
  assert.deepEqual(result.events.filter(e => e.type === 'controller').map(e => e.controller), ['usb-drd0', 'usb-drd1']);
  assert.ok(result.events.some(e => e.type === 'progress' && e.completed === 1));
});
test('a partial transfer never probes another controller', async t => {
  const root = fixture(t, `console.log('Keyboard enumerated. Sending...'); console.error('Transfer stopped'); process.exitCode = 1;`);
  const result = await run(root, ['hid', 'bootstrap', 'auto']).done;
  assert.equal(result.code, 1);
  assert.equal(result.events.filter(e => e.type === 'controller').length, 1);
  assert.ok(result.events.some(e => e.type === 'failed' && e.partial === true));
});
test('typing evidence arriving during timeout shutdown prevents retry', {timeout: 10000}, async t => {
  const root = fixture(t, `
    process.on('SIGTERM', () => {console.log('Keyboard enumerated. Sending...'); process.exitCode = 1; clearInterval(timer);});
    console.log('Waiting for USB host enumeration...'); const timer = setInterval(() => {}, 1000);
  `);
  const result = await run(root, ['hid', 'bootstrap', 'auto']).done;
  assert.equal(result.code, 1);
  assert.equal(result.events.filter(e => e.type === 'controller').length, 1);
  assert.ok(result.events.some(e => e.partial === true));
});
test('host publishes private pairing, redacts output and accepts verified result', async t => {
  const pairing = command();
  const root = fixture(t, undefined, `
    const fs = require('fs'); const path = require('path'); process.umask(0o077);
    const directory = path.join(__dirname, 'runs', 'test-session'); fs.mkdirSync(directory, {recursive: true});
    console.log(${JSON.stringify('  ' + pairing)}); console.log('Run folder: ' + directory);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({verified:true,fs:{verified:true,restored:true,cleanup:{cleanedUp:true}}}));
    setTimeout(() => {}, 150);
  `);
  const result = await run(root, ['host', '192.0.2.1']).done;
  assert.equal(result.code, 0, result.error);
  assert.equal(result.output.includes(pairing), false);
  assert.ok(result.events.some(e => e.type === 'host-ready'));
  assert.ok(result.events.some(e => e.type === 'verified'));
  assert.equal(fs.existsSync(path.join(root, 'vendor/ns2jb/runs/mac2jb-active-connect.txt')), false);
  assert.equal(fs.statSync(path.join(root, 'vendor/ns2jb/runs')).mode & 0o777, 0o700);
});
test('host rejects a claimed success without restoration', async t => {
  const root = fixture(t, undefined, `
    const fs = require('fs'); const path = require('path'); process.umask(0o077);
    const directory = path.join(__dirname, 'runs', 'test-session'); fs.mkdirSync(directory, {recursive: true});
    console.log('Run folder: ' + directory);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({verified:true,fs:{verified:true,restored:false,cleanup:{cleanedUp:true}}}));
  `);
  const result = await run(root, ['host', '192.0.2.1']).done;
  assert.equal(result.code, 1);
  assert.equal(result.events.some(e => e.type === 'verified'), false);
});
test('cancellation stops the owned native worker', async t => {
  const root = fixture(t, `console.log('Keyboard enumerated. Sending...'); setInterval(() => {}, 1000);`);
  const {child, done} = run(root, ['hid', 'bootstrap', 'auto']);
  await new Promise(resolve => child.stdout.once('data', resolve));
  await new Promise(resolve => setTimeout(resolve, 100));
  child.kill('SIGTERM');
  const result = await done;
  assert.equal(result.code, 130);
  assert.ok(result.events.some(e => e.type === 'cancelled'));
});
