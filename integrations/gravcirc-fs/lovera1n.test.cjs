const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const os = require('node:os');
const path = require('node:path');
const {
  TERMINAL_BANNER, CONSOLE_BANNER, parseArgs, usableIPv4,
  selectMacIPv4, consoleSource, run,
} = require('./lovera1n.cjs');

const switchIp = '10.0.0.199';
const macIp = '10.0.0.205';

test('CLI parses one optional Switch address and a development canary flag', () => {
  assert.deepEqual(parseArgs([]), {canary: false, switchIp: null});
  assert.deepEqual(parseArgs(['--canary', switchIp]), {canary: true, switchIp});
  assert.deepEqual(parseArgs(['-h']), {help: true});
  assert.throws(() => parseArgs(['--unknown']), /usage:/);
  assert.throws(() => parseArgs([switchIp, switchIp]), /usage:/);
  assert.throws(() => parseArgs(['127.0.0.1']), /unicast/);
  assert.throws(() => usableIPv4('256.0.0.1', 'Switch address'), /IPv4/);
});

test('terminal and console banners preserve the requested artwork without graphics hooks', () => {
  assert.equal(TERMINAL_BANNER.split('\n').length, 6);
  assert.match(TERMINAL_BANNER, /▄██▄▀███▀/);
  assert.equal(CONSOLE_BANNER, '+----<3    lovera1n by cpypwn    +----<3');
  const source = consoleSource();
  assert.match(source, /^assert\(LS and LS\.state == "serving"/);
  assert.match(source, /LS\.nx_info\.profile == "gravity-circuit-v1\.2\.1"/);
  assert.match(source, /log\("\[NET\] RPC ready"\)/);
  assert.match(source, /log\("\[FS\] target image: Gravity Circuit v1\.2\.1"\)/);
  assert.match(source, /log\("\[FS\] native profile loaded"\)/);
  assert.match(source, /LOVERA1N_BANNER_OK/);
  assert.doesNotMatch(source, /graphics|draw|render|hook/i);
});

test('Mac route is selected without sending UDP and must match an active local interface', async () => {
  const calls = [];
  class RouteSocket extends EventEmitter {
    connect(port, host, done) {
      calls.push(['connect', port, host]);
      done();
    }
    address() {return {address: macIp};}
    close() {calls.push(['close']);}
    send() {throw Error('UDP traffic must not be sent');}
  }
  const selected = await selectMacIPv4(switchIp, {
    socketFactory: type => {assert.equal(type, 'udp4'); return new RouteSocket();},
    interfaces: () => ({en0: [{address: macIp, family: 'IPv4', internal: false}]}),
  });
  assert.equal(selected, macIp);
  assert.deepEqual(calls, [['connect', 9026, switchIp], ['close']]);
  await assert.rejects(selectMacIPv4(switchIp, {
    socketFactory: () => new RouteSocket(),
    interfaces: () => ({en0: [{address: '10.0.0.206', family: 'IPv4', internal: false}]}),
  }), /not an active/);
});

function fakeDependencies(overrides = {}) {
  const events = [];
  const output = {write(value) {events.push(['output', value]);}};
  return {events, dependencies: {
    output,
    promptSwitchIp: async () => {events.push(['prompt']); return switchIp;},
    selectMacIPv4: async ip => {events.push(['route', ip]); return macIp;},
    probe: async ({host}) => {
      events.push(['probe', host]);
      return {gameId: 'gravity-circuit', runtimeReady: true,
        nativeProfile: 'gravity-circuit-v1.2.1'};
    },
    executeLua: async request => {
      events.push(['lua', request]);
      return '-> LOVERA1N_BANNER_OK\n';
    },
    loadTarget: name => {events.push(['target', name]); return {name};},
    assertFullSupported: () => {events.push(['full-gate']);},
    assertCanarySupported: () => {events.push(['canary-gate']);},
    runFull: async (args, options) => {
      events.push(['before-host']);
      await options.beforeHostStart();
      events.push(['full-run', args, options.runRoot]);
      return 'full-result';
    },
    runCanary: async (args, options) => {
      events.push(['before-host']);
      await options.beforeHostStart();
      events.push(['canary-run', args, options.runRoot]);
      return 'canary-result';
    },
    ...overrides,
  }};
}

test('default CLI defers the console banner until the guarded full host is ready to start', async () => {
  const {events, dependencies} = fakeDependencies();
  assert.equal(await run([], dependencies), 'full-result');
  assert.equal(events[0][1], `${TERMINAL_BANNER}\n`);
  assert.deepEqual(events.filter(event => event[0] !== 'output').map(event => event[0]),
    ['prompt', 'route', 'probe', 'target', 'full-gate', 'before-host', 'lua', 'full-run']);
  assert.equal(events.find(event => event[0] === 'lua')[1].port, 9026);
  assert.match(events.find(event => event[0] === 'lua')[1].source,
    /target image: Gravity Circuit v1\.2\.1/);
  assert.deepEqual(events.find(event => event[0] === 'full-run')[1], [switchIp, macIp]);
  assert.equal(events.find(event => event[0] === 'full-run')[2],
    path.join(os.homedir(), '.lovera1n', 'runs'));
});

test('unverified full FS gate stops before native traffic', async () => {
  const {events, dependencies} = fakeDependencies({
    assertFullSupported: () => {throw Error('missing measured FS geometry');},
  });
  await assert.rejects(run([switchIp], dependencies),
    /full FS path is not verified: missing measured FS geometry.*No native FS traffic/);
  assert.equal(events.some(event => event[0] === 'full-run'), false);
  assert.equal(events.some(event => event[0] === 'lua'), false);
});

test('development canary uses its own gate and never starts the full path', async () => {
  const {events, dependencies} = fakeDependencies();
  assert.equal(await run(['--canary', switchIp], dependencies), 'canary-result');
  assert.equal(events.some(event => event[0] === 'full-run' || event[0] === 'full-gate'), false);
  assert.deepEqual(events.find(event => event[0] === 'canary-run')[1], [switchIp, macIp]);
  assert.equal(events.find(event => event[0] === 'canary-run')[2],
    path.join(os.homedir(), '.lovera1n', 'runs'));
});

test('wrong game or missing banner confirmation prevents FS runner', async () => {
  const first = fakeDependencies({probe: async () => ({gameId: 'other', runtimeReady: true})});
  await assert.rejects(run([switchIp], first.dependencies), /native REPL is not ready/);
  assert.equal(first.events.some(event => event[0] === 'lua'), false);
  const wrongProfile = fakeDependencies({probe: async () => ({
    gameId: 'gravity-circuit', runtimeReady: true,
    nativeProfile: 'gravity-circuit-v1.0',
  })});
  await assert.rejects(run([switchIp], wrongProfile.dependencies), /native REPL is not ready/);
  assert.equal(wrongProfile.events.some(event => event[0] === 'lua'), false);
  const second = fakeDependencies({executeLua: async () => '-> wrong\n'});
  await assert.rejects(run([switchIp], second.dependencies), /did not confirm/);
  assert.equal(second.events.some(event => event[0] === 'full-run'), false);
});
