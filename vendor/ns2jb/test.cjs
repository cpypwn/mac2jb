// These exercise host bytes and TCP only. Console execution is tested on hardware.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {Connection, parseHello, pairingCode, MAGIC} = require('./engine/lib/connection.cjs');
const {callRecord} = require('./engine/lib/native.cjs');
const {build} = require('./engine/shared/frames.cjs');
const {plan} = require('./engine/switch2/memory/signed-cache-plan.cjs');
const {chooseHost, addresses, connectCommand} = require('./run.cjs');
const {isUtf8} = require('node:buffer');

async function channel(t, timeout = 1000) {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const incoming = once(server, 'connection');
  const peer = net.createConnection(server.address().port, '127.0.0.1');
  peer.on('error', () => {});
  const [socket] = await incoming;
  const connection = new Connection(socket, timeout);
  t.after(async () => {
    connection.close(); peer.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {connection, peer};
}

test('fragmented and coalesced TCP records preserve every byte', async t => {
  const {connection, peer} = await channel(t);
  const expected = crypto.randomBytes(32784), tail = crypto.randomBytes(40);
  const pending = connection.read(expected.length);
  await assert.rejects(connection.read(1), /already pending/);
  peer.write(expected.subarray(0, 3));
  await new Promise(setImmediate);
  peer.write(expected.subarray(3, 113));
  await new Promise(setImmediate);
  peer.write(Buffer.concat([expected.subarray(113), tail]));
  assert.deepEqual(await pending, expected);
  assert.deepEqual(await connection.read(tail.length), tail);
});

test('a timeout permanently closes the connection', async t => {
  const {connection} = await channel(t, 25);
  await assert.rejects(connection.read(1), /timed out/);
  await assert.rejects(connection.read(1), /timed out/);
  await assert.rejects(connection.write(Buffer.from([1])), /timed out/);
});

test('a disconnect cannot turn a partial record into a reply', async t => {
  const {connection, peer} = await channel(t);
  const pending = connection.read(16);
  peer.end(Buffer.alloc(8));
  await assert.rejects(pending, /disconnected|closed/);
  await assert.rejects(connection.read(8), /disconnected|closed/);
});

function hello(platform, token) {
  const sdk = 0x4012300000, main = 0x3012300000;
  const values = [MAGIC, 1, platform, 0x5012340000, 0x80000, main, sdk,
    main + 0x9c92f0, sdk + 0x5872f0, 0x5010100000, 0x5010100070, ...token, 3925528160];
  const bytes = Buffer.alloc(128);
  values.forEach((value, index) => bytes.writeBigUInt64LE(BigInt(value), index * 8));
  return bytes;
}

test('pairing binds the fresh token, platform and bootstrap layout', () => {
  const token = pairingCode();
  assert.equal(token.length, 4);
  assert.ok(token.every(value => Number.isSafeInteger(value) && value >= 0 && value < 2 ** 48));
  for (const platform of [2]) {
    const bytes = hello(platform, token);
    assert.equal(parseHello(bytes, token).platform, platform);
    assert.throws(() => parseHello(hello(1, token), token), /console type/);
    const other = [...token]; other[0] = (other[0] + 1) % 2 ** 48;
    assert.throws(() => parseHello(bytes, other), /Pairing code/);
    bytes.writeBigUInt64LE(0x80001n, 32);
    assert.throws(() => parseHello(bytes, token), /bootstrap layout/);
  }
});

test('native records preserve all 64 bits and reject malformed arguments', () => {
  const bytes = callRecord(0x4012300000, 0x100, [0xffffffffffffffffn, 0x8000000000000000n, 1, 0]);
  assert.equal(bytes.length, 40);
  assert.equal(bytes.readBigUInt64LE(), 0x4012300100n);
  assert.equal(bytes.readBigUInt64LE(8), 0xffffffffffffffffn);
  assert.equal(bytes.readBigUInt64LE(16), 0x8000000000000000n);
  assert.throws(() => callRecord(0x4012300000, 3, [0, 0, 0, 0]));
  assert.throws(() => callRecord(0x4012300000, 0x5e1000, [0, 0, 0, 0]));
  assert.throws(() => callRecord(0x4012300000, 0, [-1, 0, 0, 0]));
  assert.throws(() => callRecord(0x4012300000, 0, [1n << 64n, 0, 0, 0]));
  assert.throws(() => callRecord(0x4012300000, 0, [2 ** 60, 0, 0, 0]));
  assert.throws(() => callRecord(0x4012300000, 0, ['1.5', 0, 0, 0]));
  assert.equal(callRecord(0x4012300000, 0, ['18446744073709551615', 0, 0, 0]).readBigUInt64LE(8),
    0xffffffffffffffffn);
});

test('unused cache entries accept only zero fill or the known pathname fill', () => {
  const {unusedTail} = require('./engine/switch2/retained/cache-shape.cjs');
  assert.equal(unusedTail(Buffer.alloc(0x5a0)), true);
  for (const prefix of [[], [0], [0, 0, 0x40, 1, 0], [0, 0, 0x40, 1, 0, 0]]) {
    const bytes = Buffer.alloc(0x5a0);
    Buffer.from([...prefix, ...Buffer.from('AAA/AAAA/AAA')]).copy(bytes, 0x30);
    assert.equal(unusedTail(bytes), true);
    bytes[0x180] = 1;
    assert.equal(unusedTail(bytes), false);
  }
  const bytes = Buffer.alloc(0x5a0);
  bytes.writeBigUInt64LE(0x4012340000n, 0x90);
  assert.equal(unusedTail(bytes), false);
  bytes.fill(0x41, 0x30);
  assert.equal(unusedTail(bytes), false);
});

test('signed prefixes satisfy encoding, bucket and address constraints', () => {
  for (const target of [0x4000000000, 0x4012fffe40, 0x510102c000, 0x6f1fffc000, 0x7fffffc000]) {
    for (const cycle of [0x28000, 0x500000]) {
      const result = plan(target, 144827272, cycle), bytes = result.bytes;
      const offset = bytes.readBigInt64LE(), base = bytes.readBigUInt64LE(32);
      assert.ok(isUtf8(bytes) && ![0, 0x2f, 0x5c].some(byte => bytes.includes(byte)));
      assert.equal((offset >> 14n) % BigInt(cycle / 0x4000), 0n);
      assert.equal(BigInt.asUintN(64, base + BigInt(result.readOffset) - offset), BigInt(target));
      assert.ok(offset < 0n && result.readOffset + 0x4000 <= 144827272);
    }
  }
  assert.throws(() => plan(2 ** 39, 144827272));
  assert.throws(() => plan(0x4000000000, 1));
});

test('payloads have their declared hashes and contain NSO images', () => {
  for (const folder of ['engine/switch2/ro/payload']) {
    const directory = path.join(__dirname, folder);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
    const bytes = fs.readFileSync(path.join(directory, 'main'));
    assert.equal(bytes.subarray(0, 4).toString(), 'NSO0');
    assert.equal(bytes.length, manifest.payloadBytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), manifest.payloadSha256);
  }
});


test('one host address and one BASIC command select the fixed Switch 2 path', async () => {
  assert.equal(await chooseHost(['192.0.2.10']), '192.0.2.10');
  assert.equal(connectCommand('192.0.2.10', [1, 2, 3, 281474976710655]),
    'V=START(REDACTED)');
  await assert.rejects(chooseHost(['switch1']), /Usage/);
  await assert.rejects(chooseHost(['192.0.2.10', 'extra']), /Usage/);
  assert.deepEqual(addresses({a: [
    {family: 'IPv4', address: '127.0.0.1', internal: true},
    {family: 'IPv4', address: '10.1.0.2', netmask: '255.255.255.0'},
    {family: 'IPv4', address: '10.1.0.2', netmask: '255.255.255.0'},
    {family: 'IPv4', address: '100.64.0.1', netmask: '255.255.255.255'},
    {family: 'IPv4', address: '169.254.1.2', netmask: '255.255.0.0'},
    {family: 'IPv6', address: '::1'},
  ]}), ['10.1.0.2']);
});

test('a stop prevents the next operation but still permits restoration', async t => {
  const {RunControl, StopRequested} = require('./engine/switch2/memory/run-control.cjs');
  const snapshots = [], control = new RunControl({id: 'host-test', save: async () => snapshots.push({...control.state})});
  await control.start();
  t.after(async () => {if (control.started) await control.close();});
  const directory = control.state.directory;
  await control.begin('first');
  await control.end('first');
  control.stopSignal();
  await assert.rejects(control.begin('next'), StopRequested);
  control.retire();
  await control.begin('restore');
  await control.end('restore');
  await control.close();
  assert.equal(fs.existsSync(directory), false);
  assert.equal(control.state.mode, 'closed');
  assert.ok(snapshots.some(row => row.mode === 'stopping'));
  assert.ok(snapshots.some(row => row.mode === 'retiring' && row.checkpoint === 'restore'));
});

test('the engine has only local or Node dependencies, all present in the package', () => {
  const root = __dirname, files = ['run.cjs'];
  function walk(folder) {
    for (const item of fs.readdirSync(path.join(root, folder), {withFileTypes: true})) {
      const name = folder + '/' + item.name;
      if (item.isDirectory()) walk(name);
      else files.push(name);
    }
  }
  walk('engine');
  const present = new Set(files), generated = new Set(['engine/connection.json', 'engine/switch2/app/mounts.json']);
  assert.ok(!files.some(name => name.includes('switch1')));
  for (const name of files.filter(name => name.endsWith('.cjs'))) {
    for (const match of fs.readFileSync(path.join(root, name), 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      const dependency = match[1];
      if (!dependency.startsWith('.')) {
        assert.ok(dependency.startsWith('node:'), name + ': external dependency ' + dependency);
      } else {
        const relative = path.relative(root, path.resolve(root, path.dirname(name), dependency));
        assert.ok(present.has(relative) || generated.has(relative), name + ': missing ' + relative);
      }
    }
  }
});
