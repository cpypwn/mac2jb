const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const {makeSource, parseReply, runPreflight} = require('./canary-preflight.cjs');

const nonce = '0123456789abcdef';
const arenaBase = '0x4964000000';
const goodReply = `-> BAL_CANARY_PREFLIGHT_V1\tcanary-preflight\tok\t${nonce}\t${arenaBase}\t2097152\t19200000\t4800000\t250000\tready\n`;

test('pinned Balatro 1.0.1f preflight compiles and contains no FS or worker action', () => {
  const source = makeSource({nonce, arenaBase});
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /info\.version=='1\.0\.1f-FULL'/);
  assert.match(source, /held\.owner~=nonce or held\.stage~='ready'/);
  assert.match(source, /local getTick=love\.ffi\.declare\('uint64_t'/);
  assert.match(source, /not guard\(\) or/);
  const action = source.slice(source.indexOf('local held=b.fs_bridge'));
  assert.doesNotMatch(action, /createThread|createFile|writeFile|commit\(|svcStartThread/);
  const syntax = spawnSync('luajit', ['-e', `local f=assert(loadstring(io.read('*a')));io.write(f())`],
    {input: source, encoding: 'utf8'});
  if (syntax.error?.code !== 'ENOENT') {
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(syntax.stdout,
      `BAL_CANARY_PREFLIGHT_V1\tcanary-preflight\tfail\t${nonce}\tidentity`);
  }
  assert.throws(() => makeSource({nonce: 'bad', arenaBase}), /nonce/);
  assert.throws(() => makeSource({nonce, arenaBase: '0x4964000001'}), /out of range/);
});

test('preflight accepts bounded native tick measurement and rejects stale evidence', () => {
  const result = parseReply(goodReply, {nonce, arenaBase});
  assert.equal(result.sdkHz, 19200000);
  assert.equal(result.measuredHz, 19200000);
  assert.match(result.status, /marker unverified/);
  assert.throws(() => parseReply(goodReply + goodReply, {nonce, arenaBase}), /duplicated/);
  assert.throws(() => parseReply(goodReply.replace(nonce, 'ffffffffffffffff'),
    {nonce, arenaBase}), /does not match/);
  assert.throws(() => parseReply(goodReply.replace('250000', '10000'),
    {nonce, arenaBase}), /measurement did not verify/);
  assert.throws(() => parseReply(goodReply.replace('ready', 'stale'),
    {nonce, arenaBase}), /incomplete/);
  assert.throws(() => parseReply(
    `-> BAL_CANARY_PREFLIGHT_V1\tcanary-preflight\tfail\t${nonce}\tarena-guard\n`,
    {nonce, arenaBase}), /failed: arena-guard/);
  assert.throws(() => parseReply(goodReply, {nonce: 'bad', arenaBase}), /invalid.*context/);
  assert.throws(() => parseReply(goodReply, {nonce, arenaBase: 'bad'}), /invalid.*context/);
});

test('one inspected arena and one timing request; no retries on failure', async () => {
  const calls = [];
  const result = await runPreflight({host: '10.0.0.189', nonce,
    inspect: async request => {
      calls.push({kind: 'inspect', request});
      return {base: arenaBase, bytes: 2097152};
    },
    execute: async request => {
      calls.push({kind: 'timing', request});
      return goodReply;
    }});
  assert.equal(result.arenaBase, arenaBase);
  assert.deepEqual(calls.map(call => call.kind), ['inspect', 'timing']);
  assert.equal(calls[1].request.port, 9026);
  assert.equal(calls[1].request.timeoutMs, 15000);
  let attempted = 0;
  await assert.rejects(runPreflight({host: '10.0.0.189', nonce,
    inspect: async () => {attempted++; throw Error('arena guard failed');},
    execute: async () => {attempted++; return goodReply;}}), /arena guard failed/);
  assert.equal(attempted, 1);
  await assert.rejects(runPreflight({host: 'not-an-ip', nonce,
    inspect: async () => {attempted++;}, execute: async () => {attempted++;}}), /IPv4/);
  assert.equal(attempted, 1);
  await assert.rejects(runPreflight({host: '10.0.0.189', nonce,
    inspect: async () => ({base: arenaBase, bytes: 1024}),
    execute: async () => {attempted++; return goodReply;}}), /unexpected size/);
  assert.equal(attempted, 1);
});
