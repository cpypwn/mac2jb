const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const root = __dirname;
const verification = JSON.parse(fs.readFileSync(path.join(root, 'verification.json'), 'utf8'));
const manifestPath = path.join(root, 'stage', 'save-write-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const scriptName = 'norahax-entry-v3.asb';

function verify() {
  if (verification.titleId !== '010012900d38a000') throw Error('Wrong title ID');
  const hasThumbnail = Object.hasOwn(verification.stageFiles, 'save0001.png');
  if (!Array.isArray(manifest.files) || manifest.files.length !== (hasThumbnail ? 3 : 2))
    throw Error('Unexpected stage manifest');
  for (const [name, expected] of Object.entries(verification.sourceFiles)) {
    const actual = hash(fs.readFileSync(path.join(root, 'original', name)));
    if (actual !== expected) throw Error('Original file hash mismatch: ' + name);
  }
  for (const [name, expected] of Object.entries(verification.stageFiles)) {
    const actual = hash(fs.readFileSync(path.join(root, 'stage', name)));
    if (actual !== expected) throw Error('Stage file hash mismatch: ' + name);
    const guiFile = hash(fs.readFileSync(path.join(root, 'write-files', name)));
    if (guiFile !== expected) throw Error('GUI write file hash mismatch: ' + name);
  }
  const expectedFiles = [
    {path: '/save0001.dat', local: 'stage/save0001.dat', replace: true},
    {path: '/' + scriptName, local: 'stage/' + scriptName},
    ...(hasThumbnail ? [{path: '/save0001.png', local: 'stage/save0001.png', replace: true}] : []),
  ];
  if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
    throw Error('Stage manifest differs from the verified package');
  }
}

function main() {
  verify();
  if (process.argv[2] === '--check' && process.argv.length === 3) {
    console.log('Nora v3 diagnostic package verified locally; no console operation was started.');
    return;
  }
  if (process.argv[2] !== '--write' || process.argv.length !== 7) {
    throw Error('Usage: node write-proof.cjs --check OR --write <mac2jb-checkout> <run-directory> <uid-hex> <fresh-backup-directory>');
  }
  const [, , , checkout, run, uid, backup] = process.argv;
  if (!/^[0-9a-fA-F]{32}$/.test(uid)) throw Error('UID must be 16 bytes as 32 hex characters');
  const backupSlot = path.join(path.resolve(backup), 'save0001.dat');
  if (hash(fs.readFileSync(backupSlot)) !== verification.sourceFiles['save0001.dat']) {
    throw Error('Fresh backup slot differs from the proof source; rebuild the proof from that backup');
  }
  if (Object.hasOwn(verification.stageFiles, 'save0001.png') &&
      hash(fs.readFileSync(path.join(path.resolve(backup), 'save0001.png'))) !==
      verification.sourceFiles['save0001.png']) {
    throw Error('Fresh backup thumbnail differs from the proof source; rebuild from that backup');
  }
  const writer = path.join(path.resolve(checkout), 'vendor/ns2-savekit/tools/save-write-stage.cjs');
  if (!fs.existsSync(writer) || !fs.statSync(writer).isFile()) {
    throw Error('SaveKit writer was not found in the checkout');
  }
  const result = spawnSync(process.execPath, [writer, path.resolve(run), verification.titleId,
    uid, path.resolve(backup), manifestPath], {cwd: root, stdio: 'inherit'});
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
