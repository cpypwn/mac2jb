const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {createQualifiedContext} = require('./fs-counter-probe.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {prepareOwnedLease, cleanupOwnedLease} = require('./fs-owned-prep.cjs');

const sdk = 0x57390b4000;
const arena = 0x4964000000;
const scratch = arena + 0x10000;
const arenaNonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const preflight = {gameProfile: profile.gameProfile,
  sdkBase: `0x${sdk.toString(16)}`,
  arenaBase: `0x${arena.toString(16)}`,
  arenaNonce, markerNonce, exactAllocationBytes: null,
  markerHitVerified: false, fsStageVerified: false};

function evidence() {
  const manager = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
  return {gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    nonce: '9876543210abcdef', sdkBase: preflight.sdkBase,
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
}

function movedReply(handle) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(0x80000004, 4);
  bytes.writeUInt32LE(1 << 5, 8);
  bytes.writeUInt32LE(handle, 12);
  bytes.write('SFCO', 16);
  return bytes;
}

function initReply() {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(0);
  bytes.writeUInt32LE(4, 4);
  bytes.write('SFCO', 16);
  return bytes;
}

function fixture({changedBoot = false, failAfterWrite = false} = {}) {
  const observed = evidence();
  const context = createQualifiedContext({arenaBase: preflight.arenaBase,
    nonce: arenaNonce,
    hello: {status: 'read-only transport handshake verified',
      scratch: `0x${scratch.toString(16)}`, scratchBytes: 0x80000,
      sdkBase: preflight.sdkBase,
      sdkCrc32: Number.parseInt(profile.sdkCode.offlineCrc32, 16)},
    crc: {gameProfile: profile.gameProfile,
      nonce: arenaNonce, port: 39381, sdkBase: preflight.sdkBase,
      sdkCrc32: profile.sdkCode.offlineCrc32}});
  const calls = [];
  const state = {marker: false, markerBytes: null,
    rootHandle: 321, cloneHandle: 311,
    fileHandle: 312, neutralized: false};
  const memory = new Map();
  const put = (address, bytes) => bytes.forEach((byte, index) =>
    memory.set(address + index, byte));
  const get = (address, length) => Buffer.from(Array.from({length},
    (_, index) => memory.get(address + index) || 0));
  const native = {addresses: {sdk, scratch},
    async verifyFunction() {calls.push('verify-function');},
    async write(address, bytes) {
      calls.push('native-write');
      // NativeClient stages each write here before copying to its destination.
      put(scratch + 0x40080, bytes);
      put(address, bytes);
    },
    async read(address, length) {
      calls.push('native-read');
      const bytes = get(address, length);
      put(scratch + 0x4040, bytes);
      return bytes;
    },
    async call(offset, ...args) {
      calls.push(`native-call:${offset}`);
      if (offset === profile.symbols['nn::sm::GetServiceHandle'].offset) {
        assert.equal(args[0], scratch + 0x20804);
        assert.equal(args[1], scratch + 0x20000);
        assert.equal(get(args[1], 8).toString('ascii'), 'fsp-srv\0');
        assert.equal(get(args[0] - 4, 4).readUInt32LE(), 0x5a17eacc);
        const handle = Buffer.alloc(4);
        handle.writeUInt32LE(state.rootHandle);
        put(args[0], handle);
        return {result: 0n};
      }
      throw Error(`unexpected main-thread native call ${offset}`);
    }};
  const transport = Object.create(BalatroCloneTransport.prototype);
  Object.assign(transport, {native, evidence: observed, sdk, scratch,
    pathAddress: scratch + 0x20000, outputAddress: scratch + 0x20800,
    dataAddress: scratch + 0x22000,
    ownedHandles: new Set(), rawOwnedHandles: new Set(),
    rawCloseAttempts: new Set(),
    runCloseWorker: async () => {
      calls.push('close-worker');
      return 0n;
    },
    inspectLive: async () => {
      calls.push('inspect');
      return changedBoot ? {...observed, nonce: '0000000000000000'} : observed;
    },
    initialize: async () => {calls.push('initialize');},
    sendPacket: async () => {calls.push('initialize-root'); return initReply();},
    readOriginal: async path => {
      calls.push('read-original');
      return path.includes('marker') && state.marker ?
        {result: 0, type: 1, bytes: Buffer.from(state.markerBytes)} :
        {result: 0x202, type: null, bytes: null};
    },
    writeMarker: async () => {
      calls.push('write-marker'); state.marker = true;
      state.markerBytes = content(markerNonce);
      return {verified: true};
    },
    sendControl: async () => {
      calls.push('copy-domain');
      if (failAfterWrite) throw Error('copy failed');
      transport.ownedHandles.add(state.cloneHandle);
      return movedReply(state.cloneHandle);
    },
    readClone: async (_handle, path) => {
      calls.push('read-clone');
      return path.includes('marker') ?
        {result: 0, type: 1, bytes: content(markerNonce)} :
        {result: 0x202, type: null, bytes: null};
    },
    sendOwned: async (_handle, bytes) => {
      calls.push('send-owned');
      const command = bytes.readUInt32LE(bytes.indexOf('SFCI') + 8);
      if (command === 8) {
        return {result: 0, moves: [state.fileHandle], copies: [], data: Buffer.alloc(0)};
      }
      if (command === 7) return {result: 0, moves: [], copies: [],
        data: Buffer.from([1, 0, 0, 0])};
      if (command === 0) {
        put(transport.dataAddress, state.markerBytes);
        const data = Buffer.alloc(8); data.writeBigUInt64LE(16n);
        return {result: 0, moves: [], copies: [], data};
      }
      const data = Buffer.alloc(8); data.writeBigUInt64LE(16n);
      return {result: 0, moves: [], copies: [], data};
    },
    closeOwned: async handle => {
      calls.push(`close-owned:${handle}`);
      assert.equal(transport.ownedHandles.delete(handle), true);
      return {closed: true};
    },
    deleteMarker: async (_path, _owned, {onPhase} = {}) => {
      calls.push('delete-marker');
      onPhase?.('marker:inspect');
      return {verified: true, removed: false, overwritten: false, skipped: true};
    }});
  return {context, transport, observed, calls, state};
}

test('prepares and cleans a one-shot owned marker, clone, file and root', async () => {
  const x = fixture();
  const prepared = await prepareOwnedLease({preflight, evidence: x.observed,
    transport: x.transport, context: x.context});
  assert.equal(prepared.file.handle, x.state.fileHandle);
  assert.equal(prepared.clone.handle, x.state.cloneHandle);
  assert.equal(prepared.root.handle, x.state.rootHandle);
  assert.equal(x.transport.ownedHandles.has(x.state.fileHandle), true);
  const cleaned = await cleanupOwnedLease(prepared);
  assert.equal(cleaned.ownedHandlesClosed, true);
  assert.equal(cleaned.markerNeutralized, false);
  assert.equal(cleaned.markerRemoved, false);
  assert.equal(cleaned.markerRetained, true);
  assert.deepEqual([...x.transport.ownedHandles], []);
  assert.deepEqual([...x.transport.rawOwnedHandles], []);
  assert.equal(prepared.root.closed, true);
  assert.equal(prepared.ownedHandlesOpen, false);
  assert.equal(x.calls.filter(call => call === 'close-worker').length, 1);
  assert.equal(x.calls.indexOf('delete-marker') <
    x.calls.indexOf('close-owned:312'), true);
  assert.equal(x.calls.indexOf('close-owned:312') <
    x.calls.indexOf('close-owned:311'), true);
  await assert.rejects(cleanupOwnedLease(prepared), /attempted already/);
});

test('cleanup failure names the marker operation and records completed closes', async () => {
  const x = fixture();
  const prepared = await prepareOwnedLease({preflight, evidence: x.observed,
    transport: x.transport, context: x.context});
  x.transport.deleteMarker = async (_path, _owned, {onPhase}) => {
    onPhase('marker:write-file');
    throw Error('simulated marker write failure');
  };
  await assert.rejects(cleanupOwnedLease(prepared), error => {
    assert.equal(error.resourceStateUncertain, true);
    assert.equal(error.cleanupPhase, 'marker:write-file');
    assert.equal(error.diagnostic.cleanupPhase, 'marker:write-file');
    assert.deepEqual(error.diagnostic.completedCleanupPhases,
      ['verify-owned-handles']);
    return true;
  });
  assert.equal(prepared.root.closed, false);
  assert.equal(x.state.neutralized, false);
  await assert.rejects(cleanupOwnedLease(prepared), /attempted already/);
});

test('same-boot mismatch stops before service open or marker mutation', async () => {
  const x = fixture({changedBoot: true});
  await assert.rejects(prepareOwnedLease({preflight, evidence: x.observed,
    transport: x.transport, context: x.context}), /live nonce changed/);
  assert.equal(x.calls.includes('write-marker'), false);
  assert.equal(x.calls.some(call => call.startsWith('native-call')), false);
});

test('post-write failure quarantines handles and marker without replay', async () => {
  const x = fixture({failAfterWrite: true});
  await assert.rejects(prepareOwnedLease({preflight, evidence: x.observed,
    transport: x.transport, context: x.context}), /retain resources and restart/);
  assert.equal(x.state.marker, true);
  assert.equal(x.calls.includes('delete-marker'), false);
  assert.equal(x.calls.filter(call => call === 'copy-domain').length, 1);
});
