const {performance} = require('node:perf_hooks');
const {setTimeout: sleep} = require('node:timers/promises');
const {
  SDK_TICK_HZ, GENERAL_HEAP_INDEX, makeTickPacket, parseTickReply,
  makeOpenServicePacket, parseOpenServiceReply, makeIpcPacket,
  parseIpcReply, parseOpenStorageReply, makeCloseServicePacket,
  parseCloseServiceReply, sampleStableCounters, assessPinning,
} = require('./fs-counter-probe.cjs');
const {assessNoStorageControls} = require('./canary-geometry-plan.cjs');

const CALIBRATION_MS = 250;
const CLOCK_TOLERANCE_MS = 50;
const MAX_READS_PER_PHASE = 8;
const EVENT_ROLES = Object.freeze([
  'no-storage-before', 'open-owned-storage', 'no-storage-held',
  'close-owned-storage', 'no-storage-after',
]);

function stableValue(phase) {
  if (!phase || !Array.isArray(phase.samples) || phase.samples.length !== 2 ||
      phase.samples.some(row => !Array.isArray(row) || row.length !== 16 ||
        !Number.isSafeInteger(row[GENERAL_HEAP_INDEX]) ||
        row[GENERAL_HEAP_INDEX] < 0) ||
      phase.samples[0][GENERAL_HEAP_INDEX] !== phase.samples[1][GENERAL_HEAP_INDEX]) {
    throw Error('Balatro native order control needs stable 16-counter phase pairs');
  }
  return phase.samples[1][GENERAL_HEAP_INDEX];
}

function assessClock(first, second, calibrationMs = CALIBRATION_MS) {
  if (![first, second].every(row => row && typeof row.tick === 'string' &&
      /^\d+$/.test(row.tick) && Number.isFinite(row.hostStartMs) &&
      Number.isFinite(row.hostEndMs) && row.hostStartMs <= row.hostEndMs) ||
      !(first.hostEndMs < second.hostStartMs)) {
    throw Error('Balatro native clock samples are incomplete or out of order');
  }
  const delta = BigInt(second.tick) - BigInt(first.tick);
  const minimumMs = second.hostStartMs - first.hostEndMs;
  const maximumMs = second.hostEndMs - first.hostStartMs;
  const measuredMs = Number(delta) * 1000 / SDK_TICK_HZ;
  if (delta <= 0n || !Number.isSafeInteger(Number(delta)) ||
      minimumMs < calibrationMs * 0.5 || !Number.isFinite(measuredMs) ||
      measuredMs < minimumMs - CLOCK_TOLERANCE_MS ||
      measuredMs > maximumMs + CLOCK_TOLERANCE_MS) {
    throw Error('Balatro native counter did not match the measured host-time envelope');
  }
  return {nativeCounterFrequencyVerified: true, sdkHz: SDK_TICK_HZ,
    elapsedTicks: delta.toString(), measuredMs, minimumMs, maximumMs,
    toleranceMs: CLOCK_TOLERANCE_MS};
}

function assessEventOrder(events) {
  if (!Array.isArray(events) || events.length !== EVENT_ROLES.length ||
      events.some((event, index) => event?.role !== EVENT_ROLES[index] ||
        typeof event.startTick !== 'string' || !/^\d+$/.test(event.startTick) ||
        typeof event.endTick !== 'string' || !/^\d+$/.test(event.endTick) ||
        !Number.isFinite(event.hostSendMs) ||
        !Number.isFinite(event.hostReceiveMs) ||
        event.hostSendMs > event.hostReceiveMs)) {
    throw Error('Balatro native action and receive order is incomplete');
  }
  let previousEnd = 0n;
  let previousReceive = -Infinity;
  for (const event of events) {
    const start = BigInt(event.startTick);
    const end = BigInt(event.endTick);
    if (start <= previousEnd || end <= start ||
        event.hostSendMs < previousReceive) {
      throw Error('Balatro native action or receive order changed');
    }
    previousEnd = end;
    previousReceive = event.hostReceiveMs;
  }
  return {serialReceiveOrderVerified: true, concurrentOverlapMeasured: false,
    exactRequestLifetimeMeasured: false};
}

function assessNativeOrderControl({phases, events, clock}) {
  if (clock?.nativeCounterFrequencyVerified !== true) {
    throw Error('Balatro native counter must be qualified before FS controls');
  }
  const controls = assessNoStorageControls(phases);
  if (stableValue(phases.oneHeld) !== stableValue(phases.noStorageHeld)) {
    throw Error('Balatro held-storage no-storage control drifted');
  }
  const pin = assessPinning(phases.before.samples, phases.oneHeld.samples,
    phases.after.samples);
  if (!pin.verified) {
    throw Error('Balatro storage diagnostic did not restore or lacks a candidate');
  }
  const order = assessEventOrder(events);
  return {...controls, ...order,
    candidateDiagnosticCostBytes: pin.bytes,
    diagnosticRestoration: pin.restoration,
    exactAllocationBytes: null, pinAddress: null,
    overlapQualified: false, markerHitVerified: false,
    fsStageVerified: false};
}

async function runNativeOrderControl({context, exchange, wait = sleep,
  now = () => performance.now(), maxReads = MAX_READS_PER_PHASE}) {
  if (!context || typeof exchange !== 'function' || typeof wait !== 'function' ||
      typeof now !== 'function' || !Number.isInteger(maxReads) ||
      maxReads < 3 || maxReads > MAX_READS_PER_PHASE) {
    throw new TypeError('Balatro native order control needs a bounded qualified exchange');
  }
  let root;
  let storage;
  let failure;
  const phases = {};
  const events = [];
  let clock;
  const tick = async phase => {
    const hostStartMs = now();
    const response = await exchange(makeTickPacket(context), phase);
    const hostEndMs = now();
    return {tick: parseTickReply(response).toString(), hostStartMs, hostEndMs};
  };
  const counters = label => sampleStableCounters(index =>
    exchange(makeIpcPacket(context, root.handle, 'counters'), `${label}-${index}`)
      .then(reply => parseIpcReply(reply, context, 'counters')), maxReads);
  const action = async (role, packet, parse) => {
    const before = await tick(`${role}-tick-before`);
    const hostSendMs = now();
    const result = parse(await exchange(packet, role));
    const hostReceiveMs = now();
    const after = await tick(`${role}-tick-after`);
    if (!(before.hostEndMs <= hostSendMs &&
          hostSendMs <= hostReceiveMs &&
          hostReceiveMs <= after.hostStartMs) ||
        BigInt(after.tick) <= BigInt(before.tick)) {
      throw Error(`Balatro ${role} native timing envelope changed`);
    }
    events.push({role, startTick: before.tick, endTick: after.tick,
      hostSendMs, hostReceiveMs});
    return result;
  };
  const close = async (entry, phase) => {
    if (!entry || entry.attempted) return;
    entry.attempted = true;
    parseCloseServiceReply(await exchange(makeCloseServicePacket(context, entry.handle),
      phase), context, entry.handle);
  };
  try {
    root = {handle: parseOpenServiceReply(
      await exchange(makeOpenServicePacket(context), 'open-fsp-srv'), context),
    attempted: false};
    parseIpcReply(await exchange(makeIpcPacket(context, root.handle, 'initialize'),
      'initialize-fsp-srv'), context, 'initialize');
    const first = await tick('clock-first');
    await wait(CALIBRATION_MS);
    const second = await tick('clock-second');
    clock = assessClock(first, second);
    phases.before = await counters('before');
    await action('no-storage-before', makeTickPacket(context), parseTickReply);
    phases.noStorageBefore = await counters('noStorageBefore');
    if (stableValue(phases.before) !== stableValue(phases.noStorageBefore)) {
      throw Error('Balatro baseline no-storage control drifted');
    }
    await action('open-owned-storage',
      makeIpcPacket(context, root.handle, 'open-storage'), reply => {
        storage = {handle: parseOpenStorageReply(reply, context, root.handle),
          attempted: false};
        return storage.handle;
      });
    phases.oneHeld = await counters('oneHeld');
    await action('no-storage-held', makeTickPacket(context), parseTickReply);
    phases.noStorageHeld = await counters('noStorageHeld');
    if (stableValue(phases.oneHeld) !== stableValue(phases.noStorageHeld)) {
      throw Error('Balatro held-storage no-storage control drifted');
    }
    await action('close-owned-storage', makeCloseServicePacket(context, storage.handle),
      reply => {
        storage.attempted = true;
        return parseCloseServiceReply(reply, context, storage.handle);
      });
    phases.after = await counters('after');
    await action('no-storage-after', makeTickPacket(context), parseTickReply);
    phases.noStorageAfter = await counters('noStorageAfter');
  } catch (error) {
    failure = error;
  }
  const cleanupErrors = [];
  if (storage && !storage.attempted) {
    try {await close(storage, 'cleanup-owned-storage');}
    catch (error) {cleanupErrors.push(error);}
  }
  if (storage && !storage.handle.closed) {
    cleanupErrors.push(Error('Balatro storage handle close is unverified'));
  }
  if (root) {
    try {await close(root, 'close-fsp-srv');}
    catch (error) {cleanupErrors.push(error);}
    if (!root.handle.closed) cleanupErrors.push(Error('Balatro fsp-srv close is unverified'));
  }
  if (cleanupErrors.length) {
    throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors,
      'Balatro native order control did not verify handle cleanup');
  }
  if (failure) throw failure;
  const assessment = assessNativeOrderControl({phases, events, clock});
  return {phases, events, clock, assessment, cleanup: 'released',
    saveWrites: 0, markerAttempted: false,
    status: 'serial native-counter and no-storage controls verified; exact pin placement and concurrent overlap unverified'};
}

module.exports = {CALIBRATION_MS, MAX_READS_PER_PHASE, EVENT_ROLES,
  assessClock, assessEventOrder, assessNativeOrderControl,
  runNativeOrderControl};
