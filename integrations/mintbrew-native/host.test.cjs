'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {main, parseOptions, verifySource, preflightCustomNativeApp,
  stageCustomNativeApp} = require('./host.cjs');

const root = path.resolve(__dirname, '../..');
const source = path.join(__dirname, 'upstream');
const kurumuz = path.join(root, 'vendor/ns2jb-hosts/kurumuz');
const cellenseres = path.join(root, 'vendor/ns2jb-hosts/cellenseres');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-native-host-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({sourceSha256: 'fixture'}));
  fs.writeFileSync(path.join(directory, 'display-inspection.json'), JSON.stringify({session: 'test-session'}));
  fs.writeFileSync(path.join(directory, 'compatibility-module.json'), '{}');
  const events = [], calls = [], signals = new EventEmitter();
  class Target {
    constructor() {this.unsafeSources = new Set(); this.mapped = [];}
    static async open() {
      calls.push('target-open');
      return new Target();
    }
    async close() {calls.push('target-close');}
  }
  class Runtime {
    constructor({target}) {this.target = target; calls.push('runtime-new');}
    async open() {calls.push('runtime-open');}
    async run(order) {
      calls.push('runtime-run');
      order.onReady();
      signals.emit('SIGTERM');
      assert.equal(this.stopRequested, true);
      return {entries: 1, launches: 0};
    }
    async launchOneApp(order) {
      calls.push('runtime-app-' + order.appId);
      order.onReady();
      return 0;
    }
    async stop(options) {
      calls.push('runtime-stop-' + options.teardown);
      await this.target.close();
    }
  }
  const options = {root, nativeRoot: source, signals, emit: (type, fields) => events.push({type, ...fields}),
    validateRun: async () => ({directory, proof: {session: 'test-session'}}),
    trustedProfileForDigest: () => ({profile: {id: 'kurumuz'}, sourceDirectory: kurumuz}),
    request: async () => ({ready: true}),
    readMacRoms: async () => ({missing: true, roms: [], skipped: []}),
    readSDRoms: async () => ({missing: true, roms: [], skipped: []}),
    LiveTarget: Target, Runtime};
  return {directory, events, calls, signals, options};
}

for (const [hostId, hostSource] of [['kurumuz', kurumuz], ['cellenseres', cellenseres]])
test('native source and built Hello CPU match the patched ' + hostId + ' ABI', () => {
  const verified = verifySource(source, hostSource);
  assert.equal(verified.launcher.abi, 3);
  assert.equal(verified.hello.id, 'hello-cpu');
});

test('options allow only the bounded native diagnostic', () => {
  const folder = '/private/tmp/native-run';
  assert.deepEqual(parseOptions([folder, '--app', 'hello-cpu']).appId, 'hello-cpu');
  assert.equal(parseOptions([folder, '--sd-rom-folder', '/sd/roms/nes']).sdRomFolder,
    '/sd/roms/nes');
  assert.throws(() => parseOptions([folder, '--sd-rom-folder', '/sd/../user']),
    /SD ROM folder/);
  assert.throws(() => parseOptions([folder, '--app', 'animal-crossing']), /Hello CPU/);
  assert.throws(() => parseOptions(['relative/run']), /Usage/);
  assert.equal(parseOptions([folder, '--app-folder', '/private/tmp/my-native']).appFolder,
    '/private/tmp/my-native');
  assert.throws(() => parseOptions([folder, '--app', 'hello-cpu',
    '--app-folder', '/private/tmp/my-native']), /one native app launch mode/);
});

test('custom ABI 3 app is copied into a private native library without changing bundled apps', async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-native-custom-')));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  const original = path.join(temp, 'my-native');
  fs.cpSync(path.join(source, 'apps/hello-cpu'), original, {recursive: true});
  for (const name of ['manifest.json', 'build/report.json']) {
    const file = path.join(original, name), document = JSON.parse(fs.readFileSync(file));
    document.id = 'my-native';
    fs.writeFileSync(file, JSON.stringify(document));
  }
  const prepared = await preflightCustomNativeApp(temp, original);
  t.after(prepared.cleanup);
  assert.equal(prepared.kind, 'native-app');
  assert.equal(prepared.app.id, 'my-native');
  assert.equal(fs.existsSync(path.join(source, 'apps/my-native')), false);
  const run = path.join(temp, 'held-run');
  fs.mkdirSync(run);
  const staged = await stageCustomNativeApp(run, path.join(source, 'apps'), prepared.packageFolder);
  assert.equal(fs.existsSync(path.join(staged.appsDir, 'my-native/build/code.bin')), true);
  assert.deepEqual(fs.readdirSync(staged.appsDir), ['my-native']);
  const catalog = require('./upstream/host/lib/packages.cjs').scan(staged.appsDir);
  assert.deepEqual(catalog.errors, []);
  assert.deepEqual(catalog.packages.map(item => item.manifest.id), ['my-native']);
  assert.equal(fs.existsSync(path.join(source, 'apps/my-native')), false);
  fs.rmSync(original, {recursive: true, force: true});
  assert.equal(fs.existsSync(path.join(staged.appsDir, 'my-native/build/code.bin')), true);
  fs.rmSync(staged.stageDir, {recursive: true, force: true});
});

test('selected custom native app reaches the existing HBLauncher runtime from a private copy', async t => {
  const {directory, options} = fixture(t);
  const original = path.join(fs.realpathSync(directory), 'my-native');
  fs.cpSync(path.join(source, 'apps/hello-cpu'), original, {recursive: true});
  for (const name of ['manifest.json', 'build/report.json']) {
    const file = path.join(original, name), document = JSON.parse(fs.readFileSync(file));
    document.id = 'my-native';
    fs.writeFileSync(file, JSON.stringify(document));
  }
  let privateApps;
  const Runtime = options.Runtime;
  options.Runtime = class extends Runtime {
    constructor(settings) {
      super(settings);
      privateApps = settings.appsDir;
      assert.equal(fs.existsSync(path.join(privateApps, 'my-native/build/code.bin')), true);
      assert.deepEqual(fs.readdirSync(privateApps), ['my-native']);
      assert.notEqual(privateApps, path.join(source, 'apps'));
    }
  };
  await main([directory, '--app-folder', original], options);
  assert.equal(fs.existsSync(privateApps), false);
  assert.equal(fs.existsSync(path.join(source, 'apps/my-native')), false);
});

test('native launcher claims one held session, starts, stops and closes its client', async t => {
  const {directory, events, calls, options} = fixture(t);
  const result = await main([directory], options);
  assert.equal(result.stopped, true);
  assert.deepEqual(events.map(event => event.type).filter(type => type !== 'progress'),
    ['started', 'running', 'stopped']);
  assert.deepEqual(calls, ['target-open', 'runtime-new', 'runtime-open', 'runtime-run',
    'runtime-stop-false', 'target-close']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, '.mac2jb-hblauncher-attempt.json'))).application,
    'native-hblauncher');
  assert.equal(events.at(-1).cleanupVerified, true);
  assert.deepEqual(events.at(-1).attemptMarkers, ['.mac2jb-hblauncher-attempt.json']);
  assert.equal(events.at(-1).attemptMarkerSha256, crypto.createHash('sha256').update(
    fs.readFileSync(path.join(directory, '.mac2jb-hblauncher-attempt.json'))).digest('hex'));
});

for (const [hostId, hostSource] of [['kurumuz', kurumuz], ['cellenseres', cellenseres]])
test('native launcher uses the already validated patched ' + hostId + ' source', async t => {
  const {directory, options} = fixture(t);
  const digest = 'a'.repeat(64);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({sourceSha256: digest}));
  options.validateRun = async () => ({directory, proof: {session: 'test-session'},
    trustedSource: {profileId: hostId, directory: hostSource, sourceSha256: digest}});
  options.trustedProfileForDigest = () => {throw Error('Pinned original digest lookup should not run');};
  assert.equal((await main([directory], options)).stopped, true);
});

test('Hello CPU direct path is one-shot and keeps the held RPC owner separate', async t => {
  const {directory, events, calls, options} = fixture(t);
  await main([directory, '--app', 'hello-cpu'], options);
  assert(calls.includes('runtime-app-hello-cpu'));
  assert(events.some(event => event.type === 'running'));
});

test('preflight failure remains retry safe and never opens a native target', async t => {
  const {directory, events, calls, options} = fixture(t);
  options.request = async () => ({ready: false});
  await assert.rejects(main([directory], options), /no longer ready/);
  assert.deepEqual(calls, []);
  assert.deepEqual(events.map(event => event.type), ['failed']);
  assert.equal(events[0].retrySafe, true);
  assert.equal(fs.existsSync(path.join(directory, '.mac2jb-hblauncher-attempt.json')), false);
});

test('a failed native open retains the attempt and reports blocked cleanup', async t => {
  const {directory, events, options} = fixture(t);
  options.Runtime = class {
    constructor({target}) {this.target = target;}
    async open() {throw Error('native map failed');}
    async stop() {await this.target.close();}
  };
  await assert.rejects(main([directory], options), /native map failed/);
  const failed = events.find(event => event.type === 'failed');
  assert.equal(failed.cleanupBlocked, true);
  assert.equal(failed.retrySafe, false);
  assert.equal(fs.existsSync(path.join(directory, '.mac2jb-hblauncher-attempt.json')), true);
});

test('a failed pre-display map can return to app selection after verified rollback', async t => {
  const {directory, events, calls, options} = fixture(t);
  options.Runtime = class {
    constructor({target}) {
      this.target = target;
      this.displayAttempted = false;
      this.blocks = [{base: 0x10000}];
      this.mappedImages = [];
      calls.push('runtime-new');
    }
    async open() {calls.push('runtime-open'); throw Error('map RX rejected before display');}
    async stop({teardown}) {
      calls.push('runtime-stop-' + teardown);
      assert.equal(teardown, true);
      this.blocks = [];
      await this.target.close();
    }
  };
  await assert.rejects(main([directory], options), /map RX rejected/);
  const failed = events.find(event => event.type === 'failed');
  assert.equal(failed.cleanupBlocked, false);
  assert.equal(failed.retrySafe, true);
  assert.equal(fs.existsSync(path.join(directory, '.mac2jb-hblauncher-attempt.json')), false);
  assert(calls.includes('runtime-stop-true'));
});

test('a failed map with an unverified native source still blocks reentry', async t => {
  const {directory, events, options} = fixture(t);
  options.Runtime = class {
    constructor({target}) {
      this.target = target;
      this.displayAttempted = false;
      this.blocks = [{base: 0x10000}];
      this.mappedImages = [];
    }
    async open() {
      this.target.unsafeSources.add(0x10000);
      throw Error('map rollback was not verified');
    }
    async stop({teardown}) {assert.equal(teardown, true); await this.target.close();}
  };
  await assert.rejects(main([directory], options), /map rollback was not verified/);
  const failed = events.find(event => event.type === 'failed');
  assert.equal(failed.cleanupBlocked, true);
  assert.equal(failed.retrySafe, false);
  assert.equal(fs.existsSync(path.join(directory, '.mac2jb-hblauncher-attempt.json')), true);
});

test('unavailable SD mount falls back to bundled MintNES before native mapping', async t => {
  const {directory, events, calls, options} = fixture(t);
  options.readSDRoms = async () => {throw Error('SD filesystem is unavailable');};
  await main([directory], options);
  assert(calls.includes('runtime-open'));
  assert(events.some(event => event.type === 'progress' &&
    /continuing with available MintNES ROMs/.test(event.message)));
  assert(events.some(event => event.type === 'stopped'));
});

test('Mac and SD ROMs are staged together before native runtime opens', async t => {
  const {directory, events, calls, options} = fixture(t);
  const rom = Buffer.alloc(16 + 16384);
  Buffer.from('4e45531a', 'hex').copy(rom);
  rom[4] = 1;
  options.readMacRoms = async folder => {
    assert.equal(folder.endsWith('/MintNES/roms'), true);
    calls.push('mac-read');
    return {roms: [{name: 'Mac.nes', bytes: rom}], skipped: []};
  };
  options.readSDRoms = async (_run, config) => {
    assert.equal(config.limit, 14);
    calls.push('sd-read');
    return {roms: [{name: 'SD.nes', bytes: rom}], skipped: []};
  };
  options.stageApps = async (_run, _apps, roms) => {
    assert.deepEqual(roms.map(item => item.name), ['Mac.nes', 'SD.nes']);
    calls.push('stage-apps');
    return {appsDir: '/test/session/apps', stageDir: null,
      imported: ['Mac.nes', 'SD.nes']};
  };
  await main([directory], options);
  assert.deepEqual(calls.slice(0, 4), ['mac-read', 'sd-read', 'stage-apps', 'target-open']);
  assert(events.some(event => /Staged 2 additional ROMs/.test(event.message || '')));
});

test('MintNES refresh re-reads the Mac ROM folder and removes stale entries', async t => {
  const {directory, options} = fixture(t);
  const rom = Buffer.alloc(16 + 16384);
  Buffer.from('4e45531a', 'hex').copy(rom);
  rom[4] = 1;
  let macRoms = [{name: 'First.nes', bytes: rom}];
  options.readMacRoms = async () => ({roms: macRoms, skipped: []});
  options.readSDRoms = async () => ({roms: [{name: 'SD.nes', bytes: rom}], skipped: []});
  options.stageApps = async () => ({appsDir: '/test/session/apps', stageDir: null,
    imported: ['First.nes', 'SD.nes']});
  const MockRuntime = options.Runtime;
  options.Runtime = class extends MockRuntime {
    constructor(config) {
      super(config);
      this.refreshAssets = config.refreshAssets;
    }
    async run(order) {
      const first = (await this.refreshAssets()).map(asset => asset.name);
      assert(first.includes('First.nes') && first.includes('SD.nes'));
      macRoms = [{name: 'Next.nes', bytes: rom}];
      const second = (await this.refreshAssets()).map(asset => asset.name);
      assert(second.includes('Next.nes') && second.includes('SD.nes'));
      assert(!second.includes('First.nes'));
      return super.run(order);
    }
  };
  await main([directory], options);
});

test('uncertain SD attachment cleanup blocks native mapping', async t => {
  const {directory, events, calls, options} = fixture(t);
  options.readSDRoms = async () => {
    const error = Error('SD attachment did not release its handles');
    error.cleanupBlocked = true;
    throw error;
  };
  await assert.rejects(main([directory], options), /did not release/);
  assert.equal(calls.includes('target-open'), false);
  const failed = events.find(event => event.type === 'failed');
  assert.equal(failed.cleanupBlocked, true);
  assert.equal(failed.retrySafe, false);
});

test('failed unmap never frees a source still mapped into the console', async () => {
  const {Runtime} = require('./upstream/host/lib/runtime.cjs');
  const freed = [];
  const target = {kind: 'mock', unsafeSources: new Set(),
    async unmapImage() {throw Error('unmap failed');},
    async free(address) {freed.push(address);}, async close() {}};
  const log = {stage() {}, info() {}, warn() {}};
  const runtime = new Runtime({target, log});
  runtime.launcher = {resident: false};
  runtime.mappedImages = [{label: 'launcher-code', source: 0x10000,
    destination: 0x08000000, bytes: 0x1000}];
  runtime.blocks = [{base: 0x10000}, {base: 0x20000}];
  await runtime.stop({teardown: true});
  assert.deepEqual(freed, [0x20000]);
  assert.equal(runtime.cleanupBlocked, true);
  assert.equal(target.unsafeSources.has(0x10000), true);
});

test('partial native range mapping retains the entire backing source', async () => {
  const {LiveTarget, MAX_RANGE_PAGES} = require('./upstream/host/lib/target.cjs');
  const target = new LiveTarget({runDir: '/mock', log: {}});
  target.query = async () => ({type: 0, address: 0, size: 0x20000000});
  let calls = 0;
  target.mapRange = async () => {
    if (++calls === 2) throw Error('second chunk failed');
  };
  const source = 0x10000000;
  await assert.rejects(target.mapImage({source, destination: 0x08000000,
    bytes: (MAX_RANGE_PAGES + 1) * 0x1000, permission: 5}), /second chunk failed/);
  assert.equal(target.unsafeSources.has(source), true);
});

test('a rejected first map with a verified free destination keeps its source releasable', async () => {
  const {LiveTarget} = require('./upstream/host/lib/target.cjs');
  const target = new LiveTarget({runDir: '/mock', log: {}});
  target.query = async () => ({type: 0, address: 0, size: 0x20000000});
  target.mapRange = async () => {throw Error('map RX rejected');};
  const source = 0x10000000;
  await assert.rejects(target.mapImage({source, destination: 0x08000000,
    bytes: 0x10000, permission: 5}), /map RX rejected/);
  assert.equal(target.unsafeSources.has(source), false);
});
