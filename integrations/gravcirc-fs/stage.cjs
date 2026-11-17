const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { probe } = require('./probe.cjs');
const { executeLua, DEFAULT_PORT, MAX_REQUEST_BYTES } = require('./repl-client.cjs');

const BRIDGE_SOURCE = fs.readFileSync(path.join(__dirname, 'bridge.lua'), 'utf8');
const GAME_PROFILES = new Set(['gravity-circuit-v1.0', 'gravity-circuit-v1.2.1']);

function ipv4(value, label) {
  if (typeof value !== 'string' || net.isIP(value) !== 4) {
    throw new TypeError(`${label} must be an IPv4 address`);
  }
  return value;
}

function signature(value, label, sdkBytes, alignment) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must contain a measured offset and instruction bytes`);
  }
  const { offset, bytes } = value;
  if (typeof bytes !== 'string' || !/^(?:[0-9a-f]{2}){4,256}$/.test(bytes)) {
    throw new TypeError(`${label}.bytes must be 4 to 256 lowercase hexadecimal instruction bytes`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % alignment !== 0 ||
      offset + bytes.length / 2 > sdkBytes) {
    throw new RangeError(`${label}.offset must be ${alignment}-byte aligned and inside the measured SDK`);
  }
  return { offset, bytes };
}

function validateProfile(value, { nativeProfile, macIp }) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('measured profile must be a JSON object');
  }
  if (!GAME_PROFILES.has(nativeProfile) || value.gameProfile !== nativeProfile) {
    throw new Error('measured profile does not match the running Gravity Circuit build');
  }
  if (!Number.isSafeInteger(value.sdkBytes) ||
      value.sdkBytes <= 0x1000 || value.sdkBytes >= 0x2000000) {
    throw new RangeError('measured profile needs the SDK byte length');
  }
  if (!Number.isSafeInteger(value.sdkCrc32) ||
      value.sdkCrc32 < 0 || value.sdkCrc32 > 0xffffffff) {
    throw new RangeError('measured profile needs a 32-bit SDK CRC');
  }
  ipv4(macIp, 'Mac IP');
  if (value.hostIp !== undefined) ipv4(value.hostIp, 'profile hostIp');
  if (value.hostIp !== undefined && value.hostIp !== macIp) {
    throw new Error('measured profile hostIp does not match the selected Mac IP');
  }
  const port = value.port === undefined ? 39380 : value.port;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new RangeError('profile port must be between 1024 and 65535');
  }
  const memmove = signature(value.memmove, 'memmove', value.sdkBytes, 8);
  const queryMemory = signature(value.queryMemory, 'queryMemory', value.sdkBytes, 4);
  if (memmove.offset === queryMemory.offset) {
    throw new Error('memmove and queryMemory must have distinct measured offsets');
  }
  return {
    gameProfile: value.gameProfile,
    sdkBytes: value.sdkBytes,
    sdkCrc32: value.sdkCrc32,
    hostIp: macIp,
    memmove,
    queryMemory,
    port,
  };
}

function luaString(value) {
  if (!/^[\x20-\x7e]+$/.test(value)) throw new TypeError('Lua string must be printable ASCII');
  return JSON.stringify(value);
}

function luaSourceLiteral(source) {
  let marks = '';
  while (source.includes(`]${marks}]`)) marks += '=';
  return `[${marks}[${source}]${marks}]`;
}

function buildChunk(profile, bridgeSource = BRIDGE_SOURCE) {
  if (typeof bridgeSource !== 'string' || bridgeSource.length === 0) {
    throw new TypeError('bridge source must be nonempty Lua');
  }
  const source = [
    `local bridge = assert(loadstring(${luaSourceLiteral(bridgeSource)}, "gravcirc-fs-bridge"))()`,
    'local profile = {',
    `gameProfile=${luaString(profile.gameProfile)},`,
    `sdkBytes=${profile.sdkBytes},sdkCrc32=${profile.sdkCrc32},`,
    `hostIp=${luaString(profile.hostIp)},port=${profile.port},`,
    `memmove={offset=${profile.memmove.offset},bytes=${luaString(profile.memmove.bytes)}},`,
    `queryMemory={offset=${profile.queryMemory.offset},bytes=${luaString(profile.queryMemory.bytes)}}`,
    '}',
    'return bridge.install(LS, profile)',
  ].join('\n');
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes >= MAX_REQUEST_BYTES) {
    throw new RangeError(`Gravity Circuit stage chunk must be smaller than ${MAX_REQUEST_BYTES} bytes`);
  }
  return source;
}

function parseBridgeReply(reply, expectedPort) {
  if (typeof reply !== 'string') throw new TypeError('Gravity Circuit bridge reply must be text');
  if (/^(?:compile error:|error:|internal evaluation error:)/m.test(reply)) {
    throw new Error(reply.trim());
  }
  const matches = [...reply.matchAll(/^-> FS bridge listening on port (\d+)\s*$/gm)];
  if (matches.length !== 1 || Number(matches[0][1]) !== expectedPort) {
    throw new Error('Gravity Circuit bridge did not confirm the expected listener port');
  }
  return { status: 'listening', port: expectedPort };
}

async function stage({ switchIp, macIp, profile, replPort = DEFAULT_PORT, timeoutMs = 15000 },
                     dependencies = {}) {
  ipv4(switchIp, 'Switch IP');
  ipv4(macIp, 'Mac IP');
  const runProbe = dependencies.probe || probe;
  const runLua = dependencies.executeLua || executeLua;
  const result = await runProbe({ host: switchIp, port: replPort, timeoutMs });
  if (!result.runtimeReady || result.gameId !== 'gravity-circuit' ||
      !GAME_PROFILES.has(result.nativeProfile)) {
    throw new Error('Gravity Circuit native REPL is not serving a recognized build');
  }
  const measured = validateProfile(profile, { nativeProfile: result.nativeProfile, macIp });
  const source = buildChunk(measured, dependencies.bridgeSource || BRIDGE_SOURCE);
  const reply = await runLua({ host: switchIp, port: replPort, source, timeoutMs });
  return { probe: result, bridge: parseBridgeReply(reply, measured.port) };
}

async function main() {
  const [switchIp, profilePath, macIp, portText] = process.argv.slice(2);
  if (!switchIp || !profilePath || !macIp || process.argv.length > 6) {
    process.stderr.write('usage: node stage.cjs <switch-ipv4> <measured-profile.json> <mac-ipv4> [repl-port]\n');
    process.exitCode = 2;
    return;
  }
  try {
    const replPort = portText === undefined ? DEFAULT_PORT : Number(portText);
    if (!Number.isInteger(replPort) || replPort < 1 || replPort > 65535) {
      throw new RangeError('REPL port must be between 1 and 65535');
    }
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const result = await stage({ switchIp, macIp, profile, replPort });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { BRIDGE_SOURCE, validateProfile, buildChunk, parseBridgeReply, stage };
