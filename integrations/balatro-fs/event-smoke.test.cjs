const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const {SDK_CRC32} = require('./qualify-native-crc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {makeSource, parseReply, runEventSmoke, EVENT_OFFSET} = require('./event-smoke.cjs');

const nonce = '0123456789abcdef';
const arenaBase = '0x4964000000';
const event = `0x${(BigInt(arenaBase) + BigInt(EVENT_OFFSET)).toString(16)}`;
const reply = `-> BAL_EVENT_SMOKE_V1\tevent-smoke\tok\t${nonce}\t${event}\t0\t1\tfinalized\n`;

test('owned event lifecycle source compiles and only touches an interior arena object', () => {
  const source = makeSource({nonce, arenaBase});
  assert.ok(Buffer.byteLength(source) < 32768);
  for (const name of ['InitializeLightEvent', 'FinalizeLightEvent',
    'TryWaitLightEvent', 'SignalLightEvent']) {
    assert.match(source, new RegExp(`base\\+${profile.symbols[`nn::os::${name}`].offset}`));
  }
  assert.match(source, /if b\.fs_worker_hold then return fail\('worker-retained'\) end/);
  assert.match(source, /eventMap\.type~=5 or eventMap\.perm~=3/);
  assert.match(source, /pcall\(finalize,ffi\.cast\('void\*',event\)\)/);
  assert.doesNotMatch(source.slice(source.indexOf('local held=b.fs_bridge')),
    /createFile|writeFile|commit\(|svcStartThread|fsp-srv/);
  const syntax = spawnSync('luajit', ['-e', `local f=assert(loadstring(io.read('*a')));io.write(f())`],
    {input: source, encoding: 'utf8'});
  if (syntax.error?.code !== 'ENOENT') {
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.equal(syntax.stdout,
      `BAL_EVENT_SMOKE_V1\tevent-smoke\tfail\t${nonce}\tidentity`);
  }
  assert.throws(() => makeSource({nonce, arenaBase: '0x4964000001'}), /invalid Balatro arena address/);
});

test('event proof requires matching owner, address, state transition and finalization', () => {
  const result = parseReply(reply, {nonce, arenaBase});
  assert.equal(result.event, event);
  assert.equal(result.cleanup, 'finalized');
  assert.match(result.status, /marker unverified/);
  assert.throws(() => parseReply(reply + reply, {nonce, arenaBase}), /duplicated/);
  assert.throws(() => parseReply(reply.replace(event, '0x4964000000'),
    {nonce, arenaBase}), /incomplete/);
  assert.throws(() => parseReply(reply.replace('\t0\t1\t', '\t1\t1\t'),
    {nonce, arenaBase}), /incomplete/);
  assert.throws(() => parseReply(reply.replace('finalized', 'retained'),
    {nonce, arenaBase}), /incomplete/);
  assert.throws(() => parseReply(
    `-> BAL_EVENT_SMOKE_V1\tevent-smoke\tfail\t${nonce}\tevent-map\n`,
    {nonce, arenaBase}), /failed: event-map/);
});

test('native event call follows full SDK CRC and same-arena recheck exactly once', async () => {
  const calls = [];
  const ready = {nonce, arenaBase, arenaBytes: 0x200000};
  const crc = {nonce, port: 39381, sdkBase: '0x5050000000',
    sdkCrc32: `0x${SDK_CRC32.toString(16)}`};
  const result = await runEventSmoke({host: '10.0.0.189', macIp: '10.0.0.205', nonce,
    preflight: async () => {calls.push('preflight'); return ready;},
    verifyCrc: async () => {calls.push('crc'); return crc;},
    execute: async () => {calls.push('event'); return reply;}});
  assert.equal(result.signaledWait, true);
  assert.deepEqual(calls, ['preflight', 'crc', 'preflight', 'event']);
  calls.length = 0;
  await assert.rejects(runEventSmoke({host: '10.0.0.189', macIp: '10.0.0.205', nonce,
    preflight: async () => {calls.push('preflight'); return ready;},
    verifyCrc: async () => {calls.push('crc'); return {...crc, sdkCrc32: '0x0'};},
    execute: async () => {calls.push('event'); return reply;}}), /CRC did not match/);
  assert.deepEqual(calls, ['preflight', 'crc']);
});
