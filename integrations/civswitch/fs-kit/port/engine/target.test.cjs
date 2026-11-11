const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {parseHello, MAGIC} = require('./lib/connection.cjs');
const {NativeClient, callRecord, RESPONSE_BYTES} = require('./lib/native.cjs');
const {build} = require('./shared/frames.cjs');
const {loadTarget, nativeOffset, validateArtifacts, assertAppSupported, assertFullSupported,
  materializeTarget} = require('./shared/target.cjs');
const {parseArguments} = require('./run.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns2jb-civ7-target-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const functions = JSON.parse(fs.readFileSync(path.join(__dirname, 'shared/sdk-functions.json'), 'utf8'));
  Object.assign(functions, {
    memcpy: {offset: 0x100, bytes: '00000000'},
    memmove: {offset: 0x5f0000, bytes: '00000000'},
    svcQueryMemory: {offset: 0x168b0c, bytes: 'e10f1ff8c10000d4'},
    crc32: {offset: 0x200, bytes: '00000000'},
    svcCancelSynchronization: {offset: 0x300, bytes: '00000000'},
    svcGetThreadId: {offset: 0x304, bytes: '00000000'},
    svcWaitForAddress: {offset: 0x308, bytes: '00000000'},
    svcGetInfo: {offset: 0x30c, bytes: '00000000'}
  });
  fs.writeFileSync(path.join(root, 'sdk-functions.civ7.json'), JSON.stringify(functions));
  const layout = JSON.parse(fs.readFileSync(path.join(__dirname, '../sdk-layout.civ7.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'sdk-layout.civ7.json'), JSON.stringify(layout));
  fs.mkdirSync(path.join(root, 'civ7-app'));
  for (const name of ['thread-code.json', 'event-code.json', 'timing-code.json', 'hash-code.json',
    'sdk-proxy-code.json', 'thread-scheduling-reference.json', 'compat-affinity-reference.json'])
    fs.copyFileSync(path.join(__dirname, '../civ7-app', name), path.join(root, 'civ7-app', name));
  return root;
}

function civHello(target, overrides = {}) {
  const sdk = 0x4012300000, main = 0x3012300000;
  const got = target.hello.gotOffsetFromMain === null ? 0 : main + target.hello.gotOffsetFromMain;
  const values = [MAGIC, 1, 2, 0x5012340000, 0x80000, main, sdk,
    got, sdk + nativeOffset('memmove', target), 0, 0,
    0, 0, 0, 0, target.hello.sdkCrc32];
  const bytes = Buffer.alloc(128);
  values.forEach((value, index) => bytes.writeBigUInt64LE(BigInt(value), index * 8));
  for (const [word, value] of Object.entries(overrides)) bytes.writeBigUInt64LE(BigInt(value), Number(word) * 8);
  return bytes;
}

test('Civ7 HELLO uses generated memmove, configured GOT/CRC, and zero optional fields', t => {
  const target = loadTarget('civ7', {portRoot: fixture(t)});
  Object.assign(target.hello, {gotOffsetFromMain: 0x2000, sdkCrc32: 0x12345678});
  const bytes = civHello(target);
  const parsed = parseHello(bytes, target);
  assert.equal(parsed.target, 'civ7');
  assert.equal(parsed.sdkCrc32, 0x12345678);
  assert.throws(() => parseHello(civHello(target, {8: 0x4012300100n}), target), /Unsupported Civilization VII/);
  assert.throws(() => parseHello(civHello(target, {9: 0x5010100000n}), target), /unresolved HELLO backing/);
  assert.throws(() => parseHello(civHello(target, {15: 0n}), target), /Unsupported Civilization VII/);
});

test('checked-in Civ7 HELLO profile pairs without a SmileBASIC GOT', () => {
  const target = loadTarget('civ7');
  const parsed = parseHello(civHello(target), target);
  assert.equal(parsed.got, 0);
  assert.equal(parsed.memmove, 0x4012300000 + 0x522830);
  assert.equal(parsed.sdkCrc32, 157086863);
});

test('Civ7 native records accept offsets beyond the SmileBASIC text mapping', t => {
  const target = loadTarget('civ7', {portRoot: fixture(t)});
  const offset = nativeOffset('memmove', target);
  assert.equal(offset, 0x5f0000);
  assert.ok(offset >= loadTarget('smilebasic').sdkBytes);
  const bytes = callRecord(0x4012300000, offset, [0, 0, 0, 0], target);
  assert.equal(bytes.readBigUInt64LE(), 0x4012300000n + BigInt(offset));
  assert.throws(() => callRecord(0x4012300000, target.sdkBytes, [0, 0, 0, 0], target), /Invalid SDK function/);
});

test('Civ7 six-argument calls require verification and use one continuation', async t => {
  const target = loadTarget('civ7', {portRoot: fixture(t)});
  const packets = [];
  const connection = {
    async write(bytes) { packets.push(Buffer.from(bytes)); },
    async read(size) { assert.equal(size, RESPONSE_BYTES); return Buffer.alloc(size); },
  };
  const addresses = {scratch: 0x5012340000, sdk: 0x4012300000, target: 'civ7'};
  const native = new NativeClient(connection, addresses, target);
  const fn = 0x4012304000;
  assert.throws(() => native.callAddress6(fn, 1n, 2n, 3n, 4n, 5n, 6n), /has not been verified/);
  native.functions.add(fn);
  await native.callAddress6(fn, 1n, 2n, 3n, 4n, 5n, 6n);
  assert.equal(native.calls, 1);
  assert.equal(packets.length, 1);
  const packet = packets[0];
  assert.equal(packet.readBigUInt64LE(0), BigInt(fn));
  assert.equal(packet.readBigUInt64LE(0x28), 2n);
  assert.deepEqual(Array.from({length: 4}, (_, index) => packet.readBigUInt64LE(8 + index * 8)),
    [1n, 2n, 3n, 4n]);
  assert.equal(packet.readBigUInt64LE(0x30), 5n);
  assert.equal(packet.readBigUInt64LE(0x38), 6n);
  await assert.rejects(native.callAddress6(fn, 1n), /Exactly six/);
});

test('Civ7 worker frames use configured memcpy, call4 slot, and high SDK call targets', t => {
  const target = loadTarget('civ7', {portRoot: fixture(t)});
  target.thread = {mode: 'direct-nnos'};
  const base = 0x5010000000, sdk = 0x4012300000;
  const calls = [{function: sdk + 0x5f1000, args: [{u32: base + 0x4000}, 0, 0, 0]}];
  const code = {loadTable: {offset: 0x400}, call4: {offset: 0x404, loadFromSelfOffset: 112},
    saveResult64: {offset: 0x408}, exit: {offset: 0x40c}, exitContinuation: {offset: 0x13e094}};
  const {frame, proof} = build(base, sdk, calls, code, false, target);
  assert.equal(proof.nativeCalls, 2);
  assert.equal(frame.readBigUInt64LE(proof.stackOffset + 0x140 + 0x128), BigInt(sdk + 0x13e094));
  assert.equal(frame.readBigUInt64LE(proof.tablesOffset + 0x80), BigInt(sdk + nativeOffset('memcpy', target)));
  assert.equal(frame.readBigUInt64LE(proof.tablesOffset + 0x100 + 0x80), BigInt(sdk + 0x5f1000));
  const original = build(base, sdk, calls, {...code, call4: {offset: 0x404}}, false, target);
  assert.equal(original.frame.readBigUInt64LE(original.proof.tablesOffset + 0x78),
    BigInt(sdk + nativeOffset('memcpy', target)));
  assert.equal(original.frame.readBigUInt64LE(original.proof.tablesOffset + 0x100 + 0x78),
    BigInt(sdk + 0x5f1000));
});

test('Civ7 raw-svc frames exit through the svcExitThread gadget and preflight passes', t => {
  const target = loadTarget('civ7', {portRoot: fixture(t)});
  target.thread = {mode: 'raw-svc'};
  const base = 0x5010000000, sdk = 0x4012300000;
  const calls = [{function: sdk + 0x5f1000, args: [0, 0, 0, 0]}];
  const code = {loadTable: {offset: 0x400}, call4: {offset: 0x404},
    saveResult64: {offset: 0x408}, exit: {offset: 0x40c}, rawExitContinuation: {offset: 0x168b4c}};
  const {frame, proof} = build(base, sdk, calls, code, false, target);
  assert.equal(frame.readBigUInt64LE(proof.stackOffset + 0x128), BigInt(sdk + 0x168b4c));
  const checkedIn = loadTarget('civ7');
  assert.equal(checkedIn.thread.mode, 'raw-svc');
  assertFullSupported(checkedIn);
});

test('missing and unresolved Civ7 entries fail with their artifact or gate named', t => {
  const root = fixture(t), missing = path.join(root, 'missing');
  fs.mkdirSync(missing);
  assert.throws(() => nativeOffset('memcpy', loadTarget('civ7', {portRoot: missing})),
    /Missing civ7 SDK function table.*sdk-functions\.civ7\.json/i);
  const target = loadTarget('civ7', {portRoot: root});
  Object.assign(target.hello, {gotOffsetFromMain: 0x2000, sdkCrc32: 1});
  target.sessionManager = {stateSize: 0x800, stateOffset: 0x5c, stateValue: 3};
  target.thread = {mode: 'pthread'};
  target.crc32 = {function: null, expected: 1};
  assert.throws(() => assertAppSupported(target), /civ7 SDK CRC-32 function/i);
  target.crc32 = {function: 'crc32', expected: 1};
  assertFullSupported(Object.assign(target, {
    nativeFunctions: {...target.nativeFunctions, eventSyscallScan: 0x400, syscallCapture: 0x500},
    romMount: {implementationVtableOffset: 0x600, storageWrapperVtableOffset: 0x604, serviceVtableOffset: 0x608},
    retainedCaptureBytes: 0x4d8000,
    retainedCaptureOffset: 0x500000,
    smServiceOffset: 0x12a0,
    programIds: {host: ['0100000000000000'], ro: '0x0400000000000037', allowedRo: ['0x0400000000000037']}
  }));
});

test('Civ7 artifacts are validated and materialized without modifying their sources', async t => {
  const root = fixture(t), target = loadTarget('civ7', {portRoot: root});
  const artifacts = validateArtifacts(target);
  assert.equal(Object.keys(artifacts.app).length, 7);
  const destination = path.join(root, 'run');
  fs.mkdirSync(path.join(destination, 'shared'), {recursive: true});
  fs.mkdirSync(path.join(destination, 'switch2/app'), {recursive: true});
  const before = fs.readFileSync(artifacts.sdkFunctions.file);
  const copies = await materializeTarget(target, destination);
  assert.equal(copies.length, 9);
  assert.deepEqual(fs.readFileSync(path.join(destination, 'shared/sdk-functions.json')), before);
  assert.deepEqual(fs.readFileSync(artifacts.sdkFunctions.file), before);
  for (const name of Object.keys(artifacts.app))
    assert.ok(fs.existsSync(path.join(destination, 'switch2/app', name)));
});

test('runner target arguments default to Civ7 and retain the SmileBASIC fallback', () => {
  const previous = process.env.NS2_TARGET;
  delete process.env.NS2_TARGET;
  try {
    assert.deepEqual(parseArguments([]), {targetName: 'civ7', hostArgs: [], appOnly: false, rpcMode: false, dumpFirmware: false});
    assert.equal(parseArguments(['--target', 'smilebasic', '192.0.2.1']).targetName, 'smilebasic');
    assert.equal(parseArguments(['--target=civ7', '--rpc']).rpcMode, true);
    assert.equal(parseArguments(['--app-only']).appOnly, true);
    assert.throws(() => parseArguments(['--app-only', '--rpc']), /cannot be combined/);
    assert.throws(() => parseArguments(['--app-only', '--dump-firmware']), /cannot be combined/);
    assert.throws(() => parseArguments(['--target', 'other']), /Unsupported target/);
    assert.throws(() => parseArguments(['--target']), /requires civ7 or smilebasic/);
  } finally {
    if (previous === undefined) delete process.env.NS2_TARGET;
    else process.env.NS2_TARGET = previous;
  }
});
