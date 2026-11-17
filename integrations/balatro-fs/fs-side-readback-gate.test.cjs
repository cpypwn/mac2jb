'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {createHash} = require('node:crypto');
const {packet} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {READ_BYTES} = require('./fs-owned-storage-read.cjs');
const {assessSideReadbackCandidate} = require('./fs-side-readback-gate.cjs');

const arenaBase = 0x4964000000;
const owner = '0123456789abcdef';
const markerNonce = 'fedcba9876543210';
const waveId = 'cafebabedeadcafe';
const ordinaryHandle = 1234;
const candidateHandle = 5678;
const aliasOffset = 0x1400000;

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function u64(value) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(BigInt(value));
  return result;
}

function reply() {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4, 0);
  bytes.writeUInt32LE(4, 4);
  bytes.write('SFCO', 16);
  return bytes;
}

function read(handle, offset, output, address, poison = 0xa5) {
  return {owner, handle, command: 0, offset, size: output.length,
    result: 0, guardsIntact: true, poison, address, arenaBase,
    packet: packet(0, Buffer.concat([u64(offset), u64(output.length)]),
      {receive: [{address, size: output.length, mode: 1}]}),
    reply: reply(), output: Buffer.from(output)};
}

function paths() {
  const marker = {result: 0, type: 1, bytes: content(markerNonce)};
  const absent = {result: 0x202, type: null, bytes: null};
  return {explicitSaveWrites: 0,
    original: {marker, absent}, cloned: {marker, absent},
    padded: {marker, absent}};
}

function phases() {
  const pair = () => ({samples: [Array(16).fill(2266512),
    Array(16).fill(2266512)]});
  return {before: pair(), noStorageBefore: pair(),
    after: pair(), noStorageAfter: pair()};
}

function fixture(candidateBytes) {
  const zero = Buffer.alloc(READ_BYTES, 0x42);
  Buffer.from('ordinary-prefix!').copy(zero);
  const atAlias = Buffer.alloc(16, 0x99);
  const before = paths(), after = paths();
  return {
    baseline: {gameProfile: profile.gameProfile,
      exactRepeatVerified: true,
      markerBytesAbsentFromOrdinaryContent: true,
      completeSaveAuditVerified: true, cleanup: 'verified',
      fsSideAliasVerified: false, markerHitVerified: false,
      storageBytes: 0x3000000,
      ordinaryContentSha256: sha(zero)},
    preflight: {gameProfile: profile.gameProfile,
      sdkBase: '0x57390b4000', arenaBase: `0x${arenaBase.toString(16)}`,
      arenaNonce: owner, markerNonce, exactAllocationBytes: null,
      markerHitVerified: false, fsStageVerified: false},
    wave: {owner, sdkBase: '0x57390b4000', waveId,
      workerKind: 'balatro-gap-13', eventGatedRelease: true,
      clock: 'native-counter', clockHz: 19200000,
      release: {result: 0, gate: 'group-released', workerJoined: true,
        startTick: '100', endTick: '200'},
      nativeGuard: {completed: 0, earlyHole: 0, minimumSpacing: 0},
      canary: {result: 0, type: 0,
        before: {result: 0, type: 1}, after: {result: 0, type: 1}},
      trigger: {result: 0, type: 1}, triggerAborted: false,
      counterRestored: true, changedPathRoles: ['canary'],
      borrowedSessionHandle: 42},
    ordinary: {owner, handle: ordinaryHandle, closed: true,
      storageBytes: 0x3000000,
      zeroBefore: read(ordinaryHandle, 0, zero, arenaBase + 0x32000),
      zeroAfter: read(ordinaryHandle, 0, zero, arenaBase + 0x50000, 0x5a),
      aliasBefore: read(ordinaryHandle, aliasOffset, atAlias,
        arenaBase + 0x70000),
      aliasAfter: read(ordinaryHandle, aliasOffset, atAlias,
        arenaBase + 0x71000, 0x5a)},
    candidate: {owner, handle: candidateHandle, closed: true,
      storageBytes: 0x3000000,
      aliasOffset, openedClock: 'native-counter', openedTick: '201',
      zeroRead: read(candidateHandle, 0, zero,
        arenaBase + 0x73000, 0x5a),
      aliasRead: read(candidateHandle, aliasOffset, candidateBytes,
        arenaBase + 0x72000)},
    controls: {pathBefore: before, pathAfter: after,
      counterPhases: phases(), changedPaths: [],
      saveAudit: {coverage: 'bounded-cloned-save-tree',
        completeSaveTreeVerified: true, logPrefixVerified: true,
        logState: 'append-only', changed: []}},
    cleanup: {ordinaryStorageClosed: true, candidateStorageClosed: true,
      groupClosed: true, workersJoinedClosed: true,
      ownedHandlesClosed: true, markerNeutralized: true,
      markerRemoved: false,
      borrowedSession: 'preserved', arena: 'released'},
  };
}

test('ordinary prefix at candidate alias offset is a cache alias candidate only', () => {
  const zeroPrefix = Buffer.from('ordinary-prefix!');
  const result = assessSideReadbackCandidate(fixture(zeroPrefix));
  assert.equal(result.cacheAliasCandidate, true);
  assert.equal(result.markerNeutralized, true);
  assert.equal(result.markerRemoved, false);
  assert.equal(result.nonceMarkerCandidate, false);
  assert.equal(result.candidateDiffersFromOrdinaryAlias, true);
  assert.equal(result.fsSideReaderVerified, false);
  assert.equal(result.fsSideMarkerReadbackVerified, false);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
});

test('exact nonce bytes remain a candidate without independent FS provenance', () => {
  const result = assessSideReadbackCandidate(fixture(content(markerNonce)));
  assert.equal(result.cacheAliasCandidate, false);
  assert.equal(result.nonceMarkerCandidate, true);
  assert.equal(result.markerHitVerified, false);
  assert.equal(result.fsStageVerified, false);
});

test('ordinary alias bytes classify as a negative observation', () => {
  const result = assessSideReadbackCandidate(fixture(Buffer.alloc(16, 0x99)));
  assert.equal(result.candidateDiffersFromOrdinaryAlias, false);
  assert.equal(result.cacheAliasCandidate, false);
  assert.equal(result.nonceMarkerCandidate, false);
});

test('missing release, distinct ownership, stable content, or cleanup fails closed', () => {
  const input = fixture(Buffer.from('ordinary-prefix!'));
  input.wave.eventGatedRelease = false;
  assert.throws(() => assessSideReadbackCandidate(input), /event-gated/);
  const sameHandle = fixture(Buffer.from('ordinary-prefix!'));
  sameHandle.candidate.handle = ordinaryHandle;
  sameHandle.candidate.aliasRead.handle = ordinaryHandle;
  assert.throws(() => assessSideReadbackCandidate(sameHandle), /distinct owned/);
  const drift = fixture(Buffer.from('ordinary-prefix!'));
  drift.ordinary.zeroAfter.output[0] ^= 0xff;
  assert.throws(() => assessSideReadbackCandidate(drift), /ordinary content changed/);
  const wrongCandidate = fixture(Buffer.from('ordinary-prefix!'));
  wrongCandidate.candidate.zeroRead.output[0] ^= 0xff;
  assert.throws(() => assessSideReadbackCandidate(wrongCandidate),
    /ordinary content changed/);
  const unclean = fixture(Buffer.from('ordinary-prefix!'));
  unclean.controls.saveAudit.changed.push('/save.dat');
  assert.throws(() => assessSideReadbackCandidate(unclean), /save audit/);
});
