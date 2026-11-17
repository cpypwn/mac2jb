const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {MARKER, ARENA_BYTES, FRAME_SPACING, WORKERS, SLEEP_NS,
  makeIdleSource, parseIdleReply, buildSleepFrame, frameWords, assessRows, makeSource, parseReply,
  makeReleaseSource, parseReleaseReply, runDiagnostic} = require('./native-counter-overlap.cjs');

const nonce = '7ce41805f743aa82';
const arenaBase = '0x3cb18f8000';
const sdkBase = '0x28b04b4000';
const context = {nonce, arenaBase, sdkBase};
const hex = value => value.toString(16).padStart(16, '0');
const rows = [
  {threadId: hex(0x21), enteredTick: hex(1000000), completedTick: hex(3000000)},
  {threadId: hex(0x22), enteredTick: hex(1500000), completedTick: hex(3500000)},
  {threadId: hex(0x23), enteredTick: hex(2000000), completedTick: hex(4000000)},
];
const reply = `-> ${MARKER}\tnative-counter-overlap\tok\t${nonce}\t${arenaBase}` +
  `\t${sdkBase}\thandles-released\t` +
  rows.map(row => [row.threadId, row.enteredTick, row.completedTick].join(',')).join('\t') +
  '\tarena-retained\n';

test('Balatro sleep chain passes 100 ms as an exact native argument', () => {
  const frame = buildSleepFrame({base: 0x100000000, sdk: 0x200000000});
  assert.equal(frame.length, 0x2000);
  assert.equal(frame.readBigUInt64LE(0x808),
    BigInt(0x200000000 + profile.symbols['nn::os::SleepThread'].offset));
  assert.equal(frame.readBigUInt64LE(0x10a8), BigInt(SLEEP_NS));
  assert.equal(frame.readBigUInt64LE(0x800),
    BigInt(0x200000000 + profile.symbols['nn::os::GetSystemTick'].offset));
  assert.equal(frame.readBigUInt64LE(0x810),
    BigInt(0x200000000 + profile.symbols['nn::os::GetSystemTick'].offset));
  assert.equal(frame.readBigUInt64LE(0x400), 0xfedcba9876543210n);
  assert.equal(frame.readBigUInt64LE(0x410), 0xfedcba9876543210n);
  const relocated = frameWords();
  assert.equal(relocated.frameBytes, 0x2000);
  assert.deepEqual(relocated.words.find(word => word[0] === 0x10a8),
    [0x10a8, 4, SLEEP_NS]);
  assert.deepEqual(relocated.words.find(word => word[0] === 0x808),
    [0x808, 2, profile.symbols['nn::os::SleepThread'].offset]);
  assert.ok(FRAME_SPACING > frame.length &&
    (WORKERS - 1) * FRAME_SPACING + frame.length < ARENA_BYTES);
});

test('native timing assessment requires three unique, bounded worker intervals', () => {
  const result = assessRows(rows);
  assert.equal(result.nativeWorkerOverlapMeasured, true);
  assert.equal(result.commonOverlapTicks, '1000000');
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
  assert.equal(assessRows([
    rows[0], rows[1],
    {threadId: hex(0x23), enteredTick: hex(5000000), completedTick: hex(7000000)},
  ]).nativeWorkerOverlapMeasured, false);
  for (const changed of [
    [rows[0], rows[0], rows[2]],
    [rows[0], rows[1]],
    [rows[0], rows[1], {...rows[2], enteredTick: 'garbled'}],
    [rows[0], rows[1], {...rows[2], completedTick: hex(2000001)}],
  ]) assert.throws(() => assessRows(changed));
});

test('the generated RPC request has a bounded worker and cleanup path without explicit FS writes', () => {
  const source = makeSource(context);
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /local phase="native-counter-overlap"/);
  assert.match(source, /b\.fs_worker_hold=hold/);
  assert.match(source, /previous-worker-or-transport/);
  assert.match(source, /for j=0,2 do/);
  assert.match(source, /local function join\(entry\)/);
  assert.match(source, /if not retained then b\.fs_worker_hold=nil end/);
  assert.match(source, /arena-retained/);
  assert.doesNotMatch(source.slice(source.indexOf('local held=b.fs_bridge')),
    /CreateFile|WriteFile|save:|marker-hit|FS acquisition readback/);
  const cleanup = makeReleaseSource(context);
  assert.match(cleanup, /if not b or b\.state~='serving'/);
  assert.match(cleanup, /b\.fs_worker_hold or b\.fs_transport/);
  assert.match(cleanup, /b\.fs_bridge=nil/);
  assert.doesNotMatch(cleanup, /CreateFile|WriteFile|save:/);
});

test('idle gate rejects previous arena, workers, transport and changed image', () => {
  const idleContext = {...context, mainBase: '0x289d804000'};
  const source = makeIdleSource(idleContext);
  assert.match(source, /b\.fs_bridge or b\.fs_worker_hold or b\.fs_transport/);
  assert.match(source, /b\.info\.main_base/);
  assert.match(source, /b\.info\.sdk_base/);
  assert.deepEqual(parseIdleReply(`-> ${MARKER}\tidle\tok\t${nonce}\tno-held-state\n`, nonce),
    {nonce, idle: true});
  for (const changed of [
    `-> ${MARKER}\tidle\tfail\t${nonce}\tactive-state\n`,
    `-> ${MARKER}\tidle\tfail\t${nonce}\timage-changed\n`,
    `-> ${MARKER}\tidle\tok\t0000000000000000\tno-held-state\n`,
  ]) assert.throws(() => parseIdleReply(changed, nonce));
});

test('reply parsing rejects stale identity, unverified handles, and malformed rows', () => {
  const result = parseReply(reply, context);
  assert.equal(result.nativeWorkerOverlapMeasured, true);
  assert.equal(result.workerHandles, 'released');
  assert.equal(result.arena, 'retained');
  assert.equal(result.explicitFsWriteRequests, 0);
  assert.equal(result.rpcLoggingMayWriteSave, true);
  for (const changed of [
    reply.replace(nonce, '0000000000000000'),
    reply.replace('handles-released', 'handles-retained'),
    reply.replace('arena-retained', 'arena-detached'),
    reply.replace(rows[1].threadId, rows[0].threadId),
    reply + reply,
    `-> ${MARKER}\tnative-counter-overlap\tfail\t${nonce}\tworker-timeout:retained\n`,
  ]) assert.throws(() => parseReply(changed, context));
  assert.deepEqual(parseReleaseReply(
    `-> ${MARKER}\tARENA_DETACHED\t${nonce}\t${arenaBase}\n`, context),
  {arena: 'detached', owner: nonce});
  assert.throws(() => parseReleaseReply(`-> ${MARKER}\tcleanup-refused\n`, context));
});

test('runner gates one worker request on fresh arena, native clock, SDK CRC and image', async () => {
  const image = {state: 'serving', metadataVersion: profile.runtimeVersion,
    codeHeadProfile: '1.0.1f', mainBase: '0x289d804000', sdkBase,
    sampleFingerprintSha256: 'f'.repeat(64)};
  let imageCalls = 0;
  let workerCalls = 0;
  let releaseCalls = 0;
  let idleCalls = 0;
  const deps = {
    host: '10.0.0.189', macIp: '10.0.0.205', nonce,
    identifyImage: async () => {imageCalls++; return image;},
    reserve: async () => ({phase: 'reserve', nonce, base: arenaBase, bytes: ARENA_BYTES}),
    preflight: async () => ({nonce, arenaBase, arenaBytes: ARENA_BYTES, sdkHz: 19200000}),
    verifyCrc: async () => ({nonce, port: 39381, sdkBase,
      sdkCrc32: `0x${Number.parseInt(profile.sdkCode.offlineCrc32, 16).toString(16)}`}),
    execute: async ({source, port}) => {
      assert.equal(port, 9026);
      if (source.includes(`'${MARKER}\\tidle`)) {
        idleCalls++;
        return `-> ${MARKER}\tidle\tok\t${nonce}\tno-held-state\n`;
      }
      if (source.includes('local phase="native-counter-overlap"')) {
        workerCalls++;
        return reply;
      }
      if (source.includes('ARENA_DETACHED')) {
        releaseCalls++;
        return `-> ${MARKER}\tARENA_DETACHED\t${nonce}\t${arenaBase}\n`;
      }
      throw Error('unexpected RPC request');
    },
  };
  const result = await runDiagnostic(deps);
  assert.equal(result.nativeWorkerOverlapMeasured, true);
  assert.equal(result.arena, 'detached');
  assert.equal(imageCalls, 2);
  assert.equal(idleCalls, 1);
  assert.equal(workerCalls, 1);
  await assert.rejects(runDiagnostic({...deps,
    execute: async ({source}) => source.includes(`'${MARKER}\\tidle`) ?
      `-> ${MARKER}\tidle\tfail\t${nonce}\tactive-state\n` : reply}),
  /active state/);
  assert.equal(workerCalls, 1);
  assert.equal(releaseCalls, 1);
  await assert.rejects(runDiagnostic({...deps,
    reserve: async () => ({phase: 'reserve', nonce: 'stale', base: arenaBase,
      bytes: ARENA_BYTES})}), /fresh arena reservation/);
  assert.equal(workerCalls, 1);
  await assert.rejects(runDiagnostic({...deps,
    verifyCrc: async () => ({nonce, port: 39381, sdkBase, sdkCrc32: '0x0'})}),
  /complete SDK CRC/);
  assert.equal(workerCalls, 1);
  await assert.rejects(runDiagnostic({...deps,
    identifyImage: async () => ({...image, codeHeadProfile: '1.0.1o'})}),
  /pinned 1.0.1f image/);
  assert.equal(workerCalls, 1);
});
