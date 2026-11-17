const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {runPreflight} = require('./canary-preflight.cjs');
const {makePreamble} = require('./qualify-owned.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const SOURCE = fs.readFileSync(path.join(__dirname, 'transport-probe.lua'), 'utf8');
const MARKER = 'BAL_TRANSPORT_V1';
const PORT = 39381;
const SOURCE_LIMIT = 32768;
const HELLO_BYTES = 128;
const ARENA_BYTES = 0x200000;
const SCRATCH_OFFSET = 0x10000;
const SCRATCH_BYTES = 0x80000;
const SDK_CRC32 = Number.parseInt(profile.sdkCode.offlineCrc32, 16);

function luaLiteral(source) {
  let equals = '';
  while (source.includes(`]${equals}]`)) equals += '=';
  return `[${equals}[${source}]${equals}]`;
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

function makeStageSource({nonce, hostIp, port = PORT}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') || net.isIP(hostIp) !== 4 || !validPort(port)) {
    throw new TypeError('Balatro transport requires a nonce and Mac IPv4 address');
  }
  const inherited = makePreamble({phase: 'allocator-map', nonce});
  if (!inherited.includes('local phase="allocator-map"') ||
      !inherited.includes("'BAL_OWNED_V1'")) throw Error('Balatro pinned preamble changed');
  const preamble = inherited.replace('local phase="allocator-map"',
    'local phase="transport-probe"').replace("'BAL_OWNED_V1'", `'${MARKER}'`);
  const source = `${preamble}
if not b.net or not b.net.ip or not b.info.main_base then return fail('network') end
local bridge=assert(loadstring(${luaLiteral(SOURCE)},'balatro-transport-probe'))()
return bridge.install(b,{hostIp=${JSON.stringify(hostIp)},nonce=nonce,port=${port},
  sdkCrc32=${SDK_CRC32},memmoveOffset=${profile.symbols.memmove.offset}})`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro transport source exceeds the REPL limit');
  }
  return source;
}

function parseStageReply(reply, {port = PORT} = {}) {
  if (typeof reply !== 'string') throw new TypeError('Balatro transport reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw Error('Balatro transport confirmation was missing or duplicated');
  const fields = lines[0].slice(3).split('\t');
  if (fields[1] === 'transport-probe' && fields[2] === 'fail') {
    throw Error(`Balatro transport preflight failed: ${fields[4]}`);
  }
  if (fields.length !== 3 || fields[0] !== MARKER ||
      !['listening', 'reused'].includes(fields[1]) || fields[2] !== String(port)) {
    throw Error('Balatro transport confirmation was invalid');
  }
  return {status: fields[1], port};
}

function makeCloseSource({nonce, hostIp, port = PORT}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') || net.isIP(hostIp) !== 4 || !validPort(port)) {
    throw new TypeError('Balatro transport cleanup requires a nonce and Mac IPv4 address');
  }
  return `local t=BL and BL.fs_transport\nif not t or t.owner~=${JSON.stringify(nonce)} or t.hostIp~=${JSON.stringify(hostIp)} or t.port~=${port} then return '${MARKER}\\tcleanup-refused' end\nt:close()\nBL.fs_transport=nil\nreturn '${MARKER}\\tclosed\\t${port}'`;
}

function parseCloseReply(reply, {port = PORT} = {}) {
  if (typeof reply !== 'string') throw new TypeError('Balatro transport cleanup reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1 || lines[0] !== `-> ${MARKER}\tclosed\t${port}`) {
    throw Error('Balatro transport listener could not be verified closed');
  }
}

function parseHello(bytes, {arenaBase}) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== HELLO_BYTES) {
    throw Error('Balatro transport greeting must be exactly 128 bytes');
  }
  const fields = Array.from({length: 16}, (_, index) => bytes.readBigUInt64LE(index * 8));
  const expectedScratch = BigInt(arenaBase) + BigInt(SCRATCH_OFFSET);
  const checks = [
    fields[0] === 0x31545344n, fields[1] === 1n, fields[2] === 2n,
    fields[3] === expectedScratch, fields[4] === BigInt(SCRATCH_BYTES),
    fields[5] > 0n && fields[5] % 4096n === 0n,
    fields[6] > 0n && fields[6] % 4096n === 0n,
    fields[8] === fields[6] + BigInt(profile.symbols.memmove.offset),
    fields[15] === BigInt(SDK_CRC32),
  ];
  if (!checks.every(Boolean) || fields.slice(7, 15).some((value, index) =>
      index !== 1 && value !== 0n)) {
    throw Error('Balatro transport greeting does not match the pinned profile');
  }
  return {status: 'read-only transport handshake verified',
    scratch: `0x${fields[3].toString(16)}`, scratchBytes: SCRATCH_BYTES,
    mainBase: `0x${fields[5].toString(16)}`, sdkBase: `0x${fields[6].toString(16)}`,
    sdkCrc32: SDK_CRC32};
}

function readHello({host, port = PORT, timeoutMs = 5000}) {
  if (net.isIP(host) !== 4 || !validPort(port)) throw new TypeError('invalid Balatro transport target');
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = net.connect({host, port});
    const chunks = [];
    let count = 0;
    const finish = (error, data) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(data);
    };
    socket.setTimeout(timeoutMs, () => finish(Error('Balatro transport handshake timed out')));
    socket.on('data', chunk => {
      chunks.push(chunk);
      count += chunk.length;
      if (count > HELLO_BYTES) finish(Error('Balatro transport sent too many bytes'));
    });
    socket.on('end', () => finish(count === HELLO_BYTES ? null :
      Error(`Balatro transport sent ${count} of ${HELLO_BYTES} greeting bytes`),
      Buffer.concat(chunks)));
    socket.on('error', finish);
    socket.on('close', () => {if (!done) finish(Error('Balatro transport closed early'));});
  });
}

async function runTransportProbe({host, macIp, nonce, port = PORT, execute = executeLua,
  preflight = runPreflight, receive = readHello}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 || !validPort(port)) {
    throw new TypeError('Switch and Mac must use IPv4 and a valid transport port');
  }
  const ready = await preflight({host, nonce, execute});
  if (ready.nonce !== nonce || ready.arenaBytes !== ARENA_BYTES) {
    throw Error('Balatro arena preflight does not match the transport request');
  }
  const staged = parseStageReply(await execute({host, port: 9026,
    source: makeStageSource({nonce, hostIp: macIp, port}), timeoutMs: 15000}), {port});
  let hello;
  let probeError;
  try {
    hello = parseHello(await receive({host, port}), {arenaBase: ready.arenaBase});
  } catch (error) {
    probeError = error;
  }
  try {
    parseCloseReply(await execute({host, port: 9026,
      source: makeCloseSource({nonce, hostIp: macIp, port}), timeoutMs: 15000}), {port});
  } catch (error) {
    if (probeError) throw new AggregateError([probeError, error],
      'Balatro transport probe failed and its listener could not be verified closed');
    throw error;
  }
  if (probeError) throw probeError;
  return {gameProfile: profile.gameProfile, stage: staged.status, ...hello,
    status: 'read-only transport handshake verified; listener closed; FS canary and marker untested'};
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length < 3 || argv.length > 4) {
    process.stderr.write('usage: node transport-probe.cjs <switch-ipv4> <mac-ipv4> <arena-nonce> [transport-port]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runTransportProbe({host: argv[0], macIp: argv[1],
      nonce: argv[2], port: argv[3] === undefined ? PORT : Number(argv[3])});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo FS canary or native bridge request was attempted.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {PORT, HELLO_BYTES, SOURCE, makeStageSource, parseStageReply,
  makeCloseSource, parseCloseReply, parseHello, readHello, runTransportProbe};
