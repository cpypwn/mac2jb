const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const transport = require('./transport-probe.cjs');
const {stageNativeBridge} = require('./native-bridge.cjs');
const {openConnection, REQUEST_BYTES, RESPONSE_BYTES} = require('./native-readonly-smoke.cjs');

const VECTOR = Buffer.from('123456789', 'ascii');
const VECTOR_CRC32 = 0xcbf43926;
const SDK_CRC32 = Number.parseInt(profile.sdkCode.offlineCrc32, 16);
const VECTOR_OFFSET = 0x100;
const INPUT_OFFSET = 0x40000;

function makeCrcPacket(hello) {
  if (!hello || typeof hello.scratch !== 'string' || typeof hello.sdkBase !== 'string') {
    throw new TypeError('Balatro native CRC needs a verified transport greeting');
  }
  const scratch = BigInt(hello.scratch);
  const sdk = BigInt(hello.sdkBase);
  const entry = profile.symbols.nnutilZlib_crc32;
  if (!entry || !/^([0-9a-f]{2}){4,256}$/.test(entry.bytes) ||
      scratch < 0x1000n || scratch + 0x80000n >= (1n << 39n) ||
      sdk < 0x1000n || sdk + BigInt(profile.sdkCode.size) >= (1n << 39n)) {
    throw new RangeError('Balatro native CRC addresses are outside the pinned range');
  }
  const packet = Buffer.alloc(REQUEST_BYTES);
  const functionAddress = sdk + BigInt(entry.offset);
  const vectorAddress = scratch + BigInt(INPUT_OFFSET + VECTOR_OFFSET);
  const first = [functionAddress, 0n, vectorAddress, BigInt(VECTOR.length), 0n];
  const second = [functionAddress, 0n, sdk, BigInt(profile.sdkCode.size), 0n];
  first.forEach((value, index) => packet.writeBigUInt64LE(value, index * 8));
  second.forEach((value, index) => packet.writeBigUInt64LE(value, 0x28 + index * 8));
  VECTOR.copy(packet, VECTOR_OFFSET);
  return packet;
}

function parseCrcReply(bytes, hello) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== RESPONSE_BYTES ||
      !hello || typeof hello.sdkBase !== 'string') {
    throw Error('Balatro native CRC response has the wrong shape');
  }
  const vector = bytes.readBigUInt64LE(8);
  const sdk = bytes.readBigUInt64LE(0);
  if (vector !== BigInt(VECTOR_CRC32) || sdk !== BigInt(SDK_CRC32)) {
    throw Error('Balatro native CRC did not match both pinned vectors');
  }
  return {sdkBase: hello.sdkBase, vectorCrc32: `0x${vector.toString(16)}`,
    sdkCrc32: `0x${sdk.toString(16)}`};
}

async function qualifyNativeCrc({host, macIp, nonce, port = transport.PORT,
  prepare = stageNativeBridge, connect = openConnection, execute = executeLua}) {
  const staged = await prepare({host, macIp, nonce, port, execute});
  if (staged.nonce !== nonce || staged.port !== port ||
      !/^0x[0-9a-f]+$/.test(staged.arenaBase || '')) {
    throw Error('Balatro native CRC bridge stage returned an invalid owner');
  }
  let connection;
  let result;
  let operationError;
  try {
    connection = await connect(host, port);
    const hello = transport.parseHello(await connection.read(128),
      {arenaBase: staged.arenaBase});
    await connection.write(makeCrcPacket(hello));
    result = parseCrcReply(await connection.read(RESPONSE_BYTES), hello);
    await connection.write(Buffer.alloc(REQUEST_BYTES));
  } catch (error) {
    operationError = error;
  } finally {
    connection?.close();
  }
  try {
    transport.parseCloseReply(await execute({host, port: 9026,
      source: transport.makeCloseSource({nonce, hostIp: macIp, port}),
      timeoutMs: 15000}), {port});
  } catch (cleanup) {
    if (operationError) throw new AggregateError([operationError, cleanup],
      'Balatro native CRC failed and its listener could not be verified closed');
    throw cleanup;
  }
  if (operationError) throw operationError;
  return {gameProfile: profile.gameProfile, nonce, port, ...result,
    status: 'native SDK CRC verified; FS canary and marker untested'};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node qualify-native-crc.cjs <switch-ipv4> <mac-ipv4> <arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await qualifyNativeCrc({host: argv[0],
      macIp: argv[1], nonce: argv[2]}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo FS canary or marker was attempted.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {VECTOR, VECTOR_CRC32, SDK_CRC32, makeCrcPacket,
  parseCrcReply, qualifyNativeCrc};
