const {runPinningCycle} = require('./fs-pinning-probe.cjs');

const MAX_CYCLES = 2;

function validCycle(cycle) {
  return cycle?.cleanup === 'released' && cycle.assessment?.verified === true &&
    Number.isSafeInteger(cycle.assessment.bytes) && cycle.assessment.bytes > 0 &&
    cycle.assessment.bytes <= 0x10000 && cycle.assessment.restoration === 0;
}

async function runRepeatedPinning({context, exchange, cycle = runPinningCycle}) {
  if (!context || typeof exchange !== 'function' || typeof cycle !== 'function') {
    throw new TypeError('Balatro repeated pinning needs a qualified context and exchange');
  }
  const cycles = [];
  for (let index = 1; index <= MAX_CYCLES; index++) {
    const result = await cycle({context,
      exchange: (packet, phase) => exchange(packet, `cycle-${index}-${phase}`)});
    if (result?.cleanup !== 'released' || !result.assessment ||
        typeof result.assessment.verified !== 'boolean') {
      throw Error(`Balatro pinning cycle ${index} did not verify resource cleanup`);
    }
    cycles.push(result);
    if (!validCycle(result)) break;
  }
  const repeatabilityVerified = cycles.length === MAX_CYCLES &&
    cycles.every(validCycle) &&
    cycles[0].assessment.bytes === cycles[1].assessment.bytes;
  return {cycles, repeatabilityVerified,
    candidateDiagnosticDropBytes: repeatabilityVerified ? cycles[1].assessment.bytes : null,
    interpretation: 'cmd1009 is a get-and-clear peak diagnostic; the drop is not an exact allocation size',
    cleanup: 'released', markerAttempted: false,
    status: repeatabilityVerified ?
      'two bounded pinning cycles had the same diagnostic drop; marker placement remains unverified' :
      'pinning diagnostic did not repeat; no canary or marker was attempted'};
}

module.exports = {MAX_CYCLES, validCycle, runRepeatedPinning};
