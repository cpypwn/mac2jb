'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {PROFILES, PROFILE_FIELDS, PROFILE_PROBE, parseStatus, parseProfile,
  runCompatibilityCheck} = require('./fs-host.cjs');
const {stage, verifiedRun} = require('./runtime-host.cjs');

function profileReply(game, changes = {}) {
  const profile = {...PROFILES[game], ...changes};
  const values = ['mac2jb-profile', game, 'Ounce', '2468000', '50000000',
    'function', 'function', 'function', 'function', 'function', 'function', 'function',
    ...PROFILE_FIELDS.map(field => profile[field].toString(16))];
  return 'status: ok\noutput:\n' + values.join('\t') + '\n';
}

test('accepts current Seedsow and Nora v2 HTTP status banners', () => {
  assert.equal(parseStatus('n2h HTTP server (seedsow)\nPOST /eval\n'), 'seedsow');
  assert.equal(parseStatus('n2h HTTP server (nora2)\r\n'), 'nora2');
  assert.throws(() => parseStatus('n2h HTTP server (hamidashi)\n'), /not running a supported/);
});

test('checks each game against its own Lua runtime offsets', () => {
  assert.equal(parseProfile(profileReply('seedsow'), 'seedsow').game, 'seedsow');
  assert.throws(() => parseProfile(profileReply('seedsow'), 'nora2'), /different games/);
  assert.throws(() => parseProfile(profileReply('seedsow', {socket_socket: 0xc18e0}), 'seedsow'),
    /socket_socket differs/);
  assert.throws(() => parseProfile('status: error\nresult: fault\n', 'seedsow'), /probe failed/);
});

test('the Lua probe only reads runtime metadata', () => {
  assert.match(PROFILE_PROBE, /rawget\(_G,"n2h"\)/);
  assert.doesNotMatch(PROFILE_PROBE, /N\.(?:call_deep|poke|write_bytes|alloc)\s*\(/);
});

test('HTTP compatibility check makes only GET status and POST eval requests', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', part => {body += part;});
    req.on('end', () => {
      requests.push({method: req.method, url: req.url, body});
      res.setHeader('Content-Type', 'text/plain');
      res.end(req.url === '/status' ? 'n2h HTTP server (seedsow)\n' : profileReply('seedsow'));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const events = [];
    const result = await runCompatibilityCheck({consoleIp: '127.0.0.1', macIp: '127.0.0.1',
      runtimeRoot: '/tmp/mac2jb-test', port: server.address().port,
      emit: value => events.push(value)});
    assert.equal(result.game, 'seedsow');
    assert.deepEqual(requests.map(value => [value.method, value.url]),
      [['GET', '/status'], ['POST', '/eval']]);
    assert.equal(requests[1].body, PROFILE_PROBE);
    assert.deepEqual(events.map(value => value.type), ['preparing', 'probe-ready']);
    assert.equal(events[1].fsVerified, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('HTTP mismatch fails before any bridge or FS host is started', async () => {
  const server = http.createServer((_req, res) => res.end('n2h HTTP server (hamidashi)\n'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const events = [];
    await assert.rejects(() => runCompatibilityCheck({consoleIp: '127.0.0.1', macIp: '127.0.0.1',
      runtimeRoot: '/tmp/mac2jb-test', port: server.address().port,
      emit: value => events.push(value)}), /not running a supported/);
    assert.equal(events.at(-1).type, 'failed');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('stages a distinct Seedsow host with checked code and SaveKit overlays', async t => {
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'm2art-'));
  t.after(() => fs.rm(temp, {recursive:true, force:true}));
  const staged = await stage(temp);
  assert.match(staged.root, /\/runs\/artemis-fs-[a-f0-9]{16}$/);
  assert.equal(JSON.parse(await fs.readFile(path.join(staged.port,
    'engine/shared/target.artemis-seedsow.json'))).name, 'artemis-seedsow');
  const marker = JSON.parse(await fs.readFile(path.join(staged.port,'.mac2jb-artemis-fs.json')));
  assert.equal(marker.target, 'artemis-seedsow');
  assert.match(marker.sourceSha256, /^[a-f0-9]{64}$/);
  const run = path.join(staged.port,'engine/runs/switch2-abc123');
  await fs.mkdir(run,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(run,'result.json'),
    JSON.stringify({target:'artemis-seedsow',sourceSha256:marker.sourceSha256}),{mode:0o600});
  const prepared = await require('../../scripts/prepare-artemis-fs.cjs').verifyPreparedRun(null,run);
  assert.equal(prepared.profile.id, 'artemis-seedsow');
  await fs.writeFile(path.join(run,'connection.json'),
    JSON.stringify({port:39380,addresses:{target:'artemis-seedsow'}}),{mode:0o600});
  await assert.rejects(() => verifiedRun(staged.port,run),
    /did not produce verified held RPC and filesystem proof/);
  await fs.writeFile(path.join(staged.port,'engine/run.cjs'),'changed',{mode:0o600});
  await assert.rejects(() => require('../../scripts/prepare-artemis-fs.cjs').verifyPreparedRun(null,run),
    /staged Artemis source changed/);
});
