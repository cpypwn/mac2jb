const assert = require('node:assert/strict');
const test = require('node:test');
const {checkArena} = require('./ffi-arena-live.cjs');

const nonce = '0123456789abcdef';

test('reserve uses one bounded request and validates the exact reply', async () => {
  const calls = [];
  const result = await checkArena({host: '10.0.0.189', phase: 'reserve', nonce,
    execute: async options => {
      calls.push(options);
      return `-> BAL_FFI_ARENA_V1\treserve\tok\t${nonce}\t0x4964000000\t2097152\tretained\n`;
    }});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].port, 9026);
  assert.equal(calls[0].timeoutMs, 30000);
  assert.ok(Buffer.byteLength(calls[0].source) < 32768);
  assert.equal(result.bytes, 2097152);
});

test('inspect rejects stale nonce and neither phase retries', async () => {
  let calls = 0;
  await assert.rejects(checkArena({host: '10.0.0.189', phase: 'inspect', nonce,
    execute: async () => {
      calls++;
      return '-> BAL_FFI_ARENA_V1\tinspect\tok\tffffffffffffffff\t0x4964000000\t2097152\tretained\n';
    }}), /phase and nonce/);
  assert.equal(calls, 1);
  await assert.rejects(checkArena({host: 'not-an-ip', phase: 'reserve', nonce,
    execute: async () => { calls++; }}), /IPv4/);
  assert.equal(calls, 1);
});
