const net = require('node:net');
const {executeLua} = require('../gravcirc-fs/repl-client.cjs');
const {makeSource, parseReply} = require('./ffi-arena.cjs');

async function checkArena({host, phase, nonce, execute = executeLua,
  skipMountCheck = true}) {
  if (net.isIP(host) !== 4) throw new TypeError('Switch address must be IPv4');
  if (typeof execute !== 'function') throw new TypeError('execute must be a function');
  const source = makeSource({phase, nonce, skipMountCheck});
  const reply = await execute({host, port: 9026, source, timeoutMs: 30000});
  return parseReply(reply, {phase, nonce});
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node ffi-arena-live.cjs <switch-ipv4> reserve|inspect <16-lowercase-hex-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await checkArena({host: argv[0], phase: argv[1], nonce: argv[2]});
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\nNo automatic retry was attempted.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {checkArena, main};
