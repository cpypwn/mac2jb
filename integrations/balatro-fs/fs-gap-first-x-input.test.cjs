'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const profile = require('./sdk-profile.v1.0.1f.json');
const {paths} = require('./marker-path-control.cjs');
const {DESCRIPTOR_BYTES, TERMINATOR_OFFSET, CANDIDATE_OFFSET,
  buildGapFirstXInput} = require('./fs-gap-first-x-input.cjs');

const owner = '0123456789abcdef';
const nonce = 'fedcba9876543210';
const preflight = {gameProfile: profile.gameProfile,
  arenaNonce: owner, markerNonce: nonce,
  exactAllocationBytes: null, markerHitVerified: false,
  fsStageVerified: false};

test('first-X descriptors preserve the B-filler positive and /-filler controls', () => {
  const plan = buildGapFirstXInput({preflight});
  assert.equal(plan.mode, 'balatro-first-x-0x800-hypothesis');
  assert.equal(plan.descriptorBytes, DESCRIPTOR_BYTES);
  assert.equal(plan.terminatorOffset, TERMINATOR_OFFSET);
  assert.equal(plan.candidateOffset, CANDIDATE_OFFSET);
  assert.equal(plan.markerPath, paths(nonce).marker);
  assert.equal(plan.absentPath, paths(nonce).absent);
  assert.equal(plan.selectedDirectory, `/bal-gap-${owner}/selected`);
  assert.equal(plan.absentDirectory.length, plan.selectedDirectory.length);
  for (const [name, bytes] of Object.entries(plan.descriptors)) {
    assert.equal(bytes.length, 0x800, name);
    assert.equal(bytes[0x7ff], 0, name);
    assert.equal(bytes.subarray(0, 0x7ff).includes(0), false, name);
    assert.match(plan.sha256[name], /^[0-9a-f]{64}$/);
  }
  assert.equal(path.posix.normalize(plan.descriptors.markerControl
    .toString('ascii', 0, 0x7ff)), paths(nonce).marker.slice(5));
  assert.equal(path.posix.normalize(plan.descriptors.absentControl
    .toString('ascii', 0, 0x7ff)), paths(nonce).absent.slice(5));
  assert.equal(path.posix.normalize(plan.descriptors.selectedDirectoryControl
    .toString('ascii', 0, 0x7ff)), plan.selectedDirectory);
  assert.equal(path.posix.normalize(plan.descriptors.absentDirectoryControl
    .toString('ascii', 0, 0x7ff)), plan.absentDirectory);
  assert.equal(plan.descriptors.positiveCandidate.subarray(0,
    plan.backslashPrefix.length).toString(), plan.backslashPrefix);
  assert.equal(plan.descriptors.negativeCandidate.subarray(0,
    plan.forwardPrefix.length).toString(), plan.forwardPrefix);
  assert.equal(plan.descriptors.positiveCandidate.subarray(0x700,
    0x700 + plan.selectedDirectory.length).toString(),
    plan.selectedDirectory);
  assert.equal(plan.descriptors.absentCandidate.subarray(0x700,
    0x700 + plan.absentDirectory.length).toString(),
    plan.absentDirectory);
  assert.equal(path.posix.normalize(plan.descriptors.negativeCandidate
    .toString('ascii', 0, 0x7ff)).replace(/\/$/, ''),
  plan.selectedDirectory);
  assert.equal(path.posix.normalize(plan.descriptors.absentCandidate
    .toString('ascii', 0, 0x7ff)).replace(/\/$/, ''),
  plan.absentDirectory);
  assert.equal(plan.shortControls.forward.selected,
    plan.forwardPrefix + plan.selectedDirectory);
  assert.equal(plan.shortControls.backslash.absent,
    plan.backslashPrefix + plan.absentDirectory);
  // The positive carries one unbroken 'B' filler component (>255 chars); the
  // negative and absent controls keep the '/' filler. They differ in both the
  // separator and the filler region, not just one byte.
  assert.equal(plan.descriptors.positiveCandidate[plan.changedSeparatorOffset],
    0x5c);
  assert.equal(plan.descriptors.negativeCandidate[plan.changedSeparatorOffset],
    0x2f);
  assert.ok(plan.descriptors.positiveCandidate
    .subarray(plan.backslashPrefix.length, 0x700)
    .every(byte => byte === 0x42));
  assert.ok(plan.descriptors.negativeCandidate
    .subarray(plan.forwardPrefix.length, 0x700)
    .every(byte => byte === 0x2f));
  assert.ok(plan.descriptors.absentCandidate
    .subarray(plan.forwardPrefix.length, 0x700)
    .every(byte => byte === 0x2f));
  assert.notDeepEqual(plan.descriptors.positiveCandidate,
    plan.descriptors.negativeCandidate);
  assert.equal(plan.selectedDirectoryCreatedAndVerified, false);
  assert.equal(plan.fsVictimAddress, null);
  assert.equal(plan.exactPinAllocationBytes, null);
  assert.equal(plan.directPathControlsVerified, false);
  assert.equal(plan.positiveAttemptAllowed, false);
  assert.equal(plan.markerHitVerified, false);
  assert.equal(plan.fsStageVerified, false);
});

test('stale or already claimed owner cannot produce positive descriptor plan', () => {
  assert.throws(() => buildGapFirstXInput({preflight: {...preflight,
    exactAllocationBytes: 14096}}), /fresh pinned owner/);
  assert.throws(() => buildGapFirstXInput({preflight: {...preflight,
    markerHitVerified: true}}), /fresh pinned owner/);
  assert.throws(() => buildGapFirstXInput({preflight: {...preflight,
    arenaNonce: nonce}}), /fresh pinned owner/);
});
