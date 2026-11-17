const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { executeLua, MAX_REQUEST_BYTES, MAX_REPLY_BYTES } = require('./repl-client.cjs');
const { SOURCE, parseReply, probe } = require('./probe.cjs');

async function withServer(onConnection, run) {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('repl client sends one Lua chunk and reads the reply after half-close', async () => {
  let received = '';
  await withServer((socket) => {
    socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
    socket.on('end', () => {
      socket.write('-> GC_PROBE_V1\tgravity-circuit\tGravity Circuit\tserving\tOther\t');
      socket.end('gravity-circuit-v1.2.1\t10.0.0.91\tabsent\n');
    });
  }, async (port) => {
    const result = await probe({ host: '127.0.0.1', port });
    assert.equal(received, SOURCE);
    assert.deepEqual(result, {
      gameId: 'gravity-circuit',
      gameName: 'Gravity Circuit',
      state: 'serving',
      jitOs: 'Other',
      nativeProfile: 'gravity-circuit-v1.2.1',
      ip: '10.0.0.91',
      recognizedGame: true,
      recognizedProfile: true,
      runtimeReady: true,
      fsBridgeReady: false,
    });
  });
});

test('probe does not claim an unsupported native profile is ready', () => {
  const result = parseReply('-> GC_PROBE_V1\tgravity-circuit\tGravity Circuit\tserving\tOther\tunknown\t10.0.0.91\taccept\n');
  assert.equal(result.recognizedProfile, false);
  assert.equal(result.runtimeReady, false);
  assert.equal(result.fsBridgeReady, false);
});

test('probe reports an active bridge without claiming FS access', () => {
  const result = parseReply('-> GC_PROBE_V1\tgravity-circuit\tGravity Circuit\tserving\tOther\tgravity-circuit-v1.2.1\t10.0.0.91\taccept\n');
  assert.equal(result.runtimeReady, true);
  assert.equal(result.fsBridgeReady, true);
});

test('probe rejects missing runtime and remote Lua errors', () => {
  assert.throws(() => parseReply('-> GC_PROBE_V1\tmissing-runtime\n'), /runtime is unavailable/);
  assert.throws(() => parseReply('error: test failure\n'), /test failure/);
  assert.throws(() => parseReply('-> unexpected\n'), /not recognized/);
});

test('repl client enforces request and reply caps', async () => {
  assert.throws(() => executeLua({ host: '127.0.0.1', source: 'x'.repeat(MAX_REQUEST_BYTES + 1) }), /exceeds/);
  await withServer((socket) => {
    socket.resume();
    socket.on('end', () => socket.end(Buffer.alloc(MAX_REPLY_BYTES + 1, 120)));
  }, async (port) => {
    await assert.rejects(executeLua({ host: '127.0.0.1', port, source: 'return 1' }), /reply exceeds/);
  });
});

test('repl client times out and validates its endpoint', async () => {
  assert.throws(() => executeLua({ host: 'localhost', source: 'return 1' }), /IPv4/);
  assert.throws(() => executeLua({ host: '127.0.0.1', port: 0, source: 'return 1' }), /port/);
  await withServer(() => {}, async (port) => {
    await assert.rejects(executeLua({ host: '127.0.0.1', port, source: 'return 1', timeoutMs: 30 }), /timed out/);
  });
});
