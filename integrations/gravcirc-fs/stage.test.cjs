const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { MAX_REQUEST_BYTES } = require('./repl-client.cjs');
const { BRIDGE_SOURCE, validateProfile, buildChunk, parseBridgeReply, stage } = require('./stage.cjs');

const nativeProfile = 'gravity-circuit-v1.2.1';
const macIp = '10.0.0.205';
const profile = {
  gameProfile: nativeProfile,
  sdkBytes: 0x400000,
  sdkCrc32: 0x1234abcd,
  hostIp: macIp,
  memmove: { offset: 0x1200, bytes: 'aabbccddeeff0011' },
  queryMemory: { offset: 0x2204, bytes: '123456789abcdef0' },
};

function checked(value = profile) {
  return validateProfile(value, { nativeProfile, macIp });
}

test('a complete measured profile normalizes for the bridge', () => {
  assert.deepEqual(checked(), { ...profile, port: 39380 });
  assert.deepEqual(checked({ ...profile, port: 40400 }), { ...profile, port: 40400 });
  const {hostIp, ...portable} = profile;
  assert.deepEqual(checked(portable), { ...profile, port: 39380 });
});

test('the measured Gravity Circuit SDK profile accepts a selected Mac address', () => {
  const measured = JSON.parse(fs.readFileSync(path.join(__dirname, 'profile.v1.2.1.json'), 'utf8'));
  assert.deepEqual(validateProfile(measured, {nativeProfile, macIp}), {
    gameProfile: nativeProfile,
    sdkBytes: 0x5dd000,
    sdkCrc32: 0xfaede953,
    hostIp: macIp,
    memmove: {offset: 0x5894e0,
      bytes: 'fd7bbea9f30b00f9fd030091f30300aa1f0001eb800300542800028b1f0113eb'},
    queryMemory: {offset: 0x1589e0,
      bytes: 'e10f1ff8c10000d4e20340f9410000b9ff430091c0035fd6'},
    port: 39380,
  });
});

test('the profile must match the running game and Mac address', () => {
  assert.throws(() => checked({ ...profile, gameProfile: 'gravity-circuit-v1.0' }), /does not match/);
  assert.throws(() => checked({ ...profile, hostIp: '10.0.0.12' }), /does not match/);
  assert.throws(() => checked({ ...profile, hostIp: 'not-an-ip' }), /IPv4/);
  assert.throws(() => validateProfile(profile, { nativeProfile: 'unknown', macIp }), /does not match/);
});

test('incomplete sizes, CRCs, and native instruction signatures are rejected', () => {
  assert.throws(() => checked({ ...profile, sdkBytes: undefined }), /SDK byte length/);
  assert.throws(() => checked({ ...profile, sdkCrc32: undefined }), /SDK CRC/);
  assert.throws(() => checked({ ...profile, sdkCrc32: 0x100000000 }), /SDK CRC/);
  assert.throws(() => checked({ ...profile, memmove: { offset: 0x1204, bytes: 'aabbccdd' } }), /8-byte aligned/);
  assert.throws(() => checked({ ...profile, queryMemory: { offset: 0x400000, bytes: 'aabbccdd' } }), /inside the measured SDK/);
  assert.throws(() => checked({ ...profile, queryMemory: { offset: 0x2204, bytes: 'AABBCCDD' } }), /lowercase hexadecimal/);
  assert.throws(() => checked({ ...profile, queryMemory: { offset: 0x1200, bytes: 'aabbccdd' } }), /distinct/);
});

test('serialized Lua contains only checked values and stays below the REPL limit', () => {
  const measured = checked({ ...profile, arbitrary: 'os.execute("bad")' });
  const source = buildChunk(measured);
  assert.ok(source.includes('return bridge.install(LS, profile)'));
  assert.ok(source.includes('sdkCrc32=305441741'));
  assert.ok(source.includes('hostIp="10.0.0.205"'));
  assert.ok(source.includes(BRIDGE_SOURCE));
  assert.ok(!source.includes('os.execute("bad")'));
  assert.ok(Buffer.byteLength(source, 'utf8') < MAX_REQUEST_BYTES);
  assert.throws(() => buildChunk(measured, 'x'.repeat(MAX_REQUEST_BYTES)), /smaller/);
});

test('Lua long brackets adapt when bridge source contains a closing delimiter', () => {
  const source = buildChunk(checked(), 'return "]]"');
  assert.ok(source.includes('[=['));
  assert.ok(source.includes(']=]'));
  assert.ok(source.includes('return "]]"'));
  assert.ok(!source.includes('[[return'));
});

test('only an exact listener confirmation is accepted', () => {
  assert.deepEqual(parseBridgeReply('-> FS bridge listening on port 39380\n', 39380),
    { status: 'listening', port: 39380 });
  assert.throws(() => parseBridgeReply('-> FS bridge listening on port 39381\n', 39380), /expected listener/);
  assert.throws(() => parseBridgeReply('-> FS bridge is already installed\n', 39380), /expected listener/);
  assert.throws(() => parseBridgeReply('error: native profile mismatch\n', 39380), /native profile mismatch/);
});

test('staging probes first and sends one bounded bridge chunk', async () => {
  const calls = [];
  const result = await stage({ switchIp: '10.0.0.91', macIp, profile }, {
    probe: async (options) => {
      calls.push(['probe', options]);
      return { runtimeReady: true, gameId: 'gravity-circuit', nativeProfile };
    },
    executeLua: async (options) => {
      calls.push(['stage', options]);
      return '-> FS bridge listening on port 39380\n';
    },
  });
  assert.deepEqual(calls.map(([name]) => name), ['probe', 'stage']);
  assert.equal(calls[1][1].host, '10.0.0.91');
  assert.ok(Buffer.byteLength(calls[1][1].source, 'utf8') < MAX_REQUEST_BYTES);
  assert.deepEqual(result.bridge, { status: 'listening', port: 39380 });
});

test('staging never sends the bridge for an unrecognized runtime or profile', async () => {
  let sent = false;
  const executeLua = async () => { sent = true; };
  await assert.rejects(stage({ switchIp: '10.0.0.91', macIp, profile }, {
    probe: async () => ({ runtimeReady: false, gameId: 'gravity-circuit', nativeProfile: 'unknown' }),
    executeLua,
  }), /not serving a recognized build/);
  await assert.rejects(stage({ switchIp: '10.0.0.91', macIp, profile: { ...profile, sdkCrc32: null } }, {
    probe: async () => ({ runtimeReady: true, gameId: 'gravity-circuit', nativeProfile }),
    executeLua,
  }), /SDK CRC/);
  assert.equal(sent, false);
});
