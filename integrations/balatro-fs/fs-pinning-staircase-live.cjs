const {runCounterLive} = require('./fs-counter-live.cjs');
const {MAX_CYCLES, PHASES, assessStaircase,
  runRepeatedStaircase} = require('./fs-pinning-staircase.cjs');

function validStaircaseResult(result) {
  if (result?.cleanup !== 'released' || result.markerAttempted !== false ||
      result.saveWrites !== 0 || result.exactAllocationBytes !== null ||
      typeof result.repeatabilityVerified !== 'boolean' ||
      !Array.isArray(result.cycles) || result.cycles.length < 1 ||
      result.cycles.length > MAX_CYCLES) return false;
  let assessments;
  try {
    assessments = result.cycles.map(cycle => {
      if (cycle?.cleanup !== 'released' || !cycle.phases ||
          PHASES.some(name => !cycle.phases[name])) return null;
      return assessStaircase(cycle.phases);
    });
  } catch {
    return false;
  }
  if (assessments.some(value => !value) || result.cycles.some((cycle, index) =>
    cycle.assessment?.staircaseVerified !== assessments[index].staircaseVerified ||
    cycle.assessment?.candidateDiagnosticCostBytes !==
      assessments[index].candidateDiagnosticCostBytes ||
    cycle.assessment?.exactAllocationBytes !== null)) return false;
  const repeated = assessments.length === MAX_CYCLES &&
    assessments.every(value => value.staircaseVerified) &&
    assessments[0].candidateDiagnosticCostBytes ===
      assessments[1].candidateDiagnosticCostBytes;
  return result.repeatabilityVerified === repeated &&
    result.candidateDiagnosticCostBytes ===
      (repeated ? assessments[1].candidateDiagnosticCostBytes : null);
}

async function runStaircaseLive(options) {
  return runCounterLive({...options,
    sample: options?.sample || runRepeatedStaircase,
    validateResult: validStaircaseResult});
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node fs-pinning-staircase-live.cjs <switch-ipv4> <mac-ipv4> <retained-arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runStaircaseLive({host: argv[0], macIp: argv[1],
      nonce: argv[2], onPhase: phase => process.stderr.write(`${phase}\n`)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.repeatabilityVerified) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry, save write, or marker attempt was made.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {validStaircaseResult, runStaircaseLive};
