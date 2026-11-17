'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {requireGeometryProof} = require('./geometry-proof.cjs');

const target = {name: 'gravcirc', sdkSha256: 'a'.repeat(64),
  pinningAllocationBytes: 6960,
  canaryGeometry: {qualified: true, pinningAllocationBytes: 6960}};

function evidence(root) {
  const memory = path.join(root, 'memory');
  fs.mkdirSync(memory);
  const reportFile = path.join(memory, 'reserved-gap-123.json');
  const report = {session: 'switch2-owned', target: 'gravcirc', sdkSha256: target.sdkSha256,
    completed: true, cleanedUp: true, writeSize: 0x80000, requiredSaveSpace: 0x190000,
    freeSpace: {save: {result: 0, bytes: '3293184', required: 0x190000}},
    geometryOnly: {attempts: 1, pinningAllocationBytes: 6960, baseline: 100000,
      after: 93040, pinWindowOk: true},
    cases: [{profile: 'abort-control', triggerAborted: true, nativeGuard: {completed: 1},
      newPersistentBytes: 6960, restored: true, pinCostOk: true,
      changedPaths: [], canaryResult: 0, canaryType: 1, pinWindowOk: true,
      allPending: true}],
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false}};
  const sizes = [0x1000, 0x10000, 0x40000, 0x80000];
  const writeSizeProbe = {session: 'switch2-owned', verified: true, cleanedUp: true,
    maxSize: 0x80000, scratchCreateCommitResult: 0, scratchDeleteResult: 0,
    scratchCommitResult: 0,
    results: sizes.map(size => ({size, createResult: 0, result: 0, closed: 0,
      writeCommitResult: 0, deleteResult: 0, commitResult: 0,
      commitTimingSource: 'Mac-side monotonic wall time', writeCommitMacWallMs: 1,
      deleteCommitMacWallMs: 1,
      ...(size === 0x80000 ? {readBack: {result: 0, matches: true}} : {})}))};
  const proof = {session: 'switch2-owned', target: 'gravcirc', sdkSha256: target.sdkSha256,
    verified: true, cleanedUp: true, pinningAllocationBytes: 6960,
    writeSizeProbe, report: reportFile};
  const proofFile = path.join(root, 'geometry-current.json');
  const write = () => {
    fs.writeFileSync(reportFile, JSON.stringify(report));
    fs.writeFileSync(proofFile, JSON.stringify(proof));
  };
  write();
  return {report, proof, proofFile, reportFile, write};
}

test('a 512 KiB geometry proof binds the cleaned measurement to the target', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-geometry-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = evidence(root);
  assert.deepEqual(requireGeometryProof(target, source.proofFile),
    {session: 'switch2-owned', report: fs.realpathSync(source.reportFile),
      pinningAllocationBytes: 6960, writeSize: 0x80000});
  source.report.sdkSha256 = 'b'.repeat(64);
  source.write();
  assert.throws(() => requireGeometryProof(target, source.proofFile), /another build|512 KiB canary/);
});

test('missing allocation or proof stops before a canary can start', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-geometry-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = evidence(root);
  assert.throws(() => requireGeometryProof({...target, pinningAllocationBytes: null}, source.proofFile),
    /remains unmeasured/);
  assert.throws(() => requireGeometryProof(target, undefined), /NS2_GC_GEOMETRY_PROOF/);
  source.proof.writeSizeProbe.results[3].readBack.matches = false;
  source.write();
  assert.throws(() => requireGeometryProof(target, source.proofFile), /incomplete/);
});

test('an incomplete native cleanup or wrong canary size is not proof', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-geometry-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = evidence(root);
  source.report.retained.handles = [42];
  source.write();
  assert.throws(() => requireGeometryProof(target, source.proofFile), /retains native resources/);
  source.report.retained.handles = [];
  source.report.writeSize = 0x100000;
  source.write();
  assert.throws(() => requireGeometryProof(target, source.proofFile), /512 KiB canary/);
  source.report.writeSize = 0x80000;
  source.report.freeSpace.save.bytes = String(0x190000);
  source.write();
  assert.throws(() => requireGeometryProof(target, source.proofFile), /save space/);
});

test('proof cannot borrow a report from another run or session', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-geometry-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = evidence(root);
  source.proof.session = 'switch2-other';
  source.proof.writeSizeProbe.session = 'switch2-other';
  source.write();
  assert.throws(() => requireGeometryProof(target, source.proofFile), /another session/);
  source.proof.session = source.report.session;
  source.proof.writeSizeProbe.session = source.report.session;
  source.proof.report = path.join(root, 'reserved-gap-123.json');
  source.write();
  fs.copyFileSync(source.reportFile, source.proof.report);
  assert.throws(() => requireGeometryProof(target, source.proofFile), /not in its measured run/);
});
