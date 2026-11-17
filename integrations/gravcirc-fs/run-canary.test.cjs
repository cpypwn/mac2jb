const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const path = require('node:path');
const {args, parseStatus, ensureBridge, reserveAppArena, startHost, main} = require('./run-canary.cjs');
const profile = require('./profile.v1.2.1.json');

const live = {runtimeReady: true, gameId: 'gravity-circuit',
  nativeProfile: 'gravity-circuit-v1.2.1'};
const status = (stage, hostIp = '10.0.0.205', port = 39380, crc = profile.sdkCrc32) =>
  `-> GC_BRIDGE_V1\t${stage}\t${hostIp}\t${port}\t${profile.gameProfile}\t${crc}\n`;

test('canary runner accepts explicit console and Mac IPv4 addresses', () => {
  assert.deepEqual(args(['10.0.0.199', '10.0.0.205']).switchIp, '10.0.0.199');
  assert.throws(() => args(['10.0.0.199']), /Usage/);
  assert.throws(() => args(['not-an-address', '10.0.0.205']), /Usage/);
});

test('bridge status accepts one complete measured record', () => {
  assert.deepEqual(parseStatus(status('accept')), {
    stage: 'accept', hostIp: '10.0.0.205', port: 39380,
    gameProfile: profile.gameProfile, sdkCrc32: profile.sdkCrc32,
  });
  assert.deepEqual(parseStatus('-> GC_BRIDGE_V1\tabsent\n'), {stage: 'absent'});
  assert.throws(() => parseStatus(status('accept') + status('accept')), /not recognized/);
  assert.throws(() => parseStatus('-> GC_BRIDGE_V1\taccept\n'), /incomplete/);
});

test('reuses only an idle bridge with the exact profile and Mac address', async () => {
  let stageCalls = 0;
  const result = await ensureBridge({switchIp: '10.0.0.199', macIp: '10.0.0.205', profile}, {
    probe: async () => live,
    executeLua: async () => status('accept'),
    stage: async () => {stageCalls++; throw Error('should not restage');},
  });
  assert.equal(result.bridge.reused, true);
  assert.equal(stageCalls, 0);
  for (const reply of [status('read-request'), status('accept', '10.0.0.99'),
    status('accept', '10.0.0.205', 39381), status('accept', '10.0.0.205', 39380, 1)]) {
    await assert.rejects(ensureBridge({switchIp: '10.0.0.199', macIp: '10.0.0.205', profile}, {
      probe: async () => live, executeLua: async () => reply,
    }), /busy|different measured profile/);
  }
});

test('stages a new bridge only when no active bridge exists', async () => {
  const calls = [];
  const result = await ensureBridge({switchIp: '10.0.0.199', macIp: '10.0.0.205', profile}, {
    probe: async () => live,
    executeLua: async () => '-> GC_BRIDGE_V1\tabsent\n',
    stage: async input => {calls.push(input); return {bridge: {status: 'listening', port: 39380}};},
  });
  assert.equal(result.bridge.port, 39380);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profile.hostIp, '10.0.0.205');
});

test('app arena reservation is bounded and requires a checked REPL response', async () => {
  const requests = [];
  const arena = await reserveAppArena({switchIp: '10.0.0.199', mode: 'app'}, {
    executeLua: async request => {
      requests.push(request);
      return '-> GC_APP_ARENA_V1\t7340032\t524288\n';
    },
  });
  assert.deepEqual(arena, {base: 0x700000, bytes: 0x80000});
  assert.match(requests[0].source, /reserveAppArena\(524288\)/);
  await assert.rejects(reserveAppArena({switchIp: '10.0.0.199', mode: 'geometry'}, {
    executeLua: async () => '-> GC_APP_ARENA_V1\t7340032\t524288\n',
  }), /not reserved/);
  await assert.rejects(reserveAppArena({switchIp: '10.0.0.199', mode: 'app'}, {
    executeLua: async () => '-> GC_APP_ARENA_V1\t7340033\t524288\n',
  }), /not reserved/);
});

test('host readiness matches the configured Gravity Circuit display name', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  const host = startHost('10.0.0.205', 1000, {spawnProcess: () => child});
  child.stdout.write('Waiting for Gravity Circuit v1.2.1 at 10.0.0.205:39380.\n');
  await host.ready;
  child.emit('close', 0, null);
  assert.deepEqual(await host.finished, {code: 0, signal: null});
});

test('geometry host selects the bounded measurement mode', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  let command, settings;
  const runRoot = path.resolve('lovera1n-run-root');
  const host = startHost('10.0.0.205', 1000, {
    runRoot,
    spawnProcess: (_node, args, options) => {command = args; settings = options; return child;}
  }, 'geometry');
  assert.deepEqual(command.slice(1), ['--target', 'gravcirc', '--geometry-only', '10.0.0.205']);
  assert.equal(settings.env.NS2_WRITE_SIZE_MAX, '524288');
  assert.equal(settings.env.NS2_RUN_ROOT, runRoot);
  child.stdout.write('Waiting for Gravity Circuit v1.2.1 at 10.0.0.205:39380.\n');
  await host.ready;
  child.emit('close', 0, null);
  await host.finished;
});

test('canary geometry guard runs before any console probe', async () => {
  let probed = false;
  await assert.rejects(main(['10.0.0.199', '10.0.0.205'], {
    assertCanarySupported: () => {},
    requireGeometryProof: () => {throw Error('geometry proof absent');},
    probe: async () => {probed = true; throw Error('console contacted');},
  }, 'canary'), /geometry proof absent/);
  assert.equal(probed, false);
});

test('write-size host reserves a large arena and hard-caps the child at 512 KiB', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  let command, settings;
  const host = startHost('10.0.0.205', 1000, {
    spawnProcess: (_node, args, options) => {command = args; settings = options; return child;}
  }, 'write-size');
  assert.deepEqual(command.slice(1), ['--target', 'gravcirc', '--write-size-only', '10.0.0.205']);
  assert.equal(settings.env.NS2_WRITE_SIZE_MAX, '524288');
  child.stdout.write('Waiting for Gravity Circuit v1.2.1 at 10.0.0.205:39380.\n');
  await host.ready;
  child.emit('close', 0, null);
  await host.finished;
  const arena = await reserveAppArena({switchIp: '10.0.0.199', mode: 'write-size'}, {
    executeLua: async request => {
      assert.match(request.source, /reserveAppArena\(37748736\)/);
      return '-> GC_APP_ARENA_V1\t7340032\t37748736\n';
    }
  });
  assert.equal(arena.bytes, 0x2400000);
});

test('one-shot host passes one selected candidate and reserves the full app arena', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  let command, settings;
  const host = startHost('10.0.0.205', 1000, {
    retrySize: 0x200000,
    spawnProcess: (_node, args, options) => {command = args; settings = options; return child;}
  }, 'one-mib');
  assert.deepEqual(command.slice(1), ['--target', 'gravcirc', '--one-mib-retry', '10.0.0.205']);
  assert.equal(settings.env.NS2_ONE_SHOT_SIZE, '2097152');
  child.stdout.write('Waiting for Gravity Circuit v1.2.1 at 10.0.0.205:39380.\n');
  await host.ready;
  child.emit('close', 0, null);
  await host.finished;
  const arena = await reserveAppArena({switchIp: '10.0.0.199', mode: 'one-mib'}, {
    executeLua: async request => {
      assert.match(request.source, /reserveAppArena\(37748736\)/);
      return '-> GC_APP_ARENA_V1\t7340032\t37748736\n';
    }
  });
  assert.equal(arena.bytes, 0x2400000);
});

test('split MiB host reserves the full app arena without one-shot size selection', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  let command, settings;
  const host = startHost('10.0.0.205', 1000, {
    spawnProcess: (_node, args, options) => {command = args; settings = options; return child;}
  }, 'split-mib');
  assert.deepEqual(command.slice(1), ['--target', 'gravcirc', '--split-mib', '10.0.0.205']);
  assert.equal(settings.env.NS2_ONE_SHOT_SIZE, undefined);
  child.stdout.write('Waiting for Gravity Circuit v1.2.1 at 10.0.0.205:39380.\n');
  await host.ready;
  child.emit('close', 0, null);
  await host.finished;
  const arena = await reserveAppArena({switchIp: '10.0.0.199', mode: 'split-mib'}, {
    executeLua: async request => {
      assert.match(request.source, /reserveAppArena\(37748736\)/);
      return '-> GC_APP_ARENA_V1\t7340032\t37748736\n';
    }
  });
  assert.equal(arena.bytes, 0x2400000);
});

test('application host selects the qualification mode', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  let command;
  const host = startHost('10.0.0.205', 1000, {
    spawnProcess: (_node, args) => {command = args; return child;}
  }, 'app');
  assert.deepEqual(command.slice(1), ['--target', 'gravcirc', '--app-only', '10.0.0.205']);
  child.stdout.write('Waiting for Gravity Circuit v1.2.1 at 10.0.0.205:39380.\n');
  await host.ready;
  child.emit('close', 0, null);
  await host.finished;
});

test('application run qualifies timing before the native host accepts the relay', async () => {
  const order = [];
  const proof = {measuredFrequency: 31264192, nonce: '0123456789abcdef'};
  let requests = 0;
  const result = await main(['10.0.0.199', '10.0.0.205'], {
    probe: async () => {order.push('probe'); return live;},
    executeLua: async () => {
      requests++;
      order.push(requests === 1 ? 'status' : 'arena');
      return requests === 1 ? status('accept') :
        '-> GC_APP_ARENA_V1\t7340032\t524288\n';
    },
    qualifyTimingProof: async () => {order.push('timing'); return proof;},
    beforeHostStart: async () => {order.push('banner');},
    startHost: (_macIp, _timeout, dependencies, mode) => {
      order.push('host');
      assert.equal(mode, 'app');
      assert.deepEqual(dependencies.timingProof, proof);
      return {ready: Promise.resolve(), finished: Promise.resolve({code: 0, signal: null}),
        stop() {order.push('stop');}};
    },
    relay: async () => {order.push('relay'); return {requests: 1};},
  }, 'app');
  assert.deepEqual(order, ['probe', 'status', 'arena', 'timing', 'banner', 'host', 'relay', 'stop']);
  assert.deepEqual(result.traffic, {requests: 1});
});

test('a rejected console banner prevents the canary host from starting', async () => {
  const order = [];
  let requests = 0;
  await assert.rejects(main(['10.0.0.199', '10.0.0.205'], {
    probe: async () => {order.push('probe'); return live;},
    executeLua: async () => {
      requests++;
      order.push(requests === 1 ? 'status' : 'arena');
      return requests === 1 ? status('accept') :
        '-> GC_APP_ARENA_V1\t7340032\t524288\n';
    },
    qualifyTimingProof: async () => {
      order.push('timing');
      return {measuredFrequency: 31264192};
    },
    beforeHostStart: async () => {order.push('banner'); throw Error('banner rejected');},
    startHost: () => {order.push('host'); throw Error('host must not start');},
  }, 'app'), /banner rejected/);
  assert.deepEqual(order, ['probe', 'status', 'arena', 'timing', 'banner']);
});

test('full host starts one held RPC run with timing proof and isolated signals', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', 0, null);
  let command, options;
  const proof = {gameProfile: profile.gameProfile, elapsedTicks: 31250000};
  const host = startHost('10.0.0.205', 1000, {
    timingProof: proof,
    spawnProcess: (_node, argv, settings) => {
      command = argv; options = settings; return child;
    }
  }, 'full');
  assert.deepEqual(command.slice(1), ['--target', 'gravcirc', '--rpc', '10.0.0.205']);
  assert.equal(options.detached, true);
  assert.deepEqual(JSON.parse(options.env.NS2_GC_TIMING_PROOF), proof);
  child.stdout.write('Waiting for Gravity Circuit v1.2.1 at 10.0.0.205:39380.\n');
  await host.ready;
  child.stdout.write('4/4 verified. Gravity Circuit v1.2.1 RPC and FS memory endpoint remain live while this process and the app stay open.\n');
  await host.heldReady;
  host.stop();
  assert.deepEqual(await host.finished, {code: 0, signal: null});
});

test('full host rejects exit before held RPC and requires timing proof', async () => {
  assert.throws(() => startHost('10.0.0.205', 1000, {}, 'full'), /timing proof/);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  const host = startHost('10.0.0.205', 1000, {
    timingProof: {gameProfile: profile.gameProfile}, spawnProcess: () => child
  }, 'full');
  child.stdout.write('Waiting for Gravity Circuit v1.2.1 at 10.0.0.205:39380.\n');
  await host.ready;
  child.emit('close', 1, null);
  await assert.rejects(host.heldReady, /before held RPC was ready/);
  assert.deepEqual(await host.finished, {code: 1, signal: null});
});
