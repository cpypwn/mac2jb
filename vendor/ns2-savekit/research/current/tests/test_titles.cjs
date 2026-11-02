#!/usr/bin/env node
// Offline tests for tools/lib/titles.cjs. No network, no console.
//
//   node tests/test_titles.cjs
//
// Each case gets its own tree and its own node process: titles.cjs caches the
// merged map and the local overrides for the life of the process, so cases
// cannot share one. `global.fetch` is stubbed to fail, which is the offline
// first-run case.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'titles-test-'));

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

function probe(ids, config, {offline = false} = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
  fs.mkdirSync(path.join(dir, 'tools/lib'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'config'), {recursive: true});
  fs.copyFileSync(path.join(ROOT, 'tools/lib/titles.cjs'), path.join(dir, 'tools/lib/titles.cjs'));
  for (const [file, value] of Object.entries(config)) {
    fs.writeFileSync(path.join(dir, 'config', file), JSON.stringify(value));
  }
  const script = `
    ${offline ? 'global.fetch = async () => { throw new Error("offline"); };' : ''}
    const t = require(${JSON.stringify(path.join(dir, 'tools/lib/titles.cjs'))});
    (async () => {
      const refreshed = await t.refresh();
      const out = {refreshed, available: t.available(), names: {}};
      for (const id of ${JSON.stringify(ids)}) out.names[id] = t.name(id);
      out.slug = t.slug(${JSON.stringify(ids[0])});
      out.hasDeviceName = t.hasDeviceName(${JSON.stringify(ids[0])});
      out.unnamed = t.unnamed(${JSON.stringify(ids)});
      out.stub = JSON.parse(t.namesStub(${JSON.stringify(ids)}));
      console.log(JSON.stringify(out));
    })();
  `;
  const result = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8'});
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('the fetched cache names titles', () => {
  const id = '01000000000000bb';
  const r = probe([id], {'titledb-cache.json': {[id]: 'Fetched'}});
  assert.strictEqual(r.refreshed, true);       // fresh cache: no network
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.names[id], 'Fetched');
  assert.deepStrictEqual(r.unnamed, []);
});

test('config/titles.json names work with no cache and no network', () => {
  const id = '01000000000000aa';
  const r = probe([id], {'titles.json': {names: {[id]: 'Curated'}}}, {offline: true});
  assert.strictEqual(r.refreshed, false);
  assert.strictEqual(r.names[id], 'Curated');
  assert.deepStrictEqual(r.unnamed, []);
});

test('config/titles.local.json overrides the cache', () => {
  const id = '01000000000000cc';
  const r = probe([id], {
    'titledb-cache.json': {[id]: 'Fetched'},
    'titles.local.json': {names: {[id]: 'Mine'}},
  });
  assert.strictEqual(r.names[id], 'Mine');
});

test('a name read from the console beats titledb and is reused', () => {
  const id = '01001234567890ab';
  const r = probe([id], {
    'titledb-cache.json': {[id]: 'Switch 1 catalogue entry'},
    'titles.nacp.json': {[id]: 'Welcome Tour'},
  });
  assert.strictEqual(r.names[id], 'Welcome Tour');
  assert.deepStrictEqual(r.unnamed, []);
});

test('the console cache is found whatever prefix the caller uses', () => {
  const id = '01001234567890ae';
  const r = probe(['0x' + id], {'titles.nacp.json': {[id]: 'Welcome Tour'}});
  assert.strictEqual(r.names['0x' + id], 'Welcome Tour');
  assert.strictEqual(r.hasDeviceName, true);
});

test('a curated local name still beats the console name', () => {
  const id = '01001234567890ac';
  const r = probe([id], {
    'titles.nacp.json': {[id]: 'Console Name'},
    'titles.local.json': {names: {[id]: 'My Name'}},
  });
  assert.strictEqual(r.names[id], 'My Name');
});

test('a console name is written once and only when it changes', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'cache-'));
  fs.mkdirSync(path.join(dir, 'tools/lib'), {recursive: true});
  fs.mkdirSync(path.join(dir, 'config'), {recursive: true});
  fs.copyFileSync(path.join(ROOT, 'tools/lib/titles.cjs'), path.join(dir, 'tools/lib/titles.cjs'));
  const cache = path.join(dir, 'config/titles.nacp.json');
  const script = `
    const fs = require('node:fs');
    const t = require(${JSON.stringify(path.join(dir, 'tools/lib/titles.cjs'))});
    const first = t.rememberDeviceNames({'01001234567890ad': 'Yoshi'});
    const again = t.rememberDeviceNames({'01001234567890AD': 'Yoshi'});
    const changed = t.rememberDeviceNames({'01001234567890ad': 'Yoshi 2'});
    console.log(JSON.stringify({first, again, changed, name: t.name('01001234567890ad'),
      file: fs.readFileSync(${JSON.stringify(cache)}, 'utf8')}));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8'});
  assert.strictEqual(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.first, true);
  assert.strictEqual(out.again, false);
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.name, 'Yoshi 2');
  // The cache is plain id -> name, the shape the next process reads back.
  assert.deepStrictEqual(JSON.parse(out.file), {'01001234567890ad': 'Yoshi 2'});
});

test('a name that is not latinate enough falls back to the id for its folder', () => {
  const id = '0100c9100b06a000';
  const r = probe([id], {'titles.nacp.json': {[id]: '\u30d7\u30c1\u30b3\u30f34'}});
  assert.strictEqual(r.names[id], '\u30d7\u30c1\u30b3\u30f34');
  assert.strictEqual(r.slug, id);
});

test('an unknown id is reported with a paste-ready stub', () => {
  const id = '01000000000000dd';
  const r = probe([id], {'titledb-cache.json': {}});
  assert.strictEqual(r.names[id], null);
  assert.deepStrictEqual(r.unnamed, [id]);
  assert.deepStrictEqual(r.stub, {names: {[id]: '<name>'}});
});

test('no cache and no network leaves the id unknown', () => {
  const id = '01000000000000ee';
  const r = probe([id], {}, {offline: true});
  assert.strictEqual(r.refreshed, false);
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.names[id], null);
  assert.deepStrictEqual(r.unnamed, [id]);
});

fs.rmSync(tmp, {recursive: true, force: true});
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
