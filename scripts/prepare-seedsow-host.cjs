#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {selectedProfile, profileById, sourceDigest} = require('./host-profiles.cjs');
const provenance = require('../vendor/ns2-savekit/provenance.json');
const overlays = [
  ['engine/shared/ipc.cjs', provenance.kurumuzIpc],
  ['engine/switch2/ro/ncm.cjs', provenance.kurumuzNcm],
  ['engine/switch2/app/mounted-save.cjs', provenance.kurumuzMountedSave]
];
const supported = new Set(['kurumuz', 'cellenseres']);

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verify(root, active = false, profileId = active ? selectedProfile(root).id : 'kurumuz') {
  if (!supported.has(profileId)) throw Error('SaveKit requires Kurumuz or Cellenseres.');
  const profile = profileById(profileId);
  const source = path.join(root, active ? 'vendor/ns2jb' : profile.sourceDirectory);
  const save = path.join(root, 'vendor/ns2-savekit', provenance.editor.asset);
  if (sourceDigest(source, profile) !== profile.sourceSha256 ||
      overlays.some(([relative, record]) =>
        digest(path.join(source, relative)) !== record.originalSha256 ||
        digest(path.join(root, 'vendor/ns2-savekit/overlay', relative)) !== record.patchedSha256) ||
      digest(save) !== provenance.editor.sha256)
    throw Error('Seedsow savekit source integrity check failed.');
  return {source, profile};
}

function expectedPatchedSource(root, profileId) {
  const {source, profile} = verify(root, false, profileId);
  const replacements = Object.fromEntries(overlays.map(([relative, record]) =>
    [relative, record.patchedSha256]));
  return {profile, sourceDirectory: source, replacements,
    sourceSha256: sourceDigest(source, profile, replacements)};
}

function prepare(root) {
  if (!supported.has(selectedProfile(root).id) ||
      !fs.existsSync(path.join(root, 'selected-host.json')))
    throw Error('SaveKit requires a fresh Kurumuz or Cellenseres host session.');
  const {source} = verify(root, true);
  const folder = fs.mkdtempSync(path.join(root, 'vendor/ns2-savekit-host-'));
  fs.chmodSync(folder, 0o700);
  fs.cpSync(source, folder, {recursive: true, filter(candidate) {
    const relative = path.relative(source, candidate);
    return relative !== 'runs' && !relative.startsWith('runs' + path.sep);
  }});
  for (const [relative] of overlays)
    fs.copyFileSync(path.join(root, 'vendor/ns2-savekit/overlay', relative), path.join(folder, relative));
  fs.mkdirSync(path.join(folder, 'runs'), {mode: 0o700});
  return folder;
}

function main(args = process.argv.slice(2)) {
  const root = path.resolve(__dirname, '..');
  if (args.length === 1 && args[0] === '--check') {
    for (const id of supported) verify(root, false, id);
    console.log('Seedsow editor save and Kurumuz/Cellenseres IPC patch verified.');
    return;
  }
  throw Error('Usage: prepare-seedsow-host.cjs --check');
}

module.exports = {verify, prepare, expectedPatchedSource, supported};
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
