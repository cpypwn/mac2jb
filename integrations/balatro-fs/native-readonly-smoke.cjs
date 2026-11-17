const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {Connection} = require('../civswitch/fs-kit/port/engine/lib/connection.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');
const transport = require('./transport-probe.cjs');
const {stageNativeBridge} = require('./native-bridge.cjs');

const REQUEST_BYTES = 0x8080;
const RESPONSE_BYTES = 0x8010;
const OUTPUT_OFFSET = 0x4040;
const QUERY_BYTES = 0x40;

function makeQueryPacket(hello) {
  if (!hello || typeof hello.scratch !== 'string' || typeof hello.sdkBase !== 'string') {
    throw new TypeError('Balatro native query needs a verified transport greeting');
  }
  const scratch = BigInt(hello.scratch);
  const sdk = BigInt(hello.sdkBase);
  if (sdk < 0x1000n || sdk + BigInt(profile.sdkCode.size) >= (1n << 39n) ||
      scratch < 0x1000n || scratch + 0x80000n >= (1n << 39n)) {
    throw new RangeError('Balatro native query addresses are outside the pinned range');
  }
  const output = scratch + BigInt(OUTPUT_OFFSET);
  const packet = Buffer.alloc(REQUEST_BYTES);
  const first = [sdk + BigInt(profile.symbols.svcQueryMemory.offset), output,
    output + 0x40n, sdk, 0n];
  const second = [sdk + BigInt(profile.symbols.memmove.offset), output, output, 0n, 0n];
  first.forEach((value, index) => packet.writeBigUInt64LE(value, index * 8));
  second.forEach((value, index) => packet.writeBigUInt64LE(value, 0x28 + index * 8));
  return packet;
}

function parseQueryReply(bytes, hello) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== RESPONSE_BYTES) {
    throw Error('Balatro native query response has the wrong size');
  }
  const output = BigInt(hello.scratch) + BigInt(OUTPUT_OFFSET);
  const queryResult = bytes.readBigUInt64LE(8);
  const noopResult = bytes.readBigUInt64LE(0);
  const memory = bytes.subarray(16, 16 + QUERY_BYTES);
  const base = memory.readBigUInt64LE();
  const size = memory.readBigUInt64LE(8);
  const type = memory.readUInt32LE(16);
  const attributes = memory.readUInt32LE(20);
  const permissions = memory.readUInt32LE(24);
  const sdk = BigInt(hello.sdkBase);
  if (queryResult !== 0n || noopResult !== output || base !== sdk ||
      size < BigInt(profile.sdkCode.size) || type !== 3 || attributes !== 0 ||
      permissions !== 5) {
    throw Error('Balatro native query did not verify the pinned SDK mapping');
  }
  return {sdkBase: hello.sdkBase, sdkMappingBytes: Number(size),
    sdkMappingType: type, sdkPermissions: permissions};
}

async function openConnection(host, port, timeoutMs = 10000) {
  if (net.isIP(host) !== 4 || !Number.isInteger(port) || port < 1024 ||
      port > 65535 || port === 39380) {
    throw new TypeError('Balatro native smoke needs its own IPv4 listener');
  }
  const socket = net.connect({host, port});
  const connection = new Connection(socket, timeoutMs);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Balatro native bridge connect timed out')),
        timeoutMs);
      socket.once('connect', () => {clearTimeout(timer); resolve();});
      socket.once('error', error => {clearTimeout(timer); reject(error);});
    });
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

async function runNativeReadOnlySmoke({host, macIp, nonce, port = transport.PORT,
  prepare = stageNativeBridge, connect = openConnection, execute = executeLua}) {
  const staged = await prepare({host, macIp, nonce, port, execute});
  if (staged.nonce !== nonce || staged.port !== port ||
      !/^0x[0-9a-f]+$/.test(staged.arenaBase || '')) {
    throw Error('Balatro native bridge stage returned an invalid owner');
  }
  let connection;
  let result;
  let operationError;
  try {
    connection = await connect(host, port);
    const hello = transport.parseHello(await connection.read(128),
      {arenaBase: staged.arenaBase});
    await connection.write(makeQueryPacket(hello));
    const mapping = parseQueryReply(await connection.read(RESPONSE_BYTES), hello);
    result = {gameProfile: profile.gameProfile, nonce, port, ...mapping,
      status: 'read-only native query verified; FS canary and marker untested'};
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
      'Balatro native query failed and its listener could not be verified closed');
    throw cleanup;
  }
  if (operationError) throw operationError;
  return result;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node native-readonly-smoke.cjs <switch-ipv4> <mac-ipv4> <arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runNativeReadOnlySmoke({host: argv[0], macIp: argv[1],
      nonce: argv[2]});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo FS canary or marker was attempted.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {REQUEST_BYTES, RESPONSE_BYTES, makeQueryPacket,
  parseQueryReply, openConnection, runNativeReadOnlySmoke};
