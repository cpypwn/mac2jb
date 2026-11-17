const {runCounterLive} = require('./fs-counter-live.cjs');
const {MAX_CYCLES, validCycle, runRepeatedPinning} = require('./fs-pinning-repeat.cjs');

function validRepeatedResult(result) {
  if (result?.cleanup !== 'released' || result.markerAttempted !== false ||
      typeof result.repeatabilityVerified !== 'boolean' ||
      !Array.isArray(result.cycles) || result.cycles.length < 1 ||
      result.cycles.length > MAX_CYCLES ||
      result.cycles.some(cycle => cycle?.cleanup !== 'released' ||
        typeof cycle.assessment?.verified !== 'boolean')) return false;
  const match = result.cycles.length === MAX_CYCLES &&
    result.cycles.every(validCycle) &&
    result.cycles[0].assessment.bytes === result.cycles[1].assessment.bytes;
  return result.repeatabilityVerified === match &&
    result.candidateDiagnosticDropBytes === (match ? result.cycles[1].assessment.bytes : null);
}

async function runRepeatedLive(options) {
  return runCounterLive({...options,
    sample: options?.sample || runRepeatedPinning,
    validateResult: validRepeatedResult});
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node fs-pinning-repeat-live.cjs <switch-ipv4> <mac-ipv4> <retained-arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runRepeatedLive({host: argv[0], macIp: argv[1],
      nonce: argv[2], onPhase: phase => process.stderr.write(`${phase}\n`)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.repeatabilityVerified) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\nNo canary or marker was attempted.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {validRepeatedResult, runRepeatedLive};
