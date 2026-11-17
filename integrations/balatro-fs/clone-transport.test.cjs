const assert = require('node:assert/strict');
const test = require('node:test');
const {runCloneControl} = require('./clone-control.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const abi = require('./fs-write-abi.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {RESULT_OFFSET} = require('./worker-frame.cjs');

const CLOSE_FRAME_OFFSET = 0x30000;

const sdk = 0x57390b4000;
const manager = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
const evidence = {
  gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
  sdkCodeSha256: profile.sdkCode.sha256, sdkCrc32: profile.sdkCode.offlineCrc32,
  nonce: '070e86b659d3b0e4', sdkBase: `0x${sdk.toString(16)}`,
  mount: {name: 'save', node: '0x41fb8472a8', accessor: '0x41fb8472a0',
    implementation: '0x41fb889660', service: '0x41fb8b22d0',
    serviceVtable: `0x${(sdk + 0xce89a0).toString(16)}`,
    serviceVtableOffset: '0xce89a0', manager: `0x${manager.toString(16)}`,
    objectId: 152, guardsVerified: true},
  proxy: {object: `0x${(sdk + Number(BigInt(captured.fsProxy.objectSdkOffset))).toString(16)}`,
    manager: `0x${manager.toString(16)}`, objectId: 146},
  sessionManager: {stateSize: 2048, stateValue: 3, slot: '0x5739e069c0',
    borrowedHandle: 459250},
  absentPathResult: '0x00000202', status: 'read-only; mounted domain not cloned',
};
const scratch = 0x4200000000;
const ownedClone = 900001;
const ownedFile = 900002;
const fileAccessor = scratch + 0x24000;
const fileAdapter = scratch + 0x24040;
const fileProxy = scratch + 0x24080;
const fileManagedProxy = scratch + 0x240c0;
const fileSession = scratch + 0x24100;
const rawSessionHandle = 0x600001;

function reply({result = 0, moves = [], data = Buffer.alloc(0)}) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(((4 + Math.ceil(data.length / 4)) |
    (moves.length ? 0x80000000 : 0)) >>> 0, 4);
  let at = 8;
  if (moves.length) {
    bytes.writeUInt32LE(moves.length << 5, at);
    at += 4;
    for (const handle of moves) {bytes.writeUInt32LE(handle, at); at += 4;}
  }
  at = (at + 15) & ~15;
  bytes.write('SFCO', at);
  bytes.writeUInt32LE(result, at + 8);
  data.copy(bytes, at + 16);
  return bytes;
}

// A CMIF domain reply: 16-byte domain out-header (object count) followed by the
// SFCO, matching domain.response(..., {domain: true}).
function domainReply({result = 0, objects = []}) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(4, 4);
  bytes.writeUInt32LE(objects.length, 16);
  bytes.write('SFCO', 32);
  bytes.writeUInt32LE(result, 40);
  for (let i = 0; i < objects.length; i++) bytes.writeUInt32LE(objects[i], 48 + 4 * i);
  return bytes;
}

function fakeNative() {
  const memory = Buffer.alloc(0x80000);
  const state = {marker: null, path: null, closed: [], borrowedUsed: false,
    seenPackets: [], verified: [], writes: [], threads: 0};
  const address = number => number - scratch;
  const readString = number => {
    const at = address(number);
    const end = memory.indexOf(0, at);
    return memory.toString('utf8', at, end);
  };
  const directOffset = pointer => pointer - sdk;
  const resultSlot = scratch + CLOSE_FRAME_OFFSET + RESULT_OFFSET;
  const native = {
    addresses: {sdk, scratch}, output: scratch + 0x4040,
    async verifyFunction(pointer, bytes) {
      assert.ok(pointer >= sdk);
      assert.ok(bytes.length >= 4);
      state.verified.push(pointer - sdk);
    },
    async write(pointer, bytes) {
      assert.ok(pointer >= scratch && pointer + bytes.length <= scratch + memory.length);
      bytes.copy(memory, address(pointer));
      state.writes.push([pointer, Buffer.from(bytes)]);
    },
    async read(pointer, count) {
      assert.ok(pointer >= scratch && pointer + count <= scratch + memory.length);
      return Buffer.from(memory.subarray(address(pointer), address(pointer) + count));
    },
    async callAddress(pointer, ...args) {
      const offset = directOffset(pointer);
      if (offset === 0x9ddcc) { state.verified.push(offset); return {result: 0n}; } // FileAccessor release
      const name = Object.keys(abi.functions).find(key => abi.functions[key].offset === offset);
      assert.ok(name, `unknown direct call ${offset}`);
      if (name === 'entryType') {
        const file = readString(args[1]);
        memory.writeUInt32LE(state.marker && file.includes('marker') ? 1 : 0x5a17eacc,
          address(args[0]));
        return {result: state.marker && file.includes('marker') ? 0n : 0x202n};
      }
      if (name === 'createFile') {
        state.marker = Buffer.alloc(16);
        return {result: 0n};
      }
      if (name === 'openFile') {
        memory.writeBigUInt64LE(BigInt(fileAccessor), address(args[0]));
        memory.writeBigUInt64LE(BigInt(fileAdapter), address(fileAccessor + 0x10));
        memory.writeBigUInt64LE(BigInt(fileProxy), address(fileAdapter + 0x08));
        memory.writeBigUInt64LE(BigInt(fileManagedProxy), address(fileProxy + 0x10));
        memory.writeBigUInt64LE(BigInt(fileSession), address(fileManagedProxy + 0x10));
        memory.writeUInt32LE(rawSessionHandle, address(fileSession));
        return {result: 0n};
      }
      if (name === 'getFileSize') {
        memory.writeBigUInt64LE(16n, address(args[0]));
        return {result: 0n};
      }
      if (name === 'readFile') {
        state.marker.copy(memory, address(args[2]));
        return {result: 0n};
      }
      if (name === 'deleteFile') {
        state.marker = null;
        return {result: 0n};
      }
      return {result: 0n};
    },
    async callAddress6(pointer, ...args) {
      const offset = directOffset(pointer);
      if (offset === abi.functions.writeFile.offset) {
        assert.equal(args[0], BigInt(fileAccessor));
        assert.equal(args[3], 16);
        state.marker = Buffer.from(memory.subarray(address(args[2]), address(args[2]) + 16));
        return {result: 0n};
      }
      if (offset === profile.symbols.svcCreateThread.offset) {
        const threadHandle = 0x500000 + (++state.threads);
        memory.writeUInt32LE(threadHandle, address(args[0]));
        return {result: 0n};
      }
      throw new Error(`unexpected six-argument call ${offset.toString(16)}`);
    },
    async call(offset, ...args) {
      if (offset === profile.symbols.svcStartThread.offset) {
        return {result: 0n};
      }
      if (offset === profile.symbols.svcWaitSynchronization.offset) {
        // Simulate the worker thread finishing: saveResult64 wrote 0 (success).
        memory.writeBigUInt64LE(0n, address(resultSlot));
        return {result: 0n};
      }
      if (offset === profile.symbols.svcCloseHandle.offset) {
        state.closed.push(args[0]);
        return {result: 0n};
      }
      throw new Error(`unexpected native call ${offset.toString(16)}`);
    },
    async exchange(operations, data) {
      assert.equal(operations[0].offset, profile.symbols.svcSend.offset);
      assert.equal(operations[1].offset, profile.symbols.memmove.offset);
      const handle = operations[0].args[2];
      const frame = Buffer.alloc(0x8080);
      data.copy(frame, 0x80);
      frame.copy(memory, 0x40000);
      const request = Buffer.from(memory.subarray(address(operations[0].args[0]),
        address(operations[0].args[0]) + 256));
      state.seenPackets.push({handle, request, frame});
      let result;
      if (handle === evidence.sessionManager.borrowedHandle) {
        state.borrowedUsed = true;
        if ((request.readUInt32LE() & 0xffff) === 5) {
          // domain.control(1, objectId) = CloneCurrentObject
          result = reply({moves: [ownedClone]});
        } else {
          // pathDomainPacket = CMIF DeleteFile on the direct mounted object
          state.marker = null;
          result = domainReply({result: 0});
        }
      } else if (handle === ownedClone) {
        const command = request.readUInt32LE(request.indexOf('SFCI') + 8);
        if (command === 1) {
          state.marker = null;
          result = reply({result: 0});
        } else if (command === 7 || command === 8) {
          const file = readString(scratch + 0x20000);
          if (command === 7) result = file.includes('marker') ?
            reply({data: Buffer.from([1, 0, 0, 0])}) : reply({result: 0x202});
          else result = reply({moves: [ownedFile]});
        } else throw new Error('unexpected cloned filesystem command');
      } else if (handle === ownedFile) {
        const command = request.readUInt32LE(request.indexOf('SFCI') + 8);
        if (command === 4) result = reply({data: Buffer.from([16, 0, 0, 0, 0, 0, 0, 0])});
        else if (command === 0) {
          state.marker.copy(memory, 0x22000);
          result = reply({data: Buffer.from([16, 0, 0, 0, 0, 0, 0, 0])});
        } else throw new Error('unexpected cloned file command');
      } else throw new Error('IPC targeted an unowned handle');
      return {results: [0n, BigInt(native.output)], output: result};
    },
  };
  return {native, state};
}

test('Balatro IPC packet survives native request-frame replacement', async () => {
  const {native, state} = fakeNative();
  const transport = new BalatroCloneTransport({native, evidence,
    inspectLive: async () => evidence});
  const request = Buffer.alloc(256, 0xa5);
  request.writeUInt32LE(4);
  await transport.sendPacket(evidence.sessionManager.borrowedHandle, request);
  assert.equal(state.writes.some(([address]) => address === transport.ipcAddress), false);
  assert.equal(state.seenPackets.length, 1);
  assert.deepEqual(state.seenPackets[0].frame.subarray(0x1000, 0x1100), request);
  assert.deepEqual(state.seenPackets[0].request, request);
  assert.equal(state.seenPackets[0].frame.subarray(0x1100, 0x1200).every(byte => byte === 0), true);
});

test('Balatro transport verifies exact cloned content and closes only moved handles', async () => {
  const {native, state} = fakeNative();
  const transport = new BalatroCloneTransport({native, evidence,
    inspectLive: async () => evidence});
  const result = await runCloneControl({evidence, transport,
    nonceBytes: () => Buffer.from('0011223344556677', 'hex')});
  assert.equal(result.ownedCloneVerified, true);
  assert.equal(result.cleanup, 'verified');
  assert.notDeepEqual(state.marker, Buffer.alloc(16));
  assert.equal(state.borrowedUsed, true);
  assert.equal(state.threads, 3);
  assert.deepEqual(state.closed, [0x500001, 0x500002, 0x500003]);
  assert.ok(!state.closed.includes(evidence.sessionManager.borrowedHandle));
  assert.equal(state.verified.length, 18);
  const pathRequests = state.seenPackets.filter(item => item.handle === ownedClone);
  assert.ok(pathRequests.length >= 3);
  for (const {request} of pathRequests) {
    assert.equal(request.readUInt32LE() & 0x10004, 0x10004);
    assert.equal(request.readUInt32LE(8) & 0x3ff0000, 0x3010000);
    assert.equal(request.readUInt32LE(12), (scratch + 0x20000) >>> 0);
  }
});

test('Balatro transport rejects borrowed handle closure and non-owned paths', async () => {
  const {native} = fakeNative();
  const transport = new BalatroCloneTransport({native, evidence,
    inspectLive: async () => evidence});
  await assert.rejects(() => transport.closeOwned(evidence.sessionManager.borrowedHandle),
    /borrowed|not transferred/);
  assert.throws(() => transport.registerRawOwned(evidence.sessionManager.borrowedHandle),
    /borrowed/);
  await assert.rejects(() => transport.closeRawOwned(0x600002),
    /unregistered/);
  await assert.rejects(() => transport.deleteMarker('save:/other.bin'),
    /nonce-owned/);
  await assert.rejects(() => transport.readClone(ownedClone, '/etc/passwd'),
    /nonce-owned/);
});

test('Balatro raw root handle closes through the same worker path once', async () => {
  const {native, state} = fakeNative();
  const transport = new BalatroCloneTransport({native, evidence,
    inspectLive: async () => evidence});
  const root = 0x600002;
  transport.registerRawOwned(root);
  const closed = await transport.closeRawOwned(root);
  assert.deepEqual(closed, {closed: true, closeResult: 0,
    method: 'worker-svcCloseHandle'});
  assert.equal(state.threads, 1);
  assert.equal(transport.rawOwnedHandles.has(root), false);
  await assert.rejects(() => transport.closeRawOwned(root), /already attempted/);
  assert.throws(() => transport.registerRawOwned(root), /already owned/);
});

test('ambiguous raw worker close is never replayed', async () => {
  const {native} = fakeNative();
  const transport = new BalatroCloneTransport({native, evidence,
    inspectLive: async () => evidence});
  const root = 0x600002;
  let attempts = 0;
  transport.registerRawOwned(root);
  transport.runCloseWorker = async () => {
    attempts++;
    throw Error('simulated worker timeout');
  };
  await assert.rejects(() => transport.closeRawOwned(root), /worker timeout/);
  assert.equal(transport.rawOwnedHandles.has(root), true);
  assert.equal(transport.rawCloseAttempts.has(root), true);
  await assert.rejects(() => transport.closeRawOwned(root), /already attempted/);
  assert.equal(attempts, 1);
});

test('marker cleanup straight-skips the overwrite and leaves the marker intact', async () => {
  const {native, state} = fakeNative();
  const transport = new BalatroCloneTransport({native, evidence,
    inspectLive: async () => evidence});
  const path = 'save:/bal-marker-0011223344556677.bin';
  await transport.writeMarker(path, Buffer.from('00112233445566778899aabbccddeeff', 'hex'));
  const before = Buffer.from(state.marker);
  const result = await transport.deleteMarker(path);
  assert.equal(result.verified, true);
  assert.equal(result.overwritten, false);
  assert.equal(result.skipped, true);
  assert.deepEqual(state.marker, before);
});

test('native IPC failure reports transport and response-copy results separately', async () => {
  const {native} = fakeNative();
  const transport = new BalatroCloneTransport({native, evidence,
    inspectLive: async () => evidence});
  native.exchange = async () => ({results: [0xe401n, BigInt(native.output)],
    output: Buffer.alloc(256)});
  await assert.rejects(transport.sendPacket(evidence.sessionManager.borrowedHandle,
    Buffer.alloc(256)), /svcSend=0xe401, responseCopy=0x[0-9a-f]+/);
  native.exchange = async () => ({results: [0n, 0n], output: Buffer.alloc(256)});
  await assert.rejects(transport.sendPacket(evidence.sessionManager.borrowedHandle,
    Buffer.alloc(256)), /svcSend=0x0, responseCopy=0x0, expectedCopy=0x[0-9a-f]+/);
});
