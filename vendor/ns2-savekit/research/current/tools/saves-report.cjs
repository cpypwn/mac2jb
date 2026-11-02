#!/usr/bin/env node
// Report what a pull produced, per archive, so "does this generalise?" is a table
// rather than an impression.
//
//   node tools/saves-report.cjs <saves-root>
//
// Reads every <dir>/manifest.json written by save-pull-root (per-file size and
// sha256) and the progress.json that pull-all keeps, and prints:
//
//   title | files | bytes | space/type that opened it | hashes
//
// The space/type column is the generalisation evidence: a title whose save is not
// User/Account needs a different combination, and the tool records which one opened
// it instead of assuming.
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
if (!root) {
  console.error('usage: node saves-report.cjs <saves-root>');
  process.exit(2);
}
const base = path.resolve(root);

let progress = {};
try { progress = JSON.parse(fs.readFileSync(path.join(base, 'progress.json'), 'utf8')); }
catch { /* no progress file: report the manifests that exist */ }
const combinations = progress.combinations || {};

// progress.json keys by program id; map id -> directory name by reading each
// archive's manifest, which records the archive label the console reported.
const rows = [];
for (const entry of fs.readdirSync(base, {withFileTypes: true})) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(base, entry.name);
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    rows.push({title: entry.name, files: null, bytes: null, combination: null, hashed: 'no manifest'});
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const entries = manifest.entries || [];
  const hashed = entries.filter(e => /^[0-9a-f]{64}$/.test(e.sha256 || '')).length;
  rows.push({
    title: entry.name,
    files: manifest.files ?? entries.length,
    bytes: manifest.bytes ?? entries.reduce((n, e) => n + (e.size || 0), 0),
    combination: typeof manifest.archive === 'string' ? manifest.archive
      : manifest.archive ? `space=${manifest.archive.space} type=${manifest.archive.type}` : null,
    hashed: `${hashed}/${entries.length}`
  });
}

const human = n => n === null ? '-' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MiB' : (n / 1024).toFixed(0) + ' KiB';
const width = Math.max(5, ...rows.map(r => r.title.length));
console.log('title'.padEnd(width) + '  files  ' + 'size'.padStart(9) + '  hashed     archive');
for (const row of rows.sort((a, b) => (b.bytes || 0) - (a.bytes || 0))) {
  console.log(row.title.padEnd(width) + '  ' + String(row.files ?? '-').padStart(5) + '  ' +
    human(row.bytes).padStart(9) + '  ' + String(row.hashed).padEnd(10) + ' ' + (row.combination || ''));
}
const pulled = rows.filter(r => r.bytes !== null);
console.log(`\n${pulled.length} archive(s), ${pulled.reduce((n, r) => n + r.files, 0)} files, ` +
  `${pulled.reduce((n, r) => n + r.bytes, 0)} bytes`);
if (progress.absent && progress.absent.length)
  console.log(`absent on every space/type: ${progress.absent.join(', ')}`);
if (Object.keys(combinations).length)
  console.log('space/type that opened each title: ' +
    Object.entries(combinations).map(([id, c]) => `${id.slice(-8)}=` +
      (typeof c === 'string' ? c : `space=${c.space} type=${c.type}`)).join(' '));
