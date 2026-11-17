const assert = require('node:assert/strict');
const test = require('node:test');
const {packet} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {createQualifiedContext, parseOpenServiceReply} =
  require('./fs-counter-probe.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');
const {paths} = require('./marker-path-control.cjs');
const {claimClone, claimFile, makePinRequest, makeReceiveRequest,
  makeTriggerRequest, descriptorInput} = require('./fs-attempt-packets.cjs');

const sdk = 0x57390b4000;
const scratch = 0x4200000000;
const nonce = 'fedcba9876543210';
const marker = paths(nonce);
const cloneHandle = 311;
const fileHandle = 312;

function evidence() {
  const manager = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
  return {
    gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    nonce: '0123456789abcdef', sdkBase: `0x${sdk.toString(16)}`,
    mount: {name: 'save', accessor: '0x49646472a0',
      implementation: '0x4964689680', service: '0x49646896a0',
      serviceVtable: `0x${(sdk + 0xcec000).toString(16)}`,
      serviceVtableOffset: '0xcec000', manager: `0x${manager.toString(16)}`,
      objectId: 412, guardsVerified: true},
    proxy: {object: `0x${(sdk + Number(BigInt(captured.fsProxy.objectSdkOffset))).toString(16)}`,
      manager: `0x${manager.toString(16)}`, objectId: 153},
    sessionManager: {stateSize: 2048, stateValue: 3,
      slot: '0x4964a0a000', borrowedHandle: 118},
    absentPathResult: '0x00000202',
    status: 'read-only; mounted domain not cloned',
  };
}

function transport() {
  const native = {addresses: {sdk, scratch},
    write() {}, read() {}, callAddress() {}, callAddress6() {},
    exchange() {}, verifyFunction() {}};
  const result = new BalatroCloneTransport({native, evidence: evidence(),
    inspectLive() {}});
  result.ownedHandles.add(cloneHandle);
  result.ownedHandles.add(fileHandle);
  return result;
}

function movedHandle(handle) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(0x80000004, 4);
  bytes.writeUInt32LE(1 << 5, 8);
  bytes.writeUInt32LE(handle, 12);
  bytes.write('SFCO', 16);
  return bytes;
}

function root() {
  const arena = '0x4964000000';
  const ctx = createQualifiedContext({arenaBase: arena, nonce: '0123456789abcdef',
    hello: {status: 'read-only transport handshake verified',
      scratch: '0x4964010000', scratchBytes: 0x80000,
      sdkBase: `0x${sdk.toString(16)}`,
      sdkCrc32: Number.parseInt(profile.sdkCode.offlineCrc32, 16)},
    crc: {gameProfile: profile.gameProfile,
      nonce: '0123456789abcdef', port: 39381,
      sdkBase: `0x${sdk.toString(16)}`,
      sdkCrc32: profile.sdkCode.offlineCrc32}});
  const reply = Buffer.alloc(0x8010);
  reply.writeUInt32LE(321, 16);
  return {context: ctx, root: parseOpenServiceReply(reply, ctx)};
}

test('pin uses the owned fsp-srv root and exact command 200', () => {
  const owned = root();
  const result = makePinRequest(owned);
  assert.equal(result.requestKind, 'owned-storage-open');
  assert.equal(result.handle, 321);
  assert.equal(result.packet.length, 256);
  assert.deepEqual(result.packet, packet(200));
  assert.throws(() => makePinRequest({context: owned.context,
    root: {handle: 321, role: 'root'}}), /owned/);
  owned.root.closed = true;
  assert.throws(() => makePinRequest(owned), /owned/);
});

test('trigger uses an exact nonce-bound 0x800 descriptor and aborts with a leading NUL', () => {
  const t = transport();
  const clone = claimClone({transport: t, controlReply: movedHandle(cloneHandle)});
  const normal = makeTriggerRequest({clone, nonce,
    pathAddress: t.pathAddress});
  const abort = makeTriggerRequest({clone, nonce,
    pathAddress: t.pathAddress, abort: true});
  const absent = makeTriggerRequest({clone, nonce, which: 'absent',
    pathAddress: t.pathAddress});
  assert.equal(normal.requestKind, 'cloned-save-entry-type');
  assert.equal(normal.handle, cloneHandle);
  assert.equal(normal.packet.readUInt32LE(8) >>> 16, 0x800);
  assert.equal(normal.descriptorInput.length, 0x800);
  assert.equal(normal.descriptorInput[0], '/'.charCodeAt(0));
  assert.equal(normal.descriptorInput[0x7ff], 0);
  assert.equal(normal.descriptorInput.toString('ascii', 0, 0x7ff)
    .replace(/\/+/, '/').endsWith(marker.marker.slice('save:'.length)), true);
  assert.deepEqual(abort.packet, normal.packet);
  assert.deepEqual(abort.descriptorInput.subarray(1),
    normal.descriptorInput.subarray(1));
  assert.equal(abort.descriptorInput[0], 0);
  assert.notDeepEqual(absent.descriptorInput, normal.descriptorInput);
  assert.deepEqual(descriptorInput(nonce, 'marker'), normal.descriptorInput);
  assert.throws(() => makeTriggerRequest({clone, nonce,
    pathAddress: t.pathAddress + 1}), /page-aligned/);
  assert.throws(() => makeTriggerRequest({clone, nonce,
    pathAddress: t.scratch - 0x1000}), /scratch arena/);
  t.ownedHandles.delete(cloneHandle);
  assert.throws(() => makeTriggerRequest({clone, nonce,
    pathAddress: t.pathAddress}), /open owned clone/);
});

test('receive uses an owned file and Balatro three-word file read command', () => {
  const t = transport();
  const clone = claimClone({transport: t, controlReply: movedHandle(cloneHandle)});
  const file = claimFile({clone,
    openReply: {result: 0, moves: [fileHandle], copies: []}});
  const result = makeReceiveRequest({file, receiveAddress: t.dataAddress});
  assert.equal(result.requestKind, 'receive-buffer-request');
  assert.equal(result.handle, fileHandle);
  assert.equal(result.receiveBytes, 16);
  assert.equal(result.packet.readUInt32LE(0) >>> 24 & 15, 1);
  assert.equal(result.packet.readUInt32LE(16) & 3, 1);
  const input = Buffer.alloc(24);
  input.writeBigUInt64LE(16n, 16);
  assert.deepEqual(result.packet,
    packet(0, input,
      {receive: [{address: t.dataAddress, size: 16, mode: 1}]}));
  assert.throws(() => makeReceiveRequest({file: clone,
    receiveAddress: t.dataAddress}), /open owned file/);
  assert.throws(() => makeReceiveRequest({file,
    receiveAddress: t.dataAddress, bytes: 0x801}), /bounded/);
  t.ownedHandles.delete(fileHandle);
  assert.throws(() => makeReceiveRequest({file,
    receiveAddress: t.dataAddress}), /open owned file/);
});

test('borrowed, untransferred and forged handles cannot become request capabilities', () => {
  const t = transport();
  assert.throws(() => claimClone({transport: t,
    controlReply: movedHandle(t.evidence.sessionManager.borrowedHandle)}), /owned handle/);
  assert.throws(() => claimClone({transport: t,
    controlReply: movedHandle(899)}), /not transferred/);
  const clone = claimClone({transport: t, controlReply: movedHandle(cloneHandle)});
  assert.throws(() => claimFile({clone,
    openReply: {result: 0, moves: [cloneHandle], copies: []}}), /not transferred/);
  assert.throws(() => makeTriggerRequest({clone: {handle: cloneHandle, role: 'clone'},
    nonce, pathAddress: t.pathAddress}), /open owned clone/);
});
