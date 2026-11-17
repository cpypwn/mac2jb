const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {response: cmifResponse} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {MARKER, WORKERS, FRAME_SPACING, PACKET_OFFSET, PACKET_BYTES, SERVICE_HANDLE_OFFSET,
  buildFrame, frameWords, assessRows, makeSource, parseReply, runDiagnostic} =
  require('./fs-counter-overlap.cjs');

const nonce = 'f4da129a43cd091e';
const arenaBase = '0x3cb18f8000';
const sdkBase = '0x28b04b4000';
const mainBase = '0x289d804000';
const context = {nonce, arenaBase, sdkBase, mainBase};
const hex = value => value.toString(16).padStart(16, '0');
const rows = [
  {threadId: hex(0x61), enteredTick: hex(1000000), completedTick: hex(3000000), nativeResult: 0},
  {threadId: hex(0x62), enteredTick: hex(1500000), completedTick: hex(3500000), nativeResult: 0},
  {threadId: hex(0x63), enteredTick: hex(2000000), completedTick: hex(4000000), nativeResult: 0},
];
const reply = `-> ${MARKER}\tfs-counter-overlap\tok\t${nonce}\t${arenaBase}` +
  `\t${sdkBase}\tthread-and-service-handles-released\t` +
  rows.map(row => [row.threadId, row.enteredTick, row.completedTick,
    row.nativeResult].join(',')).join('\t') + '\tarena-retained\n';

test('native worker has a separate 4096-byte CMIF buffer and exact svcSend arguments', () => {
  const base = 0x100000000;
  const sdk = 0x200000000;
  const frame = buildFrame({base, sdk, handle: 0x1234});
  assert.equal(frame.length, PACKET_OFFSET + PACKET_BYTES);
  assert.equal(frame.readBigUInt64LE(0x808),
    BigInt(sdk + profile.symbols.svcSend.offset));
  assert.equal(frame.readBigUInt64LE(0x10a8), BigInt(base + PACKET_OFFSET));
  assert.equal(frame.readBigUInt64LE(0x10b0), BigInt(PACKET_BYTES));
  assert.equal(frame.readBigUInt64LE(SERVICE_HANDLE_OFFSET), 0x1234n);
  assert.equal(frame.readBigUInt64LE(0x10d0), 0n);
  assert.equal(frame.readUInt32LE(PACKET_OFFSET), 4);
  assert.equal(frame.readUInt32LE(PACKET_OFFSET + 4) & 0x3ff, 8);
  assert.equal(frame.toString('ascii', PACKET_OFFSET + 16, PACKET_OFFSET + 20), 'SFCI');
  assert.equal(frame.readUInt32LE(PACKET_OFFSET + 24), 1009);
  assert.equal(frame.readBigUInt64LE(0x400), 0xfedcba9876543210n);
  assert.equal(frame.readBigUInt64LE(0x408), 0xfedcba9876543210n);
  assert.equal(frame.readBigUInt64LE(0x410), 0xfedcba9876543210n);
  assert.ok((WORKERS - 1) * FRAME_SPACING + frame.length < 0x200000);
  const relocated = frameWords();
  assert.deepEqual(relocated.find(word => word[0] === 0x808),
    [0x808, 2, profile.symbols.svcSend.offset]);
  assert.deepEqual(relocated.find(word => word[0] === 0x10a8),
    [0x10a8, 1, PACKET_OFFSET]);
  assert.deepEqual(relocated.find(word => word[0] === 0x10b0),
    [0x10b0, 4, PACKET_BYTES]);
});

test('the second native call receives the service handle after loadTable reloads x20', () => {
  const base = 0x100000000n;
  const sdk = 0x200000000n;
  const handle = 0x1234n;
  const frame = buildFrame({base: Number(base), sdk: Number(sdk), handle: Number(handle)});
  const read = address => frame.readBigUInt64LE(Number(address - base));
  let sp = read(base + 0x68n);
  let x20 = read(base + 0x08n);
  let x21 = read(base + 0x10n);
  let x24 = read(base + 0x28n);
  let x25 = read(base + 0x30n);
  let x27 = read(base + 0x40n);
  const calls = [];
  for (let index = 0; index < 2; index++) {
    const target = read(x21) + (x20 & 0xffffffffn);
    x20 = read(sp + 0x20n);
    x21 = read(sp + 0x10n);
    sp += 0x30n;
    calls.push({target, args: [x25, x24, x20, x27]});
    x20 = read(sp + 0xa0n);
    x21 = read(sp + 0x98n);
    x24 = read(sp + 0x80n);
    x25 = read(sp + 0x78n);
    x27 = read(sp + 0x68n);
    sp += 0xd0n;
  }
  assert.deepEqual(calls[0], {
    target: sdk + BigInt(profile.symbols['nn::os::GetSystemTick'].offset),
    args: [0n, 0n, 0n, 0n],
  });
  assert.deepEqual(calls[1], {
    target: sdk + BigInt(profile.symbols.svcSend.offset),
    args: [base + BigInt(PACKET_OFFSET), BigInt(PACKET_BYTES), handle, 0n],
  });
});

test('client IPC overlap requires a measured margin and never qualifies an FS marker', () => {
  const result = assessRows(rows);
  assert.equal(result.clientIpcWindowOverlapMeasured, true);
  assert.equal(result.commonOverlapTicks, '1000000');
  assert.equal(result.clientOverlapThresholdTicks, '19200');
  assert.equal(result.markerAttempted, false);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
  const near = [rows[0], rows[1],
    {threadId: rows[2].threadId, enteredTick: hex(2999999),
      completedTick: hex(4000000), nativeResult: 0}];
  assert.equal(assessRows(near).commonOverlapTicks, '1');
  assert.equal(assessRows(near).clientIpcWindowOverlapMeasured, false);
  for (const invalid of [
    [rows[0], rows[0], rows[2]],
    [rows[0], rows[1]],
    [rows[0], rows[1], {...rows[2], nativeResult: 1}],
    [rows[0], rows[1], {...rows[2], completedTick: hex(2000000)}],
  ]) assert.throws(() => assessRows(invalid));
});

test('generated request enforces owner, image, service and thread cleanup', () => {
  const source = makeSource(context);
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /local phase="fs-counter-overlap"/);
  assert.match(source, /b\.fs_worker_hold=hold/);
  assert.match(source, /local function validReply/);
  assert.match(source, /tonumber\(w\[0\]\)==0 and header%1024>=minimum/);
  assert.match(source, /local packet=frameBase\+8192/);
  assert.match(source, /frameBase%4096~=0 or packet%4096~=0/);
  assert.match(source, /send\(ffi\.cast\('void\*',packet\),4096,service,0\)/);
  assert.match(source, new RegExp(`frameBase\\+${SERVICE_HANDLE_OFFSET}\\)\\[0\\]=service`));
  assert.doesNotMatch(source, /local init=ffi\.new/);
  assert.match(source, /local function join\(entry\)/);
  assert.match(source, /thread-and-service-handles-released/);
  assert.match(source, /if not retained then b\.fs_worker_hold=nil end/);
  assert.match(source, /counter-reply/);
  assert.doesNotMatch(source.slice(source.indexOf('local held=b.fs_bridge')),
    /love\.ffi\.declare\([^\n]*(?:CreateFile|WriteFile)|save:|marker-hit/);
});

test('live fsp-srv init reply uses response type zero and reports success', () => {
  const captured = Buffer.from(
    '000000000800000000000000000000005346434f0000000000000000d24ef37d' +
    '00'.repeat(96), 'hex');
  assert.equal(captured.length, 128);
  assert.equal(captured.readUInt32LE(0), 0);
  assert.equal(captured.readUInt32LE(4) & 0x3ff, 8);
  const parsed = cmifResponse(captured);
  assert.equal(parsed.result, 0);
  assert.deepEqual(parsed.copies, []);
  assert.deepEqual(parsed.moves, []);
});

test('reply requires exact owner, cleanup, and all three native responses', () => {
  const result = parseReply(reply, context);
  assert.equal(result.clientIpcWindowOverlapMeasured, true);
  assert.equal(result.workerHandles, 'released');
  assert.equal(result.serviceHandles, 'released');
  assert.equal(result.counterStateClearedByCommand1009, true);
  assert.equal(result.explicitFsWriteRequests, 0);
  assert.equal(result.markerHitVerified, false);
  for (const changed of [
    reply.replace(nonce, '0000000000000000'),
    reply.replace('thread-and-service-handles-released', 'handles-retained'),
    reply.replace(rows[1].threadId, rows[0].threadId),
    reply.replace(',0\t', ',1\t'),
    reply + reply,
    `-> ${MARKER}\tfs-counter-overlap\tfail\t${nonce}\tworker-timeout:retained\n`,
  ]) assert.throws(() => parseReply(changed, context));
});

function mockRun({preflightFailure = false, workerFailure = false,
  crcFailure = false, releaseFailure = false} = {}) {
  const calls = [];
  const image = {state: 'serving', metadataVersion: profile.runtimeVersion,
    codeHeadProfile: '1.0.1f', mainBase, sdkBase,
    sampleFingerprintSha256: 'e'.repeat(64)};
  return {calls, deps: {
    host: '10.0.0.189', macIp: '10.0.0.205', nonce,
    identifyImage: async () => image,
    reserve: async () => ({phase: 'reserve', nonce, base: arenaBase, bytes: 0x200000}),
    preflight: async () => {
      calls.push('preflight');
      return {nonce, arenaBase, arenaBytes: 0x200000,
        sdkHz: preflightFailure ? 123 : 19200000};
    },
    verifyCrc: async () => {
      calls.push('crc');
      if (crcFailure) throw Error('crc transport uncertain');
      return {nonce, port: 39381, sdkBase,
        sdkCrc32: `0x${Number.parseInt(profile.sdkCode.offlineCrc32, 16).toString(16)}`};
    },
    execute: async ({source, port}) => {
      assert.equal(port, 9026);
      if (source.includes('no-held-state')) {
        calls.push('idle');
        return `-> BAL_NATIVE_OVERLAP_V1\tidle\tok\t${nonce}\tno-held-state\n`;
      }
      if (source.includes('local phase="fs-counter-overlap"')) {
        calls.push('workers');
        if (workerFailure) throw Error('worker result uncertain');
        return reply;
      }
      if (source.includes('ARENA_DETACHED')) {
        calls.push('release');
        if (releaseFailure) throw Error('release response uncertain');
        return `-> BAL_NATIVE_OVERLAP_V1\tARENA_DETACHED\t${nonce}\t${arenaBase}\n`;
      }
      throw Error('unexpected request');
    },
  }};
}

test('successful run releases owned service handles and detaches its fresh arena', async () => {
  const {calls, deps} = mockRun();
  const result = await runDiagnostic(deps);
  assert.equal(result.arena, 'detached');
  assert.deepEqual(calls, ['idle', 'preflight', 'crc', 'preflight',
    'workers', 'release']);
});

test('preflight failure releases arena but uncertain CRC or worker result retains it', async () => {
  const early = mockRun({preflightFailure: true});
  await assert.rejects(runDiagnostic(early.deps), /fresh arena or native clock/);
  assert.deepEqual(early.calls, ['idle', 'preflight', 'release']);
  const crc = mockRun({crcFailure: true});
  await assert.rejects(runDiagnostic(crc.deps), /crc transport uncertain/);
  assert.deepEqual(crc.calls, ['idle', 'preflight', 'crc']);
  const worker = mockRun({workerFailure: true});
  await assert.rejects(runDiagnostic(worker.deps), /worker result uncertain/);
  assert.deepEqual(worker.calls, ['idle', 'preflight', 'crc', 'preflight', 'workers']);
  const release = mockRun({releaseFailure: true});
  await assert.rejects(runDiagnostic(release.deps), /release response uncertain/);
  assert.deepEqual(release.calls, ['idle', 'preflight', 'crc', 'preflight',
    'workers', 'release']);
});

test('phase breadcrumbs distinguish a timeout before any owned arena exists', async () => {
  const {calls, deps} = mockRun();
  const phases = [];
  deps.onPhase = (phase, state) => phases.push({phase, ...state});
  deps.identifyImage = async () => {
    throw Error('REPL timed out after 10000 ms');
  };
  await assert.rejects(runDiagnostic(deps),
    /identify-image-before-reserve: REPL timed out after 10000 ms/);
  assert.deepEqual(phases, [{phase: 'identify-image-before-reserve', nonce,
    arenaState: 'not-reserved'}]);
  assert.deepEqual(calls, []);
});

test('phase breadcrumbs preserve uncertain worker and one cleanup attempt', async () => {
  const {calls, deps} = mockRun({workerFailure: true});
  const phases = [];
  deps.onPhase = (phase, state) => phases.push({phase, ...state});
  await assert.rejects(runDiagnostic(deps),
    /run-fs-counter-client-overlap: worker result uncertain/);
  assert.deepEqual(phases.map(row => row.phase), ['identify-image-before-reserve',
    'check-no-held-native-state', 'reserve-fresh-owned-arena',
    'verify-fresh-arena-and-clock', 'verify-pinned-sdk-crc',
    'verify-arena-after-sdk-crc', 'run-fs-counter-client-overlap']);
  assert.equal(phases[2].arenaState, 'reserve-request-in-flight');
  assert.equal(phases[3].arenaState, 'retained');
  assert.equal(calls.includes('release'), false);
});
