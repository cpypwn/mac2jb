const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {makeScanSource, parseScanReply,
  runRecoveryReadOnly} = require('./clone-recovery-readonly.cjs');

const sdk = 0x57390b4000n;
const hex = value => `0x${value.toString(16)}`;
const manager = hex(sdk + BigInt(captured.fsProxy.managerSdkOffset));
const evidence = {
  gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
  sdkCodeSha256: profile.sdkCode.sha256, nonce: '070e86b659d3b0e4',
  sdkBase: hex(sdk),
  mount: {name: 'save', accessor: '0x41fb8472a0', implementation: '0x41fb889660',
    service: '0x41fb8b22d0', serviceVtable: hex(sdk + 0xce89a0n),
    serviceVtableOffset: '0xce89a0', manager, objectId: 152, guardsVerified: true},
  proxy: {object: hex(sdk + BigInt(captured.fsProxy.objectSdkOffset)),
    manager, objectId: 146},
  sessionManager: {stateSize: 2048, stateValue: 3, slot: '0x5739e069c0',
    borrowedHandle: 459250},
  absentPathResult: '0x00000202', status: 'read-only; mounted domain not cloned',
};

test('read-only scan names are bounded and exact', () => {
  const source = makeScanSource();
  assert.match(source, /getDirectoryItems/);
  assert.doesNotMatch(source, /CreateFile|DeleteFile|WriteFile|Commit/);
  assert.deepEqual(parseScanReply('-> BAL_CLONE_SCAN_V1\tok\t\n'), []);
  assert.deepEqual(parseScanReply('-> BAL_CLONE_SCAN_V1\tok\tbal-marker-0123456789abcdef.bin\n'),
    ['0123456789abcdef']);
  assert.throws(() => parseScanReply('-> BAL_CLONE_SCAN_V1\tok\tbal-marker-bad.bin\n'),
    /unexpected marker/);
  assert.throws(() => parseScanReply('-> BAL_CLONE_SCAN_V1\tfail\tlisting-unavailable\n'),
    /listing-unavailable/);
});

test('same-boot recovery inspects listed markers and cannot mutate them', async () => {
  const calls = [];
  const result = await runRecoveryReadOnly({host: '10.0.0.189', evidence,
    probe: async ({nonceBytes}) => {
      calls.push('probe');
      assert.equal(nonceBytes().toString('hex'), evidence.nonce);
      return evidence;
    },
    execute: async ({source}) => {
      calls.push('scan');
      assert.equal(source, makeScanSource());
      return '-> BAL_CLONE_SCAN_V1\tok\tbal-marker-0123456789abcdef.bin\n';
    },
    inspect: async ({nonce}) => {
      calls.push('inspect');
      return {nonce, marker: `save:/bal-marker-${nonce}.bin`,
        absentResult: evidence.absentPathResult, entryResult: '0x00000000',
        fileType: 1, fileSize: 16, openResult: '0x00000000'};
    }});
  assert.deepEqual(calls, ['probe', 'scan', 'inspect']);
  assert.equal(result.markers.length, 1);
  assert.equal(result.markers[0].fileSize, 16);
  assert.equal(result.status, 'read-only; no marker changed');
});

test('stale boot stops recovery before listing', async () => {
  let listed = false;
  await assert.rejects(runRecoveryReadOnly({host: '10.0.0.189', evidence,
    probe: async () => ({...evidence, nonce: '1111111111111111'}),
    execute: async () => {listed = true; return '';}}), /nonce changed/);
  assert.equal(listed, false);
});
