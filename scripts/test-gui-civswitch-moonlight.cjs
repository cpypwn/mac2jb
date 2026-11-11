'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {Readable} = require('node:stream');
const test = require('node:test');
const moonlight = require('./gui-civswitch-moonlight.cjs');

function fixture() {
  const item = {format: 'civswitch-app', version: 1, id: 'moonlight-civswitch', name: 'Moonlight',
    metadata: {release: '0.1.3', api: 1}, scripts: [{name: 'app.js', source: 'log("Moonlight")'}], icon: ''};
  const bytes = Buffer.from(JSON.stringify(item) + '\n');
  const pin = {...moonlight.source, assetSize: bytes.length,
    assetSha256: crypto.createHash('sha256').update(bytes).digest('hex')};
  const fetcher = async () => ({ok: true, url: pin.asset, body: Readable.from([bytes])});
  return {item, bytes, pin, fetcher};
}

async function runtime(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-moonlight-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

async function companion(t, reply) {
  const calls = [];
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 4) return;
      const size = pending.readUInt32BE(0);
      if (pending.length < size + 4) return;
      const request = JSON.parse(pending.subarray(4, size + 4).toString('utf8'));
      calls.push(request);
      const result = Buffer.from(JSON.stringify(reply(request)));
      const frame = Buffer.alloc(result.length + 4);
      frame.writeUInt32BE(result.length, 0);
      result.copy(frame, 4);
      socket.end(frame);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return {port: server.address().port, calls};
}

function standardReply(request, overrides = {}) {
  if (request.op === 'hello') return {ok: true, app: 'CivHomebrew', protocol: 1, packageVersion: 1, core: 1};
  if (request.op === 'status') return {ok: true, state: {mode: 'launcher', busy: false, closed: false,
    ...overrides.state}};
  if (request.op === 'list') return {ok: true, entries: overrides.entries || []};
  if (request.op === 'install') return {ok: true, entry: {id: 'moonlight-civswitch', name: 'Moonlight'}};
  if (request.op === 'run') return {ok: true, state: 'accepted', name: 'Moonlight'};
  return {ok: false, error: 'Unexpected operation'};
}

test('release pin and package identity are fixed', () => {
  assert.equal(moonlight.verifyPin().packageRelease, '0.1.3');
  const {bytes, pin} = fixture();
  assert.equal(moonlight.inspectPackage(bytes, pin).id, 'moonlight-civswitch');
  assert.throws(() => moonlight.inspectPackage(Buffer.from('wrong'), pin), /size/);
  const wrong = {...pin, assetSha256: '0'.repeat(64)};
  assert.throws(() => moonlight.inspectPackage(bytes, wrong), /checksum/);
  const renamed = Buffer.from(JSON.stringify({...fixture().item, name: 'Unexpected'}) + '\n');
  const renamedPin = {...pin, assetSize: renamed.length,
    assetSha256: crypto.createHash('sha256').update(renamed).digest('hex')};
  assert.throws(() => moonlight.inspectPackage(renamed, renamedPin), /metadata/);
});

test('prepare downloads only on request and reuses verified cache', async t => {
  const root = await runtime(t);
  const anotherRuntime = await runtime(t);
  const cacheRoot = await runtime(t);
  const {bytes, pin, fetcher} = fixture();
  let requests = 0;
  const first = await moonlight.prepare(root, {pin, cacheRoot, fetcher: async (...args) => {
    requests++;
    return fetcher(...args);
  }});
  assert.equal(first.downloaded, true);
  assert.deepEqual(await fs.readFile(first.file), bytes);
  const second = await moonlight.prepare(anotherRuntime,
    {pin, cacheRoot, fetcher: () => {throw Error('Unexpected download');}});
  assert.equal(second.downloaded, false);
  assert.equal(second.file, first.file);
  assert.equal(requests, 1);
});

test('tampered cache is never replaced or sent', async t => {
  const root = await runtime(t);
  const cacheRoot = await runtime(t);
  const {pin} = fixture();
  const file = await moonlight.cachePath(root, {cacheRoot});
  await fs.writeFile(file, 'tampered');
  await assert.rejects(moonlight.prepare(root,
    {pin, cacheRoot, fetcher: () => {throw Error('Unexpected download');}}), /size/);
  assert.equal(await fs.readFile(file, 'utf8'), 'tampered');
});

test('symlinked cache root is rejected', async t => {
  const root = await runtime(t);
  const target = await runtime(t);
  const cacheRoot = path.join(root, 'link');
  await fs.symlink(target, cacheRoot);
  await assert.rejects(moonlight.cachePath(root, {cacheRoot}), /Unsafe Moonlight cache root/);
});

test('install uses framed CivHomebrew companion and requires its confirmation', async t => {
  const root = await runtime(t);
  const cacheRoot = await runtime(t);
  const {pin, fetcher} = fixture();
  const server = await companion(t, standardReply);
  const events = [];
  await moonlight.main(['install', root, '127.0.0.1'],
    {pin, cacheRoot, fetcher, port: server.port, allowLoopback: true,
      emit: (type, fields) => events.push({type, ...fields})});
  assert.deepEqual(server.calls.map(call => call.op), ['hello', 'status', 'list', 'install']);
  assert.equal(server.calls[3].protocol, 1);
  assert.equal(server.calls[3].package.id, 'moonlight-civswitch');
  assert.equal(events.at(-1).type, 'installed');
});

test('busy CivHomebrew rejects install before downloading', async t => {
  const root = await runtime(t);
  const {pin} = fixture();
  const server = await companion(t, request => standardReply(request, {state: {busy: true}}));
  await assert.rejects(moonlight.install(root, '127.0.0.1', {pin, port: server.port,
    allowLoopback: true, fetcher: () => {throw Error('Unexpected download');}}), /Close the current/);
  assert.equal(server.calls.some(call => call.op === 'install'), false);
});

test('unknown companion rejects install before downloading', async t => {
  const root = await runtime(t);
  const {pin} = fixture();
  const server = await companion(t, request => request.op === 'hello'
    ? {ok: true, app: 'Other', protocol: 1, packageVersion: 1} : standardReply(request));
  await assert.rejects(moonlight.install(root, '127.0.0.1', {pin, port: server.port,
    allowLoopback: true, fetcher: () => {throw Error('Unexpected download');}}), /not a compatible/);
  assert.deepEqual(server.calls.map(call => call.op), ['hello']);
});

test('companion rejection stops without an install retry', async t => {
  const root = await runtime(t);
  const cacheRoot = await runtime(t);
  const {pin, fetcher} = fixture();
  const server = await companion(t, request => request.op === 'install'
    ? {ok: false, error: 'Install failed'} : standardReply(request));
  await assert.rejects(moonlight.install(root, '127.0.0.1',
    {pin, cacheRoot, fetcher, port: server.port, allowLoopback: true}), /Install failed/);
  assert.equal(server.calls.filter(call => call.op === 'install').length, 1);
});

test('launch only opens an installed Moonlight app from the idle launcher', async t => {
  const root = await runtime(t);
  const {pin} = fixture();
  const server = await companion(t, request => standardReply(request,
    {entries: [{id: 'moonlight-civswitch', name: 'Moonlight'}]}));
  const events = [];
  await moonlight.main(['launch', root, '127.0.0.1'],
    {pin, port: server.port, allowLoopback: true, emit: (type, fields) => events.push({type, ...fields})});
  assert.deepEqual(server.calls.map(call => call.op), ['hello', 'status', 'list', 'run']);
  assert.deepEqual(server.calls[3], {protocol: 1, op: 'run', id: 'moonlight-civswitch'});
  assert.equal(events.at(-1).type, 'launched');
});

test('self-test validates offline runtime files without network', async t => {
  const root = await runtime(t);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.mkdir(path.join(root, 'packaging'));
  await fs.writeFile(path.join(root, 'scripts/gui-civswitch-moonlight.cjs'), 'x');
  await fs.writeFile(path.join(root, 'packaging/Moonlight-CivSwitch-source.json'), 'x');
  const events = [];
  await moonlight.main(['--self-test', root], {emit: (type, fields) => events.push({type, ...fields})});
  assert.equal(events[0].type, 'self-test');
});
