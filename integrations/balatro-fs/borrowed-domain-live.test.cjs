const assert = require('node:assert/strict');
const {test} = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {runFreshBorrowedDomain} = require('./borrowed-domain-live.cjs');

const nonce = '7a563842fe36eeab';
const sdk = 0x57390b4000n;
const main = 0x5239400000n;
const arenaBase = 0x4200000000n;
const manager = sdk + BigInt(captured.fsProxy.managerSdkOffset);
const hex = value => `0x${value.toString(16)}`;

function evidence() {
  return {gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256, sdkCrc32: profile.sdkCode.offlineCrc32,
    nonce, sdkBase: hex(sdk),
    mount: {name: 'save', node: '0x41fb8472a8', accessor: '0x41fb8472a0',
      implementation: '0x41fb889660', service: '0x41fb8b22d0',
      serviceVtable: hex(sdk + 0xce89a0n), serviceVtableOffset: '0xce89a0',
      manager: hex(manager), objectId: 152, guardsVerified: true},
    proxy: {object: hex(sdk + BigInt(captured.fsProxy.objectSdkOffset)),
      manager: hex(manager), objectId: 146},
    sessionManager: {stateSize: 2048, stateValue: 3,
      slot: '0x5739e069c0', borrowedHandle: 459250},
    absentPathResult: '0x00000202', status: 'read-only; mounted domain not cloned'};
}

function image() {
  return {state: 'serving', metadataVersion: profile.runtimeVersion,
    codeHeadProfile: '1.0.1f', mainBase: hex(main), sdkBase: hex(sdk),
    presentAddress: hex(main + 0x1234n), sampleFingerprintSha256: 'a'.repeat(64),
    presentHead: 'fd7bbea9f44f01a9fd030091e81300b0',
    memcpyHead: 'e80301cb0a0940925f0102eb62040054', memcpyOffset: '0x1234'};
}

function hello() {
  const bytes = Buffer.alloc(128);
  const words = [0x31545344n, 1n, 2n, arenaBase + 0x10000n,
    0x80000n, main, sdk, 0n, sdk + BigInt(profile.symbols.memmove.offset),
    0n, 0n, 0n, 0n, 0n, 0n,
    BigInt(Number.parseInt(profile.sdkCode.offlineCrc32, 16))];
  words.forEach((word, index) => bytes.writeBigUInt64LE(word, index * 8));
  return bytes;
}

function fixture() {
  const events = [];
  const data = evidence();
  const options = {host: '10.0.0.189', macIp: '10.0.0.205', nonce,
    async identifyImage() {events.push('image'); return image();},
    async inspectArena({phase, nonce: owner}) {
      events.push(`arena-${phase}`);
      assert.equal(owner, nonce);
      return {phase, nonce, base: hex(arenaBase), bytes: 0x200000};
    },
    async probe({nonceBytes}) {
      events.push('domain');
      assert.equal(nonceBytes().toString('hex'), nonce);
      return data;
    },
    async execute({source}) {
      if (source.includes('ARENA_DETACHED')) {
        events.push('release');
        return `-> BAL_NATIVE_OVERLAP_V1\tARENA_DETACHED\t${nonce}\t${hex(arenaBase)}\n`;
      }
      if (source.includes('BAL_NATIVE_OVERLAP_V1')) {
        events.push('idle');
        return `-> BAL_NATIVE_OVERLAP_V1\tidle\tok\t${nonce}\tno-held-state\n`;
      }
      if (source.includes('BAL_ROOT_BATCH_IDLE_V1')) {
        events.push('owned-idle');
        return `-> BAL_ROOT_BATCH_IDLE_V1\tidle\t${nonce}\n`;
      }
      if (source.includes('BAL_TRANSPORT_V1')) {
        events.push('listener-close');
        return '-> BAL_TRANSPORT_V1\tclosed\t39381\n';
      }
      throw Error('unexpected RPC source');
    },
    async stage() {
      events.push('stage');
      return {stage: 'ready', nonce, port: 39381, arenaBase: hex(arenaBase)};
    },
    async connect() {
      events.push('connect');
      return {async read(length) {assert.equal(length, 128); return hello();},
        close() {events.push('connection-close');}};
    },
    makeNative() {events.push('native'); return {async stop() {events.push('native-stop');}};},
    makeTransport() {events.push('transport'); return {ownedHandles: new Set(),
      async initialize() {events.push('initialize');}};},
    async runOne() {events.push('one-control'); return {sendCount: 1,
      pointerBufferSize: 0x1000};}};
  return {events, options};
}

test('fresh owner sends exactly one control then closes listener and detaches once', async () => {
  const {events, options} = fixture();
  const result = await runFreshBorrowedDomain(options);
  assert.equal(result.pointerBufferSize, 0x1000);
  assert.equal(result.arena, 'detached');
  assert.equal(result.listener, 'closed');
  assert.equal(events.filter(event => event === 'one-control').length, 1);
  assert.equal(events.filter(event => event === 'release').length, 1);
  assert.equal(events.filter(event => event === 'listener-close').length, 1);
  assert.equal(events.indexOf('connect'), events.indexOf('stage') + 1,
    'no REPL probe may run between stage and TCP greeting');
});

test('one-control error retains owner and does not send release or retry', async () => {
  const {events, options} = fixture();
  options.runOne = async () => {events.push('one-control'); throw Error('svcSend=0xf601');};
  await assert.rejects(runFreshBorrowedDomain(options), error => {
    assert.equal(error.diagnostic.owner, nonce);
    assert.equal(error.diagnostic.releaseAttempted, false);
    assert.match(error.errors[0].message, /0xf601/);
    return true;
  });
  assert.equal(events.filter(event => event === 'one-control').length, 1);
  assert.equal(events.includes('release'), false);
  assert.equal(events.filter(event => event === 'listener-close').length, 1);
});

test('reused bridge refuses control, preserves listener and owner', async () => {
  const {events, options} = fixture();
  options.stage = async () => {events.push('stage');
    return {stage: 'reused', nonce, port: 39381, arenaBase: hex(arenaBase)};};
  await assert.rejects(runFreshBorrowedDomain(options), error => {
    assert.equal(error.diagnostic.releaseAttempted, false);
    return true;
  });
  assert.equal(events.includes('connect'), false);
  assert.equal(events.includes('listener-close'), false);
  assert.equal(events.includes('release'), false);
  assert.equal(events.includes('one-control'), false);
});
