const {runCounterLive} = require('./fs-counter-live.cjs');
const {runPinningCycle} = require('./fs-pinning-probe.cjs');

function validPinningResult(result) {
  const phase = name => result[name] && Array.isArray(result[name].samples) &&
    result[name].samples.length === 2 &&
    result[name].samples.every(row => Array.isArray(row) && row.length === 16);
  return result && result.cleanup === 'released' &&
    ['before', 'held', 'after'].every(phase) &&
    result.assessment && typeof result.assessment.verified === 'boolean';
}

async function runPinningLive(options) {
  return runCounterLive({...options,
    sample: options?.sample || runPinningCycle,
    validateResult: validPinningResult});
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node fs-pinning-live.cjs <switch-ipv4> <mac-ipv4> <retained-arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runPinningLive({host: argv[0], macIp: argv[1],
      nonce: argv[2], onPhase: phase => process.stderr.write(`${phase}\n`)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.assessment.verified) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry was attempted; no FS canary or marker was claimed.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {validPinningResult, runPinningLive};
