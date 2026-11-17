const fs = require('node:fs/promises');
const path = require('node:path');
const {connect, check, u64} = require('./session.cjs');
const {loadTarget} = require('../../shared/target.cjs');

const COUNTER_COUNT = 16;
const GENERAL_HEAP_INDEX = 5;
const MAX_COUNTER_READS = 16;
const REQUIRED_STREAK = 3;
const MAX_CYCLES = 3;

function assessPinning(before, held, after) {
  const valid = sample => Array.isArray(sample) && sample.length === 2 &&
    sample.every(row => Array.isArray(row) && row.length === COUNTER_COUNT &&
      row.every(value => Number.isSafeInteger(value) && value >= 0));
  check(valid(before) && valid(held) && valid(after), 'Incomplete FS allocation counters');
  const value = sample => sample[1][GENERAL_HEAP_INDEX];
  const stability = {
    before: before[1][GENERAL_HEAP_INDEX] - before[0][GENERAL_HEAP_INDEX],
    held: held[1][GENERAL_HEAP_INDEX] - held[0][GENERAL_HEAP_INDEX],
    after: after[1][GENERAL_HEAP_INDEX] - after[0][GENERAL_HEAP_INDEX],
  };
  const bytes = value(before) - value(held);
  const restoration = value(after) - value(before);
  return {bytes, restoration, stability,
    verified: Object.values(stability).every(delta => delta === 0) &&
      Number.isInteger(bytes) && bytes > 0 && bytes <= 0x10000 && restoration === 0};
}

async function readCounters(session, root, label) {
  const reply = await session.ipc(label, root, 1009);
  check(reply.result === 0 && reply.data.length >= COUNTER_COUNT * 8,
    'FS allocation counters unavailable');
  const counters = [];
  for (let at = 0; at < COUNTER_COUNT; at++) {
    const value = reply.data.readBigUInt64LE(at * 8);
    check(value <= BigInt(Number.MAX_SAFE_INTEGER), 'FS allocation counter is too large');
    counters.push(Number(value));
  }
  return counters;
}

async function readStableCounters(session, root, label, maxReads = MAX_COUNTER_READS) {
  check(Number.isInteger(maxReads) && maxReads >= REQUIRED_STREAK && maxReads <= MAX_COUNTER_READS,
    'Invalid counter sampling limit');
  let previous = null, streak = 0;
  const observedGeneralHeap = [];
  for (let index = 0; index < maxReads; index++) {
    const current = await readCounters(session, root, `${label} ${index + 1}`);
    const value = current[GENERAL_HEAP_INDEX];
    observedGeneralHeap.push(value);
    streak = previous && previous[GENERAL_HEAP_INDEX] === value ? streak + 1 : 1;
    if (streak >= REQUIRED_STREAK)
      return {samples: [previous, current], reads: index + 1, observedGeneralHeap};
    previous = current;
  }
  const error = Error(`FS general heap did not stabilize after ${maxReads} reads`);
  error.code = 'UNSTABLE_COUNTERS';
  error.observedGeneralHeap = observedGeneralHeap;
  throw error;
}

async function measureCycle(session, root, index) {
  const before = await readStableCounters(session, root, `Cycle ${index} baseline counters`);
  let storage, held;
  try {
    const opened = await session.ipc(`Cycle ${index} open owned content storage`, root, 200);
    check(opened.result === 0 && opened.moves.length === 1 && opened.copies.length === 0,
      'Owned content storage did not open');
    storage = opened.moves[0];
    held = await readStableCounters(session, root, `Cycle ${index} held counters`);
  } finally {
    if (storage !== undefined) await session.close(storage);
  }
  const after = await readStableCounters(session, root, `Cycle ${index} restored counters`);
  return {before, held, after,
    assessment: assessPinning(before.samples, held.samples, after.samples)};
}

function assessCycles(cycles) {
  const previous = cycles.at(-2)?.assessment;
  const current = cycles.at(-1)?.assessment;
  if (previous?.verified && current?.verified && previous.bytes === current.bytes)
    return {verified: true, bytes: current.bytes, repetitions: 2};
  return {verified: false, bytes: null, repetitions: 0};
}

async function main() {
  const target = loadTarget();
  check(target.name === 'gravcirc', 'Pinning allocation diagnostic is Gravity Circuit only');
  const report = {started: new Date().toISOString(), target: target.name,
    verified: false, saveWrites: 0, raceWorkers: 0};
  const label = `pinning-allocation-${Date.now()}-${process.pid}`;
  const file = path.join(__dirname, label + '.json');
  let session, root, failure;
  try {
    const connected = await connect(label);
    session = connected.s;
    report.session = connected.live.session;
    root = await session.openService('fsp-srv');
    check((await session.ipc('Initialize pinning root', root, 1, u64(0), {pid: true})).result === 0,
      'FS root initialization failed');
    report.cycles = [];
    for (let index = 1; index <= MAX_CYCLES; index++) {
      try {
        report.cycles.push(await measureCycle(session, root, index));
      } catch (error) {
        if (error.code !== 'UNSTABLE_COUNTERS') throw error;
        report.cycles.push({error: error.message,
          observedGeneralHeap: error.observedGeneralHeap});
      }
      const replicated = assessCycles(report.cycles);
      if (replicated.verified) {
        const accepted = report.cycles.at(-1);
        report.before = accepted.before.samples;
        report.held = accepted.held.samples;
        report.after = accepted.after.samples;
        report.assessment = {...accepted.assessment, repetitions: replicated.repetitions};
        break;
      }
    }
    check(report.assessment?.verified === true,
      'Pinning allocation did not repeat with stable counters and restoration');
    report.verified = true;
  } catch (error) {
    failure = error;
    report.error = error.stack;
  } finally {
    if (session) {
      try {
        await session.cleanup();
        report.cleanedUp = !session.base && !session.handles.size && !session.threads.size;
      } catch (error) {
        report.cleanupError = error.stack;
        report.cleanedUp = false;
        failure ||= error;
      }
    } else report.cleanedUp = false;
    if (!report.cleanedUp && !failure) failure = Error('Owned resources were not fully released');
    if (failure && !report.error) report.error = failure.stack;
    report.verified = report.verified && report.cleanedUp;
    report.completed = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    console.log(JSON.stringify({file, session: report.session,
      assessment: report.assessment, verified: report.verified,
      cleanedUp: report.cleanedUp, error: failure?.message}));
  }
  if (failure) throw failure;
  return report;
}

module.exports = {COUNTER_COUNT, GENERAL_HEAP_INDEX, MAX_COUNTER_READS, REQUIRED_STREAK,
  MAX_CYCLES, assessPinning, readCounters, readStableCounters, measureCycle, assessCycles, main};
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
