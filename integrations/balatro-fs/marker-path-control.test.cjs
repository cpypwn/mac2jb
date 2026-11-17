const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const abi = require('./fs-write-abi.v1.0.1f.json');
const control = require('./marker-path-control.cjs');

const nonce = '0123456789abcdef';
const absentResult = '0x00000202';

function preflight(result = absentResult) {
  return {readonly: {gameProfile: profile.gameProfile, absentPathResult: result},
    service: {cleanup: 'closed'}};
}

test('Balatro direct marker paths are equal length and use pinned target calls', () => {
  const {marker, absent} = control.paths(nonce);
  assert.equal(Buffer.byteLength(marker), Buffer.byteLength(absent));
  assert.equal(marker, 'save:/bal-marker-0123456789abcdef.bin');
  assert.equal(absent, 'save:/bal-absent-0123456789abcdef.bin');
  const source = control.makeSource({nonce, absentResult});
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /local expected=514/);
  assert.match(source, /created=true\nif not call\(create,marker,16\) then return fail\('create'\)/);
  assert.match(source, /present~=0 or tp~=1/);
  assert.match(source, /rc~=0 or tp~=1/);
  assert.match(source, /local clean=cleanup\(\)/);
  for (const name of ['entryType', 'createFile', 'commit', 'deleteFile']) {
    assert.match(source, new RegExp('base\\+' + abi.functions[name].offset));
  }
  assert.doesNotMatch(source, /marker-boundary|0x233f|0x243f|CreateThread|sleep|canary/i);
  const compile = spawnSync('/opt/homebrew/bin/luajit', ['-b', '-', '/dev/null'],
    {input: source, encoding: 'utf8'});
  if (!compile.error || compile.error.code !== 'ENOENT') {
    assert.equal(compile.status, 0, compile.stderr);
  }
});

test('recovery checks the exact nonce path and marker bytes before deletion', () => {
  const source = control.makeCleanupSource({nonce, absentResult});
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /save:\/bal-marker-0123456789abcdef\.bin/);
  assert.match(source, /save:\/bal-absent-0123456789abcdef\.bin/);
  assert.match(source, /tonumber\(size\[1\]\)==#wanted/);
  assert.match(source, /ffi\.string\(bytes,16\)==wanted/);
  assert.match(source, /marker-content','retained'/);
  assert.match(source, /if mr~=0 then return reply\('fail','marker-entry','retained'\)/);
  assert.match(source, /pcall\(remove,marker\)/);
  assert.match(source, /pcall\(commit,mount\)/);
  for (const name of ['entryType', 'openFile', 'getFileSize', 'readFile', 'closeFile',
    'deleteFile', 'commit']) {
    assert.match(source, new RegExp('base\\+' + abi.functions[name].offset));
  }
  assert.doesNotMatch(source, /marker-boundary|0x233f|0x243f|CreateThread|canary/i);
  const compile = spawnSync('/opt/homebrew/bin/luajit', ['-b', '-', '/dev/null'],
    {input: source, encoding: 'utf8'});
  if (!compile.error || compile.error.code !== 'ENOENT') {
    assert.equal(compile.status, 0, compile.stderr);
  }
});

test('read-only inspection reports exact path Result, type, open Result and size', async () => {
  const source = control.makeInspectSource({nonce});
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /save:\/bal-marker-0123456789abcdef\.bin/);
  assert.match(source, /save:\/bal-absent-0123456789abcdef\.bin/);
  assert.doesNotMatch(source, /pcall\(remove|pcall\(commit|pcall\(create/);
  const compile = spawnSync('/opt/homebrew/bin/luajit', ['-b', '-', '/dev/null'],
    {input: source, encoding: 'utf8'});
  if (!compile.error || compile.error.code !== 'ENOENT') {
    assert.equal(compile.status, 0, compile.stderr);
  }
  let sends = 0;
  const result = await control.runMarkerPathInspect({host: '10.0.0.189', nonce,
    execute: async ({port, source: sent}) => {
      sends++;
      assert.equal(port, 9026);
      assert.equal(sent, source);
      return `-> ${control.INSPECT_MARKER}|ok|${nonce}|00000000,1,00000000,16,00000202\n`;
    }});
  assert.equal(sends, 1);
  assert.deepEqual({entryResult: result.entryResult, fileType: result.fileType,
    openResult: result.openResult, fileSize: result.fileSize,
    absentResult: result.absentResult},
  {entryResult: '0x00000000', fileType: 1, openResult: '0x00000000',
    fileSize: 16, absentResult: '0x00000202'});
});

test('direct marker control stops before writing when Balatro preflight differs', async () => {
  let sent = 0;
  await assert.rejects(control.runMarkerPathControl({host: '10.0.0.189',
    nonceBytes: () => Buffer.from(nonce, 'hex'),
    qualify: async () => ({...preflight(), service: {cleanup: 'open'}}),
    execute: async () => { sent++; }}), /did not verify/);
  assert.equal(sent, 0);
});

test('direct marker control sends one bounded request and accepts verified cleanup', async () => {
  const phases = [];
  const result = await control.runMarkerPathControl({host: '10.0.0.189',
    nonceBytes: () => Buffer.from(nonce, 'hex'),
    qualify: async ({includeService}) => {
      assert.equal(includeService, true);
      phases.push('preflight');
      return preflight();
    },
    execute: async ({port, timeoutMs, source}) => {
      phases.push('direct-path');
      assert.equal(port, 9026);
      assert.equal(timeoutMs, 30000);
      assert.match(source, /save:\/bal-marker-0123456789abcdef\.bin/);
      return `-> ${control.MARKER}|ok|${nonce}|direct-path-controls|verified\n`;
    }});
  assert.deepEqual(phases, ['preflight', 'direct-path']);
  assert.equal(result.markerPathVerified, true);
  assert.equal(result.absentPathVerified, true);
  assert.equal(result.cleanup, 'verified');
  assert.equal(result.markerWaveAttempted, false);
});

test('failed or incomplete reply never claims a verified marker path', async () => {
  const context = {nonce};
  assert.throws(() => control.parseReply(
    `-> ${control.MARKER}|fail|${nonce}|absent-path|verified\n`, context),
  /failed: absent-path; cleanup verified/);
  assert.throws(() => control.parseReply(
    `-> ${control.MARKER}|ok|${nonce}|direct-path-controls|retained\n`, context),
  /incomplete/);
  assert.throws(() => control.parseReply(
    `-> ${control.MARKER}|ok|ffffffffffffffff|direct-path-controls|verified\n`, context),
  /does not match/);
  assert.throws(() => control.parseReply('', context), /missing or duplicated/);
  assert.throws(() => control.makeSource({nonce: 'bad', absentResult}), /nonce/);
});

test('recovery sends one bounded request after qualification and accepts only verified cleanup', async () => {
  let sends = 0;
  const result = await control.runMarkerPathCleanup({host: '10.0.0.189', nonce,
    qualify: async ({includeService}) => {
      assert.equal(includeService, true);
      return preflight();
    },
    execute: async ({port, timeoutMs, source}) => {
      sends++;
      assert.equal(port, 9026);
      assert.equal(timeoutMs, 30000);
      assert.match(source, /local nonce="0123456789abcdef"/);
      return `-> ${control.CLEANUP_MARKER}|ok|${nonce}|removed-owned-marker|verified\n`;
    }});
  assert.equal(sends, 1);
  assert.equal(result.status, 'removed-owned-marker');
  assert.equal(result.cleanup, 'verified');
  assert.throws(() => control.parseCleanupReply(
    `-> ${control.CLEANUP_MARKER}|fail|${nonce}|marker-size|retained\n`, {nonce}),
  /marker-size; cleanup retained/);
  assert.throws(() => control.parseCleanupReply(
    `-> ${control.CLEANUP_MARKER}|ok|${nonce}|removed-owned-marker|retained\n`, {nonce}),
  /incomplete/);
});
