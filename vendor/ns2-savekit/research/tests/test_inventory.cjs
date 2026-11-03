#!/usr/bin/env node
// Offline tests for tools/inventory.cjs. No console, no network, no deps.
//
//   node tests/test_inventory.cjs
//
// The tool shells out to list-apps.cjs and save-pull-root.cjs. These tests put
// fake versions of both in a temporary tools/ tree, so they prove the reporting
// paths - which half failed, the child's own stderr, the patch and stale-folder
// hints, and the explicit-uid escape hatch - without a held run.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-test-'));
const tools = path.join(tmp, 'tools');
fs.mkdirSync(path.join(tools, 'lib'), {recursive: true});
fs.mkdirSync(path.join(tmp, 'config'), {recursive: true});
fs.copyFileSync(path.join(ROOT, 'tools/inventory.cjs'), path.join(tools, 'inventory.cjs'));
fs.copyFileSync(path.join(ROOT, 'tools/lib/titles.cjs'), path.join(tools, 'lib/titles.cjs'));
// A fresh cache stops titles.refresh() from reaching the network.
fs.writeFileSync(path.join(tmp, 'config/titledb-cache.json'),
  JSON.stringify({'0100000000000001': 'Game A', '0100000000000002': 'Game B'}));

let passes = 0, failures = 0;
function test(name, fn) {
  try {
    fn();
    passes++;
    console.log('ok    ' + name);
  } catch (error) {
    failures++;
    console.log('FAIL  ' + name + '\n      ' + String(error.message).split('\n').join('\n      '));
  }
}

function child(name, source) { fs.writeFileSync(path.join(tools, name), source); }
function inventory(args = []) {
  const result = spawnSync(process.execPath,
    [path.join(tools, 'inventory.cjs'), '/fake-run', ...args], {encoding: 'utf8'});
  return {code: result.status, out: result.stdout, err: result.stderr};
}

const LIST_OK = `
console.log('0x0100000000000001');
console.log('0x0100000000000002');
`;
const UIDS_OK = `
const args = process.argv.slice(2);
if (args.includes('--list-uids')) {
  console.log('11111111111111111111111111111111');
  console.log('22222222222222222222222222222222');
} else if (args[1] === '0100000000000001') {
  console.log('listed 3 files, 2097152 bytes');
} else {
  console.log('listed 0 files, 0 bytes');
}
`;

test('successful enumeration still prints the table', () => {
  child('list-apps.cjs', LIST_OK);
  child('save-pull-root.cjs', UIDS_OK);
  const r = inventory();
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /Game A\s+1\s+3/);
  assert.match(r.out, /4 save archives/);
});

test('unnamed titles get a paste-ready local stub', () => {
  child('list-apps.cjs', `console.log('0x0100000000000003');`);
  child('save-pull-root.cjs', UIDS_OK);
  const r = inventory();
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /1 of 1 titles has no name/);
  assert.match(r.out, /config\/titles\.local\.json/);
  assert.match(r.out, /"names":\{"0100000000000003":"<name>"\}/);
});

test('a failed app listing names the half and forwards stderr', () => {
  child('list-apps.cjs', `console.error("FAILED: EEXIST: file already exists, open '/x/switch2-AAAA-ncm-system-programs.bin'");
process.exit(1);`);
  const r = inventory();
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.out, '');
  assert.match(r.err, /could not list installed applications \(exit 1\)/);
  assert.match(r.err, /EEXIST: file already exists/);
  assert.match(r.err, /engine is unpatched/);
  assert.doesNotMatch(r.err, /could not list accounts/);
});

test('a failed account listing names the half and suggests a uid', () => {
  child('list-apps.cjs', LIST_OK);
  child('save-pull-root.cjs',
    `console.error('account enumeration failed: ListAllUsers: transport 0xf601');`);
  const r = inventory();
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /could not list accounts/);
  assert.match(r.err, /ListAllUsers: transport 0xf601/);
  assert.match(r.err, /pointer-descriptor/);
  assert.match(r.err, /pass one explicitly/);
});

test('an explicit uid skips account enumeration', () => {
  child('list-apps.cjs', LIST_OK);
  child('save-pull-root.cjs', `const args = process.argv.slice(2);
if (args.includes('--list-uids')) { console.error('SHOULD NOT RUN'); process.exit(99); }
console.log(args[1] === '0100000000000001' ? 'listed 3 files, 2097152 bytes' : 'listed 0 files, 0 bytes');`);
  const r = inventory(['33333333333333333333333333333333']);
  assert.strictEqual(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /SHOULD NOT RUN/);
  assert.match(r.out, /Game A\s+1\s+3/);
});

test('a stale folder is reported as such, not as a dead console', () => {
  child('list-apps.cjs', `console.error('FAILED: connect ECONNREFUSED 127.0.0.1:1234'); process.exit(1);`);
  const r = inventory();
  assert.match(r.err, /no live host/);
});

test('an empty account reply says so instead of printing nothing', () => {
  child('list-apps.cjs', LIST_OK);
  child('save-pull-root.cjs', '');
  const r = inventory();
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /could not list accounts/);
  assert.match(r.err, /\(no output\)/);
});

fs.rmSync(tmp, {recursive: true, force: true});
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
