'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const launcher = require('./launch.cjs');
const provenance = require('./provenance.json');

test('release provenance matches the downloaded kaiHEN archive', () => {
  assert.equal(launcher.ARCHIVES.kaihen.filename, provenance.archive);
  assert.equal(launcher.ARCHIVES.kaihen.url, provenance.url);
  assert.equal(launcher.ARCHIVES.kaihen.sha256, provenance.sha256);
  assert.ok(provenance.url.includes(`/releases/download/${provenance.release}/`));
  assert.equal(launcher.ARCHIVES.source.sha256, provenance.civ7Host.sha256);
  assert.equal(launcher.ARCHIVES.source.url,
    `${provenance.civ7Host.source}/archive/${provenance.civ7Host.commit}.zip`);
});

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-kaihen-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function fixture(t) {
  const root = await temporary(t);
  const sourceBytes = Buffer.from('pinned source fixture');
  const shipBytes = Buffer.from('pinned kaiHEN fixture');
  const originals = {
    source: path.join(root, 'source-fixture.zip'),
    kaihen: path.join(root, 'kaihen-fixture.zip'),
  };
  await fs.writeFile(originals.source, sourceBytes);
  await fs.writeFile(originals.kaihen, shipBytes);
  const specs = {
    source: {label: 'source fixture', filename: 'source.zip', url: 'fixture:source',
      sha256: digest(sourceBytes), archiveRoot: 'source-root', maxBytes: 1024},
    kaihen: {label: 'kaiHEN fixture', filename: 'kaihen.zip', url: 'fixture:kaihen',
      sha256: digest(shipBytes), archiveRoot: null, maxBytes: 1024},
  };
  let downloads = 0;
  const download = async (url, destination) => {
    downloads++;
    await fs.copyFile(originals[url.slice('fixture:'.length)], destination);
  };
  const extract = async (_archive, destination, archiveRoot) => {
    const base = archiveRoot ? path.join(destination, archiveRoot) : destination;
    for (const name of archiveRoot ? ['engine/hen.cjs', 'engine/run.cjs', 'bridge/civ_bridge.js'] :
      ['ro/main', 'hen/main', 'game/main', 'bootstrap.bin', 'hbmenu.nro',
        'programs/ounceshell.nro', 'licenses/kaiHEN-GPL-2.0.txt']) {
      const file = path.join(base, name);
      await fs.mkdir(path.dirname(file), {recursive: true});
      await fs.writeFile(file, name);
    }
  };
  return {root, specs, download, extract, get downloads() {return downloads;}};
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
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, null));
  }
}

test('archive paths stay within their expected root', () => {
  launcher.validateEntries(['source-root/', 'source-root/engine/run.cjs'], 'source-root');
  assert.throws(() => launcher.validateEntries(['source-root/../escape'], 'source-root'), /unsafe/);
  assert.throws(() => launcher.validateEntries(['/etc/passwd'], null), /unsafe/);
  assert.throws(() => launcher.validateEntries(['other-root/run.cjs'], 'source-root'), /unsafe/);
});

test('pinned archive rejects a wrong hash and caches only verified bytes', async t => {
  const f = await fixture(t);
  const events = [];
  const cache = path.join(f.root, 'cache');
  const bad = {...f.specs.source, sha256: '0'.repeat(64)};
  await assert.rejects(launcher.pinnedArchive(cache, bad,
    {download: f.download, emit: value => events.push(value)}), /pinned SHA-256/);
  await assert.rejects(fs.access(path.join(cache, bad.filename)), {code: 'ENOENT'});
  const saved = await launcher.pinnedArchive(cache, f.specs.source,
    {download: f.download, emit: value => events.push(value)});
  await launcher.pinnedArchive(cache, f.specs.source,
    {download: f.download, emit: value => events.push(value)});
  assert.equal(await launcher.sha256(saved), f.specs.source.sha256);
  assert.equal(f.downloads, 2);
  assert.ok(events.some(value => value.type === 'verified'));
});

test('launcher confirms HEN PID and running output before installed, then finishes', async t => {
  const f = await fixture(t);
  const emitted = [];
  let child;
  let spawned;
  const promise = launcher.launch({consoleIp: '192.168.2.118', runtimeRoot: f.root,
    supportRoot: path.join(f.root, 'support'), specs: f.specs, node: '/fixture/node',
    download: f.download, extract: f.extract, emit: value => emitted.push(value),
    spawnProcess(program, args, options) {
      spawned = {program, args, options};
      child = new FakeChild();
      setImmediate(() => {
        const runPath = path.join(options.cwd, 'runs', 'switch2-test');
        child.stdout.write(`Run folder: ${runPath}\n1/4 Checking the console\nHEN PID 210; startup record: ${runPath}/switch2/ro/hen-startup.json\n`);
        child.stderr.write('2/4 Acquiring FS memory\n');
        assert.equal(emitted.some(value => value.type === 'installed'), false);
        child.stdout.write('HEN is running. Close Civilization VII normally; hold R while opening a native game.\n');
        child.end();
      });
      return child;
    }});
  const result = await promise;
  assert.equal(result.installed, true);
  assert.equal(spawned.program, '/fixture/node');
  assert.equal(spawned.args[1], '192.168.2.118');
  assert.equal(spawned.args[2], '--dir');
  assert.equal(path.dirname(spawned.args[0]), path.join(spawned.options.cwd, 'engine'));
  assert.equal(emitted.find(value => value.type === 'progress').step, 1);
  assert.ok(emitted.some(value => value.type === 'progress' && value.step === 2));
  assert.equal(emitted.filter(value => value.type === 'installed').length, 1);
  assert.equal(emitted.at(-1).type, 'finished');
  assert.equal(child.kills.length, 0);
  await assert.rejects(fs.access(path.join(spawned.args[3], 'licenses', 'kaiHEN-GPL-2.0.txt')),
    {code: 'ENOENT'});
  assert.ok(emitted.some(value => value.type === 'log' && value.message.includes('HEN PID')));
});

test('host exit without both startup markers fails without installed event', async t => {
  const f = await fixture(t);
  const emitted = [];
  await assert.rejects(launcher.launch({consoleIp: '192.168.2.118', runtimeRoot: f.root,
    supportRoot: path.join(f.root, 'support'), specs: f.specs, node: '/fixture/node',
    download: f.download, extract: f.extract, emit: value => emitted.push(value),
    spawnProcess() {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.write('HEN PID 210; startup record: /tmp/hen-startup.json\n');
        child.end();
      });
      return child;
    }}), /before kaiHEN startup was confirmed/);
  assert.equal(emitted.some(value => value.type === 'installed'), false);
  assert.equal(emitted.some(value => value.type === 'finished'), false);
  const runs = path.join(f.root, 'support', 'runs');
  assert.deepEqual(await fs.readdir(runs), []);
});

test('failed FS acquisition reports the canary error instead of the wrapper stack', async t => {
  const f = await fixture(t);
  const emitted = [];
  await assert.rejects(launcher.launch({consoleIp: '192.168.2.118', runtimeRoot: f.root,
    supportRoot: path.join(f.root, 'support'), specs: f.specs, node: '/fixture/node',
    download: f.download, extract: f.extract, emit: value => emitted.push(value),
    spawnProcess() {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.write('ReiAyanami: FAILED: Error: Positive canary verification failed: 0 verified marker hits; retain resources\n');
        child.stderr.write('Error: run.cjs exited before "RO frontend verified": 1\n');
        child.stderr.write('    at ChildProcess._handle.onexit (node:internal/child_process:324:12)\n');
        child.end(1);
      });
      return child;
    }}), /Positive canary verification failed: 0 verified marker hits/);
  assert.ok(emitted.some(value => value.type === 'log' &&
    value.message.includes('Positive canary verification failed')));
  assert.equal(emitted.some(value => value.type === 'log' &&
    value.message.includes('ChildProcess._handle.onexit')), false);
  assert.equal(emitted.some(value => value.type === 'installed'), false);
});

test('copies bounded failure details before removing the staged host', async t => {
  const root = await temporary(t);
  const runPath = path.join(root, 'run');
  const supportRoot = path.join(root, 'support');
  await fs.mkdir(path.join(runPath, 'switch2'), {recursive: true});
  await fs.writeFile(path.join(runPath, 'result.json'), '{"verified":false}');
  await fs.writeFile(path.join(runPath, 'switch2', 'pipeline.json'), '{"step":2}');
  await fs.writeFile(path.join(runPath, 'switch2', 'acquisition-2.log'), 'marker missed');
  const destination = await launcher.preserveFailureDiagnostics(supportRoot, {runPath});
  assert.equal(destination, path.join(supportRoot, 'last-failure'));
  assert.equal(await fs.readFile(path.join(destination, 'acquisition.log'), 'utf8'),
    'marker missed');
  assert.equal(await fs.readFile(path.join(destination, 'pipeline.json'), 'utf8'),
    '{"step":2}');
});

test('stop forwards a graceful signal and never reports installation', async t => {
  const f = await fixture(t);
  const emitted = [];
  const abort = new AbortController();
  let child;
  const result = await launcher.launch({consoleIp: '192.168.2.118', runtimeRoot: f.root,
    supportRoot: path.join(f.root, 'support'), specs: f.specs, node: '/fixture/node',
    download: f.download, extract: f.extract, emit: value => emitted.push(value),
    abortSignal: abort.signal,
    spawnProcess() {
      child = new FakeChild();
      setImmediate(() => {
        abort.abort();
        child.end(0);
      });
      return child;
    }});
  assert.equal(result.stopped, true);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(emitted.at(-1).type, 'stopped');
  assert.equal(emitted.some(value => value.type === 'installed'), false);
});
