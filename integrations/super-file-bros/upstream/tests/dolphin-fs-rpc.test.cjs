const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../tools/dolphin-fs-rpc/library.cjs');
const session = {run: '/held/run', identity: 'live:socket', host: '10.42.0.20', port: 2122};
const title = '0100c9100b06a000';

test('only a running, connected attempt with matching held FS proof can be selected', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dolphin-fs-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const write = async (file, data) => {await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, JSON.stringify(data));};
  const directory = path.join(root, 'data/sessions/live');
  await write(path.join(root, 'data/state/attempts/a/attempt.json'), {status: 'running', created: '2026-10-30', runDirectory: directory, consoleAddress: session.host});
  await write(path.join(directory, 'fs-rpc-state.json'), {state: 'ready'});
  await write(path.join(directory, 'connection-state.json'), {state: 'connected'});
  const proofFile = path.join(directory, 'fs-rpc/switch2/fs-execution-current.json');
  const proof = {verified: true, restored: true, session: 'old', cleanup: {deferred: true}, retainedEndpoint: {ready: true, session: 'live', socketPath: '/tmp/live.sock'}};
  await write(proofFile, proof);
  let checks = 0;
  const preflight = async () => {checks++; return {ready: true};};
  await assert.rejects(lib.findSession(root, preflight), /No active FS RPC/);
  assert.equal(checks, 0);
  proof.session = 'live'; await write(proofFile, proof);
  const selected = await lib.findSession(root, preflight);
  assert.equal(selected.run, path.join(directory, 'fs-rpc'));
  assert.equal(selected.host, session.host);
  await write(path.join(directory, 'connection-state.json'), {state: 'reconnecting'});
  await assert.rejects(lib.findSession(root, preflight), /No active FS RPC/);
});

function exporter(options = {}) {
  const events = [], controller = new AbortController();
  return {events, controller, options: {
    signal: controller.signal, checkPort: async () => false, health: async () => {},
    attachGame: async () => ({close: async () => events.push('attachment-closed')}),
    prepareGame: async () => {events.push('prepared'); return {};},
    readImage: async () => Buffer.alloc(1),
    deployFtp: async () => {events.push('deployed'); return {close: async () => events.push('ftp-closed')};},
    probe: async () => {events.push('listed'); return ['romfs'];},
    ready: ({url}) => {assert.equal(url, 'ftp://10.42.0.20:2122/'); events.push('ready'); controller.abort();},
    ...options}};
}

test('readiness requires a real FTP listing and graceful stop closes owned resources in order', async () => {
  const f = exporter();
  await lib.exportGame(session, title, f.options);
  assert.deepEqual(f.events, ['prepared', 'deployed', 'listed', 'ready', 'ftp-closed', 'attachment-closed']);
});

test('failed FTP verification cannot open Dolphin and still releases the game attachment', async () => {
  const f = exporter({probe: async () => {throw Error('LIST failed');}});
  await assert.rejects(lib.exportGame(session, title, f.options), /LIST failed/);
  assert.deepEqual(f.events, ['prepared', 'deployed', 'ftp-closed', 'attachment-closed']);
});

test('cancelling preparation does not deploy FTP; a busy port or invalid title never attaches', async () => {
  const f = exporter();
  f.options.prepareGame = async () => {f.controller.abort(); return {};};
  await lib.exportGame(session, title, f.options);
  assert.deepEqual(f.events, ['attachment-closed']);
  const busy = exporter({checkPort: async () => true});
  await assert.rejects(lib.exportGame(session, title, busy.options), /already in use/);
  assert.deepEqual(busy.events, []);
  await assert.rejects(lib.exportGame(session, 'bad;argument', busy.options), /Title ID/);
});

test('cached game lists are bound to the retained endpoint and refresh explicitly rereads the console', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dolphin-cache-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  let reads = 0;
  const options = {root, list: async () => {reads++; return [{title, name: 'SmileBASIC 4', storages: [4]}];}};
  await lib.gamesFor(session, options);
  await lib.gamesFor(session, options);
  assert.equal(reads, 1);
  await lib.gamesFor({...session, identity: 'replacement'}, options);
  assert.equal(reads, 2);
  await lib.gamesFor({...session, identity: 'replacement'}, {...options, refresh: true});
  assert.equal(reads, 3);
});
