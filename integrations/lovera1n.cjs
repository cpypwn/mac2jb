const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const gravity = require('./gravcirc-fs/lovera1n.cjs');
const {DEFAULT_PORT, executeLua} = require('./gravcirc-fs/repl-client.cjs');
const balatroProfile = require('./balatro-fs/live-readonly-map.v1.0.1f.json');

const USAGE = 'usage: node integrations/lovera1n.cjs [--canary] [switch-ipv4]';
const IDENTITY_MARKER = 'LOVERA1N_ID_V1';
const BANNER_MARKER = 'LOVERA1N_BANNER_OK';
const BALATRO_SDK_BASE = Number(BigInt(balatroProfile.identity.sdkBase));

function parseArgs(values) {
  let canary = false;
  let switchIp = null;
  for (const value of values) {
    if (value === '--help' || value === '-h') return {help: true};
    if (value === '--canary' && !canary) {canary = true; continue;}
    if (value.startsWith('-') || switchIp) throw Error(USAGE);
    switchIp = gravity.usableIPv4(value, 'Switch address');
  }
  return {canary, switchIp};
}

async function promptSwitchIp({input = process.stdin, output = process.stdout} = {}) {
  const line = readline.createInterface({input, output});
  try {
    return gravity.usableIPv4((await line.question('Switch IPv4 shown in the game: ')).trim(),
      'Switch address');
  } finally {line.close();}
}

function identitySource(nonce) {
  if (!/^[0-9a-f]{16}$/.test(nonce)) throw Error('invalid identity nonce');
  const prefix = `${IDENTITY_MARKER}\t${nonce}\t`;
  return [
    'local g=LS',
    'if type(g)=="table" and g.state=="serving" and g.game_id=="gravity-circuit" and',
    '  g.nx_info and g.nx_info.profile=="gravity-circuit-v1.2.1" then',
    `  return ${JSON.stringify(prefix + 'gravity-circuit')}`,
    'end',
    'local b=BL',
    'if type(b)=="table" and b.state=="serving" and b.info and',
    `  b.info.version=="1.0.1f-FULL" and b.info.sdk_base==${BALATRO_SDK_BASE} then`,
    `  return ${JSON.stringify(prefix + 'balatro')}`,
    'end',
    `return ${JSON.stringify(prefix + 'unsupported')}`,
  ].join('\n');
}

function parseIdentityReply(reply, nonce) {
  if (typeof reply !== 'string') throw Error('game identity reply is not text');
  const marker = `-> ${IDENTITY_MARKER}\t`;
  const matches = reply.trimEnd().split('\n').filter(line => line.startsWith(marker));
  if (matches.length !== 1) throw Error('game identity reply is missing or duplicated');
  const fields = matches[0].trimEnd().slice(3).split('\t');
  if (fields.length !== 3 || fields[0] !== IDENTITY_MARKER || fields[1] !== nonce ||
      !['gravity-circuit', 'balatro', 'unsupported'].includes(fields[2])) {
    throw Error('game identity reply is invalid');
  }
  return fields[2];
}

function balatroBannerSource() {
  return [
    'local b=BL',
    'assert(b and b.state=="serving" and b.info and',
    `  b.info.version=="1.0.1f-FULL" and b.info.sdk_base==${BALATRO_SDK_BASE},`,
    '  "Balatro target changed after the host probe")',
    'local log=require("bl.log")',
    `log.log(${JSON.stringify(gravity.CONSOLE_BANNER)})`,
    'log.log("[NET] RPC ready")',
    'log.log("[FS] target image: Balatro 1.0.1f")',
    'log.log("[FS] native profile loaded")',
    `return ${JSON.stringify(BANNER_MARKER)}`,
  ].join('\n');
}

async function run(values = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(values);
  const output = dependencies.output || process.stdout;
  if (options.help) {output.write(`${USAGE}\n`); return {help: true};}
  const switchIp = options.switchIp || await (dependencies.promptSwitchIp || promptSwitchIp)();
  gravity.usableIPv4(switchIp, 'Switch address');
  const nonceBytes = (dependencies.nonceBytes || crypto.randomBytes)(8);
  if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 8)
    throw Error('identity nonce generator must return eight bytes');
  const nonce = nonceBytes.toString('hex');
  const execute = dependencies.executeLua || executeLua;
  const identityReply = await execute({host: switchIp, port: DEFAULT_PORT,
    source: identitySource(nonce)});
  const game = parseIdentityReply(identityReply, nonce);
  if (game === 'gravity-circuit') {
    return (dependencies.runGravity || gravity.run)([
      ...(options.canary ? ['--canary'] : []), switchIp,
    ], {...dependencies, executeLua: execute, output});
  }
  if (game !== 'balatro') {
    throw Error('No supported Gravity Circuit v1.2.1 or Balatro 1.0.1f-FULL runtime ' +
      'was found on port 9026; no FS traffic was sent');
  }
  output.write(`${gravity.TERMINAL_BANNER}\n`);
  output.write(`Balatro 1.0.1f-FULL identified at ${switchIp}:${DEFAULT_PORT}.\n`);
  const bannerReply = await execute({host: switchIp, port: DEFAULT_PORT,
    source: balatroBannerSource()});
  if (!bannerReply.split('\n').some(line => line.trim() === `-> ${BANNER_MARKER}`))
    throw Error('Balatro did not confirm the console banner; no FS traffic was sent');
  output.write('lovera1n banner sent to the game console.\n');
  throw Error(`Balatro ${options.canary ? 'canary' : 'full FS'} execution is not verified yet; ` +
    'no native FS escalation was sent');
}

module.exports = {USAGE, IDENTITY_MARKER, BANNER_MARKER, BALATRO_SDK_BASE,
  parseArgs, promptSwitchIp, identitySource, parseIdentityReply, balatroBannerSource, run};
if (require.main === module) run().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
