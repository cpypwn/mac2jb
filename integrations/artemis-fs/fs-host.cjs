'use strict';

const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const PREFIX = 'MAC2JB_ARTEMIS_FS ';
const PROFILE_MARKER = 'mac2jb-profile';
const PROFILE_FIELDS = [
  'socket_socket', 'socket_bind', 'socket_listen', 'socket_accept',
  'socket_recv', 'socket_send', 'socket_close', 'socket_fcntl',
  'svc_sleep_thread', 'svc_get_info', 'vcall8_restore',
];
const PROFILES = Object.freeze({
  seedsow: Object.freeze({
    socket_socket: 0x14d4c0, socket_bind: 0x14d3b0,
    socket_listen: 0x14d440, socket_accept: 0x14d380,
    socket_recv: 0x14d300, socket_send: 0x14d350,
    socket_close: 0x14d510, socket_fcntl: 0x14d560,
    svc_sleep_thread: 0x168b54, svc_get_info: 0x168ca4,
    vcall8_restore: 0x3d9e54,
  }),
});

const PROFILE_PROBE = `local N=rawget(_G,"n2h")
if type(N)~="table" then print("mac2jb-profile\\tmissing") return end
local O=type(N.offsets_sdk)=="table" and N.offsets_sdk or {}
local function hex(n)
  if type(n)=="number" and n>=0 and n==math.floor(n) then return string.format("%x",n) end
  return "invalid"
end
print(table.concat({"mac2jb-profile",tostring(N.game_id),tostring(N.platform),
  hex(N.main_base),hex(N.sdk_base),type(N.call_deep),type(N.alloc),
  type(N.peek),type(N.poke),type(N.write_bytes),type(N.run_chain),
  type(N.new_emitter),
  ${PROFILE_FIELDS.map(field => `hex(O.${field})`).join(',')}},"\\t"))`;

function emitLine(value) {
  process.stdout.write(PREFIX + JSON.stringify(value) + '\n');
}

function ipv4(value, label) {
  if (!net.isIPv4(value)) throw Error('Enter a valid ' + label + ' IPv4 address');
  return value;
}

function request(ip, port, method, endpoint, body = '', options = {}) {
  const timeoutMs = options.timeoutMs ?? 12000;
  const limit = options.limit ?? 16384;
  return new Promise((resolve, reject) => {
    const source = Buffer.from(body, 'utf8');
    const req = http.request({host: ip, port, method, path: endpoint,
      headers: source.length ? {'Content-Type': 'text/x-lua; charset=utf-8',
        'Content-Length': source.length} : {},
      timeout: timeoutMs, signal: options.signal}, response => {
      const chunks = [];
      let used = 0;
      response.on('data', bytes => {
        used += bytes.length;
        if (used > limit) {
          req.destroy(Error('Artemis HTTP response is too large'));
          return;
        }
        chunks.push(bytes);
      });
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200)
          reject(Error(`Artemis HTTP returned ${response.statusCode}: ${text.trim().slice(0, 180)}`));
        else resolve(text);
      });
      response.once('error', reject);
    });
    req.once('timeout', () => req.destroy(Error('Artemis HTTP timed out')));
    req.once('error', reject);
    req.end(source);
  });
}

function parseStatus(body) {
  const match = /^n2h HTTP server \((seedsow|nora2)\)\r?\n/.exec(body);
  if (!match) throw Error('The console is not running a supported Artemis v2 HTTP launcher on port 8080');
  return match[1];
}

function parseHex(value, label) {
  if (!/^[0-9a-f]+$/i.test(value)) throw Error('Artemis runtime has no verified ' + label);
  const number = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(number)) throw Error('Artemis runtime reported an imprecise ' + label);
  return number;
}

function parseProfile(body, statusGame) {
  if (!body.startsWith('status: ok\n'))
    throw Error('Artemis Lua probe failed: ' + body.trim().slice(0, 180));
  const line = body.split(/\r?\n/).find(value => value.startsWith(PROFILE_MARKER + '\t'));
  if (!line) throw Error('Artemis Lua probe did not report a runtime profile');
  const fields = line.split('\t');
  if (fields.length !== 12 + PROFILE_FIELDS.length)
    throw Error('Artemis Lua probe returned an incomplete runtime profile');
  const [marker, game, platform, main, sdk, callDeep, alloc, peek, poke, writeBytes,
    runChain, newEmitter] = fields;
  if (marker !== PROFILE_MARKER || game !== statusGame || !PROFILES[game])
    throw Error('Artemis HTTP status and Lua runtime identify different games');
  if (platform !== 'Ounce') throw Error('The Artemis runtime is not running on Switch 2');
  for (const [label, type] of Object.entries({callDeep, alloc, peek, poke, writeBytes,
    runChain, newEmitter}))
    if (type !== 'function') throw Error('Artemis runtime is missing ' + label);
  const mainBase = parseHex(main, 'main module base');
  const sdkBase = parseHex(sdk, 'SDK module base');
  if (!mainBase || !sdkBase || mainBase >= 2 ** 39 || sdkBase >= 2 ** 39 ||
      mainBase % 4096 || sdkBase % 4096)
    throw Error('Artemis runtime module bases are not aligned Switch addresses');
  for (let index = 0; index < PROFILE_FIELDS.length; index++) {
    const field = PROFILE_FIELDS[index];
    if (parseHex(fields[12 + index], field) !== PROFILES[game][field])
      throw Error('The ' + game + ' SDK offset for ' + field + ' differs from the checked profile');
  }
  return {game, mainBase, sdkBase};
}

async function runCompatibilityCheck(options) {
  const consoleIp = ipv4(options.consoleIp, 'Switch');
  ipv4(options.macIp, 'Mac');
  if (!path.isAbsolute(options.runtimeRoot || ''))
    throw Error('Runtime root must be an absolute path');
  const port = options.port ?? 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('Invalid Artemis HTTP port');
  const emit = options.emit || emitLine;
  try {
    emit({type: 'preparing', message: 'Checking the Artemis HTTP launcher'});
    const status = await request(consoleIp, port, 'GET', '/status', '', options);
    const game = parseStatus(status);
    if (game !== 'seedsow')
      throw Error('Nora Princess 2 HTTP is open, but its FS bridge has not been validated. Use a Seedsow Lullaby v2 launcher for this experimental path.');
    const response = await request(consoleIp, port, 'POST', '/eval', PROFILE_PROBE, options);
    const profile = parseProfile(response, game);
    const title = game === 'seedsow' ? 'Seedsow Lullaby' : 'Nora Princess 2';
    emit({type: 'probe-ready', game, title, fsVerified: false,
      message: `${title} HTTP and Lua runtime verified for the experimental filesystem attempt`});
    return profile;
  } catch (error) {
    emit({type: 'failed', message: error.message});
    throw error;
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 3)
    throw Error('usage: node fs-host.cjs SWITCH_IPV4 MAC_IPV4 RUNTIME_ROOT');
  await require('./runtime-host.cjs').runFsHost({consoleIp: args[0], macIp: args[1], runtimeRoot: args[2]});
}

if (require.main === module) main().catch(() => {process.exitCode = 1;});

module.exports = {PREFIX, PROFILES, PROFILE_FIELDS, PROFILE_PROBE,
  request, parseStatus, parseProfile, runCompatibilityCheck};
