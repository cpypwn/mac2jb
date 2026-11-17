const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {openConnection} = require('./native-readonly-smoke.cjs');
const {runPreflight} = require('./canary-preflight.cjs');
const {qualifyNativeCrc} = require('./qualify-native-crc.cjs');
const {stageNativeBridge} = require('./native-bridge.cjs');
const transport = require('./transport-probe.cjs');
const {REQUEST_BYTES, RESPONSE_BYTES, createQualifiedContext,
  runCounterPreflight} = require('./fs-counter-probe.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const PORT = 39381;
const ARENA_BYTES = 0x200000;

function validCounterResult(result) {
  return result && result.cleanup === 'released' && Number.isInteger(result.reads) &&
    result.reads >= 3 && result.reads <= 16 &&
    Array.isArray(result.samples) && result.samples.length === 2;
}

async function runCounterLive({host, macIp, nonce, execute = executeLua,
  preflight = runPreflight, verifyCrc = qualifyNativeCrc,
  stage = stageNativeBridge, connect = openConnection,
  sample = runCounterPreflight, validateResult = validCounterResult,
  onPhase = () => {}}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      !/^[0-9a-f]{16}$/.test(nonce || '')) {
    throw new TypeError('Balatro counter probe needs Switch and Mac IPv4 addresses and arena nonce');
  }
  if ([execute, preflight, verifyCrc, stage, connect, sample, validateResult, onPhase]
    .some(dependency => typeof dependency !== 'function')) {
    throw new TypeError('invalid Balatro counter probe dependency');
  }
  onPhase('arena-and-timing');
  const ready = await preflight({host, nonce, execute});
  if (ready.nonce !== nonce || ready.arenaBytes !== ARENA_BYTES ||
      !/^0x[0-9a-f]+$/.test(ready.arenaBase || '')) {
    throw Error('Balatro counter arena preflight did not match this owner');
  }
  onPhase('sdk-crc');
  const crc = await verifyCrc({host, macIp, nonce, port: PORT, execute});
  const checked = await preflight({host, nonce, execute});
  if (crc.nonce !== nonce || crc.port !== PORT ||
      crc.gameProfile !== profile.gameProfile ||
      crc.sdkCrc32 !== profile.sdkCode.offlineCrc32 ||
      !/^0x[0-9a-f]+$/.test(crc.sdkBase || '') ||
      checked.nonce !== nonce || checked.arenaBase !== ready.arenaBase ||
      checked.arenaBytes !== ready.arenaBytes) {
    throw Error('Balatro SDK or retained arena changed after CRC qualification');
  }
  onPhase('stage-owned-bridge');
  let connection;
  let result;
  let operationError;
  try {
    const staged = await stage({host, macIp, nonce, port: PORT, execute});
    if (staged.nonce !== nonce || staged.port !== PORT ||
        staged.arenaBase !== ready.arenaBase) {
      throw Error('Balatro native bridge stage did not match the qualified arena');
    }
    connection = await connect(host, PORT, 10000);
    const hello = transport.parseHello(await connection.read(128),
      {arenaBase: ready.arenaBase});
    const context = createQualifiedContext({arenaBase: ready.arenaBase,
      hello, crc, nonce, port: PORT});
    const exchange = async (packet, phase) => {
      onPhase(phase);
      await connection.write(packet);
      return connection.read(RESPONSE_BYTES);
    };
    result = await sample({context, exchange});
    if (!validateResult(result)) {
      throw Error('Balatro FS diagnostic did not verify service cleanup and bounds');
    }
    await connection.write(Buffer.alloc(REQUEST_BYTES));
  } catch (error) {
    operationError = error;
  } finally {
    connection?.close();
  }
  try {
    transport.parseCloseReply(await execute({host, port: 9026,
      source: transport.makeCloseSource({nonce, hostIp: macIp, port: PORT}),
      timeoutMs: 15000}), {port: PORT});
  } catch (cleanup) {
    if (operationError) throw new AggregateError([operationError, cleanup],
      'Balatro counter probe failed and its listener cleanup was not verified');
    throw cleanup;
  }
  if (operationError) throw operationError;
  return {gameProfile: profile.gameProfile, nonce, arenaBase: ready.arenaBase,
    port: PORT, ...result};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node fs-counter-live.cjs <switch-ipv4> <mac-ipv4> <retained-arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runCounterLive({host: argv[0],
      macIp: argv[1], nonce: argv[2],
      onPhase: phase => process.stderr.write(`${phase}\n`)}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry was attempted; no FS canary or marker was claimed.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {PORT, runCounterLive, validCounterResult};
