const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const {makeSource, parseReply} = require('./probe-readonly.cjs');
const abi = require('./fs-write-abi.v1.0.1f.json');
const live = require('./live-readonly-map.v1.0.1f.json');

const nonce = '0123456789abcdef';

test('read-only probe pins identity, mappings, and Balatro file symbols', () => {
  const source = makeSource({nonce});
  assert.ok(Buffer.byteLength(source, 'utf8') <= 32768);
  assert.match(source, /info\.version=='1\.0\.1f-FULL'/);
  assert.match(source, /info\.sdk_base%4096~=0/);
  assert.match(source, /codeMap\.base~=base/);
  assert.ok(source.includes(`dataMap.base~=base+${Number(BigInt(live.mappings.sdkData.base)) - Number(BigInt(live.identity.sdkBase))}`));
  assert.match(source, /romMap\.base~=saveMap\.base/);
  assert.match(source, /mount-head/);
  assert.match(source, /proxy-id/);
  assert.ok(source.includes(`base+${abi.functions.freeSpace.offset}`));
  assert.ok(source.includes(`base+${abi.functions.entryType.offset}`));
  assert.match(source, /save:\/bal-fs-/);
  assert.match(source, /path-exists/);
  assert.match(source, /entry-guard/);
  assert.match(source, /free-guard/);
  assert.match(source, /target image: Balatro 1\.0\.1f/);
  assert.match(source, /native profile loaded/);
  assert.match(source, /1\/4 Checking the console/);
  assert.match(source, /lovera1n by cpypwn/);
  assert.ok(source.indexOf('lovera1n by cpypwn') <
    source.indexOf("pcall(showcase.fs_log,'1/4 Checking the console')"));
  assert.ok(source.indexOf("if tonumber(entryRc)==0 then") <
    source.indexOf("local showcase=package.loaded['bl.lovera1n_showcase']"));
  assert.doesNotMatch(source, /local (?:createFile|writeFile|commit|deleteFile|createThread)=/);
  assert.ok(source.indexOf('local checks={') < source.indexOf('local freeCall='));
  assert.ok(source.indexOf('local freeCall=') < source.indexOf('local entryCall='));
});

test('read-only probe compiles and rejects absent target before native calls', () => {
  const result = spawnSync('luajit', ['-e', 'local f=assert(loadstring(io.read("*a")));io.write(f())'],
    {input: makeSource({nonce}), encoding: 'utf8'});
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `BAL_FS_READONLY_V1\tfail\t${nonce}\tidentity`);
});

test('CLI emits the same offline Lua source without contacting a console', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'probe-readonly.cjs'), nonce],
    {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${makeSource({nonce})}\n`);
});

test('read-only reply requires a matching nonce, measured capacity, and absent path', () => {
  const reply = `-> BAL_FS_READONLY_V1\tok\t${nonce}\t16121856\t00000402\n`;
  assert.deepEqual(parseReply(reply, {nonce}), {
    gameProfile: 'balatro-physical-base-v1.0.1f', nonce,
    freeBytes: 16121856, absentPathResult: '0x00000402',
    status: 'read-only; no save transaction tested',
  });
  assert.throws(() => parseReply(reply + reply, {nonce}), /duplicated/);
  assert.throws(() => parseReply(reply.replace(nonce, 'ffffffffffffffff'), {nonce}), /does not match/);
  assert.throws(() => parseReply(reply.replace('16121856', '0'), {nonce}), /invalid values/);
  assert.throws(() => parseReply(reply.replace('00000402', '00000000'), {nonce}), /invalid values/);
  assert.throws(() => parseReply(reply.replace('00000402', 'nope'), {nonce}), /incomplete/);
  assert.throws(() => parseReply(`-> BAL_FS_READONLY_V1\tfail\t${nonce}\tpath-exists\n`, {nonce}),
    /path-exists/);
  assert.throws(() => makeSource({nonce: 'not-hex'}), /nonce must be/);
});
