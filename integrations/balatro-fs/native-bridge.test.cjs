const assert = require('node:assert/strict');
const test = require('node:test');
const {spawnSync} = require('node:child_process');
const {MARKER, makeStageSource, parseStageReply, makeReserveSource,
  parseReserveReply, stageNativeBridge} = require('./native-bridge.cjs');

const context = {host: '10.0.0.189', macIp: '10.0.0.205',
  nonce: 'd3b7e24c1a09f563', port: 39381};

test('native bridge source is pinned, bounded, and rejects the Gravity listener', () => {
  const source = makeStageSource(context);
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /local phase="native-bridge"/);
  assert.match(source, /1\.0\.1f-FULL/);
  assert.match(source, /6160384/);
  assert.throws(() => makeStageSource({...context, port: 39380}), /own transport port/);
  assert.throws(() => makeStageSource({...context, macIp: 'invalid'}));
  assert.equal(MARKER, 'BAL_NATIVE_V1');
});

test('bridge and app arena replies require matching status, nonce, and size', () => {
  assert.deepEqual(parseStageReply(
    `-> BAL_NATIVE_V1\tready\t39381\t${context.nonce}\n`, context),
  {status: 'ready', port: 39381, nonce: context.nonce});
  for (const reply of [
    `-> BAL_NATIVE_V1\tready\t39381\twrong\n`,
    `-> BAL_NATIVE_V1\tready\t39380\t${context.nonce}\n`,
    `-> BAL_NATIVE_V1\tready\t39381\t${context.nonce}\n-> BAL_NATIVE_V1\tready\t39381\t${context.nonce}\n`,
  ]) assert.throws(() => parseStageReply(reply, context));
  assert.throws(() => parseStageReply(
    `-> BAL_NATIVE_V1\tnative-bridge\tfail\t${context.nonce}\tidentity\n`,
    context), /identity/);
  const source = makeReserveSource({...context, bytes: 0x80000});
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.throws(() => makeReserveSource({...context, bytes: 0x2400000}),
    /explicitly approved/);
  assert.deepEqual(parseReserveReply('-> BAL_APP_ARENA_V1\t0x4a20000000\t524288\n',
    0x80000), {base: '0x4a20000000', bytes: 0x80000});
  assert.throws(() => parseReserveReply('-> BAL_APP_ARENA_V1\t0x4a20000000\t36\n',
    0x80000));
});

test('stage runner qualifies the worker before opening a native listener', async () => {
  const stages = [];
  const result = await stageNativeBridge({...context,
    worker: async args => {
      assert.equal(args.nonce, context.nonce);
      stages.push('worker');
      return {nonce: context.nonce, arenaBase: '0x4a144f8000',
        tickFrequency: 19200000, cleanup: 'released'};
    },
    execute: async ({source, port}) => {
      assert.equal(port, 9026);
      if (source.includes('local phase="transport-probe"')) {
        stages.push('transport');
        return '-> BAL_TRANSPORT_V1\tlistening\t39381\n';
      }
      assert.match(source, /local phase="native-bridge"/);
      stages.push('native');
      return `-> BAL_NATIVE_V1\tready\t39381\t${context.nonce}\n`;
    }});
  assert.deepEqual(stages, ['worker', 'transport', 'native']);
  assert.match(result.status, /marker untested/);
});

test('failed native stage closes only the owned transport', async () => {
  const stages = [];
  await assert.rejects(stageNativeBridge({...context,
    worker: async () => ({nonce: context.nonce, arenaBase: '0x4a144f8000',
      tickFrequency: 19200000, cleanup: 'released'}),
    execute: async ({source}) => {
      if (source.includes('BL.fs_transport=nil')) {
        stages.push('close');
        return '-> BAL_TRANSPORT_V1\tclosed\t39381\n';
      }
      if (source.includes('local phase="transport-probe"')) {
        stages.push('transport');
        return '-> BAL_TRANSPORT_V1\tlistening\t39381\n';
      }
      stages.push('native');
      return `-> BAL_NATIVE_V1\tnative-bridge\tfail\t${context.nonce}\tidentity\n`;
    }}), /identity/);
  assert.deepEqual(stages, ['transport', 'native', 'close']);
});

test('LuaJIT bridge handles partial frames and rejects unpinned calls', t => {
  const result = spawnSync('luajit', ['integrations/balatro-fs/native-bridge.test.lua'],
    {encoding: 'utf8', timeout: 15000});
  if (result.error?.code === 'ENOENT') return t.skip('LuaJIT unavailable');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /protocol and guard checks passed/);
});
