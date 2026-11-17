const crypto = require('node:crypto');
const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const readonly = require('./probe-readonly.cjs');
const owned = require('./qualify-owned.cjs');

const PORT = 9026;
const TIMEOUT_MS = 15000;

async function qualifyLive({host, includeOwned = false, includeAllocation = false,
                            includeService = false, execute = executeLua,
                            nonceBytes = crypto.randomBytes, onPhase = () => {}}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  if (typeof includeOwned !== 'boolean' || typeof includeAllocation !== 'boolean' ||
      typeof includeService !== 'boolean') {
    throw new TypeError('qualification options must be boolean');
  }
  if (typeof execute !== 'function' || typeof nonceBytes !== 'function' ||
      typeof onPhase !== 'function') throw new TypeError('invalid qualification dependency');

  async function phase(name, makeSource, parseReply, context = {}) {
    const bytes = nonceBytes(8);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 8) {
      throw new Error('nonce generator did not return eight bytes');
    }
    const nonce = bytes.toString('hex');
    const request = {...context, nonce};
    const source = makeSource(request);
    onPhase(name);
    const reply = await execute({host, port: PORT, source, timeoutMs: TIMEOUT_MS});
    return parseReply(reply, request);
  }

  const result = {
    host,
    port: PORT,
    readonly: await phase('read-only', readonly.makeSource, readonly.parseReply),
  };
  if (includeOwned || includeAllocation) {
    result.allocation = await phase('allocation', owned.makeSource, owned.parseReply,
      {phase: 'allocation'});
  }
  if (includeOwned || includeService) {
    result.service = await phase('service', owned.makeSource, owned.parseReply,
      {phase: 'service'});
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const [host, option] = argv;
  if (argv.length < 1 || argv.length > 2 ||
      (option !== undefined && option !== '--service' && option !== '--owned' &&
       option !== '--allocation')) {
    process.stderr.write('usage: node qualify-live.cjs <switch-ipv4> [--service|--allocation|--owned]\n');
    process.exitCode = 2;
    return;
  }
  try {
    if (option === '--allocation' || option === '--owned') {
      throw new Error('Balatro block allocation is paused until the 2 MiB unit and free path are qualified');
    }
    const result = await qualifyLive({host, includeOwned: option === '--owned',
      includeAllocation: option === '--allocation',
      includeService: option === '--service',
      onPhase: name => process.stderr.write(`qualifying Balatro ${name}\n`)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {PORT, TIMEOUT_MS, qualifyLive, main};
