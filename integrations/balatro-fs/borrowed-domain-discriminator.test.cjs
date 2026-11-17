const assert = require('node:assert/strict');
const {test} = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {MANAGER_BYTES, SLOT_BYTES, PATH_BYTES, absentPath, domainAbsentPacket,
  pathBuffer, managerSnapshot, parseAbsentReply,
  runBorrowedDomainDiscriminator} = require('./borrowed-domain-discriminator.cjs');

const sdk = 0x57390b4000;
const managerAddress = sdk + Number(BigInt(captured.fsProxy.managerSdkOffset));
const slotAddress = 0x5739e069c0;
const pathAddress = 0x4200020000;
const borrowed = 459250;
const nonce = '070e86b659d3b0e4';
const hex = value => `0x${value.toString(16)}`;

function evidence() {
  return {gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    sdkCrc32: profile.sdkCode.offlineCrc32,
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

function absentReply() {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4);
  bytes.writeUInt32LE(8, 4);
  bytes.write('SFCO', 32);
  bytes.writeUInt32LE(0x202, 40);
  return bytes;
}

function fixture() {
  const manager = Buffer.alloc(MANAGER_BYTES);
  manager.writeUInt32LE(2048, 8);
  manager.writeBigUInt64LE(BigInt(slotAddress), 16);
  manager.writeUInt32LE(3, 92);
  manager.writeBigUInt64LE(BigInt(slotAddress + 32), 0x40);
  manager.writeBigUInt64LE(BigInt(slotAddress + 48), 0x48);
  manager.writeUInt32LE(16, 0x58);
  const slots = Buffer.alloc(SLOT_BYTES);
  for (let i = 0; i < 16; i++) {
    slots.writeUInt32LE(borrowed + i - 2, i * 16);
    const next = i === 2 ? 1 : i === 1 ? 0 : i === 0 ? -1 : i === 15 ? -1 : i + 1;
    slots.writeBigUInt64LE(BigInt(next < 0 ? 0 : slotAddress + next * 16), i * 16 + 8);
  }
  const events = [];
  const native = {
    async read(address, length) {
      events.push(`read:${hex(address)}:${length}`);
      if (address === managerAddress && length === MANAGER_BYTES) return Buffer.from(manager);
      if (address === slotAddress && length === SLOT_BYTES) return Buffer.from(slots);
      throw Error('unexpected native read');
    },
    async write(address, bytes) {
      events.push(`write:${hex(address)}:${bytes.length}`);
      assert.equal(address, pathAddress);
      assert.deepEqual(bytes, pathBuffer(nonce));
    },
  };
  const transport = {native, pathAddress, ownedHandles: new Set(),
    async sendPacket(handle, bytes) {
      events.push('svcSend');
      assert.equal(handle, borrowed);
      assert.deepEqual(bytes, domainAbsentPacket(152, pathAddress));
      return absentReply();
    }};
  return {manager, slots, events, native, transport};
}

test('borrowed-domain packet exactly matches the pinned CMIF domain path wire', () => {
  const actual = domainAbsentPacket(152, pathAddress);
  assert.equal(actual.subarray(0, 64).toString('hex'),
    '040001000c000000002101030000020001001000980000000000000000000000' +
    '5346434900000000070000000000000000000000000000000000000000000000');
  assert.equal(actual.readUInt32LE(), 0x10004);
  assert.equal(actual.readUInt32LE(8) >>> 16, 0x301);
  assert.equal(actual.readUInt32LE(12), pathAddress >>> 0);
  assert.equal(actual.readUInt32LE(20), 152);
  assert.equal(actual.toString('ascii', 32, 36), 'SFCI');
  assert.equal(actual.readUInt32LE(40), 7);
  assert.equal(absentPath(nonce), `/bal-domain-${nonce}.bin`);
  assert.equal(pathBuffer(nonce).length, PATH_BYTES);
  assert.equal(pathBuffer(nonce).readUInt8(absentPath(nonce).length), 0);
  assert.throws(() => domainAbsentPacket(0, pathAddress), /pinned object/);
  assert.throws(() => absentPath('bad'), /fresh owner nonce/);
});

test('full manager and slot tables are read and the borrowed handle is pinned', async () => {
  const {native, slots} = fixture();
  const read = await managerSnapshot(native, evidence());
  assert.equal(read.manager.length, MANAGER_BYTES);
  assert.equal(read.slots.length, SLOT_BYTES);
  assert.equal(read.borrowedHandle, borrowed);
  slots.writeUInt32LE(0, 2 * 16);
  await assert.rejects(managerSnapshot(native, evidence()), /idle session contains an invalid handle/);
});

test('one absent-path send follows direct SDK control and checks manager before and after', async () => {
  const {events, transport} = fixture();
  const result = await runBorrowedDomainDiscriminator({evidence: evidence(), transport,
    async inspectDomain() {events.push('direct-sdk'); return evidence();}});
  assert.equal(result.result, 0x202);
  assert.equal(result.sendCount, 1);
  assert.equal(result.domainClones, 0);
  assert.equal(result.markerWrites, 0);
  assert.equal(result.explicitSaveWrites, 0);
  assert.equal(events.filter(event => event === 'svcSend').length, 1);
  assert.deepEqual(events.filter(event => event === 'direct-sdk'),
    ['direct-sdk', 'direct-sdk']);
  assert.ok(events.indexOf('direct-sdk') < events.indexOf('svcSend'));
  assert.ok(events.lastIndexOf('direct-sdk') > events.indexOf('svcSend'));
  assert.equal(result.before.slotTableSha256, result.after.slotTableSha256);
});

test('direct SDK manager drift refuses the borrowed send', async () => {
  const {events, transport, slots} = fixture();
  await assert.rejects(runBorrowedDomainDiscriminator({evidence: evidence(), transport,
    async inspectDomain() {slots.writeUInt32LE(77, 4); return evidence();}}),
  /manager or borrowed slots changed during the direct SDK control/);
  assert.equal(events.filter(event => event === 'svcSend').length, 0);
});

test('send failure is one-shot and records the post-send manager state', async () => {
  const {events, transport} = fixture();
  transport.sendPacket = async () => {
    events.push('svcSend');
    throw Error('svcSend=0xf601');
  };
  await assert.rejects(runBorrowedDomainDiscriminator({evidence: evidence(), transport,
    async inspectDomain() {events.push('direct-sdk'); return evidence();}}), error => {
    assert.match(error.message, /one-send discriminator did not verify/);
    assert.equal(error.diagnostic.sendAttempted, true);
    assert.equal(error.diagnostic.before.borrowedHandle, borrowed);
    assert.equal(error.diagnostic.after.borrowedHandle, borrowed);
    assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /0xf601/);
    return true;
  });
  assert.equal(events.filter(event => event === 'svcSend').length, 1);
  assert.equal(events.filter(event => event === 'direct-sdk').length, 2);
});

test('domain reply refuses moved handles and non-absent CMIF results', () => {
  const moved = absentReply();
  moved.writeUInt32LE(0x80000008, 4);
  moved.writeUInt32LE(1 << 5, 8);
  moved.writeUInt32LE(123, 12);
  moved.write('SFCO', 16);
  moved.writeUInt32LE(0x202, 24);
  assert.throws(() => parseAbsentReply(moved, evidence()), /handle ownership changed/);
  const wrong = absentReply();
  wrong.writeUInt32LE(0, 40);
  assert.throws(() => parseAbsentReply(wrong, evidence()), /absent-path result/);
});
