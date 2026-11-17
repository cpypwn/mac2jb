const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const abi = require('./fs-write-abi.v1.0.1f.json');
const control = require('./marker-content-control.cjs');

const nonce = '0123456789abcdef';
const absentResult = '0x00000202';

function preflight(result = absentResult) {
  return {readonly: {gameProfile: profile.gameProfile, absentPathResult: result},
    service: {cleanup: 'closed'}};
}

test('owned Balatro content is exactly sixteen bytes and tied to the path nonce', () => {
  assert.equal(control.content(nonce).length, 16);
  assert.equal(control.content(nonce).subarray(0, 8).toString(), 'BALFSv01');
  assert.equal(control.content(nonce).subarray(8).toString('hex'), nonce);
  assert.notDeepEqual(control.content(nonce), control.content('fedcba9876543210'));
  assert.throws(() => control.content('bad'), /nonce/);
});

test('content control writes sixteen bytes, commits, reads exact bytes, then deletes', () => {
  const source = control.makeSource({nonce, absentResult});
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /local expected=514|local missing=514/);
  assert.match(source, /call\(create,marker,16\)/);
  assert.match(source, /pcall\(open,ffi\.cast\('uint64_t\*',out\)\+1,marker,2\)/);
  assert.match(source, /pcall\(writeFile,h,0,data,16,opts\)/);
  assert.match(source, /pcall\(flush,h\)/);
  assert.match(source, /call\(commit,mount\)/);
  assert.match(source, /pcall\(open,ffi\.cast\('uint64_t\*',out\)\+1,marker,1\)/);
  assert.match(source, /pcall\(getSize,ffi\.cast\('uint64_t\*',size\)\+1,h\)/);
  assert.match(source, /pcall\(readFile,h,0,read,16\)/);
  assert.match(source, /ffi\.string\(read,16\)==wanted/);
  assert.match(source, /local clean=cleanup\(\)/);
  for (const name of control.SYMBOLS) {
    assert.match(source, new RegExp('base\\+' + abi.functions[name].offset));
  }
  assert.doesNotMatch(source, /0x233f|0x243f|CreateThread|canary|race-window/i);
  const compile = spawnSync('/opt/homebrew/bin/luajit', ['-b', '-', '/dev/null'],
    {input: source, encoding: 'utf8'});
  if (!compile.error || compile.error.code !== 'ENOENT') {
    assert.equal(compile.status, 0, compile.stderr);
  }
});

test('preflight failure sends no content operation', async () => {
  let sends = 0;
  await assert.rejects(control.runMarkerContentControl({host: '10.0.0.189',
    nonceBytes: () => Buffer.from(nonce, 'hex'),
    qualify: async () => ({...preflight(), service: {cleanup: 'open'}}),
    execute: async () => { sends++; }}), /did not verify/);
  assert.equal(sends, 0);
});

test('one bounded content request accepts only exact verification and cleanup', async () => {
  const phases = [];
  const result = await control.runMarkerContentControl({host: '10.0.0.189',
    nonceBytes: () => Buffer.from(nonce, 'hex'),
    qualify: async ({includeService}) => {
      assert.equal(includeService, true);
      phases.push('preflight');
      return preflight();
    },
    execute: async ({port, timeoutMs, source}) => {
      phases.push('content');
      assert.equal(port, 9026);
      assert.equal(timeoutMs, 30000);
      assert.match(source, /save:\/bal-marker-0123456789abcdef\.bin/);
      return `-> ${control.TAG}|ok|${nonce}|exact-content-controls|verified\n`;
    }});
  assert.deepEqual(phases, ['preflight', 'content']);
  assert.equal(result.markerContentVerified, true);
  assert.equal(result.absentPathVerified, true);
  assert.equal(result.cleanup, 'verified');
  assert.equal(result.markerWaveAttempted, false);
});

test('failure and nonce mismatch do not claim content success', () => {
  assert.throws(() => control.parseReply(
    `-> ${control.TAG}|fail|${nonce}|content-mismatch|verified\n`, {nonce}),
  /content-mismatch; cleanup verified/);
  assert.throws(() => control.parseReply(
    `-> ${control.TAG}|ok|${nonce}|exact-content-controls|retained\n`, {nonce}),
  /incomplete/);
  assert.throws(() => control.parseReply(
    `-> ${control.TAG}|ok|ffffffffffffffff|exact-content-controls|verified\n`, {nonce}),
  /does not match/);
  assert.throws(() => control.parseReply('', {nonce}), /missing or duplicated/);
});
