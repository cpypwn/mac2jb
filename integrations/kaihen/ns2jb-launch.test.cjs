'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const launcher = require('./ns2jb-launch.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-ns2jb-hen-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const hostRoot = path.join(root, 'vendor/ns2jb-hosts/kurumuz');
  await fs.mkdir(hostRoot, {recursive: true});
  for (const file of ['hen.cjs', 'run.cjs']) await fs.writeFile(path.join(hostRoot, file), file);
  const bytes = Buffer.from('kaiHEN fixture');
  const source = path.join(root, 'source.zip');
  await fs.writeFile(source, bytes);
  const spec = {label: 'kaiHEN fixture', filename: 'kaihen.zip', url: 'fixture:kaihen',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), maxBytes: 1024};
  const download = async (_url, destination) => fs.copyFile(source, destination);
  const extract = async (_archive, destination) => {
    for (const name of launcher.PACKAGE_FILES) {
      const file = path.join(destination, name);
      await fs.mkdir(path.dirname(file), {recursive: true});
      await fs.writeFile(file, name);
    }
  };
  return {root, hostRoot, spec, download, extract};
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.kills = [];
  }
  kill(signal) { this.kills.push(signal); return true; }
  end(code = 0) {
    this.stdout.end(); this.stderr.end();
    setImmediate(() => this.emit('close', code, null));
  }
}

test('uses only the START command actually printed by the host', () => {
  assert.equal(launcher.startCommand('V=START(39380,10,0,0,205)', '10.0.0.205'),
    'V=START(39380,10,0,0,205)');
  assert.equal(launcher.startCommand('V=START(39380,10,0,0,205,0,0,0,0)', '10.0.0.205'),
    'V=START(39380,10,0,0,205,0,0,0,0)');
  assert.equal(launcher.startCommand('V=START(39380,10,0,0,206,0,0,0,0)', '10.0.0.205'), null);
  assert.equal(launcher.startCommand('V=START(39380,10,0,0,205,1,0,0,0)', '10.0.0.205'), null);
  assert.equal(launcher.startCommand('V=START(39380,10,0,0,205,0,0,0)', '10.0.0.205'), null);
});

test('validates package entries before starting a host', async t => {
  const f = await fixture(t);
  const run = path.join(f.root, 'support');
  await fs.mkdir(run);
  const badExtract = async (_archive, destination) => {
    await f.extract(_archive, destination);
    await fs.rm(path.join(destination, 'hbmenu.nro'));
  };
  let spawned = false;
  await assert.rejects(launcher.launch({macIp: '10.0.0.205', runtimeRoot: f.root,
    supportRoot: run, hostRoot: f.hostRoot, spec: f.spec, download: f.download,
    extract: badExtract, emit() {}, spawnProcess() { spawned = true; }}), /hbmenu\.nro/);
  assert.equal(spawned, false);
  assert.deepEqual(await fs.readdir(path.join(run, 'ns2jb-runs')), []);
});

test('starts Kurumuz hen.cjs and confirms HEN startup before installed', async t => {
  const f = await fixture(t);
  const events = [];
  let invoked;
  const done = launcher.launch({macIp: '10.0.0.205', runtimeRoot: f.root,
    supportRoot: path.join(f.root, 'support'), hostRoot: f.hostRoot,
    spec: f.spec, node: '/fixture/node', download: f.download, extract: f.extract,
    emit: value => events.push(value), spawnProcess(program, args, options) {
      invoked = {program, args, options};
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.write('V=START(39380,10,0,0,205)\n');
        child.stdout.write('1/4 Checking the console\n');
        child.stderr.write('2/4 Acquiring FS memory\n');
        child.stdout.write('RO frontend verified. SmileBASIC RPC remains live\n');
        child.stdout.write('HEN PID 123; startup record: /tmp/hen-startup.json\n');
        assert.equal(events.some(item => item.type === 'installed'), false);
        child.stdout.write('HEN launch completed! Please quit SmileBASIC\n');
        child.end();
      });
      return child;
    }});
  assert.deepEqual(await done, {installed: true});
  assert.equal(invoked.program, '/fixture/node');
  assert.equal(invoked.args[0], path.join(f.hostRoot, 'hen.cjs'));
  assert.equal(invoked.args[1], '--dir');
  assert.equal(invoked.args[3], '10.0.0.205');
  assert.equal(invoked.options.cwd, f.hostRoot);
  assert.equal(invoked.options.env.NS2_BASIC_ARITY, '5');
  assert.equal(invoked.options.env.MAC2JB_HOST_STAGE_TIMEOUT_MS, '600000');
  assert.equal(events.find(item => item.type === 'host-ready')?.startCommand,
    'V=START(39380,10,0,0,205)');
  assert.ok(events.some(item => item.type === 'progress' && item.step === 2));
  assert.equal(events.find(item => item.type === 'installed')?.pid, '123');
  assert.equal(events.at(-1).type, 'finished');
  assert.deepEqual(await fs.readdir(path.join(f.root, 'support/ns2jb-runs')), []);
});

test('does not claim installation from a HEN PID alone', async t => {
  const f = await fixture(t);
  const events = [];
  await assert.rejects(launcher.launch({macIp: '10.0.0.205', runtimeRoot: f.root,
    supportRoot: path.join(f.root, 'support'), hostRoot: f.hostRoot,
    spec: f.spec, node: '/fixture/node', download: f.download, extract: f.extract,
    emit: value => events.push(value), spawnProcess() {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.write('HEN PID 123; startup record: /tmp/hen-startup.json\n');
        child.end();
      });
      return child;
    }}), /before kaiHEN startup was confirmed/);
  assert.equal(events.some(item => item.type === 'installed'), false);
});

test('stops the acquisition host after native HEN startup fails', async t => {
  const f = await fixture(t);
  const events = [];
  let child;
  await assert.rejects(launcher.launch({macIp: '10.0.0.205', runtimeRoot: f.root,
    supportRoot: path.join(f.root, 'support'), hostRoot: f.hostRoot,
    spec: f.spec, node: '/fixture/node', download: f.download, extract: f.extract,
    emit: value => events.push(value), spawnProcess() {
      child = new FakeChild();
      child.kill = signal => { child.kills.push(signal); child.end(1); return true; };
      setImmediate(() => child.stderr.write('HEN startup failed; RPC remains live\n'));
      return child;
    }}), /Native HEN startup failed/);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(events.some(item => item.type === 'installed'), false);
});

test('rejects invalid stage timeout before launching', async t => {
  const f = await fixture(t);
  await assert.rejects(launcher.launch({macIp: '10.0.0.205', runtimeRoot: f.root,
    hostRoot: f.hostRoot, stageTimeoutMinutes: 61}), /between 1 and 60/);
});
