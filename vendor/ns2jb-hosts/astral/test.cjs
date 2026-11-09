// These exercise host bytes and TCP only. Console execution is tested on hardware.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {EventEmitter} = require('node:events');
const {Connection, parseHello, MAGIC} = require('./engine/lib/connection.cjs');
const {callRecord} = require('./engine/lib/native.cjs');
const {build} = require('./engine/shared/frames.cjs');
const {plan} = require('./engine/switch2/memory/signed-cache-plan.cjs');
const {chooseHost, addresses, connectCommand, prepareDumpDirectory,
  startEngine, checkEngine, waitForRpcStop} = require('./run.cjs');
const {waitForRelease} = require('./engine/switch2/hold.cjs');
const {serve} = require('./engine/lib/bridge.cjs');
const {request: rpcRequest} = require('./rpc.cjs');
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

test('held RPC ends on operator signal or console disconnect without leaking listeners', async () => {
  for (const [event, expected] of [['SIGINT', 'SIGINT'], ['SIGTERM', 'SIGTERM'], ['close', 'disconnected']]) {
    const signals = new EventEmitter(), socket = new EventEmitter();
    const waiting = waitForRpcStop({socket}, signals);
    (event === 'close' ? socket : signals).emit(event);
    assert.equal(await waiting, expected);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.equal(socket.listenerCount('close'), 0);
  }
});

test('held FS endpoint waits for an explicit release or parent disconnect', async () => {
  for (const event of ['release', 'disconnect']) {
    const channel = new EventEmitter();
    channel.send = () => {};
    channel.connected = true;
    const pending = waitForRelease(channel);
    if (event === 'release') channel.emit('message', {type: 'release'});
    else channel.emit('disconnect');
    assert.equal(await pending, event === 'release' ? 'release' : 'parent-disconnected');
    assert.equal(channel.listenerCount('message'), 0);
    assert.equal(channel.listenerCount('disconnect'), 0);
  }
});

test('held engine remains alive until the runner releases it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns2jb-held-engine-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'switch2'));
  fs.writeFileSync(path.join(root, 'switch2/pipeline.cjs'),
    "process.on('message', value => {if (value?.type === 'release') process.exit(0)});" +
    "process.send({type: 'held-ready', session: 'test'});\n");
  const engine = await startEngine(root, null, true);
  assert.equal((await engine.ready).session, 'test');
  assert.equal(engine.child.exitCode, null);
  checkEngine(await engine.release());
  assert.equal(engine.child.exitCode, 0);
  assert.ok(fs.existsSync(path.join(root, 'run.log')));
});

test('held RPC client reaches the local bridge and reports request errors', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns2jb-rpc-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const native = {connection: {error: null}, calls: 7};
  const bridge = await serve(native);
  t.after(() => bridge.close());
  const file = path.join(root, 'connection.json');
  fs.writeFileSync(file, JSON.stringify({port: bridge.port}));
  assert.deepEqual(await rpcRequest(root, {command: 'status'}), {ready: true, calls: 7});
  await assert.rejects(rpcRequest(root, {command: 'missing'}), /Unknown bridge command/);
});

function hello(platform) {
  const sdk = 0x4012300000, main = 0x3012300000;
  const values = [MAGIC, 1, platform, 0x5012340000, 0x80000, main, sdk,
    main + 0x9c92f0, sdk + 0x5872f0, 0x5010100000, 0x5010100070,
    0, 0, 0, 0, 3925528160];
  const bytes = Buffer.alloc(128);
  values.forEach((value, index) => bytes.writeBigUInt64LE(BigInt(value), index * 8));
  return bytes;
}

test('console greeting binds the platform and bootstrap layout', () => {
  for (const platform of [2]) {
    const bytes = hello(platform);
    assert.equal(parseHello(bytes).platform, platform);
    assert.throws(() => parseHello(hello(1)), /console type/);
    bytes.writeBigUInt64LE(0x80001n, 32);
    assert.throws(() => parseHello(bytes), /bootstrap layout/);
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

test('read-only NCM list request decodes bounded system-program keys', () => {
  const {listInput, parse} = require('./engine/switch2/ro/ncm.cjs');
  const input = listInput();
  assert.equal(input.length, 32);
  assert.equal(input[0], 1);
  assert.equal(input[1], 0);
  assert.equal(input.readBigUInt64LE(24), 0xffffffffffffffffn);
  const output = Buffer.alloc(1024 * 16), data = Buffer.alloc(8);
  output.writeBigUInt64LE(0x040000000000000an);
  output.writeUInt32LE(123, 8);
  output[12] = 1;
  output.writeBigUInt64LE(0x0400000000001000n, 16);
  output.writeUInt32LE(456, 24);
  output[28] = 1;
  data.writeInt32LE(2, 0);
  data.writeInt32LE(2, 4);
  const result = parse({result: 0, data}, output);
  assert.equal(result.complete, true);
  assert.deepEqual(result.keys.map(key => key.id),
    ['0x040000000000000a', '0x0400000000001000']);
  assert.deepEqual(result.keys.map(key => key.version), [123, 456]);
  data.writeInt32LE(1025, 4);
  assert.throws(() => parse({result: 0, data}, output), /count or output buffer/);
});


test('one host address and one BASIC command select the fixed Switch 2 path', async () => {
  assert.equal(await chooseHost(['192.0.2.10']), '192.0.2.10');
  assert.equal(connectCommand('192.0.2.10'),
    'V=START(39380,192,0,2,10)');
  assert.equal(connectCommand('192.0.2.10', 9),
    'V=START(39380,192,0,2,10,0,0,0,0)');
  assert.throws(() => connectCommand('192.0.2.10', 8), /NS2_BASIC_ARITY/);
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

test('firmware dumps use a dedicated directory and clear only marked prior dumps', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ns2jb-dump-test-'));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const root = path.join(base, 'dumps');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'user-file'), 'keep');
  await assert.rejects(prepareDumpDirectory(root), /unrecognized nonempty/);
  assert.equal(fs.readFileSync(path.join(root, 'user-file'), 'utf8'), 'keep');
  fs.unlinkSync(path.join(root, 'user-file'));
  assert.deepEqual(await prepareDumpDirectory(root), {root, cleaned: true});
  fs.writeFileSync(path.join(root, 'old-capture'), 'old');
  assert.deepEqual(await prepareDumpDirectory(root), {root, cleaned: true});
  assert.equal(fs.existsSync(path.join(root, 'old-capture')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.ns2jb-firmware-dump.json'))).kind,
    'ns2jb-system-code-dump');
  fs.rmSync(root, {recursive: true});
  fs.symlinkSync(base, root);
  await assert.rejects(prepareDumpDirectory(root), /symlink/);
});

test('the engine has only local or Node dependencies, all present in the package', () => {
  const root = __dirname, files = ['run.cjs', 'rpc.cjs', 'dump-firmware.cjs'];
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

test('startup gap cleanup matches every root entry beginning NS2_GAP', () => {
  const {gapScratch, scratchDeleteCommand} = require('./engine/switch2/cleanup-scratch.cjs');
  assert.equal(gapScratch({name: 'NS2_GAP_1792870235231', type: 0}), true);
  assert.equal(gapScratch({name: 'NS2_GAP_notes', type: 0}), true);
  assert.equal(gapScratch({name: 'NS2_GAP_file', type: 1}), true);
  assert.equal(gapScratch({name: 'other_NS2_GAP', type: 0}), false);
  assert.equal(scratchDeleteCommand(0), 4);
  assert.equal(scratchDeleteCommand(1), 1);
  assert.throws(() => scratchDeleteCommand(2), /unsupported/);
});
