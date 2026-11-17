const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const {DEFAULT_PORT, executeLua} = require('./repl-client.cjs');
const {probe} = require('./probe.cjs');
const {main: runFull} = require('./run-full.cjs');
const {main: runCanary} = require('./run-canary.cjs');
const {loadTarget, assertFullSupported, assertCanarySupported} =
  require('../civswitch/fs-kit/port/engine/shared/target.cjs');

const TERMINAL_BANNER = [
  ' ▄▄                                  ▄',
  '  ██                               ▄██',
  '  ██                   ▄         ▄█▀██  ▄',
  '  ██ ▄███▄▀█▄ ██▀▄█▀█▄ ████▄▄▀▀█▄▀  ██  ████▄',
  '  ██ ██ ██ ██▄██ ██▄█▀ ██   ▄█▀██   ██  ██ ██',
  ' ▄██▄▀███▀  ▀█▀ ▄▀█▄▄▄▄█▀  ▄▀█▄██   ██ ▄██ ▀█',
].join('\n');
const CONSOLE_BANNER = '+----<3    lovera1n by cpypwn    +----<3';
const USAGE = 'usage: node integrations/gravcirc-fs/lovera1n.cjs [--canary] [switch-ipv4]';

function usableIPv4(value, label) {
  if (net.isIP(value) !== 4) throw Error(`${label} must be an IPv4 address`);
  const first = Number(value.split('.')[0]);
  if (first === 0 || first === 127 || first >= 224)
    throw Error(`${label} must be a unicast, non-loopback IPv4 address`);
  return value;
}

function parseArgs(values) {
  let canary = false, switchIp = null;
  for (const value of values) {
    if (value === '--help' || value === '-h') return {help: true};
    if (value === '--canary' && !canary) {canary = true; continue;}
    if (value.startsWith('-') || switchIp) throw Error(USAGE);
    switchIp = usableIPv4(value, 'Switch address');
  }
  return {canary, switchIp};
}

async function promptSwitchIp({input = process.stdin, output = process.stdout} = {}) {
  const line = readline.createInterface({input, output});
  try {
    return usableIPv4((await line.question('Switch IPv4 shown in Gravity Circuit: ')).trim(),
      'Switch address');
  } finally {line.close();}
}

async function selectMacIPv4(switchIp, {
  socketFactory = dgram.createSocket,
  interfaces = os.networkInterfaces,
} = {}) {
  usableIPv4(switchIp, 'Switch address');
  const socket = socketFactory('udp4');
  let address;
  try {
    address = await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(DEFAULT_PORT, switchIp, error => {
        socket.removeListener('error', reject);
        if (error) reject(error);
        else {
          try {resolve(socket.address().address);}
          catch (cause) {reject(cause);}
        }
      });
    });
  } finally {socket.close();}
  usableIPv4(address, 'Mac route');
  if (address === switchIp) throw Error('Switch and Mac addresses are identical');
  const assigned = Object.values(interfaces()).flat().some(item => item &&
    (item.family === 'IPv4' || item.family === 4) && !item.internal &&
    item.address === address);
  if (!assigned) throw Error(`Mac route ${address} is not an active non-loopback IPv4 interface`);
  return address;
}

function consoleSource() {
  return [
    'assert(LS and LS.state == "serving" and LS.game_id == "gravity-circuit" and',
    '  LS.nx_info and LS.nx_info.profile == "gravity-circuit-v1.2.1",',
    '  "Gravity Circuit target changed after the host probe")',
    `log(${JSON.stringify(CONSOLE_BANNER)})`,
    'log("[NET] RPC ready")',
    'log("[FS] target image: Gravity Circuit v1.2.1")',
    'log("[FS] native profile loaded")',
    'return "LOVERA1N_BANNER_OK"',
  ].join('\n');
}

async function run(values = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(values);
  const output = dependencies.output || process.stdout;
  if (options.help) {output.write(`${USAGE}\n`); return {help: true};}
  output.write(`${TERMINAL_BANNER}\n`);
  const switchIp = options.switchIp || await (dependencies.promptSwitchIp || promptSwitchIp)();
  usableIPv4(switchIp, 'Switch address');
  const macIp = await (dependencies.selectMacIPv4 || selectMacIPv4)(switchIp);
  usableIPv4(macIp, 'Mac route');
  if (macIp === switchIp) throw Error('Switch and Mac addresses are identical');
  output.write(`Mac route: ${macIp}. Connecting to Gravity Circuit at ${switchIp}:${DEFAULT_PORT}.\n`);
  const live = await (dependencies.probe || probe)({host: switchIp});
  if (!live.runtimeReady || live.gameId !== 'gravity-circuit' ||
      live.nativeProfile !== 'gravity-circuit-v1.2.1')
    throw Error('Gravity Circuit v1.2.1 native REPL is not ready; no FS traffic was sent');
  const target = (dependencies.loadTarget || loadTarget)('gravcirc');
  try {
    if (options.canary) (dependencies.assertCanarySupported || assertCanarySupported)(target);
    else (dependencies.assertFullSupported || assertFullSupported)(target);
  } catch (cause) {
    throw Error(`Gravity Circuit ${options.canary ? 'canary' : 'full FS'} path is not verified: ` +
      `${cause.message}. No native FS traffic was sent.`);
  }
  output.write(`${options.canary ? 'Canary' : 'Full FS'} checks passed; starting the guarded host.\n`);
  let bannerAttempted = false;
  const beforeHostStart = async () => {
    if (bannerAttempted) throw Error('Gravity Circuit console banner was already attempted');
    bannerAttempted = true;
    const reply = await (dependencies.executeLua || executeLua)({host: switchIp,
      port: DEFAULT_PORT, source: consoleSource()});
    if (!reply.split('\n').some(line => line.trim() === '-> LOVERA1N_BANNER_OK'))
      throw Error('Gravity Circuit did not confirm the console banner; no FS traffic was sent');
    output.write('lovera1n banner sent to the game console.\n');
  };
  const runner = options.canary ? (dependencies.runCanary || runCanary) :
    (dependencies.runFull || runFull);
  return runner([switchIp, macIp], {beforeHostStart,
    runRoot: path.join(os.homedir(), '.lovera1n', 'runs')});
}

module.exports = {TERMINAL_BANNER, CONSOLE_BANNER, USAGE, usableIPv4, parseArgs,
  promptSwitchIp, selectMacIPv4, consoleSource, run};
if (require.main === module) run().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
