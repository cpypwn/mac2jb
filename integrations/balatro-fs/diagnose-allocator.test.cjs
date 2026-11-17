const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const {makeSource, parseReply, diagnose} = require('./diagnose-allocator.cjs');

const nonce = '0123456789abcdef';

test('allocator diagnostic rechecks pinned profile and calls no allocator', () => {
  const source = makeSource({nonce});
  assert.ok(Buffer.byteLength(source) <= 32768);
  assert.match(source, /info\.version=='1\.0\.1f-FULL'/);
  assert.match(source, /return fail\('code-map'\)/);
  assert.match(source, /return fail\('data-map'\)/);
  assert.match(source, /return fail\('proxy-id'\)/);
  assert.match(source, /local manager=tonumber\(ffi\.cast/);
  assert.match(source, /local region,why=mapping\(manager\)/);
  assert.match(source, /manager\+0x3f8<=region\.base\+region\.size/);
  assert.match(source, /manager\+0x3e8/);
  assert.match(source, /manager\+0x3f0/);
  assert.doesNotMatch(source, /pcall\(allocate|pcall\(release|pcall\(getService/);
  assert.doesNotMatch(source, /local allocate=|local release=|local getService=/);
  const compiled = spawnSync('luajit',
    ['-e', 'local f=assert(loadstring(io.read("*a")));io.write(f())'],
    {input: source, encoding: 'utf8'});
  if (compiled.error?.code !== 'ENOENT') {
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.equal(compiled.stdout, `BAL_OWNED_V1\tallocator-map\tfail\t${nonce}\tidentity`);
  }
});

test('parser reports map type instead of requiring heap type five', () => {
  const reply = `-> BAL_OWNED_V1\tallocator-map\tok\t${nonce}\t0x196260e018\t0x196260e000\t0xab000\t4\t3\t1\t0x4964000000\t0x600000\n`;
  assert.deepEqual(parseReply(reply, {nonce}), {
    manager: '0x196260e018',
    region: {base: '0x196260e000', size: '0xab000', type: 4, permissions: 3},
    managerHeaderFits: true,
    blockRange: {base: '0x4964000000', size: '0x600000'},
    expectedTypeWasFive: false,
    allocated: false,
  });
  assert.throws(() => parseReply(reply + reply, {nonce}), /duplicated/);
  assert.throws(() => parseReply(reply.replace(nonce, 'ffffffffffffffff'), {nonce}), /nonce/);
  assert.throws(() => parseReply(reply.replace('\t4\t3\t1', '\t4\t3\t0'), {nonce}), /inconsistent/);
  assert.throws(() => parseReply(reply.replace('0xab000', '0x0'), {nonce}), /inconsistent/);
  assert.throws(() => parseReply(reply.replace('0x600000', '0x0'), {nonce}), /inconsistent/);
  assert.throws(() => parseReply(`-> BAL_OWNED_V1\tallocator-map\tfail\t${nonce}\tquery-rc\n`,
    {nonce}), /query-rc/);
});

test('diagnostic uses only the existing port 9026 REPL', async () => {
  const calls = [];
  const result = await diagnose({host: '10.0.0.189',
    nonceBytes: () => Buffer.alloc(8, 2), execute: async request => {
      calls.push(request);
      return '-> BAL_OWNED_V1\tallocator-map\tok\t0202020202020202\t0x196260e018\t0x196260e000\t0xab000\t5\t3\t1\t0x4964000000\t0x600000\n';
    }});
  assert.equal(calls.length, 1);
  assert.deepEqual({host: calls[0].host, port: calls[0].port, timeoutMs: calls[0].timeoutMs},
    {host: '10.0.0.189', port: 9026, timeoutMs: 15000});
  assert.equal(result.expectedTypeWasFive, true);
  await assert.rejects(diagnose({host: 'invalid', execute: () => {
    throw new Error('should not connect');
  }}), /IPv4/);
  const invalid = spawnSync(process.execPath,
    [path.join(__dirname, 'diagnose-allocator.cjs'), 'not-an-ip', '--extra'],
    {encoding: 'utf8'});
  assert.equal(invalid.status, 2);
});
