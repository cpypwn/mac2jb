const assert = require('node:assert/strict');
const {test} = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {pointerSizePacket, parsePointerSizeReply,
  runBorrowedControlDiscriminator} = require('./borrowed-control-discriminator.cjs');

const sdk = 0x57390b4000;
const managerAddress = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
const slotAddress = 0x5739e069c0;
const borrowed = 459250;
const nonce = '070e86b659d3b0e4';
const hex = value => `0x${value.toString(16)}`;

function evidence() {
  return {gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256, sdkCrc32: profile.sdkCode.offlineCrc32,
    nonce, sdkBase: hex(sdk),
    mount: {name: 'save', node: '0x41fb8472a8', accessor: '0x41fb8472a0',
      implementation: '0x41fb889660', service: '0x41fb8b22d0',
      serviceVtable: hex(sdk + 0xce89a0), serviceVtableOffset: '0xce89a0',
      manager: hex(managerAddress), objectId: 152, guardsVerified: true},
    proxy: {object: hex(sdk + Number(BigInt(captured.fsProxy.objectSdkOffset))),
      manager: hex(managerAddress), objectId: 146},
    sessionManager: {stateSize: 2048, stateValue: 3,
      slot: hex(slotAddress), borrowedHandle: borrowed,
      selectedNode: hex(slotAddress + 32), idleCount: 3,
      livenessVerified: false},
    absentPathResult: '0x00000202', status: 'read-only; mounted domain not cloned'};
}

function pointerReply(size = 0x1000) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(8, 4);
  bytes.write('SFCO', 16);
  bytes.writeUInt16LE(size, 32);
  return bytes;
}

function fixture() {
  const manager = Buffer.alloc(0x800);
  manager.writeUInt32LE(2048, 8);
  manager.writeBigUInt64LE(BigInt(slotAddress), 16);
  manager.writeUInt32LE(3, 92);
  manager.writeBigUInt64LE(BigInt(slotAddress + 32), 0x40);
  manager.writeBigUInt64LE(BigInt(slotAddress + 48), 0x48);
  manager.writeUInt32LE(16, 0x58);
  const slots = Buffer.alloc(0x800);
  for (let i = 0; i < 16; i++) {
    slots.writeUInt32LE(borrowed + i - 2, i * 16);
    const next = i === 2 ? 1 : i === 1 ? 0 : i === 0 ? -1 : i === 15 ? -1 : i + 1;
    slots.writeBigUInt64LE(BigInt(next < 0 ? 0 : slotAddress + next * 16), i * 16 + 8);
  }
  const events = [];
  const native = {async read(address, length) {
    events.push(`read:${hex(address)}`);
    if (address === managerAddress && length === 0x800) return Buffer.from(manager);
    if (address === slotAddress && length === 0x800) return Buffer.from(slots);
    throw Error('unexpected native read');
  }};
  const transport = {native, ownedHandles: new Set(),
    async sendPacket(handle, bytes) {
      events.push('send');
      assert.equal(handle, borrowed);
      assert.deepEqual(bytes, pointerSizePacket());
      return pointerReply();
    }};
  return {manager, slots, events, transport};
}

test('control 3 packet is exactly the no-object, no-descriptor pinned HIPC request', () => {
  const bytes = pointerSizePacket();
  assert.equal(bytes.subarray(0, 48).toString('hex'),
    '0500000008000000000000000000000053464349000000000300000000000000' +
    '00000000000000000000000000000000');
  assert.equal(bytes.length, 256);
  assert.equal(bytes.subarray(32).every(byte => byte === 0), true);
});

test('control reply parses exact SFCO result and u16 pointer size without handles', () => {
  const parsed = parsePointerSizeReply(pointerReply(0x1234));
  assert.equal(parsed.cmifResult, 0);
  assert.equal(parsed.pointerBufferSize, 0x1234);
  assert.equal(parsed.copiedHandles, 0);
  assert.equal(parsed.movedHandles, 0);
  const truncatedRaw = pointerReply();
  truncatedRaw.writeUInt32LE(4, 4);
  assert.throws(() => parsePointerSizeReply(truncatedRaw), /reply changed/);
});

test('one send is bracketed by same-boot control and full manager-slot snapshots', async () => {
  const {transport, events} = fixture();
  const result = await runBorrowedControlDiscriminator({evidence: evidence(), transport,
    async inspectDomain() {events.push('direct'); return evidence();}});
  assert.equal(result.sendCount, 1);
  assert.equal(result.pointerBufferSize, 0x1000);
  assert.equal(result.explicitSaveWrites, 0);
  assert.equal(result.domainClones, 0);
  assert.equal(result.markerWrites, 0);
  assert.deepEqual(events.filter(event => event === 'direct'), ['direct', 'direct']);
  assert.equal(events.filter(event => event === 'send').length, 1);
  assert.ok(events.indexOf('direct') < events.indexOf('send'));
  assert.ok(events.lastIndexOf('direct') > events.indexOf('send'));
  assert.equal(result.before.slotTableSha256, result.after.slotTableSha256);
});

test('changed borrowed manager slot prevents the send', async () => {
  const {transport, events, slots} = fixture();
  await assert.rejects(runBorrowedControlDiscriminator({evidence: evidence(), transport,
    async inspectDomain() {slots.writeUInt32LE(77, 4); return evidence();}}),
  /manager or borrowed slots changed before/);
  assert.equal(events.includes('send'), false);
});

test('svc transport failure remains one-shot and records post-state', async () => {
  const {transport, events} = fixture();
  transport.sendPacket = async () => {events.push('send'); throw Error('svcSend=0xf601');};
  await assert.rejects(runBorrowedControlDiscriminator({evidence: evidence(), transport,
    async inspectDomain() {events.push('direct'); return evidence();}}), error => {
    assert.equal(error.diagnostic.sendAttempted, true);
    assert.equal(error.diagnostic.before.borrowedHandle, borrowed);
    assert.equal(error.diagnostic.after.borrowedHandle, borrowed);
    assert.equal(error.diagnostic.rawHeader, null);
    assert.match(error.errors[0].message, /0xf601/);
    return true;
  });
  assert.equal(events.filter(event => event === 'send').length, 1);
});

test('reply rejects moved handles and nonzero CMIF result', () => {
  const moved = pointerReply();
  moved.writeUInt32LE(0x80000008, 4);
  moved.writeUInt32LE(1 << 5, 8);
  moved.writeUInt32LE(733, 12);
  moved.write('SFCO', 16);
  moved.writeUInt16LE(0x1000, 32);
  assert.throws(() => parsePointerSizeReply(moved), /reply changed/);
  const failed = pointerReply();
  failed.writeUInt32LE(0xf601, 24);
  assert.throws(() => parsePointerSizeReply(failed), /reply changed/);
});
