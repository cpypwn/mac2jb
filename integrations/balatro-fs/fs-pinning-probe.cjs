const {
  createQualifiedContext, makeOpenServicePacket, parseOpenServiceReply,
  makeIpcPacket, parseIpcReply, parseOpenStorageReply,
  makeCloseServicePacket, parseCloseServiceReply, sampleStableCounters,
  assessPinning,
} = require('./fs-counter-probe.cjs');

const MAX_READS_PER_PHASE = 8;

async function runPinningCycle({context, exchange, maxReads = MAX_READS_PER_PHASE}) {
  if (!context || typeof exchange !== 'function' ||
      !Number.isInteger(maxReads) || maxReads < 3 || maxReads > MAX_READS_PER_PHASE) {
    throw new TypeError('Balatro pinning cycle needs a qualified context and bounded exchange');
  }
  let root, storage, before, held, after, failure;
  const close = async (handle, phase) => {
    if (!handle || handle.closed) return;
    parseCloseServiceReply(await exchange(makeCloseServicePacket(context, handle), phase),
      context, handle);
  };
  const counters = label => sampleStableCounters(index =>
    exchange(makeIpcPacket(context, root, 'counters'), `${label}-${index}`)
      .then(reply => parseIpcReply(reply, context, 'counters')), maxReads);
  try {
    root = parseOpenServiceReply(await exchange(makeOpenServicePacket(context),
      'open-fsp-srv'), context);
    parseIpcReply(await exchange(makeIpcPacket(context, root, 'initialize'),
      'initialize-fsp-srv'), context, 'initialize');
    before = await counters('baseline-counters');
    let heldError;
    try {
      storage = parseOpenStorageReply(await exchange(makeIpcPacket(context, root,
        'open-storage'), 'open-owned-content-storage'), context, root);
      held = await counters('held-counters');
    } catch (error) {
      heldError = error;
    }
    try {
      await close(storage, 'close-owned-content-storage');
    } catch (cleanup) {
      if (heldError) throw new AggregateError([heldError, cleanup],
        'Balatro pinning cycle failed and storage handle cleanup was not verified');
      throw cleanup;
    }
    if (heldError) throw heldError;
    after = await counters('restored-counters');
  } catch (error) {
    failure = error;
  }
  try {
    await close(root, 'close-fsp-srv');
  } catch (cleanup) {
    if (failure) throw new AggregateError([failure, cleanup],
      'Balatro pinning cycle failed and root handle cleanup was not verified');
    throw cleanup;
  }
  if (failure) throw failure;
  const assessment = assessPinning(before.samples, held.samples, after.samples);
  return {before, held, after, assessment, cleanup: 'released',
    status: assessment.verified ?
      'one bounded pinning cycle matched; repetition and FS canary unverified' :
      'pinning cycle did not match; no retry or FS canary attempted'};
}

module.exports = {MAX_READS_PER_PHASE, createQualifiedContext, runPinningCycle};
