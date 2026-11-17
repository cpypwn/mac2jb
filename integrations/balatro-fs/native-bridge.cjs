const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {makePreamble} = require('./qualify-owned.cjs');
const {runWorkerSmoke} = require('./worker-smoke.cjs');
const transport = require('./transport-probe.cjs');

const MARKER = 'BAL_NATIVE_V1';
const SOURCE = fs.readFileSync(path.join(__dirname, 'native-bridge.lua'), 'utf8');
const SOURCE_LIMIT = 32768;
const REPL_PORT = 9026;

function context({nonce, macIp, port = transport.PORT}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') || net.isIP(macIp) !== 4 ||
      !Number.isInteger(port) || port < 1024 || port > 65535 || port === 39380) {
    throw new TypeError('Balatro native bridge requires a nonce, Mac IPv4, and its own transport port');
  }
  return {nonce, macIp, port};
}

function luaLiteral(source) {
  let equals = '';
  while (source.includes(`]${equals}]`)) equals += '=';
  return `[${equals}[${source}]${equals}]`;
}

function makeStageSource(options) {
  const {nonce, macIp, port} = context(options);
  const inherited = makePreamble({phase: 'allocator-map', nonce});
  if (!inherited.includes('local phase="allocator-map"') ||
      !inherited.includes("'BAL_OWNED_V1'")) throw Error('Balatro pinned preamble changed');
  const preamble = inherited.replace('local phase="allocator-map"',
    'local phase="native-bridge"').replace("'BAL_OWNED_V1'", `'${MARKER}'`);
  const source = `${preamble}\nlocal module=assert(loadstring(${luaLiteral(SOURCE)},'balatro-native-bridge'))()\nreturn module.enable(b,{approved=true,nonce=nonce,hostIp=${JSON.stringify(macIp)},port=${port}})`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro native bridge source exceeds the REPL limit');
  }
  return source;
}

function parseStageReply(reply, options) {
  const {nonce, port} = context(options);
  if (typeof reply !== 'string') throw new TypeError('Balatro native bridge reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith(`-> ${MARKER}\t`));
  if (lines.length !== 1) throw Error('Balatro native bridge confirmation was missing or duplicated');
  const fields = lines[0].slice(3).split('\t');
  if (fields[1] === 'native-bridge' && fields[2] === 'fail' &&
      fields[3] === nonce && fields.length === 5) {
    throw Error(`Balatro native bridge preflight failed: ${fields[4]}`);
  }
  if (fields.length !== 4 || fields[0] !== MARKER ||
      !['ready', 'reused'].includes(fields[1]) || fields[2] !== String(port) ||
      fields[3] !== nonce) throw Error('Balatro native bridge confirmation was invalid');
  return {status: fields[1], port, nonce};
}

function makeReserveSource(options) {
  const {nonce, macIp, port} = context(options);
  const bytes = options.bytes;
  if (bytes !== 0x80000 && !(bytes === 0x2400000 && options.allowLarge === true)) {
    throw new TypeError('Balatro app arena must be 512 KiB or explicitly approved 36 MiB');
  }
  const source = `local b=BL\nif not b or not b.fs_transport or b.fs_transport.owner~=${JSON.stringify(nonce)} or b.fs_transport.hostIp~=${JSON.stringify(macIp)} or b.fs_transport.port~=${port} then return '${MARKER}\\treserve-refused' end\nlocal module=assert(loadstring(${luaLiteral(SOURCE)},'balatro-native-bridge'))()\nreturn module.reserveAppArena(b,{nonce=${JSON.stringify(nonce)},hostIp=${JSON.stringify(macIp)},port=${port},bytes=${bytes},allowLarge=${options.allowLarge === true}})`;
  if (Buffer.byteLength(source, 'utf8') > SOURCE_LIMIT) {
    throw new RangeError('Balatro app arena source exceeds the REPL limit');
  }
  return source;
}

function parseReserveReply(reply, bytes) {
  if (typeof reply !== 'string') throw new TypeError('Balatro app arena reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error)/m.test(reply)) throw Error(reply.trim());
  const lines = reply.trimEnd().split('\n').filter(line => line.startsWith('-> BAL_APP_ARENA_V1\t'));
  if (lines.length !== 1) throw Error('Balatro app arena confirmation was missing or duplicated');
  const fields = lines[0].slice(3).split('\t');
  if (fields.length !== 3 || fields[0] !== 'BAL_APP_ARENA_V1' ||
      !/^0x[0-9a-f]+$/.test(fields[1]) || fields[2] !== String(bytes)) {
    throw Error('Balatro app arena confirmation was invalid');
  }
  const base = Number(BigInt(fields[1]));
  if (!Number.isSafeInteger(base) || base < 4096 || base % 4096 ||
      base + bytes >= 2 ** 39) throw Error('Balatro app arena address was invalid');
  return {base: fields[1], bytes};
}

async function stageNativeBridge({host, macIp, nonce, port = transport.PORT,
  execute = executeLua, worker = runWorkerSmoke, onPhase = () => {}}) {
  context({nonce, macIp, port});
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  onPhase('stage: qualify retained arena and worker');
  const qualified = await worker({host, nonce, execute});
  if (qualified.nonce !== nonce || qualified.tickFrequency !== 19200000 ||
      qualified.cleanup !== 'released' || !/^0x[0-9a-f]+$/.test(qualified.arenaBase || '')) {
    throw Error('Balatro native worker qualification is incomplete');
  }
  let staged = false;
  try {
    onPhase('stage: open transport listener');
    transport.parseStageReply(await execute({host, port: REPL_PORT,
      source: transport.makeStageSource({nonce, hostIp: macIp, port}),
      timeoutMs: 15000}), {port});
    staged = true;
    onPhase('stage: enable native bridge');
    const result = parseStageReply(await execute({host, port: REPL_PORT,
      source: makeStageSource({nonce, macIp, port}), timeoutMs: 15000}),
    {nonce, macIp, port});
    return {host, macIp, nonce, port, arenaBase: qualified.arenaBase,
      stage: result.status, status: 'native bridge staged; FS canary and marker untested'};
  } catch (error) {
    if (staged) {
      try {
        onPhase('stage: close transport listener after failure');
        transport.parseCloseReply(await execute({host, port: REPL_PORT,
          source: transport.makeCloseSource({nonce, hostIp: macIp, port}),
          timeoutMs: 15000}), {port});
      } catch (cleanup) {
        throw new AggregateError([error, cleanup],
          'Balatro native bridge failed and transport cleanup was not verified');
      }
    }
    throw error;
  }
}

module.exports = {MARKER, SOURCE, makeStageSource, parseStageReply,
  makeReserveSource, parseReserveReply, stageNativeBridge};
