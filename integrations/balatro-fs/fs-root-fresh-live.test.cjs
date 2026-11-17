const assert = require('node:assert/strict');
const {test} = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const captured = require('./live-readonly-map.v1.0.1f.json');
const {runFreshRootBatch} = require('./fs-root-fresh-live.cjs');

const nonce = 'a0b1c2d3e4f50617';
const sdkBase = 0x57390b4000n;
const mainBase = 0x5239400000n;
const arenaBase = '0x4200000000';
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

function setup() {
  const events = [];
  const data = evidence();
  let held = false;
  let result = {coverage: 'first-root-directory-batch-only', path: '/',
    complete: false, entries: [{name: 'bl_log.txt', type: 1, size: 12}],
    ownedCloneClosed: true, nativeBridgeClosed: true, retainedArenaVerified: true};
  const options = {host: '10.0.0.189', macIp: '10.0.0.205', evidence: data,
    nonce, async identifyImage() {events.push('image'); return image();},
    async inspectArena({phase, nonce: owner}) {
      events.push(`arena:${phase}`);
      assert.equal(owner, nonce);
      if (phase === 'reserve') {
        assert.equal(held, false);
        held = true;
      } else assert.equal(held, true);
      return {phase, nonce, bytes: 0x200000, base: arenaBase};
    },
    async probe({nonceBytes}) {
      events.push('domain');
      assert.equal(nonceBytes().toString('hex'), data.nonce);
      return data;
    },
    async execute({source}) {
      if (source.includes('BAL_NATIVE_OVERLAP_V1') && source.includes('idle')) {
        events.push('idle');
        return `-> BAL_NATIVE_OVERLAP_V1\tidle\tok\t${nonce}\tno-held-state\n`;
      }
      if (source.includes('ARENA_DETACHED')) {
        events.push('release');
        assert.equal(held, true);
        held = false;
        return `-> BAL_NATIVE_OVERLAP_V1\tARENA_DETACHED\t${nonce}\t${arenaBase}\n`;
      }
      throw Error('unexpected RPC source');
    },
    async rootBatch(args) {
      events.push('root');
      assert.equal(args.arenaNonce, nonce);
      assert.equal(args.evidence, data);
      assert.equal(held, true);
      return result;
    }};
  return {events, options, setRootResult: value => {result = value;}, held: () => held};
}

test('fresh owner reserve, one root batch, owner detach, and post-state are ordered', async () => {
  const {events, options, held} = setup();
  const result = await runFreshRootBatch(options);
  assert.equal(result.complete, false);
  assert.equal(result.arena, 'detached');
  assert.equal(result.arenaOwner, nonce);
  assert.equal(result.arenaBase, arenaBase);
  assert.equal(held(), false);
  assert.deepEqual(events, ['image', 'idle', 'domain', 'arena:reserve',
    'arena:inspect', 'image', 'domain', 'root', 'arena:inspect',
    'image', 'domain', 'release', 'image', 'idle', 'domain']);
});

test('stale domain stops before arena reserve or root read', async () => {
  const {events, options} = setup();
  options.probe = async () => ({...options.evidence,
    mount: {...options.evidence.mount, objectId: 123}});
  await assert.rejects(runFreshRootBatch(options), /mount.objectId changed/);
  assert.deepEqual(events, ['image', 'idle']);
});

test('root read failure retains owner for inspection and never replays release', async () => {
  const {events, options, held} = setup();
  options.rootBatch = async () => {events.push('root'); throw Error('synthetic root failure');};
  await assert.rejects(runFreshRootBatch(options), /synthetic root failure/);
  assert.equal(held(), true);
  assert.equal(events.filter(item => item === 'release').length, 0);
});

test('unverified root cleanup retains owner without detaching it', async () => {
  const {events, options, setRootResult, held} = setup();
  setRootResult({complete: false, ownedCloneClosed: false,
    nativeBridgeClosed: true, retainedArenaVerified: true});
  await assert.rejects(runFreshRootBatch(options), /did not prove full owned cleanup/);
  assert.equal(held(), true);
  assert.equal(events.filter(item => item === 'release').length, 0);
});

test('ambiguous arena release is sent once and never auto-replayed', async () => {
  const {events, options, held} = setup();
  const original = options.execute;
  options.execute = async args => {
    if (args.source.includes('ARENA_DETACHED')) {
      events.push('release');
      throw Error('release timed out');
    }
    return original(args);
  };
  await assert.rejects(runFreshRootBatch(options), /release timed out/);
  assert.equal(events.filter(item => item === 'release').length, 1);
  assert.equal(held(), true);
});
