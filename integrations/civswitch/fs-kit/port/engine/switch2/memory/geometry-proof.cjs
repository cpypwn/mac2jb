'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {verifiesGeometryWrite} = require('../app/write-size-transaction.cjs');
const {verifyGeometryReport} = require('./geometry-checkpoint.cjs');

function requireGeometryProof(target, proofPath) {
  if (target?.name !== 'gravcirc') throw Error('Geometry proof requires Gravity Circuit');
  const geometry = target.canaryGeometry;
  if (!Number.isInteger(target.pinningAllocationBytes) || target.pinningAllocationBytes <= 0 ||
      geometry?.pinningAllocationBytes !== target.pinningAllocationBytes ||
      geometry.qualified !== true)
    throw Error('Gravity Circuit pinning allocation remains unmeasured');
  if (!proofPath) throw Error('Gravity Circuit canary requires NS2_GC_GEOMETRY_PROOF');
  const file = fs.realpathSync(path.resolve(proofPath));
  const proof = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (proof.target !== 'gravcirc' || proof.sdkSha256 !== target.sdkSha256 ||
      proof.verified !== true || proof.cleanedUp !== true ||
      !/^switch2-[A-Za-z0-9]+$/.test(proof.session || '') ||
      proof.pinningAllocationBytes !== target.pinningAllocationBytes ||
      !verifiesGeometryWrite(proof.writeSizeProbe, 'gravcirc') ||
      proof.writeSizeProbe.session !== proof.session)
    throw Error('Gravity Circuit 512 KiB geometry proof is incomplete or targets another build');
  if (typeof proof.report !== 'string' ||
      !/^reserved-gap-[0-9]+\.json$/.test(path.basename(proof.report)))
    throw Error('Gravity Circuit geometry report path is not in its measured run');
  const reportFile = fs.realpathSync(proof.report);
  if (path.dirname(reportFile) !== fs.realpathSync(path.join(path.dirname(file), 'memory')))
    throw Error('Gravity Circuit geometry report path is not in its measured run');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  if (report.target !== 'gravcirc' || report.sdkSha256 !== target.sdkSha256 ||
      report.writeSize !== 0xF0000 || report.requiredSaveSpace !== 0x200000)
    throw Error('Gravity Circuit geometry report does not cover the 960 KiB canary');
  const space = report.freeSpace?.save;
  if (space?.result !== 0 || space.required !== report.requiredSaveSpace ||
      !/^[0-9]+$/.test(space.bytes || '') ||
      BigInt(space.bytes) <= BigInt(report.requiredSaveSpace))
    throw Error('Gravity Circuit geometry report lacks enough verified save space');
  const checked = verifyGeometryReport({...report, file: reportFile}, proof.session);
  if (checked.pinningAllocationBytes !== target.pinningAllocationBytes ||
      checked.report !== reportFile)
    throw Error('Gravity Circuit canary allocation differs from the measured proof');
  return {session: proof.session, report: reportFile,
    pinningAllocationBytes: checked.pinningAllocationBytes, writeSize: report.writeSize};
}

module.exports = {requireGeometryProof};
