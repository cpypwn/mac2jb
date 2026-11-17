const crypto = require('node:crypto');
const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const probe = require('./probe-domain-readonly.cjs');

async function probeDomainLive({host, execute = executeLua, nonceBytes = crypto.randomBytes}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  const bytes = nonceBytes(8);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 8) throw new TypeError('nonce generator must return eight bytes');
  const nonce = bytes.toString('hex');
  const reply = await execute({host, port: 9026, timeoutMs: 15000,
    source: probe.makeSource({nonce})});
  return probe.parseReply(reply, {nonce});
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || net.isIP(argv[0]) !== 4) {
    process.stderr.write('usage: node probe-domain-live.cjs <switch-ipv4>\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await probeDomainLive({host: argv[0]}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo mounted domain clone or save write was attempted.\n`);
    process.exitCode = 1;
  }
}

module.exports = {probeDomainLive, main};
if (require.main === module) main();
