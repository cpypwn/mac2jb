const assert = require('node:assert/strict');
const test = require('node:test');
const domain = require('../civswitch/fs-kit/port/engine/shared/domain.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {validateEvidence, matchingBoot, copyRequest, copiedHandle,
  runCloneControl} = require('./clone-control.cjs');

const nonce = '0123456789abcdef';
const sdkBase = 0x57390b4000n;
const hex = value => `0x${value.toString(16)}`;

function evidence(overrides = {}) {
  const manager = sdkBase + BigInt(captured.fsProxy.managerSdkOffset);
  const vtableOffset = 0xcec000n;
  return {
    gameProfile: profile.gameProfile,
    runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256,
    nonce, sdkBase: hex(sdkBase),
    mount: {name: 'save', accessor: '0x49646472a0',
      implementation: '0x4964689680', service: '0x49646896a0',
      serviceVtable: hex(sdkBase + vtableOffset),
      serviceVtableOffset: hex(vtableOffset), manager: hex(manager),
      objectId: 412, guardsVerified: true},
    proxy: {object: hex(sdkBase + BigInt(captured.fsProxy.objectSdkOffset)),
      manager: hex(manager), objectId: 153},
    sessionManager: {stateSize: 2048, stateValue: 3,
      slot: '0x4964a0a000', borrowedHandle: 118},
    absentPathResult: '0x00000202',
    status: 'read-only; mounted domain not cloned',
    ...overrides,
  };
}

function handleReply(handle = 311) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(0, 0);
  bytes.writeUInt32LE(0x80000004, 4);
  bytes.writeUInt32LE(1 << 5, 8);
  bytes.writeUInt32LE(handle, 12);
  bytes.write('SFCO', 16);
  return bytes;
}

function fakeTransport(initialEvidence = evidence(), options = {}) {
  const files = new Map();
  const operations = [];
  const missing = 0x202;
  const read = path => files.has(path)
    ? {result: 0, type: 1, bytes: Buffer.from(files.get(path))}
    : {result: missing, type: null, bytes: null};
  const transport = {
    async inspectLive() {operations.push('inspect'); return initialEvidence;},
    async readOriginal(path) {operations.push(`original:${path}`); return read(path);},
    async writeMarker(path, bytes) {
      operations.push(`write:${path}`);
      files.set(path, Buffer.from(bytes));
      return {verified: true};
    },
    async sendControl(borrowed, packet) {
      operations.push(`copy:${borrowed}`);
      assert.equal(borrowed, initialEvidence.sessionManager.borrowedHandle);
      assert.equal(packet.readUInt32LE(domain.dataStart(packet) + 8), 1);
      assert.equal(packet.readUInt32LE(domain.dataStart(packet) + 16),
        initialEvidence.mount.objectId);
      return handleReply(options.handle ?? 311);
    },
    async readClone(handle, path) {
      operations.push(`clone:${handle}:${path}`);
      assert.equal(handle, 311);
      if (options.badClone && path.includes('bal-marker')) {
        return {result: missing, type: null, bytes: null};
      }
      return read(`save:${path}`);
    },
    async closeOwned(handle) {
      operations.push(`close:${handle}`);
      assert.equal(handle, 311);
      return {closed: true};
    },
    async deleteMarker(path) {
      operations.push(`delete:${path}`);
      files.delete(path);
      return {verified: true};
    },
  };
  return {transport, operations, files};
}

test('Balatro clone uses dynamic SDK base and rejects stale same-boot evidence', () => {
  const expected = evidence();
  assert.equal(validateEvidence(expected), expected);
  assert.deepEqual(matchingBoot(expected, evidence()), expected);
  assert.throws(() => matchingBoot(expected, evidence({nonce: '1111111111111111'})), /nonce changed/);
  assert.throws(() => matchingBoot(expected, evidence({sdkBase: '0x19618b4000'})), /vtable|sdkBase/);
  assert.throws(() => validateEvidence(evidence({mount: {...expected.mount,
    serviceVtableOffset: '0xcec008'}})), /vtable/);
  assert.throws(() => validateEvidence(evidence({status: 'verified'})), /evidence/);
});

test('copy request uses only the current borrowed handle and mount object ID', () => {
  const request = copyRequest(evidence());
  assert.equal(request.borrowedHandle, 118);
  const at = domain.dataStart(request.packet);
  assert.equal(request.packet.readUInt32LE(at + 8), 1);
  assert.equal(request.packet.readUInt32LE(at + 16), 412);
  assert.equal(copiedHandle(handleReply(), 118), 311);
  assert.throws(() => copiedHandle(handleReply(118), 118), /owned handle/);
});

test('owned clone proves exact marker and absent control, then cleans up', async () => {
  const {transport, operations, files} = fakeTransport();
  const result = await runCloneControl({evidence: evidence(), transport,
    nonceBytes: () => Buffer.from(nonce, 'hex')});
  assert.equal(result.ownedCloneVerified, true);
  assert.equal(result.markerWaveAttempted, false);
  assert.equal(files.size, 0);
  assert.ok(operations.includes('close:311'));
  assert.ok(!operations.includes('close:118'));
  assert.ok(operations.some(value => value === `clone:311:/${result.marker.slice(6)}`));
});

test('clone mismatch closes only owned handle and removes marker', async () => {
  const {transport, operations, files} = fakeTransport(evidence(), {badClone: true});
  await assert.rejects(runCloneControl({evidence: evidence(), transport,
    nonceBytes: () => Buffer.from(nonce, 'hex')}), /cloned filesystem marker/);
  assert.equal(files.size, 0);
  assert.ok(operations.includes('close:311'));
  assert.ok(!operations.includes('close:118'));
});

test('stale evidence blocks before any save mutation', async () => {
  const {transport, operations} = fakeTransport(evidence({nonce: '1111111111111111'}));
  await assert.rejects(runCloneControl({evidence: evidence(), transport,
    nonceBytes: () => Buffer.from(nonce, 'hex')}), /nonce changed/);
  assert.deepEqual(operations, ['inspect']);
});
