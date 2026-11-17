'use strict';

// Pure comparison for a future, event-gated Balatro gap wave. A content
// divergence is an acquisition candidate until independent FS provenance is
// established. This module performs no native operation and grants no stage.
const {createHash} = require('node:crypto');
const {packet, response} =
  require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const {content} = require('./marker-content-control.cjs');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');
const {checkPaths} = require('./fs-abort-control.cjs');
const {assessNoStorageControls} = require('./canary-geometry-plan.cjs');
const {READ_BYTES} = require('./fs-owned-storage-read.cjs');

const PROBE_BYTES = 16;
const MAX_ALIAS_OFFSET = 0x2000000;

function check(condition, reason) {
  if (!condition) throw Error(`Balatro FS readback candidate: ${reason}`);
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function tick(value) {
  check(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value),
    'native tick is missing or imprecise');
  return BigInt(value);
}

function assessRead(read, {owner, handle, offset, size}) {
  check(read?.owner === owner && read.handle === handle &&
    read.command === 0 && read.offset === offset && read.size === size &&
    read.result === 0 && read.guardsIntact === true &&
    [0xa5, 0x5a].includes(read.poison) &&
    Number.isSafeInteger(read.address) && read.address % 0x1000 === 0 &&
    read.address >= read.arenaBase + 0x10000 &&
    read.address + size + 64 <= read.arenaBase + 0x90000 &&
    Buffer.isBuffer(read.packet) && Buffer.isBuffer(read.reply) &&
    read.reply.length === 256 && Buffer.isBuffer(read.output) &&
    read.output.length === size &&
    !read.output.equals(Buffer.alloc(size, read.poison)),
  'owned read result, buffer, or guard differs');
  const expected = packet(0, Buffer.concat([u64(offset), u64(size)]),
    {receive: [{address: read.address, size, mode: 1}]});
  check(read.packet.equals(expected), 'IStorage::Read packet differs');
  const parsed = response(read.reply);
  check(parsed.result === 0 && parsed.moves.length === 0 &&
    parsed.copies.length === 0, 'IStorage::Read reply differs or moved a handle');
  return read.output;
}

function assessSideReadbackCandidate({baseline, preflight, wave, ordinary,
  candidate, controls, cleanup}) {
  const owner = preflight?.arenaNonce;
  const markerNonce = preflight?.markerNonce;
  check(preflight?.gameProfile === profile.gameProfile &&
    /^[0-9a-f]{16}$/.test(owner || '') &&
    /^[0-9a-f]{16}$/.test(markerNonce || '') &&
    preflight.markerHitVerified === false &&
    preflight.fsStageVerified === false &&
    preflight.exactAllocationBytes === null &&
    baseline?.gameProfile === profile.gameProfile &&
    baseline.exactRepeatVerified === true &&
    baseline.markerBytesAbsentFromOrdinaryContent === true &&
    baseline.completeSaveAuditVerified === true &&
    baseline.cleanup === 'verified' &&
    baseline.fsSideAliasVerified === false &&
    baseline.markerHitVerified === false &&
    /^[0-9a-f]{64}$/.test(baseline.ordinaryContentSha256 || ''),
  'fresh pinned owner and completed serial ordinary baseline are required');
  check(wave?.owner === owner && wave.sdkBase === preflight.sdkBase &&
    /^[0-9a-f]{16}$/.test(wave.waveId || '') &&
    new Set([owner, markerNonce, wave.waveId]).size === 3 &&
    wave.workerKind === 'balatro-gap-13' &&
    wave.clock === 'native-counter' && wave.clockHz === 19200000 &&
    wave.eventGatedRelease === true &&
    wave.release?.result === 0 && wave.release?.gate === 'group-released' &&
    wave.release?.workerJoined === true &&
    wave.nativeGuard?.completed === 0 &&
    wave.nativeGuard.earlyHole === 0 &&
    wave.nativeGuard.minimumSpacing === 0 &&
    wave.canary?.result === 0 && wave.canary.type === 0 &&
    wave.canary.before?.result === 0 && wave.canary.before.type === 1 &&
    wave.canary.after?.result === 0 && wave.canary.after.type === 1 &&
    wave.trigger?.result === 0 && wave.trigger.type === 1 &&
    wave.triggerAborted === false && wave.counterRestored === true &&
    Array.isArray(wave.changedPathRoles) &&
    wave.changedPathRoles.length === 1 &&
    wave.changedPathRoles[0] === 'canary',
  'event-gated path alias candidate or native guards are missing');
  const releaseEnd = tick(wave.release.endTick);
  check(candidate?.openedClock === wave.clock &&
    tick(wave.release.startTick) < releaseEnd &&
    tick(candidate?.openedTick) > releaseEnd,
  'candidate storage was not opened after the event-gated release');
  check(Number.isInteger(ordinary?.handle) && ordinary.handle > 0 &&
    ordinary.handle < 0xffff8000 && ordinary.owner === owner &&
    ordinary.closed === true &&
    Number.isInteger(candidate?.handle) && candidate.handle > 0 &&
    candidate.handle < 0xffff8000 && candidate.handle !== ordinary.handle &&
    candidate.owner === owner && candidate.closed === true &&
    ordinary.handle !== wave.borrowedSessionHandle &&
    candidate.handle !== wave.borrowedSessionHandle &&
    Number.isSafeInteger(baseline.storageBytes) &&
    Number.isSafeInteger(ordinary.storageBytes) &&
    Number.isSafeInteger(candidate.storageBytes) &&
    ordinary.storageBytes === baseline.storageBytes &&
    candidate.storageBytes === ordinary.storageBytes &&
    Number.isInteger(candidate.aliasOffset) &&
    candidate.aliasOffset >= READ_BYTES &&
    candidate.aliasOffset <= MAX_ALIAS_OFFSET &&
    candidate.aliasOffset % PROBE_BYTES === 0 &&
    candidate.aliasOffset + PROBE_BYTES <= candidate.storageBytes,
  'two distinct owned storage handles or bounded alias offset are missing');
  const geometry = {owner, offset: 0, size: READ_BYTES};
  const zeroBefore = assessRead(ordinary.zeroBefore,
    {...geometry, handle: ordinary.handle});
  const zeroAfter = assessRead(ordinary.zeroAfter,
    {...geometry, handle: ordinary.handle});
  const alias = {owner, offset: candidate.aliasOffset, size: PROBE_BYTES};
  const aliasBefore = assessRead(ordinary.aliasBefore,
    {...alias, handle: ordinary.handle});
  const aliasAfter = assessRead(ordinary.aliasAfter,
    {...alias, handle: ordinary.handle});
  const candidateZero = assessRead(candidate.zeroRead,
    {...geometry, handle: candidate.handle});
  const selected = assessRead(candidate.aliasRead,
    {...alias, handle: candidate.handle});
  check([ordinary.zeroBefore, ordinary.zeroAfter, ordinary.aliasBefore,
    ordinary.aliasAfter, candidate.zeroRead, candidate.aliasRead].every(read =>
    read.arenaBase === Number(BigInt(preflight.arenaBase))),
  'read buffers belong to another owner arena');
  check(zeroBefore.equals(zeroAfter) &&
    candidateZero.equals(zeroBefore) &&
    sha(zeroBefore) === baseline.ordinaryContentSha256 &&
    aliasBefore.equals(aliasAfter) &&
    zeroBefore.indexOf(content(markerNonce)) === -1,
  'ordinary content changed or contains the nonce marker');
  check(controls?.saveAudit?.coverage === 'bounded-cloned-save-tree' &&
    controls.saveAudit.completeSaveTreeVerified === true &&
    controls.saveAudit.logPrefixVerified === true &&
    controls.saveAudit.logState === 'append-only' &&
    Array.isArray(controls.saveAudit.changed) &&
    controls.saveAudit.changed.length === 0 &&
    Array.isArray(controls.changedPaths) &&
    controls.changedPaths.length === 0,
  'complete save audit changed or is missing');
  checkPaths(controls.pathBefore, markerNonce);
  checkPaths(controls.pathAfter, markerNonce);
  assessNoStorageControls(controls.counterPhases);
  check(cleanup?.ordinaryStorageClosed === true &&
    cleanup.candidateStorageClosed === true &&
    cleanup.groupClosed === true && cleanup.workersJoinedClosed === true &&
    cleanup.ownedHandlesClosed === true &&
    markerCleanupVerified(cleanup) &&
    cleanup.borrowedSession === 'preserved' &&
    cleanup.arena === 'released',
  'exact owner and worker cleanup is missing');
  const normalAtAlias = selected.equals(aliasBefore);
  const cacheAliasCandidate = !normalAtAlias &&
    selected.equals(zeroBefore.subarray(0, PROBE_BYTES));
  const nonceMarkerCandidate = !normalAtAlias &&
    selected.equals(content(markerNonce));
  return {waveId: wave.waveId, arenaNonce: owner,
    markerNonce, aliasOffset: candidate.aliasOffset,
    ordinaryZeroSha256: sha(zeroBefore),
    candidateZeroSha256: sha(candidateZero),
    ordinaryAliasHex: aliasBefore.toString('hex'),
    candidateAliasHex: selected.toString('hex'),
    candidateAliasSha256: sha(selected),
    ordinaryContentStable: true, completeSaveAuditVerified: true,
    ...markerCleanupSummary(cleanup),
    eventGatedReleaseRecorded: true, pathAliasCandidateRecorded: true,
    candidateDiffersFromOrdinaryAlias: !normalAtAlias,
    cacheAliasCandidate, nonceMarkerCandidate,
    fsSideReaderVerified: false,
    fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false,
    status: 'owned IStorage divergence candidate only; independent FS provenance and 2/4 unverified'};
}

module.exports = {PROBE_BYTES, MAX_ALIAS_OFFSET, assessSideReadbackCandidate};
