#!/usr/bin/env node
// Turn a pulled save directory into a manifest that save-write-stage can restore.
//
//   node tools/manifest-from-dir.cjs <save-directory> <manifest.json>
//
// Every regular file in the directory becomes an entry with its sha256 and size, and
// `replace: true`, because a restore writes into a save that already holds those files.
// `manifest.json` is skipped: it is this toolkit's own record, not save data.
//
// This is what makes restore generic: pull a save from any title, hand the same
// directory back, and the manifest describes exactly the bytes that go back on.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const [directory, out] = process.argv.slice(2);
if (!directory || !out) {
  console.error('usage: node manifest-from-dir.cjs <save-directory> <manifest.json>');
  process.exit(2);
}
const base = path.resolve(directory);

async function walk(dir, prefix, files) {
  for (const entry of await fsp.readdir(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    const virtual = (prefix.endsWith('/') ? prefix : prefix + '/') + entry.name;
    if (entry.isDirectory()) { await walk(full, virtual, files); continue; }
    if (!entry.isFile()) continue;
    if (prefix === '/' && entry.name === 'manifest.json') continue;
    const bytes = await fsp.readFile(full);
    files.push({
      path: virtual,
      local: full,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      replace: true
    });
  }
}

(async () => {
  const files = [];
  await walk(base, '/', files);
  if (!files.length) {
    console.error('no files in ' + base + ' - nothing to restore');
    process.exit(1);
  }
  // Nested files are supported (the write stage creates their parent directories),
  // but they are worth naming: a flat save and a nested one fail differently.
  const nested = files.filter(file => file.path.split('/').length > 2);
  if (nested.length) {
    console.error('note: ' + nested.length + ' file(s) in subdirectories; their parent ' +
      'directories will be created on restore:');
    for (const file of nested.slice(0, 5)) console.error('  ' + file.path);
  }
  const manifest = {
    purpose: 'restore of ' + path.basename(base),
    source: base,
    files
  };
  await fsp.writeFile(out, JSON.stringify(manifest, null, 2) + '\n');
  const total = files.reduce((n, f) => n + f.size, 0);
  console.log(`${files.length} files, ${total} bytes -> ${out}`);
})().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
