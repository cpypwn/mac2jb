'use strict';

const fs = require('node:fs');
const path = require('node:path');
const timing = require('./hole-timing.cjs');

// Prior-boot evidence only selects the candidate schedule. The live diagnostic
// must independently qualify its timing and owned-path controls before a write.
function requireTimingProof(target, proofPath) {
  if (target?.name !== 'gravcirc') throw Error('Timing proof requires Gravity Circuit');
  if (!proofPath) throw Error('Early positive requires NS2_GC_RECEIVE_TIMING_REPORT');
  const file = fs.realpathSync(path.resolve(proofPath));
  const session = path.basename(path.dirname(path.dirname(path.dirname(file))));
  if (!/^switch2-[A-Za-z0-9]+$/.test(session) ||
      path.basename(path.dirname(file)) !== 'memory' ||
      path.basename(path.dirname(path.dirname(file))) !== 'switch2' ||
      !/^reserved-gap-[0-9]+\.json$/.test(path.basename(file)))
    throw Error('Gravity Circuit timing report is outside a measured run');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const checked = timing.verifyReport(report, session);
  const initial = report.cases[report.holeTiming.initialPinCaseIndex];
  const final = report.holeTiming.observations.at(-1);
  if (checked.status !== 'window-found' || report.sdkSha256 !== target.sdkSha256 ||
      report.markerOffset !== 0x2340 || report.writeSize !== 0xF0000 ||
      initial?.newPersistentBytes !== target.pinningAllocationBytes ||
      final?.readSize !== 0x80000 || final.window?.usable !== true)
    throw Error('Gravity Circuit timing proof does not cover this 960 KiB schedule');
  return {session, report: file, readSize: final.readSize};
}

module.exports = {requireTimingProof};
