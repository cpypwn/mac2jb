const {
  makeOpenServicePacket, parseOpenServiceReply, makeIpcPacket,
  parseIpcReply, parseOpenStorageReply, makeCloseServicePacket,
  parseCloseServiceReply, sampleStableCounters, GENERAL_HEAP_INDEX,
} = require('./fs-counter-probe.cjs');

const MAX_CYCLES = 2;
const MAX_READS_PER_PHASE = 8;
const PHASES = ['before', 'baselineControl', 'oneHeld', 'twoHeld',
  'oneHeldAgain', 'after', 'restoredControl'];

function heapValue(phase) {
  if (!phase || !Array.isArray(phase.samples) || phase.samples.length !== 2 ||
      phase.samples.some(row => !Array.isArray(row) || row.length !== 16 ||
        !Number.isSafeInteger(row[GENERAL_HEAP_INDEX]) ||
        row[GENERAL_HEAP_INDEX] < 0) ||
      phase.samples[0][GENERAL_HEAP_INDEX] !== phase.samples[1][GENERAL_HEAP_INDEX]) {
    throw new TypeError('Balatro pinning staircase needs stable 16-counter phase pairs');
  }
  return phase.samples[1][GENERAL_HEAP_INDEX];
}

function assessStaircase(phases) {
  const values = Object.fromEntries(PHASES.map(name => [name, heapValue(phases?.[name])]));
  const deltas = {
    firstOpen: values.baselineControl - values.oneHeld,
    secondOpen: values.oneHeld - values.twoHeld,
    secondClose: values.oneHeldAgain - values.twoHeld,
    firstClose: values.after - values.oneHeldAgain,
  };
  const candidate = deltas.firstOpen;
  const noOpStable = values.before === values.baselineControl &&
    values.after === values.restoredControl;
  const restored = values.after === values.baselineControl;
  const staircaseVerified = noOpStable && restored &&
    Number.isSafeInteger(candidate) && candidate > 0 && candidate <= 0x10000 &&
    Object.values(deltas).every(value => value === candidate);
  return {values, deltas, noOpStable, restored, staircaseVerified,
    candidateDiagnosticCostBytes: staircaseVerified ? candidate : null,
    exactAllocationBytes: null};
}

async function runStaircaseCycle({context, exchange,
  maxReads = MAX_READS_PER_PHASE}) {
  if (!context || typeof exchange !== 'function' ||
      !Number.isInteger(maxReads) || maxReads < 3 ||
      maxReads > MAX_READS_PER_PHASE) {
    throw new TypeError('Balatro pinning staircase needs a qualified context and bounded exchange');
  }
  const phases = {};
  const handles = [];
  let root;
  let failure;
  const close = async (entry, phase) => {
    if (!entry || entry.attempted) return;
    entry.attempted = true;
    parseCloseServiceReply(await exchange(makeCloseServicePacket(context, entry.handle), phase),
      context, entry.handle);
  };
  const counters = label => sampleStableCounters(index =>
    exchange(makeIpcPacket(context, root.handle, 'counters'), `${label}-${index}`)
      .then(reply => parseIpcReply(reply, context, 'counters')), maxReads);
  const openStorage = async number => {
    const handle = parseOpenStorageReply(await exchange(makeIpcPacket(context,
      root.handle, 'open-storage'), `open-owned-content-storage-${number}`),
    context, root.handle);
    const entry = {handle, attempted: false};
    handles.push(entry);
    return entry;
  };
  try {
    root = {handle: parseOpenServiceReply(await exchange(makeOpenServicePacket(context),
      'open-fsp-srv'), context), attempted: false};
    parseIpcReply(await exchange(makeIpcPacket(context, root.handle, 'initialize'),
      'initialize-fsp-srv'), context, 'initialize');
    phases.before = await counters('before');
    phases.baselineControl = await counters('baselineControl');
    const first = await openStorage(1);
    phases.oneHeld = await counters('oneHeld');
    const second = await openStorage(2);
    phases.twoHeld = await counters('twoHeld');
    await close(second, 'close-owned-content-storage-2');
    phases.oneHeldAgain = await counters('oneHeldAgain');
    await close(first, 'close-owned-content-storage-1');
    phases.after = await counters('after');
    phases.restoredControl = await counters('restoredControl');
  } catch (error) {
    failure = error;
  }
  const cleanupErrors = [];
  for (const [index, entry] of [...handles.entries()].reverse()) {
    if (!entry.attempted) {
      try {await close(entry, `cleanup-owned-content-storage-${index + 1}`);}
      catch (error) {cleanupErrors.push(error);}
    }
    if (!entry.handle.closed) cleanupErrors.push(Error(`storage handle ${index + 1} close is unverified`));
  }
  if (root) {
    try {await close(root, 'close-fsp-srv');}
    catch (error) {cleanupErrors.push(error);}
    if (!root.handle.closed) cleanupErrors.push(Error('fsp-srv root close is unverified'));
  }
  if (cleanupErrors.length) {
    throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors,
      'Balatro pinning staircase did not verify complete handle cleanup');
  }
  if (failure) throw failure;
  return {phases, assessment: assessStaircase(phases), cleanup: 'released'};
}

async function runRepeatedStaircase({context, exchange,
  cycle = runStaircaseCycle}) {
  if (!context || typeof exchange !== 'function' || typeof cycle !== 'function') {
    throw new TypeError('Balatro repeated staircase needs a qualified context and exchange');
  }
  const cycles = [];
  for (let index = 1; index <= MAX_CYCLES; index++) {
    const result = await cycle({context,
      exchange: (packet, phase) => exchange(packet, `cycle-${index}-${phase}`)});
    if (result?.cleanup !== 'released' ||
        typeof result.assessment?.staircaseVerified !== 'boolean') {
      throw Error(`Balatro staircase cycle ${index} did not verify handle cleanup`);
    }
    cycles.push(result);
    if (!result.assessment.staircaseVerified) break;
  }
  const repeated = cycles.length === MAX_CYCLES &&
    cycles.every(result => result.assessment.staircaseVerified) &&
    cycles[0].assessment.candidateDiagnosticCostBytes ===
      cycles[1].assessment.candidateDiagnosticCostBytes;
  return {cycles, repeatabilityVerified: repeated,
    candidateDiagnosticCostBytes: repeated ?
      cycles[1].assessment.candidateDiagnosticCostBytes : null,
    exactAllocationBytes: null, markerAttempted: false,
    saveWrites: 0, cleanup: 'released',
    status: repeated ?
      'two held-storage staircases matched; independent allocation proof is still needed' :
      'held-storage staircase did not repeat; no marker was attempted'};
}

module.exports = {MAX_CYCLES, MAX_READS_PER_PHASE, PHASES, assessStaircase,
  runStaircaseCycle, runRepeatedStaircase};
