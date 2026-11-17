const domain = require('../civswitch/fs-kit/port/engine/shared/domain.cjs');
const {matchingBoot, validateEvidence} = require('./clone-control.cjs');
const {managerSnapshot, snapshotSummary, requireUnchanged} =
  require('./borrowed-domain-discriminator.cjs');

function pointerSizePacket() {
  const bytes = domain.control(3);
  if (bytes.length !== 256 || bytes.readUInt32LE(0) !== 5 ||
      bytes.readUInt32LE(4) !== 8 || bytes.toString('ascii', 16, 20) !== 'SFCI' ||
      bytes.readUInt32LE(24) !== 3) {
    throw Error('Balatro pointer-size control packet differs from pinned HIPC layout');
  }
  return bytes;
}

function parsePointerSizeReply(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 256) {
    throw Error('Balatro pointer-size control reply was not complete');
  }
  const rawHeader = bytes.subarray(0, 48).toString('hex');
  let parsed;
  try {parsed = domain.response(bytes);} catch (error) {
    error.rawHeader = rawHeader;
    throw error;
  }
  if (bytes.readUInt32LE(0) !== 0 || (bytes.readUInt32LE(4) >>> 31) !== 0 ||
      (bytes.readUInt32LE(4) & 0x3ff) < 5 ||
      parsed.result !== 0 || parsed.moves.length || parsed.copies.length ||
      parsed.objects.length || parsed.data.length < 2) {
    const error = Error('Balatro borrowed-handle pointer-size control reply changed');
    error.rawHeader = rawHeader;
    error.cmifResult = parsed.result;
    error.copiedHandles = parsed.copies;
    error.movedHandles = parsed.moves;
    throw error;
  }
  return {ipcType: 0, cmifResult: 0, pointerBufferSize: parsed.data.readUInt16LE(),
    copiedHandles: 0, movedHandles: 0, rawHeader};
}

async function runBorrowedControlDiscriminator({evidence, transport, inspectDomain,
  onPhase = () => {}}) {
  validateEvidence(evidence);
  if (!transport || !transport.native ||
      typeof transport.native.read !== 'function' ||
      typeof transport.sendPacket !== 'function' ||
      typeof inspectDomain !== 'function' || typeof onPhase !== 'function' ||
      !(transport.ownedHandles instanceof Set) || transport.ownedHandles.size) {
    throw new TypeError('Balatro pointer-size control needs an idle, handle-free native transport');
  }
  const before = await managerSnapshot(transport.native, evidence);
  onPhase('verify same-boot domain and manager before borrowed-handle control');
  matchingBoot(evidence, await inspectDomain());
  const beforeSend = await managerSnapshot(transport.native, evidence);
  requireUnchanged(before, beforeSend, 'before the borrowed-handle control');

  onPhase('send one QueryPointerBufferSize control on the borrowed handle');
  let reply;
  let sendError;
  try {reply = await transport.sendPacket(evidence.sessionManager.borrowedHandle,
    pointerSizePacket());} catch (error) {sendError = error;}

  let afterSend;
  let after;
  let postError;
  try {
    afterSend = await managerSnapshot(transport.native, evidence);
    requireUnchanged(beforeSend, afterSend, 'after the one borrowed-handle send');
    matchingBoot(evidence, await inspectDomain());
    after = await managerSnapshot(transport.native, evidence);
    requireUnchanged(afterSend, after, 'after the direct SDK post-control');
  } catch (error) {postError = error;}
  let parsed;
  let replyError;
  if (reply) {
    try {parsed = parsePointerSizeReply(reply);} catch (error) {replyError = error;}
  }
  if (sendError || postError || replyError || transport.ownedHandles.size) {
    const errors = [sendError, postError, replyError].filter(Boolean);
    if (transport.ownedHandles.size) {
      errors.push(Error('Balatro control unexpectedly acquired an owned handle'));
    }
    const error = new AggregateError(errors,
      'Balatro borrowed-handle one-send control did not verify');
    error.diagnostic = {sendAttempted: true,
      before: snapshotSummary(before), beforeSend: snapshotSummary(beforeSend),
      afterSend: afterSend && snapshotSummary(afterSend),
      after: after && snapshotSummary(after),
      rawHeader: reply?.subarray(0, 48).toString('hex') || replyError?.rawHeader || null,
      explicitSaveWrites: 0, domainClones: 0, markerWrites: 0};
    throw error;
  }
  return {command: 'QueryPointerBufferSize', controlId: 3,
    borrowedHandle: evidence.sessionManager.borrowedHandle, sendCount: 1,
    ...parsed, before: snapshotSummary(before),
    beforeSend: snapshotSummary(beforeSend),
    afterSend: snapshotSummary(afterSend), after: snapshotSummary(after),
    explicitSaveWrites: 0, domainClones: 0, markerWrites: 0,
    status: 'borrowed-handle HIPC control only; mounted FS object and 2/4 unverified'};
}

module.exports = {pointerSizePacket, parsePointerSizeReply,
  runBorrowedControlDiscriminator};
