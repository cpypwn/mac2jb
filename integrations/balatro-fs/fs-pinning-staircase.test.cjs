const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {createQualifiedContext} = require('./fs-counter-probe.cjs');
const {assessStaircase, runStaircaseCycle,
  runRepeatedStaircase} = require('./fs-pinning-staircase.cjs');
const {validStaircaseResult} = require('./fs-pinning-staircase-live.cjs');

const nonce = '0123456789abcdef';
const arenaBase = '0x4964000000';
const sdkBase = '0x6005cb4000';
const output = BigInt(arenaBase) + 0x10000n + 0x4040n;

function context() {
  return createQualifiedContext({arenaBase, nonce,
    hello: {status: 'read-only transport handshake verified',
      scratch: `0x${(BigInt(arenaBase) + 0x10000n).toString(16)}`,
      scratchBytes: 0x80000, sdkBase,
      sdkCrc32: Number.parseInt(profile.sdkCode.offlineCrc32, 16)},
    crc: {gameProfile: profile.gameProfile, nonce, port: 39381, sdkBase,
      sdkCrc32: profile.sdkCode.offlineCrc32}});
}

function serviceReply(handle = 0x321) {
  const bytes = Buffer.alloc(0x8010);
  bytes.writeUInt32LE(handle, 16);
  return bytes;
}

function counterReply(value) {
  const bytes = Buffer.alloc(0x8010);
  bytes.writeBigUInt64LE(output);
  bytes.writeUInt32LE(40, 20);
  bytes.write('SFCO', 32);
  for (let index = 0; index < 16; index++) {
    bytes.writeBigUInt64LE(BigInt(index === 5 ? value : index * 4),
      48 + index * 8);
  }
  return bytes;
}

function storageReply(handle) {
  const bytes = Buffer.alloc(0x8010);
  bytes.writeBigUInt64LE(output);
  bytes.writeUInt32LE(0x80000004, 20);
  bytes.writeUInt32LE(1 << 5, 24);
  bytes.writeUInt32LE(handle, 28);
  bytes.write('SFCO', 32);
  return bytes;
}

function phaseValue(phase, overrides = {}) {
  const name = phase.replace(/^cycle-\d+-/, '').replace(/-\d+$/, '');
  const values = {before: 0x8000, baselineControl: 0x8000,
    oneHeld: 0x7000, twoHeld: 0x6000, oneHeldAgain: 0x7000,
    after: 0x8000, restoredControl: 0x8000, ...overrides};
  assert.ok(Object.hasOwn(values, name), `unexpected phase ${phase}`);
  return values[name];
}

function fakeExchange(events, overrides = {}) {
  return async (packet, phase) => {
    events.push(phase);
    assert.equal(packet.length, 0x8080);
    if (phase.endsWith('open-fsp-srv')) return serviceReply();
    if (phase.endsWith('initialize-fsp-srv')) return counterReply(0x8000);
    if (phase.endsWith('open-owned-content-storage-1')) return storageReply(0x322);
    if (phase.endsWith('open-owned-content-storage-2')) return storageReply(0x323);
    if (phase.includes('close-')) return Buffer.alloc(0x8010);
    return counterReply(phaseValue(phase, overrides));
  };
}

function stable(value) {
  const row = Array.from({length: 16}, (_, index) => index === 5 ? value : 0);
  return {samples: [row, [...row]]};
}

function phases(overrides = {}) {
  const values = {before: 0x8000, baselineControl: 0x8000,
    oneHeld: 0x7000, twoHeld: 0x6000, oneHeldAgain: 0x7000,
    after: 0x8000, restoredControl: 0x8000, ...overrides};
  return Object.fromEntries(Object.entries(values).map(([key, value]) =>
    [key, stable(value)]));
}

test('linear 0-1-2-1-0 staircase yields only a candidate diagnostic', () => {
  const result = assessStaircase(phases());
  assert.equal(result.staircaseVerified, true);
  assert.equal(result.candidateDiagnosticCostBytes, 0x1000);
  assert.equal(result.exactAllocationBytes, null);
  assert.deepEqual(result.deltas, {firstOpen: 0x1000, secondOpen: 0x1000,
    secondClose: 0x1000, firstClose: 0x1000});
});

test('control drift and nonlinear second handle both reject the candidate', () => {
  assert.equal(assessStaircase(phases({baselineControl: 0x8100})).staircaseVerified,
    false);
  assert.equal(assessStaircase(phases({twoHeld: 0x6100})).staircaseVerified,
    false);
});

test('bounded cycle closes both storage handles and root in reverse order', async () => {
  const events = [];
  const result = await runStaircaseCycle({context: context(),
    exchange: fakeExchange(events)});
  assert.equal(result.cleanup, 'released');
  assert.equal(result.assessment.staircaseVerified, true);
  assert.equal(result.assessment.exactAllocationBytes, null);
  assert.deepEqual(events.filter(phase => phase.startsWith('close-')),
    ['close-owned-content-storage-2', 'close-owned-content-storage-1',
      'close-fsp-srv']);
  assert.ok(events.indexOf('close-owned-content-storage-2') <
    events.indexOf('oneHeldAgain-1'));
  assert.ok(events.indexOf('close-owned-content-storage-1') <
    events.indexOf('after-1'));
});

test('failed second close is never replayed and cleanup remains unverified', async () => {
  const events = [];
  const base = fakeExchange(events);
  await assert.rejects(runStaircaseCycle({context: context(),
    exchange: async (packet, phase) => {
      if (phase === 'close-owned-content-storage-2') {
        events.push(phase);
        const failed = Buffer.alloc(0x8010);
        failed.writeBigUInt64LE(1n, 8);
        return failed;
      }
      return base(packet, phase);
    }}), /did not verify complete handle cleanup/);
  assert.equal(events.filter(phase => phase === 'close-owned-content-storage-2').length, 1);
  assert.ok(events.includes('cleanup-owned-content-storage-1'));
  assert.ok(events.includes('close-fsp-srv'));
});

test('two equal bounded cycles are repeatable but do not assert exact cost', async () => {
  const events = [];
  const result = await runRepeatedStaircase({context: context(),
    exchange: fakeExchange(events)});
  assert.equal(result.repeatabilityVerified, true);
  assert.equal(result.cycles.length, 2);
  assert.equal(result.candidateDiagnosticCostBytes, 0x1000);
  assert.equal(result.exactAllocationBytes, null);
  assert.equal(result.markerAttempted, false);
  assert.equal(result.saveWrites, 0);
  assert.equal(validStaircaseResult(result), true);
});

test('live result gate rejects fabricated exact cost and mismatched counter data', async () => {
  const result = await runRepeatedStaircase({context: context(),
    exchange: fakeExchange([])});
  assert.equal(validStaircaseResult({...result, exactAllocationBytes: 0x1000}), false);
  result.cycles[0].phases.twoHeld.samples[1][5] += 0x100;
  assert.equal(validStaircaseResult(result), false);
});

test('a failed first staircase stops before a second cycle', async () => {
  let calls = 0;
  const result = await runRepeatedStaircase({context: context(),
    exchange: async () => Buffer.alloc(0),
    cycle: async () => {
      calls++;
      return {cleanup: 'released', assessment: {staircaseVerified: false}};
    }});
  assert.equal(calls, 1);
  assert.equal(result.repeatabilityVerified, false);
  assert.equal(result.candidateDiagnosticCostBytes, null);
});
