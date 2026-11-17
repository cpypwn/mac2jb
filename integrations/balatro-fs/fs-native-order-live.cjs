const {runCounterLive} = require('./fs-counter-live.cjs');
const {assessNativeOrderControl, runNativeOrderControl} =
  require('./fs-native-order-control.cjs');

function validNativeOrderResult(result) {
  if (result?.cleanup !== 'released' || result.markerAttempted !== false ||
      result.saveWrites !== 0 || !result.phases || !result.clock ||
      !Array.isArray(result.events)) return false;
  try {
    const assessed = assessNativeOrderControl(result);
    return assessed.matched === true &&
      assessed.serialReceiveOrderVerified === true &&
      assessed.concurrentOverlapMeasured === false &&
      assessed.exactAllocationBytes === null &&
      assessed.pinAddress === null &&
      assessed.candidateDiagnosticCostBytes ===
        result.assessment?.candidateDiagnosticCostBytes;
  } catch {
    return false;
  }
}

async function runNativeOrderLive(options) {
  return runCounterLive({...options,
    sample: options?.sample || runNativeOrderControl,
    validateResult: validNativeOrderResult});
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 3) {
    process.stderr.write('usage: node fs-native-order-live.cjs <switch-ipv4> <mac-ipv4> <retained-arena-nonce>\n');
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runNativeOrderLive({host: argv[0], macIp: argv[1],
      nonce: argv[2], onPhase: phase => process.stderr.write(`${phase}\n`)});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\nNo automatic retry, save write, or marker attempt was made.\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {validNativeOrderResult, runNativeOrderLive};
