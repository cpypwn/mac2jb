#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {profiles, selectedProfile, profileById, sourceDirectory, sourceDigest} = require('./host-profiles.cjs');
const provenance = require('../vendor/ns2-savekit/provenance.json');
const mountedSave = 'engine/switch2/app/mounted-save.cjs';
const overlaysFor = profileId => [
  ['engine/shared/ipc.cjs', provenance.kurumuzIpc],
  ['engine/switch2/ro/ncm.cjs', provenance.kurumuzNcm],
  ['engine/switch2/app/filesystem.cjs', provenance.kurumuzFilesystem],
  [mountedSave, profileId === 'kurumuz' ? provenance.kurumuzCurrentMountedSave : provenance.kurumuzMountedSave]
];
const supported = new Set(profiles.filter(profile => profile.supportsSaveKit).map(profile => profile.id));

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const overlayPath = (root, profileId, relative) => path.join(root, 'vendor/ns2-savekit/overlay',
  relative === mountedSave && profileId === 'kurumuz' ?
    'engine/switch2/app/mounted-save-kurumuz.cjs' : relative);

function verify(root, active = false, profileId = active ? selectedProfile(root).id : 'kurumuz') {
  if (!supported.has(profileId)) throw Error('SaveKit requires Kurumuz, Cellenseres or Astral.');
  const profile = profileById(profileId);
  const source = active ? path.join(root, 'vendor/ns2jb') : sourceDirectory(root, profile);
  if (sourceDigest(source, profile) !== profile.sourceSha256 ||
      overlaysFor(profileId).some(([relative, record]) =>
        digest(path.join(source, relative)) !== record.originalSha256 ||
        digest(overlayPath(root, profileId, relative)) !== record.patchedSha256))
    throw Error('SaveKit host patch integrity check failed.');
  return {source, profile};
}

function expectedPatchedSource(root, profileId) {
  const {source, profile} = verify(root, false, profileId);
  const replacements = Object.fromEntries(overlaysFor(profileId).map(([relative, record]) =>
    [relative, record.patchedSha256]));
  return {profile, sourceDirectory: source, replacements,
    sourceSha256: sourceDigest(source, profile, replacements)};
}

function prepare(root) {
  const profile = selectedProfile(root);
  if (!supported.has(profile.id) ||
      !fs.existsSync(path.join(root, 'selected-host.json')))
    throw Error('SaveKit requires a fresh Kurumuz, Cellenseres or Astral host session.');
  const expected = expectedPatchedSource(root, profile.id);
  const source = path.join(root, 'vendor/ns2jb');
  const activeDigest = sourceDigest(source, profile);
  if (activeDigest !== profile.sourceSha256 && activeDigest !== expected.sourceSha256)
    throw Error('SaveKit host patch integrity check failed.');
  fs.chmodSync(source, 0o700);
  if (activeDigest !== expected.sourceSha256) {
    for (const [relative] of overlaysFor(profile.id))
      fs.copyFileSync(overlayPath(root, profile.id, relative), path.join(source, relative));
    if (sourceDigest(source, profile) !== expected.sourceSha256)
      throw Error('The selected host SaveKit patch failed its integrity check.');
  }
  const runs = path.join(source, 'runs');
  if (fs.existsSync(runs)) {
    const info = fs.lstatSync(runs);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw Error('The selected host runs folder is invalid.');
  } else fs.mkdirSync(runs, {mode: 0o700});
  fs.chmodSync(runs, 0o700);
  return source;
}

function main(args = process.argv.slice(2)) {
  const root = path.resolve(__dirname, '..');
  if (args.length === 1 && args[0] === '--check') {
    for (const id of supported) verify(root, false, id);
    console.log('SaveKit host patches verified.');
    return;
  }
  throw Error('Usage: prepare-seedsow-host.cjs --check');
}

module.exports = {verify, prepare, expectedPatchedSource, overlayPath, supported};
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
