const assert = require('node:assert/strict');
const {test} = require('node:test');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {ENTRY_BYTES, makePathPacket, parseEntries,
  createOwnedSaveIo, probeSaveRoot, snapshotSaveTree, compareSaveTrees} =
  require('./fs-save-tree-audit.cjs');

function directoryEntry(name, type, size = 0) {
  const row = Buffer.alloc(ENTRY_BYTES);
  row.write(name);
  row[0x304] = type;
  row.writeBigUInt64LE(BigInt(size), 0x308);
  return row;
}

function fakeIo(fileData) {
  const dirs = {'/': [
    {name: '.lovegame', type: 0, size: 0},
    {name: 'sub', type: 0, size: 0}],
  '/.lovegame': [
    ...(fileData['/.lovegame/bl_log.txt'] ?
      [{name: 'bl_log.txt', type: 1,
        size: fileData['/.lovegame/bl_log.txt'].length}] : []),
    {name: 'bl_phase.txt', type: 1,
      size: fileData['/.lovegame/bl_phase.txt'].length}],
  '/sub': [{name: 'marker.bin', type: 1,
    size: fileData['/sub/marker.bin'].length}]};
  const active = new Set();
  const events = [];
  function open(role, path) {
    const lease = {role, path, cursor: 0};
    active.add(lease);
    events.push(`open:${path}`);
    return lease;
  }
  return {events, active,
    openDirectory: async path => open('directory', path),
    openFile: async path => open('file', path),
    readDirectory: async lease => {
      const rows = dirs[lease.path].slice(lease.cursor, lease.cursor + 4);
      lease.cursor += rows.length;
      return rows;
    },
    fileSize: async lease => fileData[lease.path].length,
    readFile: async (lease, offset, size) =>
      fileData[lease.path].subarray(offset, offset + size),
    close: async lease => {events.push(`close:${lease.path}`); active.delete(lease);},
    assertClosed: () => assert.equal(active.size, 0)};
}

function files(log = 'rpc 1\n') {
  return {'/.lovegame/bl_log.txt': Buffer.from(log),
    '/.lovegame/bl_phase.txt': Buffer.from('phase'),
    '/sub/marker.bin': Buffer.from('BALFSv01abcdefgh')};
}

test('new path IPC accepts only owned read operations', () => {
  const packet = makePathPacket(9, Buffer.alloc(4), 0x1234000);
  assert.equal(packet.toString('ascii', 16, 20), 'SFCI');
  assert.equal(packet.readUInt32LE(24), 9);
  assert.equal(packet.subarray(0, 36).toString('hex'),
    '040001000900000000000006004023015346434900000000090000000000000000000000');
  const directory = makePathPacket(9, Buffer.from([3, 0, 0, 0]), 0x1234000);
  assert.equal(directory.subarray(0, 36).toString('hex'),
    '040001000900000000000006004023015346434900000000090000000000000003000000');
  assert.throws(() => makePathPacket(2, Buffer.alloc(0), 0x1234000),
    /invalid path request/);
});

test('directory entries require exact bounded names and types', () => {
  assert.deepEqual(parseEntries(directoryEntry('.lovegame', 0), 1),
    [{name: '.lovegame', type: 0, size: 0}]);
  // DirectoryEntry is 0x310 bytes: name[0x301], type at 0x304, size at 0x308.
  const recordedShape = Buffer.alloc(0x620);
  Buffer.from('bl_log.txt\0').copy(recordedShape, 0);
  recordedShape.writeUInt32LE(1, 0x304);
  recordedShape.writeBigUInt64LE(0x1234n, 0x308);
  Buffer.from('cache\0').copy(recordedShape, 0x310);
  recordedShape.writeUInt32LE(0, 0x310 + 0x304);
  assert.deepEqual(parseEntries(recordedShape, 2), [
    {name: 'bl_log.txt', type: 1, size: 0x1234},
    {name: 'cache', type: 0, size: 0},
  ]);
  assert.throws(() => parseEntries(recordedShape.subarray(0, 0x61f), 2),
    /incomplete/);
  assert.throws(() => parseEntries(directoryEntry('../outside', 1), 1),
    /name is unsafe/);
  assert.throws(() => parseEntries(directoryEntry('file', 3), 1),
    /type or size/);
});

test('snapshot walks cloned save tree and hashes each bounded file', async () => {
  const io = fakeIo(files());
  const result = await snapshotSaveTree({io});
  assert.equal(result.complete, true);
  assert.deepEqual(result.directories, ['/', '/.lovegame', '/sub']);
  assert.equal(result.files['/.lovegame/bl_log.txt'].size, 6);
  assert.equal(result.files['/sub/marker.bin'].prefixBytes, 16);
  assert.equal(io.active.size, 0);
  assert.ok(io.events.includes('close:/sub/marker.bin'));
});

test('first root protocol probe stops after one batch and cannot certify a tree', async () => {
  const io = fakeIo(files());
  const result = await probeSaveRoot({io});
  assert.equal(result.complete, false);
  assert.equal(result.coverage, 'first-root-directory-batch-only');
  assert.equal(result.entries.length, 2);
  assert.equal(io.active.size, 0);
  assert.deepEqual(io.events, ['open:/', 'close:/']);
  assert.throws(() => compareSaveTrees(result, result), /complete/);
});

test('comparison permits only proven append to RPC log', async () => {
  const before = await snapshotSaveTree({io: fakeIo(files())});
  const after = await snapshotSaveTree({io: fakeIo(files('rpc 1\nrpc 2\n')),
    logPrefixBytes: before.files['/.lovegame/bl_log.txt'].size});
  const result = compareSaveTrees(before, after);
  assert.deepEqual(result.changedPaths, []);
  assert.equal(result.logPrefixVerified, true);
  assert.equal(result.logGrowthBytes, 6);
  assert.equal(result.logState, 'append-only');
});

test('absent RPC log is accepted only when both complete inventories lack it', async () => {
  const withoutLog = files();
  delete withoutLog['/.lovegame/bl_log.txt'];
  const before = await snapshotSaveTree({io: fakeIo(withoutLog)});
  const after = await snapshotSaveTree({io: fakeIo(withoutLog)});
  const compared = compareSaveTrees(before, after);
  assert.equal(before.logPresent, false);
  assert.deepEqual(compared.changedPaths, []);
  assert.equal(compared.logState, 'absent-on-both');
  assert.equal(compared.logPrefixVerified, false);
  assert.equal(compared.logGrowthBytes, 0);
  const appeared = await snapshotSaveTree({io: fakeIo(files())});
  assert.throws(() => compareSaveTrees(before, appeared),
    /appeared or disappeared/);
  assert.throws(() => compareSaveTrees(appeared, before),
    /appeared or disappeared/);
});

test('comparison catches same-size changes and rejects rewritten log prefix', async () => {
  const before = await snapshotSaveTree({io: fakeIo(files())});
  const changed = files('rpc 1\nrpc 2\n');
  changed['/sub/marker.bin'][0] ^= 1;
  const after = await snapshotSaveTree({io: fakeIo(changed),
    logPrefixBytes: before.files['/.lovegame/bl_log.txt'].size});
  assert.deepEqual(compareSaveTrees(before, after).changedPaths,
    ['save:/sub/marker.bin']);
  changed['/.lovegame/bl_log.txt'] = Buffer.from('bad 1\nrpc 2\n');
  const badLog = await snapshotSaveTree({io: fakeIo(changed),
    logPrefixBytes: before.files['/.lovegame/bl_log.txt'].size});
  assert.throws(() => compareSaveTrees(before, badLog), /append-only/);
});

test('limits fail closed and close opened handles', async () => {
  const io = fakeIo(files());
  await assert.rejects(snapshotSaveTree({io,
    limits: {entries: 2, files: 2, directories: 2,
      depth: 1, fileBytes: 20, totalBytes: 40}}), /entry count/);
  assert.equal(io.active.size, 0);
  const broken = fakeIo(files());
  broken.readFile = async () => {throw Error('read failed');};
  await assert.rejects(snapshotSaveTree({io: broken}), /read failed/);
  assert.equal(broken.active.size, 0);
});

test('owned clone IO sends read-only directory IPC and closes moved handle once', async () => {
  const transport = Object.create(BalatroCloneTransport.prototype);
  transport.initialized = true;
  transport.evidence = {sessionManager: {borrowedHandle: 3}};
  transport.ownedHandles = new Set([5]);
  transport.pathAddress = 0x10000;
  transport.dataAddress = 0x22000;
  const requests = [];
  transport.native = {write: async (address, bytes) => {
      assert.equal(address, transport.pathAddress);
      assert.equal(bytes.length, 0x600);
      assert.equal(bytes.subarray(0, 2).toString('hex'), '2f00');
    },
    read: async (address, size) => {
      assert.equal(address, transport.dataAddress);
      return directoryEntry('bl_log.txt', 1, 10).subarray(0, size);
    }};
  transport.sendOwned = async (handle, bytes) => {
    const command = bytes.readUInt32LE(handle === 5 ? 24 : 40);
    requests.push({handle, command});
    if (handle === 5) return {result: 0, copies: [], moves: [6]};
    assert.equal(bytes.subarray(0, 48).toString('hex'),
      '0400000108000000400c0000002002000000000000000000000000000000000053464349000000000000000000000000');
    const data = Buffer.alloc(8);
    data.writeBigUInt64LE(1n);
    return {result: 0, copies: [], moves: [], data};
  };
  transport.closeOwned = async handle => {
    assert.equal(handle, 6);
    transport.ownedHandles.delete(handle);
    return {closed: true};
  };
  const io = createOwnedSaveIo(transport, 5);
  const lease = await io.openDirectory('/');
  assert.deepEqual(await io.readDirectory(lease),
    [{name: 'bl_log.txt', type: 1, size: 10}]);
  await io.close(lease);
  io.assertClosed();
  assert.deepEqual(requests, [{handle: 5, command: 9},
    {handle: 6, command: 0}]);
  await assert.rejects(io.close(lease), /replay/);
  await assert.rejects(io.openDirectory('/bad\0path'), /outside the cloned root/);
  await assert.rejects(io.openDirectory('/' + 'a'.repeat(0x600)),
    /outside the cloned root/);
});

test('owned file IPC uses the pinned non-domain read layout', async () => {
  const transport = Object.create(BalatroCloneTransport.prototype);
  transport.initialized = true;
  transport.evidence = {sessionManager: {borrowedHandle: 3}};
  transport.ownedHandles = new Set([5]);
  transport.pathAddress = 0x10000;
  transport.dataAddress = 0x22000;
  const body = Buffer.from('BALFSv01abcdefgh');
  let sent = 0;
  transport.native = {write: async (address, bytes) => {
      assert.equal(address, transport.pathAddress);
      assert.equal(bytes.subarray(0, 12).toString(), '/marker.bin\0');
    },
    read: async (address, size) => {
      assert.equal(address, transport.dataAddress);
      assert.equal(size, body.length);
      return Buffer.from(body);
    }};
  transport.sendOwned = async (handle, bytes) => {
    sent++;
    if (handle === 5) {
      assert.equal(bytes.readUInt32LE(24), 8);
      assert.equal(bytes.readUInt32LE(32), 1);
      return {result: 0, copies: [], moves: [6]};
    }
    assert.equal(handle, 6);
    if (sent === 2) {
      assert.equal(bytes.readUInt32LE(24), 4);
      const data = Buffer.alloc(8);
      data.writeBigUInt64LE(BigInt(body.length));
      return {result: 0, copies: [], moves: [], data};
    }
    assert.equal(bytes.subarray(0, 16).toString('hex'),
      '040000010e0000001000000000200200');
    assert.equal(bytes.toString('ascii', 32, 36), 'SFCI');
    assert.equal(bytes.readUInt32LE(40), 0);
    assert.equal(bytes.readBigUInt64LE(48), 0n);
    assert.equal(bytes.readBigUInt64LE(56), 0n);
    assert.equal(bytes.readBigUInt64LE(64), BigInt(body.length));
    const data = Buffer.alloc(8);
    data.writeBigUInt64LE(BigInt(body.length));
    return {result: 0, copies: [], moves: [], data};
  };
  transport.closeOwned = async handle => {
    assert.equal(handle, 6);
    transport.ownedHandles.delete(handle);
    return {closed: true};
  };
  const io = createOwnedSaveIo(transport, 5);
  const lease = await io.openFile('/marker.bin');
  assert.equal(await io.fileSize(lease), body.length);
  assert.deepEqual(await io.readFile(lease, 0, body.length), body);
  await io.close(lease);
  io.assertClosed();
  assert.equal(sent, 3);
});
