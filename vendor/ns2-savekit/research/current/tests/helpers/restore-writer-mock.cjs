#!/usr/bin/env node
'use strict';
// Faithful stand-in for the part of save-write-stage.cjs that reads the staged
// manifest: it resolves `entry.local` relative to the child process cwd, reads
// the bytes and checks size + sha256. Used to prove the restore writer is
// invoked with the staging directory as its cwd.
const fs = require('node:fs');
const crypto = require('node:crypto');

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('usage: restore-writer-mock.cjs <manifest.json>');
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const files = [];
let failed = 0;
for (const entry of manifest.files) {
  try {
    const bytes = fs.readFileSync(entry.local);
    const ok = bytes.length === entry.size && sha256(bytes) === entry.sha256;
    files.push({path: entry.path, local: entry.local, size: bytes.length, ok});
    if (!ok) failed++;
  } catch (error) {
    files.push({path: entry.path, local: entry.local, error: error.code});
    failed++;
  }
}
console.log(JSON.stringify({cwd: process.cwd(), manifestPath, files}));
process.exit(failed ? 3 : 0);
