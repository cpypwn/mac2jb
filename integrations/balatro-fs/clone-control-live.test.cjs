const assert = require('node:assert/strict');
const test = require('node:test');
const {runCloneLive} = require('./clone-control-live.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');

const sdk = 0x57390b4000n;
const hex = value => `0x${value.toString(16)}`;
const manager = hex(sdk + BigInt(captured.fsProxy.managerSdkOffset));
const evidence = {
  gameProfile: profile.gameProfile, runtimeVersion: profile.runtimeVersion,
  sdkCodeSha256: profile.sdkCode.sha256, sdkCrc32: profile.sdkCode.offlineCrc32,
  nonce: '070e86b659d3b0e4', sdkBase: hex(sdk),
  mount: {name: 'save', node: '0x41fb8472a8', accessor: '0x41fb8472a0',
    implementation: '0x41fb889660', service: '0x41fb8b22d0',
    serviceVtable: hex(sdk + 0xce89a0n), serviceVtableOffset: '0xce89a0',
    manager, objectId: 152, guardsVerified: true},
  proxy: {object: hex(sdk + BigInt(captured.fsProxy.objectSdkOffset)),
    manager, objectId: 146},
  sessionManager: {stateSize: 2048, stateValue: 3, slot: '0x5739e069c0',
    borrowedHandle: 459250},
  absentPathResult: '0x00000202', status: 'read-only; mounted domain not cloned',
};
const arenaNonce = 'c8b4e61a72d90f35';

function hello() {
  const bytes = Buffer.alloc(128);
  const words = [0x31545344n, 1n, 2n, 0x4200010000n,
    0x80000n, 0x5239400000n, sdk, 0n,
    sdk + BigInt(profile.symbols.memmove.offset), 0n, 0n,
    0n, 0n, 0n, 0n, BigInt(Number.parseInt(profile.sdkCode.offlineCrc32, 16))];
  words.forEach((word, index) => bytes.writeBigUInt64LE(word, index * 8));
  return bytes;
}

function setup(probeEvidence = evidence) {
  const events = [];
  const dependencies = {
    host: '10.0.0.189', macIp: '10.0.0.205', arenaNonce, evidence,
    async probe({host, nonceBytes}) {
      assert.equal(host, '10.0.0.189');
      assert.equal(nonceBytes().toString('hex'), evidence.nonce);
      events.push('probe');
      return probeEvidence;
    },
    async stage({host, macIp, nonce, port}) {
      assert.equal(host, '10.0.0.189');
      assert.equal(macIp, '10.0.0.205');
      assert.equal(nonce, arenaNonce);
      assert.equal(port, 39381);
      events.push('stage');
      return {nonce, port, arenaBase: '0x4200000000'};
    },
    async connect() {
      events.push('connect');
      throw Error('synthetic connect refusal');
    },
    async execute({source, port}) {
      assert.equal(port, 9026);
      assert.ok(source.includes(arenaNonce));
      assert.ok(!source.includes(evidence.nonce));
      events.push('close-listener');
      return '-> BAL_TRANSPORT_V1\tclosed\t39381\n';
    },
  };
  return {events, dependencies};
}

test('clone wrapper keeps arena owner separate and connects directly after stage', async () => {
  const {events, dependencies} = setup();
  await assert.rejects(runCloneLive(dependencies), /synthetic connect refusal/);
  assert.deepEqual(events, ['probe', 'stage', 'connect', 'close-listener']);
});

test('stale post-greeting domain evidence blocks before any cloned-domain IPC', async () => {
  const {events, dependencies} = setup();
  let calls = 0;
  const originalProbe = dependencies.probe;
  dependencies.probe = async options => {
    const result = await originalProbe(options);
    return ++calls === 1 ? result : {...result, mount: {...result.mount, objectId: 153}};
  };
  dependencies.connect = async () => {
    events.push('connect');
    return {async read(bytes) {assert.equal(bytes, 128); events.push('greeting'); return hello();},
      close() {events.push('connection-close');}};
  };
  await assert.rejects(runCloneLive(dependencies), /mount.objectId changed/);
  assert.deepEqual(events, ['probe', 'stage', 'connect', 'greeting', 'probe',
    'connection-close', 'close-listener']);
});

test('invalid arena owner fails before any probe or stage', async () => {
  const {events, dependencies} = setup();
  dependencies.arenaNonce = evidence.nonce.toUpperCase();
  await assert.rejects(runCloneLive(dependencies), /arena owner nonce/);
  assert.deepEqual(events, []);
});

test('preflight-only checks both sides of staging and never connects or writes a marker', async () => {
  const {events, dependencies} = setup();
  const phases = [];
  const result = await runCloneLive({...dependencies, preflightOnly: true,
    onPhase: phase => phases.push(phase)});
  assert.deepEqual(events, ['probe', 'stage', 'probe', 'close-listener']);
  assert.equal(result.nativeTransport, 'closed');
  assert.match(result.status, /no native TCP or marker write attempted/);
  assert.deepEqual(phases, [
    'read-only mounted-domain preflight',
    'read-only mounted-domain post-stage check',
    'close transport listener',
  ]);
});

test('phase output identifies a staging timeout before any marker write', async () => {
  const {events, dependencies} = setup();
  const phases = [];
  dependencies.stage = async ({onPhase}) => {
    events.push('stage');
    onPhase('stage: qualify retained arena and worker');
    throw Error('synthetic REPL timeout');
  };
  await assert.rejects(runCloneLive({...dependencies, preflightOnly: true,
    onPhase: phase => phases.push(phase)}), /synthetic REPL timeout/);
  assert.deepEqual(events, ['probe', 'stage']);
  assert.deepEqual(phases, ['read-only mounted-domain preflight',
    'stage: qualify retained arena and worker']);
});
