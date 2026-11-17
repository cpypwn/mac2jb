const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const {PORT, TIMEOUT_MS, qualifyLive} = require('./qualify-live.cjs');

function replies() {
  const calls = [];
  const execute = async ({host, port, source, timeoutMs}) => {
    calls.push({host, port, source, timeoutMs});
    const nonce = source.match(/local nonce="([0-9a-f]{16})"/)?.[1];
    assert.ok(nonce);
    if (source.includes('BAL_FS_READONLY_V1')) {
      return `-> BAL_FS_READONLY_V1\tok\t${nonce}\t16121856\t00000402\n`;
    }
    const phase = source.match(/local phase="(allocation|service)"/)?.[1];
    assert.ok(phase);
    const tail = phase === 'allocation' ? '0x1000\tfree-returned' : '00000153\tclosed';
    return `-> BAL_OWNED_V1\t${phase}\tok\t${nonce}\t${tail}\n`;
  };
  return {calls, execute};
}

test('read-only qualification uses port 9026 and never runs owned calls by default', async () => {
  const {calls, execute} = replies();
  const result = await qualifyLive({host: '10.0.0.189', execute,
    nonceBytes: () => Buffer.alloc(8, 1)});
  assert.equal(result.port, PORT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, '10.0.0.189');
  assert.equal(calls[0].port, 9026);
  assert.equal(calls[0].timeoutMs, TIMEOUT_MS);
  assert.match(calls[0].source, /mount-head/);
  assert.match(calls[0].source, /proxy-id/);
  assert.match(calls[0].source, /save:\/bal-fs-/);
  assert.equal(result.readonly.freeBytes, 16121856);
  assert.equal(result.allocation, undefined);
});

test('owned qualification follows identity and stops on a failed phase', async () => {
  const {calls, execute} = replies();
  let next = 0;
  const phases = [];
  const result = await qualifyLive({host: '10.0.0.189', includeOwned: true, execute,
    nonceBytes: () => Buffer.alloc(8, ++next), onPhase: name => phases.push(name)});
  assert.deepEqual(phases, ['read-only', 'allocation', 'service']);
  assert.equal(calls.length, 3);
  assert.equal(result.allocation.cleanup, 'free-returned');
  assert.equal(result.service.cleanup, 'closed');
  assert.match(calls[1].source, /pcall\(allocate,/);
  assert.match(calls[2].source, /pcall\(getService,/);

  const failedCalls = [];
  const failAfterRead = async request => {
    failedCalls.push(request);
    if (failedCalls.length === 2) throw new Error('native call timed out');
    return execute(request);
  };
  await assert.rejects(qualifyLive({host: '10.0.0.189', includeOwned: true,
    execute: failAfterRead, nonceBytes: () => Buffer.alloc(8, 7)}), /native call timed out/);
  assert.equal(failedCalls.length, 2);
});

test('allocation-only qualification does not open a service', async () => {
  const {calls, execute} = replies();
  const phases = [];
  const result = await qualifyLive({host: '10.0.0.189', includeAllocation: true, execute,
    nonceBytes: () => Buffer.alloc(8, 4), onPhase: name => phases.push(name)});
  assert.deepEqual(phases, ['read-only', 'allocation']);
  assert.equal(calls.length, 2);
  assert.equal(result.allocation.cleanup, 'free-returned');
  assert.equal(result.service, undefined);
});

test('service-only qualification does not allocate', async () => {
  const {calls, execute} = replies();
  const phases = [];
  const result = await qualifyLive({host: '10.0.0.189', includeService: true, execute,
    nonceBytes: () => Buffer.alloc(8, 5), onPhase: name => phases.push(name)});
  assert.deepEqual(phases, ['read-only', 'service']);
  assert.equal(calls.length, 2);
  assert.equal(result.allocation, undefined);
  assert.equal(result.service.cleanup, 'closed');
  assert.doesNotMatch(calls[1].source, /pcall\(allocate,/);
});

test('invalid identity reply prevents all owned calls', async () => {
  const calls = [];
  await assert.rejects(qualifyLive({host: '10.0.0.189', includeOwned: true,
    execute: async request => {
      calls.push(request);
      return '-> BAL_FS_READONLY_V1\tfail\t0202020202020202\tcode:memcpy\n';
    }, nonceBytes: () => Buffer.alloc(8, 2)}), /code:memcpy/);
  assert.equal(calls.length, 1);
});

test('invalid arguments fail before contacting a console', async () => {
  let contacted = false;
  const execute = async () => { contacted = true; return ''; };
  await assert.rejects(qualifyLive({host: 'not-an-ip', execute}), /IPv4/);
  await assert.rejects(qualifyLive({host: '10.0.0.189', execute,
    nonceBytes: () => Buffer.alloc(4)}), /eight bytes/);
  assert.equal(contacted, false);
  const cli = spawnSync(process.execPath,
    [path.join(__dirname, 'qualify-live.cjs'), '10.0.0.189', '--write'],
    {encoding: 'utf8'});
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /usage:/);
  const paused = spawnSync(process.execPath,
    [path.join(__dirname, 'qualify-live.cjs'), '10.0.0.189', '--allocation'],
    {encoding: 'utf8'});
  assert.equal(paused.status, 1);
  assert.match(paused.stderr, /block allocation is paused/);
});
