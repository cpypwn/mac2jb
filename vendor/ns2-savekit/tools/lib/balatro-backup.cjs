'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw Error(message); };

function normalizeUid(value) {
  const uid = String(value || '').replace(/^0x/i, '').toLowerCase();
  check(/^[0-9a-f]{32}$/.test(uid) && !/^0+$/.test(uid),
    'A full, nonzero 16-byte account uid is required');
  return uid;
}

function safeSavePath(value) {
  return typeof value === 'string' && value.startsWith('/') && value !== '/' &&
    !value.endsWith('/') && !/[\\\0]/.test(value) &&
    !value.split('/').some(part => part === '.' || part === '..') &&
    path.posix.normalize(value) === value && Buffer.byteLength(value, 'utf8') < 0x301;
}

// Check parents too: lstat of the leaf alone does not detect a symlinked .lovegame.
async function plainPath(value, {allowMissing = false, kind = null} = {}) {
  const absolute = path.resolve(value);
  const base = path.parse(absolute).root;
  const parts = absolute.slice(base.length).split(path.sep).filter(Boolean);
  let current = base;
  let last;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try { last = await fs.lstat(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return absolute;
      throw error;
    }
    check(!last.isSymbolicLink(), 'Symlink paths are not accepted: ' + current);
    if (i < parts.length - 1) check(last.isDirectory(), 'Not a directory: ' + current);
  }
  if (kind === 'directory') check(last?.isDirectory(), 'Not a directory: ' + absolute);
  if (kind === 'file') check(last?.isFile(), 'Not a regular file: ' + absolute);
  return absolute;
}

async function loadBackup(directory, {titleId, uid} = {}) {
  const dir = await plainPath(directory, {kind: 'directory'});
  const manifestPath = await plainPath(path.join(dir, 'manifest.json'), {kind: 'file'});
  const raw = await fs.readFile(manifestPath);
  const manifest = JSON.parse(raw.toString('utf8'));
  check(manifest && !Array.isArray(manifest) && typeof manifest === 'object', 'Invalid backup manifest');
  check(manifest.programId === titleId, 'Backup belongs to a different title');
  const account = normalizeUid(manifest.uid);
  if (uid) check(account === normalizeUid(uid), 'Backup belongs to a different account');
  check(manifest.space === 1 && manifest.type === 1, 'Backup must be a User/Account save');
  check(manifest.partial === false && Array.isArray(manifest.failed) && manifest.failed.length === 0,
    'Backup is incomplete or does not prove a complete pull');
  check(Array.isArray(manifest.entries) && manifest.files === manifest.entries.length,
    'Backup file count is inconsistent');
  const byPath = new Map();
  let bytes = 0;
  for (const entry of manifest.entries) {
    check(entry && safeSavePath(entry.path) && entry.path !== '/manifest.json', 'Unsafe backup file path');
    check(!byPath.has(entry.path), 'Duplicate backup path: ' + entry.path);
    check(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 64 * 1024 * 1024,
      'Invalid backup file size: ' + entry.path);
    check(/^[0-9a-f]{64}$/.test(entry.sha256 || ''), 'Invalid backup hash: ' + entry.path);
    const filename = await plainPath(path.join(dir, entry.path.slice(1)), {kind: 'file'});
    const stat = await fs.stat(filename);
    check(stat.size === entry.size && sha256(await fs.readFile(filename)) === entry.sha256,
      'Backup bytes do not match the manifest: ' + entry.path);
    byPath.set(entry.path, {...entry});
    bytes += entry.size;
  }
  check(Number.isSafeInteger(bytes) && manifest.bytes === bytes, 'Backup byte count is inconsistent');
  // Do not let an unlisted local file become an unexpected writer precondition.
  async function inventory(parent, relative = '') {
    for (const item of await fs.readdir(parent, {withFileTypes: true})) {
      const rel = relative ? relative + '/' + item.name : item.name;
      check(!item.isSymbolicLink(), 'Backup contains a symlink: ' + rel);
      if (item.isDirectory()) await inventory(path.join(parent, item.name), rel);
      else check(item.isFile() && (rel === 'manifest.json' || byPath.has('/' + rel)),
        'Backup contains an unlisted or non-regular file: ' + rel);
    }
  }
  await inventory(dir);
  return {dir, manifest, manifestSha256: sha256(raw), entries: [...byPath.values()],
    byPath, uid: account, names: new Set(byPath.keys()), bytes};
}

function compareFiles(expected, actual, {absent = []} = {}) {
  const problems = [];
  for (const entry of expected) {
    const got = actual.byPath.get(entry.path);
    if (!got || got.size !== entry.size || got.sha256 !== entry.sha256)
      problems.push('Missing or changed ' + entry.path);
  }
  for (const filename of absent) if (actual.byPath.has(filename))
    problems.push('Launcher file is still present: ' + filename);
  return problems;
}

module.exports = {sha256, normalizeUid, safeSavePath, plainPath, loadBackup, compareFiles};
