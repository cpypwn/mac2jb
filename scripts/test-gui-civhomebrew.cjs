'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bridge = require('./gui-civhomebrew.cjs');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-civhomebrew-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

async function fixture(t) {
  const root = temporary(t);
  const runtime = path.join(root, 'runtime');
  const original = path.join(root, 'original');
  await fsp.mkdir(path.join(runtime, 'packaging'), {recursive: true});
  await fsp.mkdir(path.join(runtime, 'homebrew/python/bin'), {recursive: true});
  await fsp.mkdir(original);
  await fsp.writeFile(path.join(original, 'payload_menu.py'), 'print("ready")\n');
  await fsp.writeFile(path.join(original, 'install_homebrew.py'), 'print("installed")\n');
  fs.symlinkSync(process.execPath, path.join(runtime, 'node'));
  fs.symlinkSync(process.execPath, path.join(runtime, 'homebrew/python/bin/python3'));
  const archive = Buffer.from('fixture archive');
  const tree = await bridge.sourceDigest(original);
  const metadata = {
    version: 'test', commit: 'a'.repeat(40), url: 'https://codeload.github.com/fixture/fixture/zip/' + 'a'.repeat(40),
    archiveSha256: crypto.createHash('sha256').update(archive).digest('hex'),
    treeSha256: tree.sha256, fileCount: tree.fileCount
  };
  return {runtime, original, archive, metadata, cacheRoot: path.join(root, 'cache')};
}

test('the packaged bridge self-test checks its pinned source and bundled runtimes offline', async t => {
  const f = await fixture(t);
  const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, '../packaging/CivHomebrew-source.json'), 'utf8'));
  await fsp.writeFile(path.join(f.runtime, 'packaging/CivHomebrew-source.json'), JSON.stringify(pinned));
  const events = [];
  const result = await bridge.main(['--self-test', f.runtime], {emit: (type, fields) => events.push({type, ...fields})});
  assert.equal(result.selfTest, true);
  assert.equal(events[0].type, 'self-test');
  await assert.rejects(bridge.main(['--self-test', path.join(f.runtime, 'missing')],
    {emit: () => {}}), /ENOENT/);
});

test('source cache verifies every file and preserves a changed cache instead of executing it', async t => {
  const f = await fixture(t);
  const options = {metadata: f.metadata, cacheRoot: f.cacheRoot, emit: () => {},
    fetchArchive: async () => f.archive,
    extractArchive: async (_runtime, _archive, destination) => {
      for (const name of ['payload_menu.py', 'install_homebrew.py']) {
        await fsp.copyFile(path.join(f.original, name), path.join(destination, name));
      }
    }};
  assert.equal((await bridge.sourceStatus(f.runtime, options)).available, false);
  const prepared = await bridge.prepareSource(f.runtime, options);
  assert.equal(prepared.cached, false);
  assert.equal((await bridge.prepareSource(f.runtime, options)).cached, true);
  await fsp.appendFile(path.join(prepared.path, 'payload_menu.py'), 'changed\n');
  await assert.rejects(bridge.prepareSource(f.runtime, options), /source cache changed/);
  assert.match(await fsp.readFile(path.join(prepared.path, 'payload_menu.py'), 'utf8'), /changed/);
});

test('a mismatched source archive is rejected before extraction', async t => {
  const f = await fixture(t);
  let extracted = false;
  await assert.rejects(bridge.prepareSource(f.runtime, {metadata: f.metadata, cacheRoot: f.cacheRoot,
    emit: () => {}, fetchArchive: async () => Buffer.from('different archive'),
    extractArchive: async () => {extracted = true;}}), /pinned SHA-256/);
  assert.equal(extracted, false);
});

async function companion(t, respond) {
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      if (pending.length < 4 || pending.length < pending.readUInt32BE(0) + 4) return;
      const request = JSON.parse(pending.subarray(4, pending.readUInt32BE(0) + 4).toString('utf8'));
      const body = Buffer.from(JSON.stringify(respond(request)));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      socket.end(Buffer.concat([length, body]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server.address().port;
}

test('companion probe verifies CivHomebrew identity and live status', async t => {
  const port = await companion(t, request => request.op === 'hello'
    ? {ok: true, app: 'CivHomebrew', protocol: 1, core: 1}
    : {ok: true, state: {mode: 'launcher', launcher: true, ftp: true, closed: false}});
  const result = await bridge.probeCompanion('127.0.0.1', {port, allowLoopback: true});
  assert.deepEqual(result, {mode: 'launcher', launcher: true, ftp: true, closed: false});
});

test('companion probe rejects an unrelated service on the same port', async t => {
  const port = await companion(t, () => ({ok: true, app: 'other', protocol: 1, core: 1}));
  await assert.rejects(bridge.probeCompanion('127.0.0.1', {port, allowLoopback: true}),
    /did not identify a compatible CivHomebrew core/);
});

test('Python subprocesses find the bundled Node before any system Node', () => {
  const root = '/tmp/mac2jb/runtime';
  const env = bridge.pythonEnvironment(root, {PATH: '/usr/bin', PYTHONHOME: '/tmp/other'});
  assert.equal(env.PATH.split(path.delimiter)[0], root);
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(bridge.validAddress('192.168.1.100'), true);
  assert.equal(bridge.validAddress('8.8.8.8'), false);
});
