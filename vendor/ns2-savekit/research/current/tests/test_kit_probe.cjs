#!/usr/bin/env node
// Offline tests for the kit's save detection. No console, no network, no deps.
//
//   node tests/test_kit_probe.cjs
//
// kit.cjs shells out to list-apps.cjs and save-pull-root.cjs. These tests put
// fake versions of both in a temporary tools/ tree and prove what the kit does
// with each answer. The important one is 'silent': the published
// save-pull-root.cjs treated every known flag as set, so a --list-only probe
// printed the account uids, exited 0 and listed nothing. The kit used to read
// that as "no save data for this title on any account (0x7d402)" - issue #2.
// A probe that does not list must be reported as a tool problem, not absence.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-probe-test-'));
const tools = path.join(tmp, 'tools');
fs.mkdirSync(path.join(tools, 'lib'), {recursive: true});
fs.mkdirSync(path.join(tmp, 'config'), {recursive: true});
fs.copyFileSync(path.join(ROOT, 'tools/kit.cjs'), path.join(tools, 'kit.cjs'));
fs.copyFileSync(path.join(ROOT, 'tools/lib/titles.cjs'), path.join(tools, 'lib/titles.cjs'));
// A fresh cache stops titles.refresh() from reaching the network.
fs.writeFileSync(path.join(tmp, 'config/titledb-cache.json'),
  JSON.stringify({'0100000000000001': 'Game A'}));

const APP = '0100000000000001';
const UID_A = '11111111111111111111111111111111';
const UID_B = '22222222222222222222222222222222';
const UID_C = '33333333333333333333333333333333';
const ZERO_LABEL = '0'.repeat(16);

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

fs.writeFileSync(path.join(tools, 'list-apps.cjs'), `
console.error('1 installed applications (BuiltInUser)');
console.log('0x${APP}');
`);

// The fake puller answers by KIT_MODE:
//   user2  - only user B has a User/Account save
//   device - no account saves; a shared User/Device archive exists
//   held   - user A's save is held by the running title (0xe02)
//   absent - 0x7d402 for every shape
//   silent - exits 0 with the uid list and no listing (the published bug)
fs.writeFileSync(path.join(tools, 'save-pull-root.cjs'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const mode = process.env.KIT_MODE || 'absent';
const uids = ['${UID_A}', '${UID_B}', '${UID_C}'];
if (args.includes('--list-uids')) {
  for (const uid of uids) console.log(uid);
  process.exit(0);
}
if (process.env.KIT_LOG) fs.appendFileSync(process.env.KIT_LOG, JSON.stringify(args) + '\\n');
if (mode === 'silent') {
  // What the old flag handling did: print the uids, write nothing, exit 0.
  for (const uid of uids) console.log(uid);
  process.exit(0);
}
const at = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const uid = args[3];
const space = at('--space');
const type = at('--type');
const absent = code => {
  console.log('  space=? type=? rank=0 index=0 uid=???????????????? -> ' + (code || '0x7d402'));
  console.error('FAILED: No save filesystem opened for 0x${APP} (tried 2 attribute combinations)');
  process.exit(1);
};
const mounted = (typeName, uidHex, files) => {
  console.error('mounted space=User type=' + typeName + ' rank=0 index=0 uid=' + uidHex);
  console.log('listed ' + files + ' files, 100 bytes (read-only, nothing written)');
  process.exit(0);
};
if (mode === 'user2' && uid === '${UID_B}' && space === '1' && type === '1')
  mounted('Account', '${UID_B.slice(0, 16)}', 3);
if (mode === 'device' && space === '1' && type === '3')
  mounted('Device', '${ZERO_LABEL}', 1);
if (mode === 'held' && uid === '${UID_A}' && space === '1' && type === '1')
  absent('0xe02');
absent();
`);

function kit(mode) {
  const log = path.join(tmp, 'probe-' + mode + '.log');
  try { fs.unlinkSync(log); } catch { /* first run */ }
  // Three answers: title, then a blank to leave the title menu, then a blank at
  // the title prompt. More than enough, so no ask is left waiting for EOF.
  const result = spawnSync(process.execPath, [path.join(tools, 'kit.cjs'), '/fake-run'],
    {encoding: 'utf8', input: '1\n\n\n', env: {...process.env, KIT_MODE: mode, KIT_LOG: log}});
  const probes = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  return {code: result.status, out: result.stdout, err: result.stderr, probes};
}

test('a save on the second user is found without sweeping', () => {
  const r = kit('user2');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /save found for user 2/);
  assert.match(r.out, new RegExp(UID_B.slice(0, 8)));
  assert.ok(r.probes.length > 0, 'the kit probed');
  for (const args of r.probes)
    assert.ok(args.includes('--space') && args.includes('--type'),
      'every probe narrows space/type: ' + args.join(' '));
  assert.ok(r.probes.length <= 6,
    'a found save must not trigger the shared scan or a sweep (probes: ' + r.probes.length + ')');
});

test('a probe that exits 0 without a listing is not "no save" (issue #2)', () => {
  const r = kit('silent');
  assert.strictEqual(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /no save data for this title/);
  assert.match(r.out, /exited without listing anything/);
  assert.match(r.out, /the save was not touched/);
});

test('0x7d402 everywhere is reported as an absent save', () => {
  const r = kit('absent');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /no save data for this title on any account \(0x7d402\)/);
  assert.match(r.out, /launch it, close it fully/);
});

test('a shared Device archive is still found (Sports Resort case)', () => {
  const r = kit('device');
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /save found: space=User type=Device/);
  assert.match(r.out, /a shared archive/);
  assert.match(r.out, /List files in this save/);
});

test('a held save (0xe02) is not reported as absent', () => {
  const r = kit('held');
  assert.strictEqual(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /no save data for this title/);
  assert.match(r.out, /0xe02/);
  assert.match(r.out, /running title holds its save/);
});

fs.rmSync(tmp, {recursive: true, force: true});
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
