const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { once } = require('node:events');
const { relay } = require('./relay.cjs');

async function server(onConnection) {
  const listener = net.createServer(onConnection);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  return listener;
}

async function close(listener) {
  await new Promise((resolve) => listener.close(resolve));
}

test('the relay preserves binary FS traffic in both directions', async () => {
  const greeting = Buffer.alloc(128);
  greeting.writeUInt32LE(0x31545344, 0);
  greeting[125] = 0xff;
  const request = Buffer.from([0x00, 0xff, 0x80, 0x10, 0x00]);
  let receivedGreeting;
  let receivedRequest;
  const bridge = await server((socket) => {
    socket.write(greeting);
    socket.on('data', (chunk) => { receivedRequest = chunk; socket.end(); });
  });
  const host = await server((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length >= greeting.length) {
        receivedGreeting = Buffer.concat(chunks);
        socket.end(request);
      }
    });
  });
  try {
    const bytes = await relay({
      switchIp: '127.0.0.1',
      macIp: '127.0.0.1',
      bridgePort: bridge.address().port,
      hostPort: host.address().port,
    });
    assert.deepEqual(receivedGreeting, greeting);
    assert.deepEqual(receivedRequest, request);
    assert.deepEqual(bytes, { toHost: 128, toSwitch: request.length });
  } finally {
    await Promise.all([close(bridge), close(host)]);
  }
});

test('the relay rejects missing endpoints and never reports a short greeting as success', async () => {
  assert.throws(() => relay({ switchIp: 'host', macIp: '127.0.0.1' }), /IPv4/);
  assert.throws(() => relay({ switchIp: '127.0.0.1', macIp: '127.0.0.1', bridgePort: 0 }), /port/);
  const bridge = await server((socket) => socket.end(Buffer.alloc(127)));
  const host = await server((socket) => socket.resume());
  try {
    await assert.rejects(relay({
      switchIp: '127.0.0.1', macIp: '127.0.0.1',
      bridgePort: bridge.address().port, hostPort: host.address().port,
      connectTimeoutMs: 1000,
    }), /128-byte FS greeting/);
  } finally {
    await Promise.all([close(bridge), close(host)]);
  }
});

test('an explicit stop closes both relay sockets without replaying a request', async () => {
  let bridgeConnections = 0, hostConnections = 0;
  const bridge = await server(socket => {bridgeConnections++; socket.resume();});
  const host = await server(socket => {hostConnections++; socket.resume();});
  const controller = new AbortController();
  const bridgeConnected = once(bridge, 'connection');
  const hostConnected = once(host, 'connection');
  try {
    const pending = relay({switchIp: '127.0.0.1', macIp: '127.0.0.1',
      bridgePort: bridge.address().port, hostPort: host.address().port,
      signal: controller.signal});
    await Promise.all([bridgeConnected, hostConnected]);
    controller.abort();
    await assert.rejects(pending, /relay stopped/);
    assert.equal(bridgeConnections, 1);
    assert.equal(hostConnections, 1);
  } finally {
    await Promise.all([close(bridge), close(host)]);
  }
});
