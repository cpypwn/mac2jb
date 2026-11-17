'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const {packet} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {ROLES, FRAME_BASE_OFFSET, FRAME_BYTES} =
  require('./fs-gap-port-layout.cjs');
const {FRAME_SPACING} = require('./fs-counter-overlap.cjs');
const {buildGapEventFrame} = require('./fs-gap-event-frame.cjs');
const {MARKER, stageGapEventFrames, makeGapEventWorkerSource,
  parseGapEventWorkerReply} = require('./fs-gap-event-worker.cjs');

const arena = 0x4964000000;
const sdk = 0x57390b4000;
const nonce = '0123456789abcdef';
const waveId = 'aabbccddeeff0011';

function layout() {
  const frameBase = arena + FRAME_BASE_OFFSET;
  return {workerKind: 'balatro-gap-13-layout-only',
    frameLayoutNonoverlapVerified: true, positiveAttemptAllowed: false,
    nativeFrameHandlesVerified: false, frameBase,
    frameSpacing: FRAME_SPACING, frameBytes: FRAME_BYTES,
    owner: {arenaBase: arena, arenaNonce: nonce, sdkBase: sdk,
      arenaBytes: 0x200000,
      sdkCodeSha256: profile.sdkCode.sha256},
    scratch: {address: arena + 0x10000, bytes: 0x80000,
      end: arena + 0x90000},
    frames: ROLES.map((role, index) => {
      const address = frameBase + index * FRAME_SPACING;
      return {role, index, address, end: address + FRAME_BYTES,
        packetAddress: address + 0x2000};
    })};
}

function fixture(mode = 'event-smoke') {
  const ownerLayout = layout();
  const selected = mode === 'event-smoke' ? ['trigger'] : ROLES;
  const frames = selected.map((role, index) =>
    buildGapEventFrame({layout: ownerLayout, role,
      handle: 300 + index,
      request: mode === 'gap-counter-control' ? packet(1009) :
        Buffer.alloc(256, index + 1),
      delayNs: index * 150000}));
  const staged = {workerKind: 'balatro-gap-event-frames', mode,
    arenaNonce: nonce, waveId, arenaBase: arena,
    sdkBase: sdk, layout: ownerLayout, frames};
  const stageReceipt = {arenaNonce: nonce, waveId,
    frameSha256: frames.map(frame => frame.sha256),
    exactReadbackVerified: true, workerStarted: false, saveWrites: 0};
  const options = {nonce, waveId, arenaBase: `0x${arena.toString(16)}`,
    sdkBase: `0x${sdk.toString(16)}`, mainBase: '0x5a00000000',
    hostIp: '10.0.0.205', port: 39381, staged, stageReceipt};
  return {staged, options};
}

function successReply(options) {
  const rows = options.staged.frames.map((_, index) =>
    `000000000000000${(index + 1).toString(16)},${(100 + index * 10).toString(16).padStart(16, '0')},${(200 + index * 10).toString(16).padStart(16, '0')},0`);
  return `-> ${MARKER}\tfs-gap-event-worker\tok\t${nonce}\t${waveId}\t${options.arenaBase}\t${options.sdkBase}\t${options.staged.mode}\tjoined-closed\t${rows.length}\t${rows.join(';')}\tevent-finalized\tarena-retained\n`;
}

test('one-worker event smoke source releases partial starts before join', async t => {
  const {options} = fixture();
  const source = makeGapEventWorkerSource(options);
  assert.ok(Buffer.byteLength(source) <= 32768);
  assert.match(source, /for j,entry in ipairs\(hold\.entries\) do[\s\S]*hold\.phase='start:'/);
  assert.match(source, /hold\.phase='signal-master'/);
  assert.match(source, /if not hold\.signaled and #hold\.entries>0 then[\s\S]*hold\.phase='cleanup-signal'/);
  assert.match(source, /hold\.phase='cleanup-join:'/);
  assert.match(source, /if not retained then[\s\S]*hold\.phase='event-finalize'/);
  assert.match(source, /if retained or not hold\.finalized/);
  assert.match(source, /held\.stage='quarantined'/);
  assert.doesNotMatch(source, /local (?:createFile|writeFile|deleteFile)=love\.ffi\.declare/);
  const available = spawnSync('luajit', ['-v'], {encoding: 'utf8'});
  if (available.error?.code === 'ENOENT') return t.skip('LuaJIT is unavailable');
  const parsed = spawnSync('luajit', ['-e',
    'local source=io.read("*a"); local fn,err=loadstring(source); if not fn then io.stderr:write(err); os.exit(1) end'],
  {input: source, encoding: 'utf8'});
  assert.equal(parsed.status, 0, parsed.stderr);
});

test('13-role source and frame stage are bounded without touching native scratch', async t => {
  const {staged, options} = fixture('gap-candidate');
  const memory = new Map();
  const native = {addresses: {scratch: arena + 0x10000, sdk},
    async write(address, bytes) {memory.set(address, Buffer.from(bytes));},
    async read(address, length) {return memory.get(address)?.subarray(0, length);}};
  const receipt = await stageGapEventFrames(native, staged);
  assert.equal(receipt.exactReadbackVerified, true);
  assert.equal(receipt.frameSha256.length, 13);
  assert.equal(Math.min(...memory.keys()) >= arena + 0x100000, true);
  assert.equal(Math.max(...memory.keys()) + FRAME_BYTES < arena + 0x200000,
    true);
  const source = makeGapEventWorkerSource({...options,
    stageReceipt: receipt});
  assert.ok(Buffer.byteLength(source) <= 32768);
  assert.match(source, /local addresses=\{/);
  assert.match(source, /event-finalized/);
  const available = spawnSync('luajit', ['-v'], {encoding: 'utf8'});
  if (available.error?.code === 'ENOENT') return t.skip('LuaJIT is unavailable');
  const parsed = spawnSync('luajit', ['-e',
    'local source=io.read("*a"); local fn,err=loadstring(source); if not fn then io.stderr:write(err); os.exit(1) end'],
  {input: source, encoding: 'utf8'});
  assert.equal(parsed.status, 0, parsed.stderr);
});

test('duplicate concurrent service handle stops before native staging', async () => {
  const {staged} = fixture('gap-candidate');
  const second = staged.frames[1];
  staged.frames[1] = buildGapEventFrame({layout: staged.layout,
    role: second.role, handle: staged.frames[0].handle,
    request: Buffer.alloc(256, 2), delayNs: second.delayNs});
  let writes = 0;
  const native = {addresses: {scratch: arena + 0x10000, sdk},
    async write() {writes++;},
    async read() {throw Error('read should not begin');}};
  await assert.rejects(stageGapEventFrames(native, staged),
    /reuses a concurrent service handle/);
  assert.equal(writes, 0);
});

test('counter-only mode rejects a changed packet before native staging', async () => {
  const {staged} = fixture('gap-counter-control');
  staged.frames[7] = buildGapEventFrame({layout: staged.layout,
    role: staged.frames[7].role, handle: staged.frames[7].handle,
    request: packet(200)});
  let writes = 0;
  const native = {addresses: {scratch: arena + 0x10000, sdk},
    async write() {writes++;},
    async read() {throw Error('read should not begin');}};
  await assert.rejects(stageGapEventFrames(native, staged),
    /event frame ownership changed/);
  assert.equal(writes, 0);
});

test('thirteen counter-only frames produce a bounded LuaJIT source', t => {
  const {options} = fixture('gap-counter-control');
  const source = makeGapEventWorkerSource(options);
  assert.ok(Buffer.byteLength(source) <= 32768);
  assert.match(source, /gap-counter-control/);
  const available = spawnSync('luajit', ['-v'], {encoding: 'utf8'});
  if (available.error?.code === 'ENOENT') return t.skip('LuaJIT is unavailable');
  const parsed = spawnSync('luajit', ['-e',
    'local source=io.read("*a"); local fn,err=loadstring(source); if not fn then io.stderr:write(err); os.exit(1) end'],
  {input: source, encoding: 'utf8'});
  assert.equal(parsed.status, 0, parsed.stderr);
});

test('reply parser requires finalized event and every joined native row', () => {
  for (const mode of ['event-smoke', 'gap-candidate',
    'gap-counter-control']) {
    const {options} = fixture(mode);
    const parsed = parseGapEventWorkerReply(successReply(options), options);
    assert.equal(parsed.rows.length, mode === 'event-smoke' ? 1 : 13);
    assert.equal(parsed.eventGate, 'initialized-signaled-finalized');
    assert.equal(parsed.markerHitVerified, false);
    assert.equal(parsed.fsStageVerified, false);
    assert.throws(() => parseGapEventWorkerReply(
      successReply(options).replace('event-finalized', 'event-retained'),
      options), /incomplete/);
  }
});

test('source rejects stale receipt, changed layout, and frame role', () => {
  const {options} = fixture();
  assert.throws(() => makeGapEventWorkerSource({...options,
    stageReceipt: {...options.stageReceipt,
      exactReadbackVerified: false}}), /freshly staged/);
  assert.throws(() => makeGapEventWorkerSource({...options,
    staged: {...options.staged,
      layout: {...options.staged.layout,
        scratch: {address: arena + 0x10000,
        end: arena + 0x100000}}}}), /event layout or role count/);
  assert.throws(() => makeGapEventWorkerSource({...options,
    staged: {...options.staged,
      frames: [{...options.staged.frames[0], role: 'canary'}]}}),
  /event layout or role count/);
});
