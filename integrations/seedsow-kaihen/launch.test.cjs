'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {PassThrough} = require('node:stream');
const {EventEmitter} = require('node:events');
const {spawnSync} = require('node:child_process');
const {
  SOURCE, PREFIX, guardBridgeSetup, stage, observe, failureReason, launch,
} = require('./launch.cjs');
const {ARCHIVES: KAIHEN_ARCHIVES} = require('../kaihen/launch.cjs');

async function temporary(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-seedsow-test-'));
  try { return await run(root); }
  finally { await fs.rm(root, {recursive: true, force: true}); }
}

function sourceLayout() {
  return [
    'ns2-run.cjs', 'launch/unix/setup.sh', 'tools/hen.cjs',
    'tools/seedsow-bridge.cjs', 'ns2jb-main/ns2jb-main/engine/switch2/pipeline.cjs',
  ];
}

function kaihenLayout() {
  return [
    'ro/main', 'hen/main', 'game/main', 'bootstrap.bin',
    'hbmenu.nro', 'programs/ounceshell.nro',
  ];
}

async function files(root, names) {
  for (const name of names) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, name === 'launch/unix/setup.sh' ? `#!/bin/sh
export NS2_FAST
if command -v lsof >/dev/null 2>&1; then
  pids=$(lsof -ti tcp:31337 2>/dev/null || true)
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
else
  pkill -f 'seedsow-bridge\\.cjs' 2>/dev/null || true
fi
sleep 0.5
` : 'fixture');
  }
}

function makeExtractor(omit) {
  return async (archive, destination) => {
    if (archive.endsWith('source.zip')) {
      await files(path.join(destination, SOURCE.archiveRoot),
        sourceLayout().filter(name => name !== omit));
    } else {
      await files(destination, kaihenLayout().filter(name => name !== omit));
    }
  };
}

test('Seedsow source is pinned and shares the current kaiHEN release', () => {
  assert.match(SOURCE.url, /Malev0\/seedsow-fs-kaihen\/zip\/[0-9a-f]{40}$/);
  assert.match(SOURCE.sha256, /^[0-9a-f]{64}$/);
  assert.equal(KAIHEN_ARCHIVES.kaihen.label, 'kaiHEN 20261117.1');
  assert.equal(PREFIX, 'MAC2JB_SEEDSOW_KAIHEN ');
});

test('bridge setup refuses an occupied local port before stopping a console loop', async () => {
  await temporary(async root => {
    await files(root, ['launch/unix/setup.sh']);
    await guardBridgeSetup(root);
    const script = await fs.readFile(path.join(root, 'launch/unix/setup.sh'), 'utf8');
    assert.ok(script.indexOf('Local port 31337 is in use') < script.indexOf('export NS2_FAST\n') + 350);
    assert.equal((script.match(/Local port 31337 is in use/g) || []).length, 2);
    assert.doesNotMatch(script, /kill \$pids|pkill -f/);
    assert.equal(spawnSync('/bin/sh', ['-n', path.join(root, 'launch/unix/setup.sh')]).status, 0);
  });
});

test('stage validates both source and kaiHEN artifacts and cleans failed staging', async () => {
  await temporary(async root => {
    const result = await stage(root, {source: '/tmp/source.zip', kaihen: '/tmp/kaihen.zip'},
      {extract: makeExtractor(), skipSetupGuard: true});
    assert.equal(await fs.readFile(path.join(result.kaihen, 'bootstrap.bin'), 'utf8'), 'fixture');
    await fs.rm(result.runRoot, {recursive: true});
    await assert.rejects(stage(root, {source: '/tmp/source.zip', kaihen: '/tmp/kaihen.zip'},
      {extract: makeExtractor('hbmenu.nro'), skipSetupGuard: true}), /Missing kaiHEN hbmenu\.nro/);
    assert.deepEqual(await fs.readdir(path.join(root, 'runs')), []);
  });
});

test('stage lines become progress events and success requires the HEN completion line', async () => {
  const child = {stdout: new PassThrough(), stderr: new PassThrough()};
  const events = [];
  const state = observe(child, value => events.push(value), '/tmp/seedsow-source');
  child.stdout.write('run directory: /tmp/seedsow-source/runs/switch-abc\n');
  child.stdout.write('1/4 Checking the console\n2/4 Acquiring FS memory\n');
  child.stderr.write('Staging HEN to SD and starting it through ldr:ro...\n');
  child.stdout.write('kaiHEN started. Quit the game, then hold R\n');
  child.stdout.end();
  child.stderr.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.step, 4);
  assert.equal(state.started, true);
  assert.equal(state.runPath, '/tmp/seedsow-source/runs/switch-abc');
  assert.deepEqual(events.filter(event => event.type === 'progress').map(event => event.step), [1, 2, 4]);
});

test('launch validates the Switch IP before downloading', async () => {
  await assert.rejects(launch({consoleIp: 'not-an-ip', runtimeRoot: '/tmp',
    spawnProcess() { throw Error('must not spawn'); }}), /valid Switch IPv4/);
});

test('launch reports verified four-stage completion using pinned archives', async () => {
  await temporary(async root => {
    const specs = {
      source: {filename: 'source.zip', label: 'test source', sha256: crypto.createHash('sha256').update('source').digest('hex')},
      kaihen: {filename: 'kaihen.zip', label: 'test kaiHEN', sha256: crypto.createHash('sha256').update('kaihen').digest('hex')},
    };
    const events = [];
    const result = await launch({
      consoleIp: '192.168.1.25', runtimeRoot: root, supportRoot: path.join(root, 'support'),
      specs, emit: event => events.push(event), skipSetupGuard: true, extract: makeExtractor(),
      download: async (_url, destination) => {
        await fs.writeFile(destination, path.basename(destination).startsWith('source.zip') ? 'source' : 'kaihen');
      },
      spawnProcess: (_node, args, options) => {
        assert.deepEqual(args.slice(1, 3), ['--ip', '192.168.1.25']);
        assert.equal(options.detached, true);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        setImmediate(() => {
          child.stdout.end('1/4 Checking the console\n2/4 Acquiring FS memory\n3/4 Starting native worker\n' +
            'kaiHEN started. Quit the game, then hold R while launching a native game.\n');
          child.stderr.end();
          child.emit('close', 0, null);
        });
        return child;
      },
    });
    assert.deepEqual(result, {installed: true});
    assert.equal(events.at(-1).type, 'installed');
    assert.equal(events.at(-1).step, 4);
    assert.deepEqual(await fs.readdir(path.join(root, 'support', 'runs')), []);
  });
});

test('failureReason keeps a useful upstream diagnostic', () => {
  assert.equal(failureReason({recent: ['    at ChildProcess.onExit', 'FAILED: FS canary not verified']}, 1),
    'FAILED: FS canary not verified');
});
