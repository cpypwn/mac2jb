const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {spawnSync} = require('node:child_process');
const {MARKER, makeStateSource, parseStateReply,
  runBridgeGreetingDiagnostic} = require('./bridge-greeting-diagnostic.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const host = '10.0.0.189';
const macIp = '10.0.0.205';
const nonce = '17d9a46834ce20bf';
const mainBase = '0x5916c04000';
const sdkBase = '0x59298b4000';
const arenaBase = '0x31f94f8000';

function image() {
  return {state: 'serving', metadataVersion: '1.0.1f-FULL',
    codeHeadProfile: '1.0.1f', mainBase, sdkBase,
    presentAddress: '0x5916c05100', sampleFingerprintSha256: 'a'.repeat(64),
    presentHead: 'fd7bbea9f44f01a9fd030091e81300b0',
    memcpyHead: 'e80301cb0a0940925f0102eb62040054',
    memcpyOffset: '0x1234'};
}

function hello() {
  const data = Buffer.alloc(128);
  const words = [0x31545344n, 1n, 2n, BigInt(arenaBase) + 0x10000n,
    0x80000n, BigInt(mainBase), BigInt(sdkBase), 0n,
    BigInt(sdkBase) + BigInt(profile.symbols.memmove.offset),
    0n, 0n, 0n, 0n, 0n, 0n, BigInt(profile.sdkCode.offlineCrc32)];
  words.forEach((value, index) => data.writeBigUInt64LE(value, index * 8));
  return data;
}

function state(stage, accepted = 0, rejected = 0, client = 'absent') {
  return `-> ${MARKER}\tok\t${nonce}\t${stage}\t${accepted}\t${rejected}` +
    `\tpresent\t${client}\t10.0.0.205:47218\t\n`;
}

function fixture() {
  const calls = [];
  let held = false;
  let closed = false;
  let states = [state('accept'), state('read-request', 1, 0, 'present'),
    state('read-request', 1, 0, 'present')];
  let failRead = false;
  let failClose = false;
  const options = {host, macIp, nonce,
    clock: (() => {let ticks = 0; return () => ++ticks * 10;})(),
    async sleep(ms) {assert.equal(ms, 1000); calls.push('sleep');},
    async identifyImage() {calls.push('image'); return image();},
    async inspectArena({phase, nonce: owner}) {
      assert.equal(owner, nonce);
      calls.push(`arena:${phase}`);
      if (phase === 'reserve') {assert.equal(held, false); held = true;}
      else assert.equal(held, true);
      return {phase, nonce, bytes: 0x200000, base: arenaBase};
    },
    async stage(args) {
      calls.push('stage');
      assert.equal(args.host, host);
      assert.equal(args.macIp, macIp);
      assert.equal(args.nonce, nonce);
      return {stage: 'ready', nonce, arenaBase, port: 39381};
    },
    async connect(target, port, timeoutMs) {
      calls.push('connect');
      assert.equal(target, host);
      assert.equal(port, 39381);
      assert.equal(timeoutMs, 15000);
      return {socket: {localAddress: macIp},
        read(size) {
          calls.push('read');
          assert.equal(size, 128);
          return failRead ? Promise.reject(Error('synthetic greeting timeout')) :
            Promise.resolve(hello());
        },
        close() {calls.push('socket-close');}};
    },
    async execute({source}) {
      if (source.includes(MARKER)) {
        calls.push('state');
        return states.shift() || state('read-request', 1, 0, 'present');
      }
      if (source.includes('BAL_ROOT_BATCH_IDLE_V1')) {
        calls.push('retained-idle');
        return `-> BAL_ROOT_BATCH_IDLE_V1\tidle\t${nonce}\n`;
      }
      if (source.includes('ARENA_DETACHED')) {
        calls.push('release');
        assert.equal(held, true);
        held = false;
        return `-> BAL_NATIVE_OVERLAP_V1\tARENA_DETACHED\t${nonce}\t${arenaBase}\n`;
      }
      if (source.includes('BL.fs_transport=nil')) {
        calls.push('listener-close');
        if (failClose) throw Error('synthetic listener close timeout');
        closed = true;
        return '-> BAL_TRANSPORT_V1\tclosed\t39381\n';
      }
      if (source.includes('BAL_NATIVE_OVERLAP_V1') && source.includes('idle')) {
        calls.push('idle');
        assert.equal(held, false);
        return `-> BAL_NATIVE_OVERLAP_V1\tidle\tok\t${nonce}\tno-held-state\n`;
      }
      throw Error('unexpected RPC source');
    }};
  return {options, calls, held: () => held, closed: () => closed,
    setStates: rows => {states = rows;},
    failRead: () => {failRead = true;},
    failClose: () => {failClose = true;}};
}

test('owner-bound state source reads native transport diagnostics only', () => {
  const source = makeStateSource({nonce, mainBase, sdkBase, arenaBase, macIp});
  assert.match(source, /rejectedPeers/);
  assert.match(source, /fs_transport_last_error/);
  assert.match(source, /t\.arena~=h/);
  assert.doesNotMatch(source, /OpenDirectory|ReadDirectory|CreateFile|CommitSaveData/);
  const nativeSource = fs.readFileSync(path.join(__dirname, 'native-bridge.lua'), 'utf8');
  const transportSource = fs.readFileSync(path.join(__dirname, 'transport-probe.lua'), 'utf8');
  assert.match(nativeSource, /self\.accepted = \(self\.accepted or 0\) \+ 1/);
  assert.match(nativeSource, /self\.rejectedPeers = \(self\.rejectedPeers or 0\) \+ 1/);
  assert.match(transportSource, /b\.fs_transport_last_error = tostring\(reason\)/);
  assert.throws(() => makeStateSource({nonce: 'bad', mainBase, sdkBase, arenaBase, macIp}));
});

test('generated Lua state query reads accepted and rejected counters', t => {
  const probe = spawnSync('luajit', ['-v'], {encoding: 'utf8'});
  if (probe.error?.code === 'ENOENT') return t.skip('LuaJIT unavailable');
  const source = makeStateSource({nonce, mainBase, sdkBase, arenaBase, macIp});
  const script = `local h={owner='${nonce}',stage='ready',base=${Number(BigInt(arenaBase))},bytes=0x200000}\n` +
    `BL={state='serving',info={version='${profile.runtimeVersion}',main_base=${Number(BigInt(mainBase))},sdk_base=${Number(BigInt(sdkBase))}},fs_bridge=h}\n` +
    `BL.fs_transport={owner='${nonce}',hostIp='${macIp}',port=39381,arena=h,native=true,stage='send-hello',accepted=1,rejectedPeers=2,listener=42,client=43,lastPeer='10.0.0.207:1234'}\n` +
    `BL.fs_transport_last_error='send stalled'\n` +
    `io.write(assert(loadstring(${JSON.stringify(source)}))())`;
  const run = spawnSync('luajit', ['-e', script], {encoding: 'utf8', timeout: 5000});
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const result = parseStateReply(`-> ${run.stdout}\n`, nonce);
  assert.equal(result.stage, 'send-hello');
  assert.equal(result.accepted, 1);
  assert.equal(result.rejectedPeers, 2);
  assert.equal(result.lastTransportError, 'send stalled');
});

test('generated Lua state query preserves a bridge error after early transport removal', t => {
  const probe = spawnSync('luajit', ['-v'], {encoding: 'utf8'});
  if (probe.error?.code === 'ENOENT') return t.skip('LuaJIT unavailable');
  const source = makeStateSource({nonce, mainBase, sdkBase, arenaBase, macIp});
  const script = `BL={state='serving',info={version='${profile.runtimeVersion}',main_base=${Number(BigInt(mainBase))},sdk_base=${Number(BigInt(sdkBase))}},fs_bridge={owner='${nonce}',stage='ready',base=${Number(BigInt(arenaBase))},bytes=0x200000}}\n` +
    `BL.fs_transport_last_error='socket reset\\nby peer'\n` +
    `io.write(assert(loadstring(${JSON.stringify(source)}))())`;
  const run = spawnSync('luajit', ['-e', script], {encoding: 'utf8', timeout: 5000});
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const result = parseStateReply(`-> ${run.stdout}\n`, nonce);
  assert.equal(result.stage, 'absent');
  assert.equal(result.lastTransportError, 'socket reset by peer');
});

test('transport state parser rejects changed owner, duplicates, and unbounded counts', () => {
  assert.deepEqual(parseStateReply(state('read-request', 1, 0, 'present'), nonce),
    {stage: 'read-request', accepted: 1, rejectedPeers: 0,
      listener: 'present', client: 'present',
      lastPeer: '10.0.0.205:47218', lastTransportError: ''});
  assert.throws(() => parseStateReply(state('accept'), 'f'.repeat(16)), /owner|incomplete/);
  assert.throws(() => parseStateReply(state('accept') + state('accept'), nonce), /duplicated/);
  assert.throws(() => parseStateReply(state('accept', 3), nonce), /bounded handshake/);
  assert.throws(() => parseStateReply(`-> ${MARKER}\tfail\towner-image-or-transport\n`, nonce), /changed/);
});

test('one greeting is sampled while TCP is open, then owner resources close', async () => {
  const sample = fixture();
  const result = await runBridgeGreetingDiagnostic(sample.options);
  assert.equal(result.greeting.mainBase, mainBase);
  assert.equal(result.duringConnect.accepted, 1);
  assert.equal(result.arenaDetached, true);
  assert.equal(result.listenerClosed, true);
  assert.equal(result.explicitSaveDirectoryIpcRequests, 0);
  assert.equal(sample.held(), false);
  assert.equal(sample.closed(), true);
  assert.ok(sample.calls.indexOf('read') < sample.calls.indexOf('sleep'));
  assert.ok(sample.calls.indexOf('sleep') < sample.calls.indexOf('state',
    sample.calls.indexOf('read')));
  assert.ok(sample.calls.indexOf('socket-close') < sample.calls.indexOf('listener-close'));
  assert.equal(sample.calls.filter(item => item === 'release').length, 1);
});

test('greeting timeout preserves sampled stage and still releases verified owner', async () => {
  const sample = fixture();
  sample.failRead();
  sample.setStates([state('accept'), state('send-hello', 1, 0, 'present')]);
  await assert.rejects(runBridgeGreetingDiagnostic(sample.options), error => {
    assert.match(error.message, /stopped/);
    assert.match(error.errors[0].message, /greeting timeout/);
    assert.equal(error.diagnostic.duringConnect.stage, 'send-hello');
    assert.equal(error.diagnostic.arenaDetached, true);
    return true;
  });
  assert.equal(sample.held(), false);
  assert.equal(sample.calls.filter(item => item === 'release').length, 1);
});

test('early bridge closure records its native error before socket timeout', async () => {
  const sample = fixture();
  sample.setStates([state('accept'),
    state('closed').replace(/10\.0\.0\.205:47218\t\n$/,
      '10.0.0.205:47218\tBalatro transport send failed: reset\n')]);
  await assert.rejects(runBridgeGreetingDiagnostic(sample.options), error => {
    assert.match(error.errors[0].message, /transport send failed: reset/);
    assert.equal(error.diagnostic.duringConnect.stage, 'closed');
    assert.equal(error.diagnostic.arenaDetached, true);
    return true;
  });
  assert.equal(sample.calls.filter(item => item === 'release').length, 1);
});

test('rejected peer is reported from the in-flight snapshot', async () => {
  const sample = fixture();
  sample.setStates([state('accept'), state('accept', 0, 1)]);
  await assert.rejects(runBridgeGreetingDiagnostic(sample.options), error => {
    assert.match(error.errors[0].message, /rejected the TCP peer/);
    assert.equal(error.diagnostic.duringConnect.rejectedPeers, 1);
    return true;
  });
  assert.equal(sample.calls.filter(item => item === 'release').length, 1);
});

test('uncertain listener cleanup retains owner and never sends release', async () => {
  const sample = fixture();
  sample.failClose();
  await assert.rejects(runBridgeGreetingDiagnostic(sample.options), error => {
    assert.equal(error.diagnostic.listenerClosed, false);
    assert.equal(error.diagnostic.arenaDetached, false);
    assert.match(error.errors[0].message, /listener close timeout/);
    return true;
  });
  assert.equal(sample.held(), true);
  assert.equal(sample.calls.filter(item => item === 'release').length, 0);
});

test('operation budget stops after connect and still releases verified owner', async () => {
  const sample = fixture();
  let elapsed = 0;
  sample.options.clock = () => elapsed;
  sample.options.sleep = async ms => {
    assert.equal(ms, 1000);
    elapsed = 1500;
  };
  sample.options.maxOperationMs = 1000;
  await assert.rejects(runBridgeGreetingDiagnostic(sample.options), error => {
    assert.match(error.errors[0].message, /exceeded 1000 ms/);
    assert.equal(error.diagnostic.stageAttempted, true);
    assert.equal(error.diagnostic.listenerClosed, true);
    assert.equal(error.diagnostic.arenaDetached, true);
    return true;
  });
  assert.equal(sample.calls.filter(item => item === 'release').length, 1);
});
