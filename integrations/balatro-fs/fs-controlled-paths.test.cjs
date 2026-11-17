const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {claimClone} = require('./fs-attempt-packets.cjs');
const {content} = require('./marker-content-control.cjs');
const {readPaddedClone, readControlledPaths} = require('./fs-controlled-paths.cjs');

const nonce = 'aabbccddeeff0011';
const sdk = 0x57390b4000;
const scratch = 0x4964010000;

function fixture() {
  const manager = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
  const evidence = {gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256, nonce, sdkBase: `0x${sdk.toString(16)}`,
    mount: {name: 'save', accessor: '0x49646472a0',
      implementation: '0x4964689680', service: '0x49646896a0',
      serviceVtable: `0x${(sdk + 0xcec000).toString(16)}`,
      serviceVtableOffset: '0xcec000',
      manager: `0x${manager.toString(16)}`, objectId: 412,
      guardsVerified: true},
    proxy: {object: `0x${(sdk +
      Number(BigInt(captured.fsProxy.objectSdkOffset))).toString(16)}`,
    manager: `0x${manager.toString(16)}`, objectId: 153},
    sessionManager: {stateSize: 2048, stateValue: 3,
      slot: '0x4964a0a000', borrowedHandle: 118},
    absentPathResult: '0x00000202',
    status: 'read-only; mounted domain not cloned'};
  const memory = new Map();
  const native = {addresses: {sdk, scratch},
    write: async (address, bytes) => {memory.set(address, Buffer.from(bytes));},
    read: async (address, length) => {
      const bytes = memory.get(address) || Buffer.alloc(length);
      return Buffer.from(bytes.subarray(0, length));
    },
    callAddress() {}, callAddress6() {}, exchange() {}, verifyFunction() {}};
  const transport = new BalatroCloneTransport({native, evidence,
    inspectLive: async () => evidence});
  const cloneHandle = 311;
  transport.ownedHandles.add(cloneHandle);
  const reply = Buffer.alloc(256);
  reply.writeUInt32LE(4, 0);
  reply.writeUInt32LE(0x80000004, 4);
  reply.writeUInt32LE(1 << 5, 8);
  reply.writeUInt32LE(cloneHandle, 12);
  reply.write('SFCO', 16);
  const clone = claimClone({transport, controlReply: reply});
  const marker = content(nonce);
  const calls = [];
  let shouldFailRead = false;
  transport.sendOwned = async (handle, bytes) => {
    assert.ok(transport.ownedHandles.has(handle));
    const command = bytes.readUInt32LE(24);
    calls.push({handle, command});
    if (handle === cloneHandle && command === 7) {
      const path = memory.get(transport.pathAddress);
      assert.equal(path.length, 0x800);
      if (path.includes(Buffer.from('absent'))) {
        return {result: 0x202, moves: [], copies: [], data: Buffer.alloc(0)};
      }
      const data = Buffer.alloc(4);
      data.writeUInt32LE(1);
      return {result: 0, moves: [], copies: [], data};
    }
    if (handle === cloneHandle && command === 8) {
      return {result: 0, moves: [312], copies: [], data: Buffer.alloc(0)};
    }
    if (handle === 312 && command === 4) {
      const data = Buffer.alloc(8);
      data.writeBigUInt64LE(16n);
      return {result: 0, moves: [], copies: [], data};
    }
    if (handle === 312 && command === 0) {
      if (shouldFailRead) throw Error('ambiguous file read');
      memory.set(transport.dataAddress, marker);
      const data = Buffer.alloc(8);
      data.writeBigUInt64LE(16n);
      return {result: 0, moves: [], copies: [], data};
    }
    throw Error('unexpected owned request');
  };
  transport.closeOwned = async handle => {
    assert.equal(handle, 312);
    assert.equal(transport.ownedHandles.delete(handle), true);
    calls.push({handle, command: 'close'});
    return {closed: true};
  };
  return {transport, clone, calls,
    failRead: () => {shouldFailRead = true;}};
}

test('padded marker and absent paths return exact bounded controls', async () => {
  const run = fixture();
  const marker = await readPaddedClone({...run, nonce, which: 'marker'});
  const absent = await readPaddedClone({...run, nonce, which: 'absent'});
  assert.deepEqual(marker, {result: 0, type: 1, bytes: content(nonce)});
  assert.deepEqual(absent, {result: 0x202, type: null, bytes: null});
  assert.deepEqual(run.calls.map(row => row.command), [7, 8, 4, 0, 'close', 7]);
  assert.deepEqual([...run.transport.ownedHandles], [311]);
});

test('ambiguous padded read quarantines but still closes known file handle', async () => {
  const run = fixture();
  run.failRead();
  await assert.rejects(readPaddedClone({...run, nonce, which: 'marker'}),
    error => error.resourceStateUncertain === true);
  assert.deepEqual([...run.transport.ownedHandles], [311]);
  assert.equal(run.calls.at(-1).command, 'close');
});

test('full controlled path set reads original, clone and padded states', async () => {
  const run = fixture();
  const marker = {result: 0, type: 1, bytes: content(nonce)};
  const absent = {result: 0x202, type: null, bytes: null};
  run.transport.readOriginal = async path => path.includes('absent') ? absent : marker;
  run.transport.readClone = async (_, path) => path.includes('absent') ? absent : marker;
  const result = await readControlledPaths({...run, nonce});
  for (const name of ['original', 'cloned', 'padded']) {
    assert.deepEqual(result[name], {marker, absent});
  }
  assert.equal(result.explicitSaveWrites, 0);
});
