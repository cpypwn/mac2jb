const net = require('node:net');
const {performance} = require('node:perf_hooks');
const {setTimeout: sleep} = require('node:timers/promises');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {runPreflight} = require('./canary-preflight.cjs');
const {qualifyNativeCrc, SDK_CRC32} = require('./qualify-native-crc.cjs');
const {makeSource, parseReply, EXPECTED_FREQUENCY, CNTPCT_FREQUENCY} = require('./worker-chain-smoke.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const PORT = 9026;
const BRIDGE_PORT = 39381;
const INTERVAL_MS = 250;
const CLOCK_TOLERANCE_MS = 25;
const ARENA_BYTES = 0x200000;

function tickValue(result) {
  if (!result || !Number.isInteger(result.tickLow) || !Number.isInteger(result.tickHigh) ||
      result.tickLow < 0 || result.tickLow > 0xffffffff ||
      result.tickHigh < 0 || result.tickHigh > 0xffffffff) {
    throw Error('Balatro worker tick result is incomplete');
  }
  return BigInt(result.tickHigh) << 32n | BigInt(result.tickLow);
}

function clockEnvelope(first, second, times) {
  if (!times || ![times.firstStart, times.firstEnd, times.secondStart,
      times.secondEnd].every(Number.isFinite) ||
      !(times.firstStart <= times.firstEnd && times.firstEnd < times.secondStart &&
        times.secondStart <= times.secondEnd)) {
    throw Error('Balatro worker timing boundaries are invalid');
  }
  const firstTick = tickValue(first);
  const secondTick = tickValue(second);
  if (secondTick <= firstTick) throw Error('Balatro worker tick did not advance');
  const elapsedMs = Number(secondTick - firstTick) * 1000 / CNTPCT_FREQUENCY;
  const minimumMs = times.secondStart - times.firstEnd;
  const maximumMs = times.secondEnd - times.firstStart;
  if (!Number.isFinite(elapsedMs) || minimumMs < INTERVAL_MS * 0.5 ||
      elapsedMs < minimumMs - CLOCK_TOLERANCE_MS ||
      elapsedMs > maximumMs + CLOCK_TOLERANCE_MS) {
    throw Error(`Balatro worker tick is outside the measured host-time envelope (elapsedMs=${elapsedMs} min=${minimumMs} max=${maximumMs} freq=${CNTPCT_FREQUENCY})`);
  }
  return {elapsedTicks: (secondTick - firstTick).toString(), elapsedMs,
    minimumMs, maximumMs, toleranceMs: CLOCK_TOLERANCE_MS};
}

async function runWorkerRepeatability({host, macIp, nonce, execute = executeLua,
  preflight = runPreflight, verifyCrc = qualifyNativeCrc,
  wait = sleep, now = () => performance.now()}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !/^[0-9a-f]{16}$/.test(nonce || '')) {
    throw new TypeError('Balatro worker repeatability needs two IPv4 addresses and a nonce');
  }
  if ([execute, preflight, verifyCrc, wait, now].some(value => typeof value !== 'function')) {
    throw new TypeError('invalid Balatro worker repeatability dependency');
  }
  const ready = await preflight({host, nonce, execute});
  if (ready.gameProfile !== profile.gameProfile || ready.nonce !== nonce ||
      ready.arenaBytes !== ARENA_BYTES ||
      !/^0x[0-9a-f]+$/.test(ready.arenaBase || '')) {
    throw Error('Balatro retained arena did not verify before worker sampling');
  }
  const crc = await verifyCrc({host, macIp, nonce, execute, port: BRIDGE_PORT});
  if (crc.nonce !== nonce || crc.port !== BRIDGE_PORT ||
      crc.sdkCrc32 !== `0x${SDK_CRC32.toString(16)}` ||
      !/^0x[0-9a-f]+$/.test(crc.sdkBase || '')) {
    throw Error('Balatro SDK CRC did not verify before worker sampling');
  }
  const context = {nonce, arenaBase: ready.arenaBase};
  const source = makeSource(context);
  const samples = [];
  const times = {};
  times.firstStart = now();
  samples.push(parseReply(await execute({host, port: PORT, source, timeoutMs: 15000}), context));
  times.firstEnd = now();
  await wait(INTERVAL_MS);
  times.secondStart = now();
  samples.push(parseReply(await execute({host, port: PORT, source, timeoutMs: 15000}), context));
  times.secondEnd = now();
  if (samples.some(sample => sample.nonce !== nonce || sample.arenaBase !== ready.arenaBase ||
      sample.tickFrequency !== EXPECTED_FREQUENCY || sample.cleanup !== 'released')) {
    throw Error('Balatro worker samples did not retain one owner and release their handles');
  }
  const timing = clockEnvelope(samples[0], samples[1], times);
  const after = await preflight({host, nonce, execute});
  if (after.gameProfile !== profile.gameProfile || after.nonce !== nonce ||
      after.arenaBytes !== ARENA_BYTES ||
      after.arenaBase !== ready.arenaBase) {
    throw Error('Balatro retained arena changed after worker sampling');
  }
  return {gameProfile: ready.gameProfile, nonce, sdkBase: crc.sdkBase,
    arenaBase: ready.arenaBase, samples: samples.length, timing,
    cleanup: 'released', workerRepeatabilityVerified: true,
    nativeCounterFrequencyVerified: false, markerAttempted: false,
    status: 'two read-only native workers returned advancing SDK ticks; FS marker unverified'};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node worker-repeatability.cjs <switch-ipv4> <mac-ipv4> <retained-arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runWorkerRepeatability({host: argv[0], macIp: argv[1], nonce: argv[2]});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry was attempted.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {PORT, INTERVAL_MS, CLOCK_TOLERANCE_MS, tickValue,
  clockEnvelope, runWorkerRepeatability};
