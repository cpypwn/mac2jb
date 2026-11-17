const test = require('node:test');
const assert = require('node:assert/strict');
const gravity = require('./gravcirc-fs/lovera1n.cjs');
const {
  USAGE, BALATRO_SDK_BASE, parseArgs, identitySource, parseIdentityReply,
  balatroBannerSource, run,
} = require('./lovera1n.cjs');

const switchIp = '10.0.0.199';
const nonceBytes = Buffer.from('0123456789abcdef', 'hex');
const nonce = nonceBytes.toString('hex');
const reply = game => `-> LOVERA1N_ID_V1\t${nonce}\t${game}\n`;

test('one CLI accepts either game without a game-selection argument', () => {
  assert.deepEqual(parseArgs([]), {canary: false, switchIp: null});
  assert.deepEqual(parseArgs(['--canary', switchIp]), {canary: true, switchIp});
  assert.deepEqual(parseArgs(['--help']), {help: true});
  assert.match(USAGE, /integrations\/lovera1n\.cjs/);
  assert.throws(() => parseArgs(['--unknown']), /usage:/);
  assert.throws(() => parseArgs([switchIp, switchIp]), /usage:/);
  assert.throws(() => parseArgs(['127.0.0.1']), /unicast/);
});

test('identity probe checks pinned profiles without writes or native calls', () => {
  const source = identitySource(nonce);
  assert.match(source, /g\.game_id=="gravity-circuit"/);
  assert.match(source, /g\.nx_info\.profile=="gravity-circuit-v1\.2\.1"/);
  assert.match(source, /b\.info\.version=="1\.0\.1f-FULL"/);
  assert.match(source, new RegExp(`b\\.info\\.sdk_base==${BALATRO_SDK_BASE}`));
  assert.doesNotMatch(source, /ffi|write|save|commit|malloc|thread|race/i);
  assert.throws(() => identitySource('bad'), /nonce/);
});

test('identity reply requires one exact nonce-bound game marker', () => {
  assert.equal(parseIdentityReply(reply('gravity-circuit'), nonce), 'gravity-circuit');
  assert.equal(parseIdentityReply(reply('balatro'), nonce), 'balatro');
  assert.throws(() => parseIdentityReply(reply('balatro').repeat(2), nonce), /duplicated/);
  assert.throws(() => parseIdentityReply(reply('balatro'), 'ffffffffffffffff'), /invalid/);
  assert.throws(() => parseIdentityReply(reply('other'), nonce), /invalid/);
  assert.throws(() => parseIdentityReply('error: broken', nonce), /missing/);
});

test('Gravity Circuit path delegates to the existing guarded canary runner', async () => {
  const calls = [];
  const result = await run(['--canary', switchIp], {
    nonceBytes: () => nonceBytes,
    executeLua: async request => {calls.push(['identity', request]); return reply('gravity-circuit');},
    runGravity: async (args, dependencies) => {
      calls.push(['gravity', args]);
      assert.equal(typeof dependencies.executeLua, 'function');
      return {status: 'guarded-canary'};
    },
    output: {write: () => {throw Error('wrapper must not duplicate Gravity output');}},
  });
  assert.deepEqual(result, {status: 'guarded-canary'});
  assert.deepEqual(calls.map(call => call[0]), ['identity', 'gravity']);
  assert.deepEqual(calls[1][1], ['--canary', switchIp]);
  assert.equal(calls[0][1].port, 9026);
});

test('Balatro prints the same banner and stops before FS qualification', async () => {
  const events = [];
  await assert.rejects(run([switchIp], {
    nonceBytes: () => nonceBytes,
    executeLua: async request => {
      if (request.source.includes('LOVERA1N_ID_V1')) {
        events.push('identity'); return reply('balatro');
      }
      events.push('banner');
      assert.match(request.source, /require\("bl\.log"\)/);
      assert.match(request.source, /lovera1n by cpypwn/);
      return '-> LOVERA1N_BANNER_OK\n';
    },
    qualifyBalatro: async () => {throw Error('FS qualification must not run');},
    runGravity: () => {throw Error('Gravity runner must not run');},
    output: {write: text => events.push(['output', text])},
  }), /Balatro full FS execution is not verified yet.*no native FS escalation was sent/);
  assert.deepEqual(events.filter(event => typeof event === 'string'), ['identity', 'banner']);
  assert.ok(events.some(event => Array.isArray(event) &&
    event[1] === `${gravity.TERMINAL_BANNER}\n`));
});

test('unknown target and missing banner stop before any FS work', async () => {
  let qualified = false;
  const base = {
    nonceBytes: () => nonceBytes,
    qualifyBalatro: async () => {qualified = true;},
    output: {write: () => {}},
  };
  await assert.rejects(run([switchIp], {...base,
    executeLua: async () => reply('unsupported'),
  }), /No supported/);
  assert.equal(qualified, false);
  await assert.rejects(run([switchIp], {...base,
    executeLua: async request => request.source.includes('LOVERA1N_ID_V1') ?
      reply('balatro') : '-> wrong\n',
  }), /did not confirm/);
  assert.equal(qualified, false);
});

test('Balatro console banner preserves the Gravity banner and pins the runtime', () => {
  const source = balatroBannerSource();
  assert.ok(source.includes(JSON.stringify(gravity.CONSOLE_BANNER)));
  assert.match(source, /b\.info\.version=="1\.0\.1f-FULL"/);
  assert.match(source, /native profile loaded/);
  assert.doesNotMatch(source, /ffi|fs\.write|save:|commit|thread|race/i);
});
