'use strict';
// Integrity checks for a save backup produced by tools/save-pull-root.cjs.
//
// Every write and every restore in the Artemis installer is authorized by a
// backup, so "the directory exists" is not enough: the manifest must be
// complete, every entry must be present and hash to what it claims, and the
// backup must identify the save archive it came from. A corrupt or partial
// backup is refused before any console operation.
//
// Nothing here opens a console. It is pure filesystem + JSON validation so the
// rules can be tested offline and reused by stage/install/verify/restore.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

// Save paths are flat ("/name"): the writers create only the root, and this
// mirrors the reject rule in save-write-stage.cjs. A nested path in a manifest
// is a signal that the manifest is not ours, not a feature to support.
function safeSavePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  if (value.length > 0x300) return false;
  if (value.includes('\0') || value.includes('..') || value.includes('//')) return false;
  if (value === '/') return false;
  return true;
}

function parseArchive(text) {
  if (typeof text !== 'string') return null;
  const out = {};
  for (const pair of text.split(/\s+/)) {
    const match = /^([a-z]+)=(.+)$/i.exec(pair);
    if (match) out[match[1].toLowerCase()] = match[2];
  }
  return Object.keys(out).length ? out : null;
}

// Returns {ok, problems, notes, dir, manifest, entries, names, bytes,
//          manifestSha256, identity, archive}
// `requireIdentity` demands the full program id and 32-hex account uid that a
// current pull records. Older manifests carry only the truncated `archive`
// string, which is explicitly NOT accepted as identity (a truncated uid cannot
// distinguish two accounts that share a prefix).
async function validateBackup(directory, options = {}) {
  const trigger = options.trigger || 'save9999.dat';
  const problems = [];
  const notes = [];
  const result = {ok: false, dir: null, manifest: null, entries: [], names: new Set(),
    bytes: 0, manifestSha256: null, identity: null, archive: null, problems, notes};
  if (!directory) {
    problems.push('no backup directory given');
    return result;
  }
  const dir = path.resolve(directory);
  result.dir = dir;

  let stat;
  try {
    stat = await fsp.lstat(dir);
  } catch (error) {
    problems.push('backup does not exist: ' + dir);
    return result;
  }
  if (stat.isSymbolicLink()) {
    problems.push('backup path is a symlink, refusing to trust it: ' + dir);
    return result;
  }
  if (!stat.isDirectory()) {
    problems.push('backup is not a directory: ' + dir);
    return result;
  }

  let raw;
  try {
    raw = await fsp.readFile(path.join(dir, 'manifest.json'));
  } catch {
    problems.push('backup has no manifest.json (use save-pull-root.cjs): ' + dir);
    return result;
  }
  result.manifestSha256 = sha256(raw);
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    problems.push('backup manifest.json is not valid JSON: ' + dir);
    return result;
  }
  result.manifest = manifest;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    problems.push('backup manifest is not an object');
    return result;
  }
  if (manifest.partial === true) {
    problems.push('backup is marked partial:true - an incomplete pull cannot authorize a restore');
  }
  if (Array.isArray(manifest.failed) && manifest.failed.length) {
    problems.push('backup records ' + manifest.failed.length +
      ' file(s) that failed to pull; refusing an incomplete backup');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    problems.push('backup manifest has no entries');
    return result;
  }
  if (manifest.files !== undefined && manifest.files !== manifest.entries.length) {
    problems.push('manifest files=' + manifest.files + ' but lists ' +
      manifest.entries.length + ' entries');
  }

  const seen = new Set();
  let total = 0;
  for (const [index, entry] of manifest.entries.entries()) {
    const where = 'entry ' + index + (entry && entry.path ? ' (' + entry.path + ')' : '');
    if (!entry || typeof entry !== 'object') { problems.push(where + ' is not an object'); continue; }
    if (!safeSavePath(entry.path)) { problems.push(where + ' has an unsafe save path'); continue; }
    if (seen.has(entry.path)) { problems.push(where + ' is a duplicate path'); continue; }
    seen.add(entry.path);
    if (!Number.isInteger(entry.size) || entry.size < 0) {
      problems.push(where + ' has an invalid size');
    } else {
      total += entry.size;
    }
    if (!HEX64.test(String(entry.sha256 || ''))) {
      problems.push(where + ' has no valid sha256');
    }
  }
  if (manifest.bytes !== undefined && manifest.bytes !== total) {
    problems.push('manifest bytes=' + manifest.bytes + ' but entry sizes sum to ' + total);
  }
  if (problems.length) return result;

  // The files themselves, not just the manifest. lstat every entry so a symlink
  // cannot substitute a file that lives outside the backup.
  for (const entry of manifest.entries) {
    const file = path.join(dir, entry.path.slice(1));
    let st;
    try {
      st = await fsp.lstat(file);
    } catch {
      problems.push('missing backup file ' + entry.path);
      continue;
    }
    if (st.isSymbolicLink()) { problems.push('backup file is a symlink ' + entry.path); continue; }
    if (!st.isFile()) { problems.push('backup entry is not a regular file ' + entry.path); continue; }
    if (st.size !== entry.size) {
      problems.push('backup file size mismatch ' + entry.path + ' (' + st.size +
        ' != ' + entry.size + ')');
      continue;
    }
    const got = sha256(await fsp.readFile(file));
    if (got !== entry.sha256) {
      problems.push('backup file sha256 mismatch ' + entry.path + ' (' + got.slice(0, 16) +
        '… != ' + String(entry.sha256).slice(0, 16) + '…)');
    }
  }

  const names = new Set(manifest.entries.map(entry => entry.path));
  result.names = names;
  result.entries = manifest.entries;
  result.bytes = total;
  if (!names.has('/' + trigger)) {
    problems.push('backup has no /' + trigger + ' suspend file, so it cannot authorize a write');
  }

  // Identity: only the full fields count. `archive` is kept for display.
  const programId = String(manifest.programId || manifest.titleId || '').toLowerCase()
    .replace(/^0x/, '');
  const uid = String(manifest.uid || '').toLowerCase().replace(/^0x/, '');
  result.archive = parseArchive(manifest.archive);
  if (HEX16.test(programId) && HEX32.test(uid)) {
    result.identity = {programId, uid};
  } else {
    notes.push('backup predates full identity fields (programId/uid); only its ' +
      'truncated archive label is available');
  }
  if (options.requireIdentity) {
    if (!result.identity) {
      problems.push('backup does not record the full account uid and program id; ' +
        'identity cannot be established from it');
    } else {
      if (options.titleId && result.identity.programId !== String(options.titleId).toLowerCase()) {
        problems.push('backup is for program ' + result.identity.programId +
          ', not ' + options.titleId);
      }
      if (options.uid && result.identity.uid !== String(options.uid).toLowerCase()) {
        problems.push('backup is for account ' + result.identity.uid.slice(0, 8) +
          '…, not the requested account');
      }
    }
  }

  result.ok = problems.length === 0;
  return result;
}

function describeBackup(backup) {
  const ident = backup.identity
    ? 'program ' + backup.identity.programId + ', account ' + backup.identity.uid.slice(0, 8) + '…'
    : 'identity not recorded (legacy pull)';
  return `${backup.entries.length} files, ${backup.bytes} bytes, ${ident}, manifest ${backup.manifestSha256.slice(0, 16)}…`;
}

module.exports = {validateBackup, describeBackup, safeSavePath, parseArchive, sha256,
  HEX64, HEX32, HEX16};
