const assert = require('node:assert/strict');
const {test} = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {formatFailure, sameImage, sameArena, makeIdleSource, parseIdleReply,
  runRootBatchLive} = require('./fs-root-batch-live.cjs');

const arenaNonce = 'a0b1c2d3e4f50617';
const sdkBase = 0x57390b4000n;
const mainBase = 0x5239400000n;
const arenaBase = 0x4200000000n;
const hex = value => `0x${value.toString(16)}`;
const manager = hex(sdkBase + BigInt(captured.fsProxy.managerSdkOffset));

function evidence() {
  return {gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
    sdkCodeSha256: profile.sdkCode.sha256, sdkCrc32: profile.sdkCode.offlineCrc32,
    nonce: '070e86b659d3b0e4', sdkBase: hex(sdkBase),
    mount: {name: 'save', node: '0x41fb8472a8', accessor: '0x41fb8472a0',
      implementation: '0x41fb889660', service: '0x41fb8b22d0',
      serviceVtable: hex(sdkBase + 0xce89a0n), serviceVtableOffset: '0xce89a0',
      manager, objectId: 152, guardsVerified: true},
    proxy: {object: hex(sdkBase + BigInt(captured.fsProxy.objectSdkOffset)),
      manager, objectId: 146},
    sessionManager: {stateSize: 2048, stateValue: 3, slot: '0x5739e069c0',
      borrowedHandle: 459250},
    absentPathResult: '0x00000202', status: 'read-only; mounted domain not cloned'};
}

function image() {
  return {state: 'serving', metadataVersion: '1.0.1f-FULL',
    codeHeadProfile: '1.0.1f', mainBase: hex(mainBase), sdkBase: hex(sdkBase),
    presentAddress: hex(mainBase + 0x1234n), sampleFingerprintSha256: 'a'.repeat(64),
    presentHead: 'fd7bbea9f44f01a9fd030091e81300b0',
    memcpyHead: 'e80301cb0a0940925f0102eb62040054', memcpyOffset: '0x1234'};
}

function arena() {
  return {phase: 'inspect', nonce: arenaNonce, bytes: 0x200000, base: hex(arenaBase)};
}

function hello() {
  const bytes = Buffer.alloc(128);
  const words = [0x31545344n, 1n, 2n, arenaBase + 0x10000n,
    0x80000n, mainBase, sdkBase, 0n,
    sdkBase + BigInt(profile.symbols.memmove.offset), 0n, 0n,
    0n, 0n, 0n, 0n, BigInt(Number.parseInt(profile.sdkCode.offlineCrc32, 16))];
  words.forEach((word, index) => bytes.writeBigUInt64LE(word, index * 8));
  return bytes;
}

function copyReply(handle = 311) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(0, 0);
  bytes.writeUInt32LE(0x80000004, 4);
  bytes.writeUInt32LE(1 << 5, 8);
  bytes.writeUInt32LE(handle, 12);
  bytes.write('SFCO', 16);
  return bytes;
}

function setup() {
  const events = [];
  const data = evidence();
  const ownedHandles = new Set();
  const native = {async stop() {events.push('native-stop');}};
  const transport = {ownedHandles,
    async initialize() {events.push('verify-native');},
    async inspectLive() {events.push('inspect-domain'); return data;},
    async sendControl(handle) {
      events.push('copy-domain');
      assert.equal(handle, data.sessionManager.borrowedHandle);
      ownedHandles.add(311);
      return copyReply();
    },
    async closeOwned(handle) {
      events.push(`close:${handle}`);
      assert.equal(handle, 311);
      ownedHandles.delete(handle);
      return {closed: true};
    }};
  const options = {host: '10.0.0.189', macIp: '10.0.0.205', arenaNonce, evidence: data,
    async identifyImage() {events.push('image'); return image();},
    async inspectArena() {events.push('arena'); return arena();},
    async probe({nonceBytes}) {
      events.push('domain');
      assert.equal(nonceBytes().toString('hex'), data.nonce);
      return data;
    },
    async execute({source}) {
      if (source.includes('BAL_ROOT_BATCH_IDLE_V1')) {
        events.push('idle');
        return `-> BAL_ROOT_BATCH_IDLE_V1\tidle\t${arenaNonce}\n`;
      }
      if (source.includes('BAL_BRIDGE_GREETING_DIAG_V1')) {
        events.push('bridge-state');
        return `-> BAL_BRIDGE_GREETING_DIAG_V1\tok\t${arenaNonce}` +
          '\tread-request\t1\t0\tpresent\tpresent\t10.0.0.205:50801\t\n';
      }
      if (source.includes('BAL_TRANSPORT_V1')) {
        events.push('listener-close');
        return '-> BAL_TRANSPORT_V1\tclosed\t39381\n';
      }
      throw Error('unexpected RPC source');
    },
    async stage() {
      events.push('stage');
      return {stage: 'ready', nonce: arenaNonce, arenaBase: hex(arenaBase), port: 39381};
    },
    async connect() {
      events.push('connect');
      return {async read(bytes) {assert.equal(bytes, 128); return hello();},
        close() {events.push('connection-close');}};
    },
    async sleep(ms) {assert.equal(ms, 1000); events.push('sleep');},
    makeNative() {events.push('native'); return native;},
    makeTransport() {events.push('transport'); return transport;},
    makeIo(_transport, clone) {assert.equal(clone, 311); return {owned: true};},
    async runBatch() {
      events.push('batch');
      return {coverage: 'first-root-directory-batch-only', complete: false,
        path: '/', entries: [{name: 'bl_log.txt', type: 1, size: 10}]};
    }};
  return {events, options, ownedHandles};
}

test('image and arena gate reject stale builds or a changed retained owner', () => {
  assert.equal(sameImage(image(), image(), hex(sdkBase)).state, 'serving');
  assert.equal(sameArena(arena(), arena(), arenaNonce).base, hex(arenaBase));
  assert.throws(() => sameImage(image(), {...image(), mainBase: '0x1000'}, hex(sdkBase)),
    /image changed/);
  assert.throws(() => sameArena(arena(), {...arena(), base: '0x1000'}, arenaNonce),
    /arena changed/);
});

test('idle gate requires exact arena and absence of worker and transport', () => {
  const source = makeIdleSource({nonce: arenaNonce, mainBase: hex(mainBase),
    sdkBase: hex(sdkBase), arenaBase: hex(arenaBase)});
  assert.match(source, /b\.fs_worker_hold or b\.fs_transport/);
  assert.match(source, /h\.stage~='ready'/);
  assert.deepEqual(parseIdleReply(`-> BAL_ROOT_BATCH_IDLE_V1\tidle\t${arenaNonce}\n`,
    arenaNonce), {idle: true, nonce: arenaNonce});
  assert.throws(() => parseIdleReply(`-> BAL_ROOT_BATCH_IDLE_V1\tfail\t${arenaNonce}\n`,
    arenaNonce), /active native state/);
});

test('one-shot root probe uses one owned clone and verifies post-state', async () => {
  const {events, options, ownedHandles} = setup();
  const result = await runRootBatchLive(options);
  assert.equal(result.complete, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.ownedCloneClosed, true);
  assert.equal(ownedHandles.size, 0);
  assert.deepEqual(events, ['image', 'arena', 'idle', 'domain', 'stage',
    'connect', 'sleep', 'bridge-state', 'bridge-state', 'domain',
    'native', 'transport', 'verify-native', 'inspect-domain',
    'copy-domain', 'batch', 'close:311', 'native-stop',
    'listener-close', 'image', 'arena', 'idle', 'domain']);
});

test('stale mounted domain stops before bridge stage', async () => {
  const {events, options} = setup();
  options.probe = async () => ({...options.evidence,
    mount: {...options.evidence.mount, objectId: 123}});
  await assert.rejects(runRootBatchLive(options), /mount.objectId changed/);
  assert.deepEqual(events, ['image', 'arena', 'idle']);
});

test('root batch error closes owned clone, bridge, and listener once', async () => {
  const {events, options} = setup();
  options.runBatch = async () => {events.push('batch-failed'); throw Error('synthetic root error');};
  await assert.rejects(runRootBatchLive(options), /inspect owned resources before any retry/);
  assert.equal(events.filter(item => item === 'close:311').length, 1);
  assert.equal(events.filter(item => item === 'native-stop').length, 1);
  assert.equal(events.filter(item => item === 'listener-close').length, 1);
  assert.equal(events.filter(item => item === 'image').length, 1);
});

test('greeting failure records an in-flight snapshot and never starts save-directory IPC', async () => {
  const {events, options} = setup();
  options.connect = async () => {
    events.push('connect');
    return {async read() {events.push('greeting-read');
      throw Error('synthetic greeting timeout');},
    close() {events.push('connection-close');}};
  };
  await assert.rejects(runRootBatchLive(options), error => {
    assert.equal(error.diagnostic?.inFlightState?.stage, 'read-request');
    assert.equal(error.diagnostic?.postGreetingState, undefined);
    assert.equal(error.diagnostic?.explicitSaveDirectoryIpcStarted, false);
    assert.match(formatFailure(error), /synthetic greeting timeout/);
    return true;
  });
  assert.equal(events.filter(item => item === 'bridge-state').length, 1);
  assert.equal(events.filter(item => item === 'connection-close').length, 1);
  assert.equal(events.filter(item => item === 'listener-close').length, 1);
  assert.ok(!events.includes('copy-domain'));
  assert.ok(!events.includes('batch'));
});

test('reused bridge is refused without closing another owner listener', async () => {
  const {events, options} = setup();
  options.stage = async () => {
    events.push('stage');
    return {stage: 'reused', nonce: arenaNonce, arenaBase: hex(arenaBase), port: 39381};
  };
  await assert.rejects(runRootBatchLive(options), error =>
    error instanceof AggregateError &&
    error.errors?.some(item => /bridge was reused/.test(item.message)));
  assert.ok(!events.includes('listener-close'));
  assert.ok(!events.includes('connect'));
});

test('nested cleanup failures retain their actual causes in diagnostics', () => {
  const error = new AggregateError([Error('greeting timeout'),
    Error('listener close uncertain')], 'root failed');
  const formatted = formatFailure(error);
  assert.match(formatted, /root failed/);
  assert.match(formatted, /cause: Error: greeting timeout/);
  assert.match(formatted, /cause: Error: listener close uncertain/);
});
