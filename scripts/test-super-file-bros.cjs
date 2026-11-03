'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {verifySource, verifiedRun, readOnlySD} = require('../integrations/super-file-bros/read-only-export.cjs');
const {createPanel, checkedPath} = require('../integrations/super-file-bros/read-only-panel.cjs');

function save(filename, value) {
  fs.mkdirSync(path.dirname(filename), {recursive: true, mode: 0o700});
  fs.writeFileSync(filename, JSON.stringify(value), {mode: 0o600});
}

test('pinned Super File Bros. source matches its release inventory', async t => {
  await verifySource();
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac2jb-super-file-source-'));
  t.after(() => fsp.rm(temporary, {recursive: true, force: true}));
  const source = path.resolve(__dirname, '../integrations/super-file-bros/upstream');
  await fsp.cp(source, temporary, {recursive: true});
  await fsp.appendFile(path.join(temporary, 'tools/dolphin-fs-rpc/storage.cjs'), '\n');
  await assert.rejects(verifySource(temporary), /Changed Super File Bros. source/);
});

test('SD adapter accepts only an owned verified live run from this runtime', async t => {
  const runtime = await fsp.mkdtemp(path.join(os.tmpdir(), 'mac2jb-super-file-run-'));
  t.after(() => fsp.rm(runtime, {recursive: true, force: true}));
  const run = path.join(runtime, 'vendor/ns2jb/runs/switch2-fixture');
  fs.mkdirSync(run, {recursive: true, mode: 0o700});
  const session = 'switch2-fixture';
  const result = {verified: true, fs: {verified: true, restored: true,
    cleanup: {deferred: true, donor: {cleanedUp: true}},
    retainedEndpoint: {ready: true, session}}, rpc: {mode: 'held', state: 'listening'}};
  save(path.join(run, 'result.json'), result);
  save(path.join(run, 'switch2/fs-execution-current.json'), {
    verified: true, restored: true, cleanup: {deferred: true},
    retainedEndpoint: {ready: true, session}, session
  });
  save(path.join(run, 'connection.json'), {addresses: {session}});
  save(path.join(run, 'switch2/current-acquisition.json'), {session});
  save(path.join(run, 'switch2/ro/root/current-root.json'), {session, pid: 1, rootHandle: 42});
  assert.equal(verifiedRun(run, '192.168.1.20', runtime).session, session);
  assert.throws(() => verifiedRun(run, 'not-an-ip', runtime), /IPv4/);
  result.rpc.state = 'closed';
  save(path.join(run, 'result.json'), result);
  assert.throws(() => verifiedRun(run, '192.168.1.20', runtime), /verified live held/);
});

test('read-only SD view never exposes internal mounts or mutation methods', async () => {
  const opened = [];
  const storage = {
    list: async value => {opened.push(value); return [{name: 'roms', type: 'dir', size: 0}];},
    stat: async value => {opened.push(value); return {type: 'dir', size: 0};},
    openRead: async value => {opened.push(value); return {handle: 1, size: 4};},
    read: async () => Buffer.from('test'), close: async () => {},
    remove: async () => {throw Error('must not be exposed');}
  };
  const view = readOnlySD(storage);
  assert.deepEqual(await view.list('/'), [{name: 'sd', type: 'dir', size: 0}]);
  assert.deepEqual(await view.list('/sd'), [{name: 'roms', type: 'dir', size: 0}]);
  await view.openRead('/sd/roms/test.nes');
  assert.throws(() => view.list('/system'), /Only the SD filesystem/);
  assert.throws(() => view.openRead('/user/file'), /Only the SD filesystem/);
  assert.equal(view.remove, undefined);
  assert.deepEqual(opened, ['/sd', '/sd/roms/test.nes']);
});

test('local SD browser serves scoped lists and one-use downloads without write routes', async t => {
  assert.throws(() => checkedPath('/sd/../system'), /under \/sd/);
  const bytes = Buffer.from('NES!');
  const panel = await createPanel({
    stat: async value => value === '/sd/roms/demo.nes' ? {type: 'file', size: bytes.length} :
      {type: 'dir', size: 0},
    list: async () => [{name: 'demo.nes', type: 'file', size: bytes.length}],
    openRead: async () => ({handle: 1, size: bytes.length}),
    read: async (_file, offset, count) => bytes.subarray(offset, offset + count),
    close: async () => {}
  }, {ftpURL: 'ftp://192.168.1.20:2122/sd/'});
  t.after(() => panel.close());
  const key = new URL(panel.url).hash.slice(1);
  const post = (route, value, authenticated = true) => fetch(panel.origin + route, {
    method: 'POST', headers: {'content-type': 'application/json', origin: panel.origin,
      ...(authenticated ? {'x-mac2jb-key': key} : {})}, body: JSON.stringify(value)
  });
  assert.equal((await post('/api/list', {path: '/sd'}, false)).status, 403);
  const listed = await post('/api/list', {path: '/sd/roms'});
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).entries.map(entry => entry.name), ['demo.nes']);
  assert.equal((await post('/api/list', {path: '/system'})).status, 400);
  assert.equal((await post('/api/sd/delete', {path: '/sd/roms/demo.nes'})).status, 404);
  const ticket = await (await post('/api/ticket', {path: '/sd/roms/demo.nes'})).json();
  const downloaded = await fetch(panel.origin + ticket.url);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal((await fetch(panel.origin + ticket.url)).status, 404);
});
