const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const {packet} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {pathPacket} =
  require('../civswitch/fs-kit/port/engine/switch2/memory/paths.cjs');
const {descriptorInput} = require('./fs-attempt-packets.cjs');
const {buildAbortFrames, stageAbortFrames} = require('./fs-abort-frames.cjs');
const {buildFrame, FRAME_SPACING, PACKET_OFFSET} =
  require('./fs-counter-overlap.cjs');
const {makeAbortGuardSource, parseAbortGuardReply,
  makeAbortWorkerSource, parseAbortWorkerReply, MARKER, GUARD_MARKER} =
  require('./fs-abort-worker.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const main = 0x5a00000000;
const nonce = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'aabbccddeeff0011';
const hostIp = '10.0.0.205';
const port = 39381;

function plan() {
  const input = Buffer.alloc(24);
  input.writeBigUInt64LE(16n, 16);
  return {arenaNonce: nonce, markerNonce, waveId,
    sdkBase: `0x${sdk.toString(16)}`, explicitSaveWrites: 0,
    triggerControl: 'nonce-bound-absent-path',
    requests: {
      pin: {requestKind: 'owned-storage-open', handle: 321,
        packet: packet(200)},
      receive: {requestKind: 'receive-buffer-request', handle: 312,
        packet: packet(0, input,
          {receive: [{address: arena + 0x32000, size: 16, mode: 1}]}),
        receiveAddress: arena + 0x32000, receiveBytes: 16},
      trigger: {requestKind: 'cloned-save-entry-type', handle: 311,
        packet: pathPacket(7, Buffer.alloc(0), arena + 0x30000, 0x800),
        descriptorInput: descriptorInput(markerNonce, 'absent'),
        pathAddress: arena + 0x30000, aborted: false},
    }};
}

async function fixture() {
  const staged = buildAbortFrames(plan(), {arenaBase: arena, sdkBase: sdk});
  const memory = new Map();
  const native = {addresses: {scratch: arena + 0x10000, sdk},
    async write(address, bytes) {memory.set(address, Buffer.from(bytes));},
    async read(address, length) {return memory.get(address).subarray(0, length);}};
  const stageReceipt = await stageAbortFrames(native, staged);
  return {nonce, arenaBase: `0x${arena.toString(16)}`,
    sdkBase: `0x${sdk.toString(16)}`, mainBase: `0x${main.toString(16)}`,
    waveId, hostIp, port, staged, stageReceipt};
}

function successReply(options, overrides = {}) {
  const rows = options.staged.frames.map((_, index) =>
    [index + 1, index]).map(([number, index]) =>
    `${number.toString(16).padStart(16, '0')},${(100 + index * 10).toString(16).padStart(16, '0')},${(200 + index * 10).toString(16).padStart(16, '0')},0`);
  if (overrides.row) rows[overrides.index || 0] = overrides.row;
  return `-> ${MARKER}\tfs-abort-worker\tok\t${options.nonce}\t${options.waveId}\t${options.arenaBase}\t${options.sdkBase}\tjoined-closed\t${rows.join('\t')}\tarena-retained\n`;
}

function protectedFixture() {
  const roles = ['canary', 'pin', 'receive', 'trigger'];
  const handles = [315, 321, 312, 311];
  const frames = roles.map((role, index) => {
    const address = arena + index * FRAME_SPACING;
    const bytes = buildFrame({base: address, sdk, handle: handles[index]});
    const request = role === 'canary' ?
      pathPacket(7, Buffer.alloc(0), arena + 0x44000, 0x800) :
      role === 'pin' ? packet(200) : role === 'receive' ?
        packet(0, Buffer.alloc(24),
          {receive: [{address: arena + 0x32000, size: 16, mode: 1}]}) :
        pathPacket(7, Buffer.alloc(0), arena + 0x30000, 0x800);
    request.copy(bytes, PACKET_OFFSET);
    return {role, address, handle: handles[index], bytes,
      sha256: createHash('sha256').update(bytes).digest('hex')};
  });
  const staged = {workerKind: 'protected-canary-window', arenaNonce: nonce,
    waveId, arenaBase: arena, sdkBase: sdk, frames};
  const stageReceipt = {arenaNonce: nonce, waveId,
    frameSha256: frames.map(frame => frame.sha256),
    exactReadbackVerified: true, workerStarted: false, saveWrites: 0};
  return {nonce, arenaBase: `0x${arena.toString(16)}`,
    sdkBase: `0x${sdk.toString(16)}`, mainBase: `0x${main.toString(16)}`,
    waveId, hostIp, port, staged, stageReceipt};
}

test('generates bounded owner-checked native worker without save write requests', async () => {
  const options = await fixture();
  const source = makeAbortWorkerSource(options);
  assert.ok(Buffer.byteLength(source) <= 32768);
  assert.match(source, /b\.fs_transport/);
  assert.match(source, /transport\.stage~='read-request'/);
  assert.match(source, /held\.owner~=nonce/);
  assert.match(source, /b\.fs_worker_hold=hold/);
  assert.match(source, /hold\.phase='start:'/);
  assert.match(source, /hold\.phase='join:'/);
  assert.match(source, /for i=1,200 do/);
  assert.match(source, /love\.timer\.sleep\(0\.01\)/);
  assert.match(source, /if not retained then b\.fs_worker_hold=nil else held\.stage='quarantined' end/);
  assert.doesNotMatch(source, /local (?:createFile|writeFile|deleteFile)=love\.ffi\.declare/);
  assert.match(source, /packets=\{/);
  assert.match(source, /handles=\{321,312,311\}/);
  assert.match(source, /tonumber\(words\[0\]\)==0x76543210/);
  assert.match(source, /tonumber\(words\[1\]\)==0xfedcba98/);
  assert.doesNotMatch(source, /0xfedcba9876543210ULL/);
});

test('read-only guard checks all staged packets and sentinel halves before workers', async () => {
  const options = await fixture();
  const source = makeAbortGuardSource(options);
  assert.ok(Buffer.byteLength(source) <= 32768);
  assert.match(source, /t\.stage~='read-request'/);
  assert.match(source, /tonumber\(words\[k\*2\]\)~=0x76543210/);
  assert.match(source, /tonumber\(words\[k\*2\+1\]\)~=0xfedcba98/);
  assert.doesNotMatch(source, /0xfedcba9876543210ULL/);
  assert.doesNotMatch(source, /svcStartThread|b\.fs_worker_hold=hold/);
  assert.deepEqual(parseAbortGuardReply(
    `-> ${GUARD_MARKER}\tok\t${nonce}\t${waveId}\tall-frames-verified\n`,
    options), {owner: nonce, waveId, frameCount: 3,
    verified: true, workersStarted: false});
  assert.throws(() => parseAbortGuardReply(
    `-> ${GUARD_MARKER}\tfail\t${nonce}\t${waveId}\tsentinel:0:1\n`,
    options), /sentinel:0:1/);
});

test('generated Lua parses without executing native calls', async t => {
  const available = spawnSync('luajit', ['-v'], {encoding: 'utf8'});
  if (available.error?.code === 'ENOENT') return t.skip('LuaJIT is unavailable');
  const source = makeAbortWorkerSource(await fixture());
  const parsed = spawnSync('luajit', ['-e',
    'local source=io.read("*a"); local fn,err=loadstring(source); if not fn then io.stderr:write(err); os.exit(1) end'],
  {input: source, encoding: 'utf8'});
  assert.equal(parsed.status, 0, parsed.stderr);
  const guard = makeAbortGuardSource(await fixture());
  const parsedGuard = spawnSync('luajit', ['-e',
    'local source=io.read("*a"); local fn,err=loadstring(source); if not fn then io.stderr:write(err); os.exit(1) end'],
  {input: guard, encoding: 'utf8'});
  assert.equal(parsedGuard.status, 0, parsedGuard.stderr);
});

test('four-role protected canary worker preserves exact roles and cleanup gate', async t => {
  const options = protectedFixture();
  const guard = makeAbortGuardSource(options);
  const source = makeAbortWorkerSource(options);
  assert.match(guard, /for j=0,3 do/);
  assert.match(source, /for j=0,3 do/);
  assert.match(source, /if retained or #rows~=4 then return fail\('worker-cleanup'\) end/);
  assert.ok(Buffer.byteLength(guard) <= 32768);
  assert.ok(Buffer.byteLength(source) <= 32768);
  assert.equal(parseAbortGuardReply(
    `-> ${GUARD_MARKER}\tok\t${nonce}\t${waveId}\tall-frames-verified\n`,
    options).frameCount, 4);
  const parsed = parseAbortWorkerReply(successReply(options), options);
  assert.deepEqual(parsed.rows.map(row => row.role),
    ['canary', 'pin', 'receive', 'trigger']);
  assert.deepEqual(parsed.rows.map(row => row.requestKind),
    ['cloned-save-entry-type', 'owned-storage-open',
      'receive-buffer-request', 'cloned-save-entry-type']);
  assert.equal(parsed.fsSideMarkerReadbackVerified, false);
  assert.equal(parsed.fsStageVerified, false);
  const available = spawnSync('luajit', ['-v'], {encoding: 'utf8'});
  if (available.error?.code === 'ENOENT') return t.skip('LuaJIT is unavailable');
  for (const generated of [guard, source]) {
    const checked = spawnSync('luajit', ['-e',
      'local source=io.read("*a"); local fn,err=loadstring(source); if not fn then io.stderr:write(err); os.exit(1) end'],
    {input: generated, encoding: 'utf8'});
    assert.equal(checked.status, 0, checked.stderr);
  }
});

test('four-role worker rejects wrong kind, role order, and duplicate handles', () => {
  const options = protectedFixture();
  assert.throws(() => makeAbortWorkerSource({...options,
    staged: {...options.staged, workerKind: 'abort-control'}}),
  /kind and exact role count/);
  assert.throws(() => makeAbortWorkerSource({...options,
    staged: {...options.staged, frames: options.staged.frames.map((frame, i) =>
      i === 0 ? {...frame, role: 'trigger'} : frame)}}),
  /frame no longer has exact ownership/);
  assert.throws(() => makeAbortWorkerSource({...options,
    staged: {...options.staged, frames: options.staged.frames.map((frame, i) =>
      i === 1 ? {...frame, handle: options.staged.frames[0].handle} : frame)}}),
  /frame no longer has exact ownership/);
});

test('rejects altered stage receipts, ownership and handles before source creation', async () => {
  const options = await fixture();
  assert.throws(() => makeAbortWorkerSource({...options,
    stageReceipt: {...options.stageReceipt, exactReadbackVerified: false}}),
  /freshly staged/);
  assert.throws(() => makeAbortWorkerSource({...options, waveId: nonce}),
    /distinct wave/);
  assert.throws(() => makeAbortWorkerSource({...options,
    staged: {...options.staged, frames: options.staged.frames.map((frame, index) =>
      index ? frame : {...frame, handle: 999})}}), /exact ownership/);
});

test('parses exact joined native rows and preserves CMIF parsing for the adapter', async () => {
  const options = await fixture();
  const parsed = parseAbortWorkerReply(successReply(options), options);
  assert.equal(parsed.workerState, 'joined-closed');
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows.map(row => row.role), ['pin', 'receive', 'trigger']);
  assert.deepEqual(parsed.rows.map(row => row.handle), [321, 312, 311]);
  assert.equal(new Set(parsed.rows.map(row => row.threadId)).size, 3);
  assert.equal(parsed.fsSideMarkerReadbackVerified, false);
  assert.equal(parsed.fsStageVerified, false);
});

test('fails closed on stale, duplicated, timed-out and retained-worker replies', async () => {
  const options = await fixture();
  const good = successReply(options);
  assert.throws(() => parseAbortWorkerReply(good + good, options),
    /missing or duplicated/);
  assert.throws(() => parseAbortWorkerReply(good.replace(options.waveId,
    '1111111111111111'), options), /incomplete/);
  assert.throws(() => parseAbortWorkerReply(good.replace('joined-closed',
    'retained'), options), /cleanup uncertain/);
  assert.throws(() => parseAbortWorkerReply(good.replace('arena-retained',
    'arena-released'), options), /cleanup uncertain/);
  assert.throws(() => parseAbortWorkerReply(successReply(options,
    {row: '0000000000000001,0000000000000001,0000000003000000,0'}), options),
  /bounded native time/);
  assert.throws(() => parseAbortWorkerReply(
    `-> ${MARKER}\tfs-abort-worker\tfail\t${options.nonce}\tjoin:2:worker-timeout:retained\n`,
    options), /worker-timeout:retained/);
});
