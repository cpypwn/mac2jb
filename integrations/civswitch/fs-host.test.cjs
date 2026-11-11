'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {runFsHost, stage, verifiedRun, verifiedStop, failureDetails} = require('./fs-host.cjs');
const {prepare, verifyStage} = require('../../scripts/prepare-civswitch-savekit.cjs');

test('the pinned kit stages with SaveKit compatibility and a patched bridge address', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-civ-fs-source-'));
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(__dirname, 'fs-kit', 'port');
  const staged = await stage(source, root, '192.0.2.55', prepare);
  const checked = await verifyStage(staged.stagedPort);
  assert.match(checked.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(await fs.readFile(staged.bridgeFile, 'utf8'), /PC_IP: '192\.0\.2\.55'/);
  assert.match(await fs.readFile(path.join(staged.stagedPort, 'engine/switch2/memory/fs-memory-control.cjs'), 'utf8'),
    /state\.listening = 'unix'/);
});

test('a failed preparation removes its partial staged copy', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-civ-fs-stage-fail-'));
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'civ_bridge.js'), "PC_IP: '<PC_IP>'");
  await assert.rejects(stage(source, root, '192.0.2.55', async () => {throw Error('preparation failed');}),
    /preparation failed/);
  assert.deepEqual(await fs.readdir(path.join(root, 'runs')), []);
});

async function fixture(t, hostCode, closeAfterUpload = false, supportProbe = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-civ-fs-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const sourcePort = path.join(root, 'source-port');
  await fs.mkdir(path.join(sourcePort, 'engine'), {recursive: true});
  await fs.writeFile(path.join(sourcePort, 'civ_bridge.js'), "const CONFIG = { PC_IP: '<PC_IP>' };\n");
  await fs.writeFile(path.join(sourcePort, 'engine', 'run.cjs'), hostCode);
  const sockets = new Set();
  let received = '';
  const server = net.createServer({allowHalfOpen: true}, socket => {
    sockets.add(socket);
    let request = '';
    socket.on('data', bytes => {
      request += bytes.toString('utf8');
      received += bytes.toString('utf8');
    });
    socket.on('end', () => {
      if (supportProbe && /^log\("mac2jb-civswitch-[a-f0-9]{32}"\);$/.test(request)) {
        socket.end(request.slice(5, -3) + '\nExecuted successfully\n');
      } else if (closeAfterUpload) socket.end('Executed successfully\n');
    });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {root, sourcePort, port: server.address().port, received: () => received};
}

const successHost = `
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.join(__dirname, 'runs'), {recursive: true});
const run = fs.mkdtempSync(path.join(__dirname, 'runs', 'switch2-'));
console.log('Waiting for Civilization VII via CivSwitch at 127.0.0.1:39380.');
console.log('Run folder: ' + run);
setTimeout(() => {
  fs.writeFileSync(path.join(run, 'connection.json'), JSON.stringify({port: 42123}));
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({target: 'civ7', verified: true,
    fs: {verified: true, retainedEndpoint: {ready: true}}, rpc: {state: 'listening'}}));
  console.log('4/4 verified. Civilization VII via CivSwitch RPC and FS memory endpoint remain live.');
}, 80);
process.on('SIGINT', () => {
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({target: 'civ7', verified: true,
    fs: {verified: true, cleanup: {cleanedUp: true}}, rpc: {state: 'closed'}}));
  process.exit(0);
});
setInterval(() => {}, 1000);
`;

const acquisitionFailureHost = `
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.join(__dirname, 'runs'), {recursive: true, mode: 0o700});
const run = fs.mkdtempSync(path.join(__dirname, 'runs', 'switch2-'));
fs.mkdirSync(path.join(run, 'switch2'), {mode: 0o700});
console.log('Run folder: ' + run);
setTimeout(() => {
  console.log('2/4 Acquiring FS memory');
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({target: 'civ7', verified: false,
    error: 'Error: FS acquisition did not complete. Inspect acquisition.log; restart the console.'}),
    {mode: 0o600});
  fs.writeFileSync(path.join(run, 'switch2', 'acquisition.log'),
    'Scanning FS memory\\nError: Switch 2 application connection is not ready\\n', {mode: 0o600});
  process.exit(1);
}, 80);
`;

test('FS acquisition failure reports the actual cause and its private log path', async t => {
  const f = await fixture(t, acquisitionFailureHost, true);
  const events = [];
  await assert.rejects(runFsHost({
    consoleIp: '127.0.0.1', macIp: '192.168.1.55', runtimeRoot: f.root,
    sourcePort: f.sourcePort, loaderPort: f.port, prepare: async () => {},
    verifyPrepared: async () => {}, handleSignals: false, emit: entry => events.push(entry),
  }), /exited before it was ready/);
  const failed = events.find(entry => entry.type === 'failed');
  assert.match(failed.message, /FS acquisition did not complete: Switch 2 application connection is not ready/);
  assert.match(failed.runPath, /\/runs\/switch2-[A-Za-z0-9]{6}$/);
  assert.equal(failed.logPath, path.join(failed.runPath, 'switch2', 'acquisition.log'));
  assert.equal(events.some(entry => entry.type === 'held-ready'), false);
});

test('failure diagnostics refuse run paths outside the staged host and symlinked logs', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-civ-fs-diagnostics-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const staged = path.join(root, 'port');
  const runs = path.join(staged, 'engine', 'runs');
  const run = path.join(runs, 'switch2-Ab12Cd');
  const switch2 = path.join(run, 'switch2');
  await fs.mkdir(switch2, {recursive: true, mode: 0o700});
  assert.equal(await failureDetails(staged, root), null);
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify({error: 'FS acquisition failed'}), {mode: 0o600});
  await fs.writeFile(path.join(root, 'outside.log'), 'Error: untrusted', {mode: 0o600});
  await fs.symlink(path.join(root, 'outside.log'), path.join(switch2, 'acquisition.log'));
  const details = await failureDetails(staged, run);
  assert.equal(details.cause, undefined);
  assert.equal(details.logPath, path.join(run, 'result.json'));
});

test('stages the host, sends the bridge once, exposes a verified held run and stops cleanly', async t => {
  const f = await fixture(t, successHost);
  const abort = new AbortController();
  const events = [];
  const result = await runFsHost({
    consoleIp: '127.0.0.1', macIp: '192.168.1.55', runtimeRoot: f.root,
    sourcePort: f.sourcePort, loaderPort: f.port, prepare: async () => {},
    verifyPrepared: async () => {},
    abortSignal: abort.signal, handleSignals: false,
    emit: entry => {events.push(entry); if (entry.type === 'held-ready') abort.abort();},
  });
  assert.equal(result.stopped, true);
  assert.match(result.runPath, /\/runs\/civswitch-fs-[a-f0-9]{16}\/port\/engine\/runs\/switch2-/);
  assert.equal(await fs.readFile(result.connectionPath, 'utf8'), '{"port":42123}');
  assert.match(f.received(), /PC_IP: '192\.168\.1\.55'/);
  assert.deepEqual(events.filter(entry => ['bridge-sent', 'held-ready', 'stopped'].includes(entry.type))
    .map(entry => entry.type), ['bridge-sent', 'held-ready', 'stopped']);
});

test('wait mode verifies the saved loader before sending a single bridge', async t => {
  const f = await fixture(t, successHost, false, true);
  const abort = new AbortController();
  const events = [];
  const result = await runFsHost({
    consoleIp: '127.0.0.1', macIp: '192.168.1.55', runtimeRoot: f.root,
    sourcePort: f.sourcePort, loaderPort: f.port, prepare: async () => {},
    verifyPrepared: async () => {}, abortSignal: abort.signal, handleSignals: false,
    waitForLoader: true,
    emit: entry => {events.push(entry); if (entry.type === 'held-ready') abort.abort();},
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(events.filter(entry => ['loader-wait', 'loader-ready', 'bridge-sent'].includes(entry.type))
    .map(entry => entry.type), ['loader-wait', 'loader-ready', 'bridge-sent']);
  assert.equal((f.received().match(/const CONFIG/g) || []).length, 1);
});

test('cancelling while waiting for the saved loader never sends the bridge', async t => {
  const f = await fixture(t, successHost);
  const abort = new AbortController();
  const events = [];
  const result = await runFsHost({
    consoleIp: '127.0.0.1', macIp: '192.168.1.55', runtimeRoot: f.root,
    sourcePort: f.sourcePort, loaderPort: f.port, prepare: async () => {},
    verifyPrepared: async () => {}, abortSignal: abort.signal, handleSignals: false,
    waitForLoader: true, probeLoader: async () => {abort.abort();},
    emit: entry => events.push(entry),
  });
  assert.equal(result.stopped, true);
  assert.equal(events.some(entry => entry.type === 'bridge-sent'), false);
  assert.equal(f.received(), '');
});

test('a loader response may close before the held host reaches 4/4', async t => {
  const f = await fixture(t, successHost, true);
  const abort = new AbortController();
  const events = [];
  await runFsHost({
    consoleIp: '127.0.0.1', macIp: '192.168.1.55', runtimeRoot: f.root,
    sourcePort: f.sourcePort, loaderPort: f.port, prepare: async () => {},
    verifyPrepared: async () => {}, abortSignal: abort.signal, handleSignals: false,
    emit: entry => {events.push(entry); if (entry.type === 'held-ready') abort.abort();},
  });
  assert.ok(events.some(entry => entry.type === 'held-ready'));
  assert.ok(events.some(entry => entry.type === 'stopped'));
});

test('a stop request during acquisition waits for held verification before cleanup', async t => {
  const f = await fixture(t, successHost);
  const abort = new AbortController();
  const events = [];
  const result = await runFsHost({
    consoleIp: '127.0.0.1', macIp: '192.168.1.55', runtimeRoot: f.root,
    sourcePort: f.sourcePort, loaderPort: f.port, prepare: async () => {},
    verifyPrepared: async () => {}, abortSignal: abort.signal, handleSignals: false,
    emit: entry => {events.push(entry); if (entry.type === 'bridge-sent') abort.abort();},
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(events.filter(entry => ['bridge-sent', 'held-ready', 'stopped'].includes(entry.type))
    .map(entry => entry.type), ['bridge-sent', 'held-ready', 'stopped']);
});

test('rejects a reported held run without FS proof', async t => {
  const f = await fixture(t, successHost);
  const staged = path.join(f.root, 'port');
  const run = path.join(staged, 'engine', 'runs', 'switch2-bad');
  await fs.mkdir(run, {recursive: true});
  await fs.writeFile(path.join(run, 'result.json'), JSON.stringify({target: 'civ7', verified: true,
    fs: {verified: false}, rpc: {state: 'listening'}}));
  await fs.writeFile(path.join(run, 'connection.json'), JSON.stringify({port: 42123}));
  await assert.rejects(verifiedRun(staged, run), /did not provide verified held RPC and FS proof/);
  await assert.rejects(verifiedRun(staged, f.root), /outside its staged source/);
});

test('a stop is clean only when the host records released FS resources', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-civ-fs-stop-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const result = path.join(root, 'result.json');
  await fs.writeFile(result, JSON.stringify({rpc: {state: 'closed'},
    fs: {cleanup: {cleanedUp: false}}}));
  assert.equal(await verifiedStop(result), false);
  await fs.writeFile(result, JSON.stringify({rpc: {state: 'closed'},
    fs: {cleanup: {cleanedUp: true}}}));
  assert.equal(await verifiedStop(result), true);
});
