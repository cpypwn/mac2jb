#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {redact, validStart, verifiedResult, hidSettings} = require('./gui-host.cjs');
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
  if (sender) for (const name of ['mac2jb-send', 'mac2jb-commands'])
    fs.writeFileSync(path.join(root, name), '#!' + process.execPath + '\n' + sender, {mode: 0o700});
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
test('timing defaults and independent range limits are validated', () => {
  assert.deepEqual(hidSettings([]), {delay: 50, enumerationTimeout: 4,
    loadWaitMs: 3000, runWaitMs: 3000, removeWaitMs: 3000, loadConfirmWaitMs: 1000});
  assert.equal(hidSettings(['2000', '--enumeration-timeout', '120', '--load-wait-ms', '0']).loadWaitMs, 0);
  for (const args of [['0'], ['2001'], ['50', '--enumeration-timeout', '0'],
    ['50', '--enumeration-timeout', '121'], ['50', '--run-wait-ms', '120001'],
    ['50', '--load-confirm-wait-ms', '-1']]) assert.throws(() => hidSettings(args));
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
test('selected enumeration window is counted down and bounded', {timeout: 5000}, async t => {
  const root = fixture(t, `
    console.log('Waiting for USB host enumeration...');
    process.on('SIGTERM', () => process.exit(1)); setInterval(() => {}, 1000);
  `);
  const started = performance.now();
  const result = await run(root, ['hid', 'bootstrap', 'usb-drd0', '60', '--enumeration-timeout', '1']).done;
  const elapsed = performance.now() - started;
  assert.equal(result.code, 1);
  assert.ok(elapsed >= 900 && elapsed < 2500, `Elapsed ${elapsed}ms`);
  const countdown = result.events.filter(e => e.type === 'enumeration-progress');
  assert.ok(countdown.length >= 2);
  assert.ok(countdown.every(e => e.total === 1000 && e.remainingMs >= 0 && e.completed <= 1000));
  assert.ok(countdown.at(-1).remainingMs <= 10);
});
test('post-command typing, waits and progress replace enumeration and preserve tuning', {timeout: 5000}, async t => {
  const root = fixture(t, `
    const fs = require('fs'); fs.writeFileSync('timing-args.json', JSON.stringify({args:process.argv.slice(2), timeout:process.env.MAC2JB_ENUMERATION_TIMEOUT_SECONDS}));
    const event = value => console.log('MAC2JB_GUI ' + JSON.stringify(value));
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    (async () => {
      await pause(150); event({type:'typing',completed:0,total:4});
      for (let step=1;step<=4;step++) {
        event({type:'command-start',step,completed:step-1,total:4,label:['LOAD','RUN','REMOVE','START'][step-1]});
        console.log('Sending: ' + ['LOAD','RUN','REMOVE','START'][step-1]); await pause(20);
        event({type:'command-complete',step,completed:step,total:4,label:['LOAD','RUN','REMOVE','START'][step-1]});
        if(step<4) {event({type:'wait',completed:step,total:4,label:'after command',remainingMs:25,durationMs:25});await pause(25);}
      }
      await pause(1100);
    })();
  `);
  const result = await run(root, ['hid', 'commands', 'usb-drd1', '77', '--enumeration-timeout', '1',
    '--load-confirm-wait-ms', '11', '--load-wait-ms', '22', '--run-wait-ms', '33', '--remove-wait-ms', '44']).done;
  assert.equal(result.code, 0, result.error);
  const forwarded = JSON.parse(fs.readFileSync(path.join(root, 'timing-args.json')));
  assert.equal(forwarded.timeout, '1');
  for (const [flag, value] of [['--delay-ms','77'], ['--enumeration-timeout','1'], ['--load-confirm-wait-ms','11'],
    ['--load-wait-ms','22'], ['--run-wait-ms','33'], ['--remove-wait-ms','44']])
    assert.equal(forwarded.args[forwarded.args.indexOf(flag)+1], value);
  const typing = result.events.findIndex(e => e.type === 'typing');
  assert.ok(typing >= 0);
  assert.equal(result.events.slice(typing+1).some(e => e.type === 'enumeration-progress'), false);
  assert.deepEqual(result.events.filter(e => e.type === 'command-complete').map(e => e.completed), [1,2,3,4]);
  assert.equal(result.events.filter(e => e.type === 'wait').length, 3);
  assert.ok(result.events.some(e => e.type === 'transfer-complete'));
});
test('a launch error clears even a long enumeration countdown immediately', {timeout: 2000}, async t => {
  const root = fixture(t);
  const result = await run(root, ['hid', 'bootstrap', 'usb-drd0', '50', '--enumeration-timeout', '120']).done;
  assert.equal(result.code, 1);
  assert.ok(result.events.some(e => e.type === 'failed' && /ENOENT/.test(e.message)));
});
