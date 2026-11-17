#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {verifyReport: verifyEarlyPositiveReport} =
  require('../civswitch/fs-kit/port/engine/switch2/memory/early-positive.cjs');

const CONTROL_PROFILES = [
  'marker-first-descriptor-marker',
  'marker-first-descriptor-absent',
  'negative',
  'positive',
];

function check(condition, message) {
  if (!condition) throw Error(`Gravity Circuit report comparison: ${message}`);
}

function triggerObservation(row) {
  const trigger = row.rows?.find(item => item.role === 'trigger');
  const commit = row.rows?.find(item => item.role === 'commit');
  const canary = row.rows?.find(item => item.role === 'canary');
  check(trigger && commit && canary && [trigger, commit, canary].every(item =>
    Number.isFinite(item.startUs) && Number.isFinite(item.endUs) &&
    item.endUs >= item.startUs), 'trigger, commit, or canary timing is missing');
  check(Number.isInteger(trigger.result) && trigger.result >= 0 &&
    typeof trigger.inline === 'string' && /^[0-9a-f]{8,}$/i.test(trigger.inline) &&
    trigger.inline.length % 2 === 0,
  'trigger result is missing');
  const type = trigger.result === 0 ?
    Buffer.from(trigger.inline, 'hex').readUInt32LE() : null;
  return {
    cmifResult: `0x${trigger.result.toString(16)}`,
    type,
    startedUs: trigger.startUs,
    endedUs: trigger.endUs,
    durationUs: trigger.endUs - trigger.startUs,
    commitEndedUs: commit.endUs,
    canaryEndedUs: canary.endUs,
    endedBeforeCommit: trigger.endUs < commit.endUs,
    endedBeforeCanary: trigger.endUs < canary.endUs,
  };
}

function observation(row, caseIndex) {
  check(Number.isInteger(row.readSize) && row.readSize > 0 &&
    Number.isInteger(row.holeDelayNs) && row.holeDelayNs > 0 &&
    Number.isInteger(row.extent) && row.extent > 0 &&
    Number.isInteger(row.pathTerminatorOffset) &&
    row.pathTerminatorOffset >= 0 && row.pathTerminatorOffset <= row.extent &&
    Array.isArray(row.changedPaths) &&
    Number.isFinite(row.receiveOrderMarginUs),
  `case ${caseIndex} lacks recorded geometry or outcome`);
  return {
    caseIndex,
    profile: row.profile,
    geometry: {
      readSize: row.readSize,
      holeDelayNs: row.holeDelayNs,
      extentBytes: row.extent,
      pathTerminatorOffset: row.pathTerminatorOffset,
    },
    trigger: triggerObservation(row),
    receiveOrderMarginUs: row.receiveOrderMarginUs,
    allPending: row.allPending === true,
    triggerAborted: row.triggerAborted === true,
    restored: row.restored === true,
    selectedMarker: row.selectedMarker === true,
    changedPaths: [...row.changedPaths],
    canary: {cmifResult: Number.isInteger(row.canaryResult) ?
      `0x${row.canaryResult.toString(16)}` : null, type: row.canaryType ?? null},
  };
}

function compareReport(report) {
  check(report?.target === 'gravcirc' && typeof report.session === 'string' &&
    report.earlyPositiveEnabled === true &&
    report.earlyPositive?.mode === 'fresh-timing-one-positive' &&
    Array.isArray(report.cases), 'expected a Gravity Circuit early-positive run report');
  // Reuse the engine's full evidence and cleanup checks. A control hit by itself
  // must never promote this diagnostic to an FS canary checkpoint.
  const validated = verifyEarlyPositiveReport(report, report.session);
  const positions = CONTROL_PROFILES.map(profile => report.cases
    .map((row, caseIndex) => ({row, caseIndex}))
    .filter(item => item.row.profile === profile).at(-1));
  check(positions.every(Boolean), 'marker, absent, negative, or positive case is missing');
  check(positions.every((item, index) => !index ||
    positions[index - 1].caseIndex < item.caseIndex),
  'matched controls and positive case are out of order');
  const [marker, absent, negative, positive] = positions.map(item =>
    observation(item.row, item.caseIndex));
  const sameSchedule = [marker, absent, negative].every(item =>
    item.geometry.readSize === positive.geometry.readSize &&
    item.geometry.holeDelayNs === positive.geometry.holeDelayNs);
  const cleanupRecorded = report.cleanedUp === true && !report.cleanupError &&
    report.retained?.base === 0 && report.retained?.released === true &&
    report.retained?.handles?.length === 0 && report.retained?.threads?.length === 0 &&
    report.retained?.created?.length === 0 && !report.retained?.group &&
    !report.retained?.cacheNeedsRestore;
  return {
    session: report.session,
    reportKind: 'one-positive diagnostic',
    recordedOutcome: validated.status,
    facts: {
      markerControl: marker,
      absentControl: absent,
      negativeControl: negative,
      positiveWave: positive,
      sameReadSizeAndHoleDelay: sameSchedule,
      markerOffset: report.markerOffset,
      cleanupRecorded,
    },
    hypotheses: [
      {
        claim: 'The positive request may be rejected before it selects the owned marker.',
        basis: 'Compare the positive and marker-control CMIF results, trigger durations, and commit end times.',
        verified: false,
      },
      {
        claim: 'The first-descriptor control and positive path may exercise different path parsing boundaries.',
        basis: 'The report records different path terminator offsets; it does not record the complete request bytes.',
        verified: false,
      },
    ],
    escalation: {
      repeatedPositiveCanaryVerified: false,
      stageTwoOfFourComplete: false,
      reason: 'A one-positive diagnostic cannot establish the repeated positive marker and extent-control checkpoint.',
    },
  };
}

function main(args = process.argv.slice(2)) {
  check(args.length === 1, 'usage: node compare-marker-report.cjs RUN_REPORT.json');
  const report = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  process.stdout.write(`${JSON.stringify(compareReport(report), null, 2)}\n`);
}

module.exports = {compareReport, main};
if (require.main === module) {
  try {main();}
  catch (error) {process.stderr.write(`${error.message}\n`); process.exitCode = 1;}
}
