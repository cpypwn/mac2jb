const net = require('node:net');
const {runFreshBorrowedDomain} = require('./borrowed-domain-live.cjs');
const {runBorrowedDomainDiscriminator} = require('./borrowed-domain-discriminator.cjs');
const {formatFailure} = require('./fs-root-batch-live.cjs');

async function runFreshAbsentPath({host, macIp, runFresh = runFreshBorrowedDomain,
  onPhase = () => {}}) {
  if (net.isIP(host) !== 4 || net.isIP(macIp) !== 4 ||
      typeof runFresh !== 'function' || typeof onPhase !== 'function') {
    throw new TypeError('Balatro absent-path control needs Switch and Mac IPv4 addresses');
  }
  const result = await runFresh({host, macIp,
    runOne: runBorrowedDomainDiscriminator, onPhase});
  if (result.sendCount !== 1 || result.result !== 0x202 ||
      result.arena !== 'detached' || result.listener !== 'closed' ||
      result.nativeBridge !== 'closed' || result.domainClones !== 0 ||
      result.markerWrites !== 0 || result.explicitSaveWrites !== 0) {
    throw Error('Balatro absent-path control did not verify one send and full cleanup');
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || net.isIP(argv[0]) !== 4 || net.isIP(argv[1]) !== 4) {
    process.stderr.write('usage: node borrowed-absent-live.cjs <switch-ipv4> <mac-ipv4>\n');
    process.exitCode = 2;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runFreshAbsentPath({
      host: argv[0], macIp: argv[1],
      onPhase: label => process.stderr.write(`phase: ${label}\n`)}), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${formatFailure(error)}\nNo automatic retry or clone was attempted.\n`);
    if (error.diagnostic) process.stderr.write(`${JSON.stringify(error.diagnostic, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {runFreshAbsentPath, main};
if (require.main === module) main();
