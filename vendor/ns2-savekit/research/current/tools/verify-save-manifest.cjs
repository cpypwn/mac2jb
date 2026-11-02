#!/usr/bin/env node
// Check a pulled save directory against the manifest that was written into it.
//
//   node tools/verify-save-manifest.cjs <save-directory> <manifest.json> [--strict]
//   node tools/verify-save-manifest.cjs <save-directory> --manifest-json '<json>'
//
// By default only the manifest's own entries are checked: a manifest may describe five
// files injected into a save that already holds 290, and calling the other 285 "extra"
// is wrong. --strict additionally requires the pull to contain nothing else, which is
// only meaningful for a manifest that describes a whole archive.
//
// This is the after-the-fact half of "verify every file by hash": the write tool
// hashes what it read back from the console, and this hashes what a later *pull*
// produced, so a file that changed between the commit and the next boot is caught.
// Exit 0 = every manifest entry is present with the recorded sha256 and no extra
// file was added; 1 = mismatch (the differences are printed); 2 = bad usage.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function listFiles(directory, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    const name = prefix + '/' + entry.name;
    if (entry.isDirectory()) out.push(...listFiles(full, name));
    else if (entry.isFile()) out.push(name);
  }
  return out;
}

function main() {
  const strict = process.argv.includes('--strict');
  const [directory, manifestArg] = process.argv.slice(2).filter(a => a !== '--strict');
  if (!directory || (!manifestArg && !process.argv.includes('--manifest-json'))) {
    console.error('usage: node verify-save-manifest.cjs <save-directory> <manifest.json>');
    process.exit(2);
  }
  const at = process.argv.indexOf('--manifest-json');
  const manifest = JSON.parse(at >= 0 ? process.argv[at + 1] : fs.readFileSync(manifestArg, 'utf8'));
  // save-pull-root writes {files: <count>, bytes, entries: [...]}, where `files` is a
  // number - so the array has to be found by shape, not by name.
  const entries = Array.isArray(manifest) ? manifest
    : Array.isArray(manifest.entries) ? manifest.entries
    : Array.isArray(manifest.files) ? manifest.files : [];
  if (!entries.length) {
    console.log(manifest.files === 0
      ? 'EMPTY    the archive opened and holds no files (a save the account never wrote)'
      : 'EMPTY    the manifest lists no files');
    process.exit(0);
  }

  const problems = [];
  const expected = new Set();
  let totalBytes = 0;
  for (const entry of entries) {
    const relative = (entry.path || entry.name || '').replace(/^\/+/, '');
    if (!relative) { problems.push('manifest entry without a path'); continue; }
    expected.add('/' + relative);
    const file = path.join(directory, relative);
    if (!fs.existsSync(file)) { problems.push(`missing  /${relative}`); continue; }
    const bytes = fs.readFileSync(file);
    totalBytes += bytes.length;
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const want = entry.sha256 || entry.hash;
    if (!want) problems.push(`no hash in manifest for /${relative}`);
    else if (sha !== want) problems.push(`hash     /${relative} ${sha.slice(0, 16)}… != ${want.slice(0, 16)}…`);
    else console.log(`ok       /${relative} (${bytes.length} bytes)`);
  }
  if (strict && !manifest.partial) {
    for (const name of listFiles(directory)) {
      // The manifest lives in the archive it describes, so it is never "extra".
      if (name === '/manifest.json') continue;
      if (!expected.has(name)) problems.push(`extra    ${name}`);
    }
  }
  if (problems.length) {
    for (const problem of problems) console.log(problem);
    console.log(`FAILED   ${problems.length} problem(s) against ${entries.length} manifest entries`);
    process.exit(1);
  }
  console.log(`VERIFIED ${entries.length} files, ${totalBytes} bytes from the manifest`);
}

try { main(); } catch (error) { console.error('FAILED:', error.message); process.exit(2); }
