const assert = require('node:assert/strict');
const test = require('node:test');
const {packet} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {pathPacket} =
  require('../civswitch/fs-kit/port/engine/switch2/memory/paths.cjs');
const {content} = require('./marker-content-control.cjs');
const {descriptorInput} = require('./fs-attempt-packets.cjs');
const {PACKET_OFFSET, SERVICE_HANDLE_OFFSET} =
  require('./fs-counter-overlap.cjs');
const {requestCommand, buildAbortFrames, stageAbortFrames,
  parseAbortReplies, closeMovedStorage} = require('./fs-abort-frames.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const markerNonce = 'fedcba9876543210';
const arenaNonce = '0123456789abcdef';
const waveId = 'aabbccddeeff0011';
const pathAddress = arena + 0x30000;
const receiveAddress = arena + 0x32000;
const handles = {pin: 321, receive: 312, trigger: 311};

function plan() {
  const input = Buffer.alloc(24);
  input.writeBigUInt64LE(16n, 16);
  return {arenaNonce, markerNonce, waveId, sdkBase: `0x${sdk.toString(16)}`,
    explicitSaveWrites: 0, triggerControl: 'nonce-bound-absent-path',
    requests: {
      pin: {requestKind: 'owned-storage-open', handle: handles.pin,
        packet: packet(200)},
      receive: {requestKind: 'receive-buffer-request', handle: handles.receive,
        packet: packet(0, input,
          {receive: [{address: receiveAddress, size: 16, mode: 1}]}),
        receiveAddress, receiveBytes: 16},
      trigger: {requestKind: 'cloned-save-entry-type', handle: handles.trigger,
        packet: pathPacket(7, Buffer.alloc(0), pathAddress, 0x800),
        descriptorInput: descriptorInput(markerNonce, 'absent'),
        pathAddress, aborted: false},
    }};
}

function response(result, move, data = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(0, 0);
  bytes.writeUInt32LE(move ? 0x80000004 : 4, 4);
  if (move) {
    bytes.writeUInt32LE(1 << 5, 8);
    bytes.writeUInt32LE(move, 12);
  }
  bytes.write('SFCO', 16);
  bytes.writeUInt32LE(result, 24);
  data.copy(bytes, 32);
  return bytes;
}

function worker(staged) {
  return {waveId: staged.waveId, arenaNonce: staged.arenaNonce,
    workerState: 'joined-closed', rows: staged.frames.map((frame, index) =>
      ({role: frame.role, handle: frame.handle, transportResult: 0,
        startTick: 100 + index * 20, endTick: 500 + index * 20,
        threadId: `000000000000000${index + 1}`,
        requestId: `100000000000000${index + 1}`}))};
}

test('extracts all three CMIF commands at their actual descriptor offsets', () => {
  const p = plan();
  assert.deepEqual(Object.values(p.requests).map(row => requestCommand(row.packet)),
    [200, 0, 7]);
  assert.equal(p.requests.pin.packet.readUInt32LE(24), 200);
  assert.equal(p.requests.receive.packet.indexOf('SFCI'), 32);
  assert.equal(p.requests.trigger.packet.indexOf('SFCI'), 16);
});

test('builds separate exact native frames and stages them immediately before worker', async () => {
  const staged = buildAbortFrames(plan(), {arenaBase: arena, sdkBase: sdk});
  assert.equal(staged.frames.length, 3);
  for (const [index, frame] of staged.frames.entries()) {
    assert.equal(frame.address, arena + index * 0x4000);
    assert.equal(frame.bytes.readBigUInt64LE(SERVICE_HANDLE_OFFSET),
      BigInt(handles[frame.role]));
    assert.deepEqual(frame.bytes.subarray(PACKET_OFFSET, PACKET_OFFSET + 256),
      plan().requests[frame.role].packet);
  }
  const memory = new Map();
  const native = {addresses: {scratch: arena + 0x10000, sdk},
    async write(address, bytes) {memory.set(address, Buffer.from(bytes));},
    async read(address, length) {return memory.get(address)?.subarray(0, length);}};
  const receipt = await stageAbortFrames(native, staged);
  assert.equal(receipt.exactReadbackVerified, true);
  assert.equal(receipt.workerStarted, false);
  assert.equal(memory.get(pathAddress).length, 0x800);
  assert.equal(memory.get(receiveAddress).length, 16);
});

test('final staged-set reread catches an earlier frame changed by a later write', async () => {
  const staged = buildAbortFrames(plan(), {arenaBase: arena, sdkBase: sdk});
  const memory = new Map();
  const native = {addresses: {scratch: arena + 0x10000, sdk},
    async write(address, bytes) {
      memory.set(address, Buffer.from(bytes));
      if (address === staged.frames[2].address) {
        memory.get(staged.frames[0].address)[0x2000] ^= 1;
      }
    },
    async read(address, length) {return memory.get(address)?.subarray(0, length);}};
  await assert.rejects(stageAbortFrames(native, staged),
    /changed after staging/);
});

test('separates svcSend transport from CMIF results and verifies marker read', async () => {
  const staged = buildAbortFrames(plan(), {arenaBase: arena, sdkBase: sdk});
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(16n);
  const replies = [response(0, 450), response(0, null, length),
    response(0x202)];
  const parsed = parseAbortReplies(staged, worker(staged), replies,
    content(markerNonce));
  assert.equal(parsed.movedStorageHandle, 450);
  assert.equal(parsed.rows[0].transportResult, 0);
  assert.equal(parsed.rows[2].ipcResult, 0x202);
  assert.equal(parsed.rows[1].receiveBytesVerified, 16);
  assert.throws(() => parseAbortReplies(staged, worker(staged),
    [replies[0], replies[1], response(0)], content(markerNonce)),
  /absent-path trigger/);
  assert.throws(() => parseAbortReplies(staged, worker(staged),
    replies, Buffer.alloc(16)), /owned marker/);
  const calls = [];
  const native = {addresses: {sdk}, async call(offset, handle) {
    calls.push({offset, handle}); return {result: 0n};}};
  const closed = await closeMovedStorage(native, staged, parsed);
  assert.equal(closed.closed, true);
  assert.equal(closed.retained, true);
  assert.equal(closed.skipped, true);
  assert.equal(calls.length, 0);
  await assert.rejects(closeMovedStorage(native, staged, parsed), /was attempted/);
  assert.equal(calls.length, 0);
});

test('a moved-handle close is skipped (no raw svcCloseHandle) and never replayed', async () => {
  const staged = buildAbortFrames(plan(), {arenaBase: arena, sdkBase: sdk});
  const length = Buffer.alloc(8); length.writeBigUInt64LE(16n);
  const parsed = parseAbortReplies(staged, worker(staged),
    [response(0, 450), response(0, null, length), response(0x202)],
    content(markerNonce));
  let calls = 0;
  const native = {addresses: {sdk}, async call() {calls++; throw Error('timeout');}};
  const closed = await closeMovedStorage(native, staged, parsed);
  assert.equal(closed.closed, true);
  assert.equal(closed.skipped, true);
  assert.equal(calls, 0);
  await assert.rejects(closeMovedStorage(native, staged, parsed), /was attempted/);
  assert.equal(calls, 0);
});
