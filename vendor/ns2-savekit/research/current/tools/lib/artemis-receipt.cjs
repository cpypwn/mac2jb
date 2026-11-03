'use strict';
// Installation records for the Artemis Launcher installer.
//
// There are two kinds, deliberately separate:
//
//   ORIGINAL   the state before the *first* Artemis install. Written once and
//              never replaced: it is the rollback baseline.
//   TRANSACTION one install/update/restore attempt. Updates and restores write
//              a new transaction; they never touch the original.
//
// Keeping one receipt per title/account (the first design) meant a reinstall
// overwrote the only record of the pre-install state, so "rollback" could only
// return to a post-install backup. This layout keeps the baseline immutable.
//
// Records are local state, never committed: they contain the full account uid.
//   ~/.local/state/ns2-savekit/artemis-launcher/
//     receipts/<title>-<tag>.original.json
//     receipts/<title>-<tag>.transactions/<timestamp>-<random>.json
//     receipts/<title>-<tag>.json            (legacy single receipt, read-only)
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const VERSION = 1;
const KIND_ORIGINAL = 'ns2-savekit/artemis-launcher-original';
const KIND_TRANSACTION = 'ns2-savekit/artemis-launcher-transaction';
const KIND_RECEIPT = 'ns2-savekit/artemis-launcher-receipt'; // first design
const STATUSES = new Set(['installing', 'installed', 'install-failed', 'restoring', 'restored',
  'restore-failed']);

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

function stateRoot() {
  return process.env.ARTEMIS_STATE ||
    path.join(os.homedir(), '.local', 'state', 'ns2-savekit', 'artemis-launcher');
}

function receiptDir() {
  return path.join(stateRoot(), 'receipts');
}

function baseName(titleId, uid) {
  const id = String(titleId).toLowerCase();
  const account = String(uid).toLowerCase();
  if (!HEX16.test(id) || !HEX32.test(account)) throw Error('receipt path needs a title id and uid');
  const tag = sha256(Buffer.from(id + ':' + account)).slice(0, 16);
  return id + '-' + tag;
}

// The legacy single file kept for reading installs made before the split.
function receiptPath(titleId, uid) {
  return path.join(receiptDir(), baseName(titleId, uid) + '.json');
}

function originalPath(titleId, uid) {
  return path.join(receiptDir(), baseName(titleId, uid) + '.original.json');
}

function transactionDir(titleId, uid) {
  return path.join(receiptDir(), baseName(titleId, uid) + '.transactions');
}

function transactionPath(titleId, uid, id) {
  const safe = String(id || '').replace(/[^0-9A-Za-z._-]/g, '');
  if (!safe) throw Error('transaction id is empty');
  return path.join(transactionDir(titleId, uid), safe + '.json');
}

async function readJson(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('receipt is not valid JSON: ' + file), {code: 'ERECEIPT'});
  }
}

const readReceipt = (titleId, uid) => readJson(receiptPath(titleId, uid));
const readOriginal = (titleId, uid) => readJson(originalPath(titleId, uid));

// Atomic write-then-link: `link` fails if the destination exists, so an
// original record can never be replaced by a later install. 0600 because the
// account uid is inside.
async function writeImmutable(file, record) {
  await fsp.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  await fsp.writeFile(temp, JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  try {
    await fsp.link(temp, file);
  } catch (error) {
    await fsp.rm(temp, {force: true});
    if (error.code === 'EEXIST') {
      throw Object.assign(new Error('refusing to replace the immutable original record: ' + file), {
        code: 'EIMMUTABLE',
      });
    }
    throw error;
  }
  await fsp.rm(temp, {force: true});
  return file;
}

async function writeTransaction(record) {
  const file = transactionPath(record.title.id, record.account.uid, record.id);
  await fsp.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  await fsp.writeFile(temp, JSON.stringify(record, null, 2) + '\n', {mode: 0o600});
  await fsp.rename(temp, file);
  return file;
}

// The first design wrote one mutable receipt here; kept for reading old installs.
async function writeReceipt(receipt) {
  const file = receiptPath(receipt.title.id, receipt.account.uid);
  await fsp.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  await fsp.writeFile(temp, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600});
  await fsp.rename(temp, file);
  return file;
}

function transactionId(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-') +
    '-' + crypto.randomBytes(3).toString('hex');
}

async function listTransactions(titleId, uid) {
  let names;
  try {
    names = await fsp.readdir(transactionDir(titleId, uid));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(transactionDir(titleId, uid), name), 'utf8')));
    } catch { /* an unreadable transaction is ignored, not trusted */ }
  }
  return out;
}

async function latestTransaction(titleId, uid, predicate = () => true) {
  const list = (await listTransactions(titleId, uid)).filter(predicate);
  return list.length ? list[list.length - 1] : null;
}

function commonProblems(record, {titleId, uid, commit, launcherFiles, trigger} = {}) {
  const problems = [];
  if (!record || typeof record !== 'object') return ['record is empty'];
  if (record.version !== VERSION) problems.push('unsupported record version ' + record.version);
  if (!record.title || !HEX16.test(String(record.title.id || ''))) {
    problems.push('record has no valid title id');
  } else if (titleId && record.title.id !== String(titleId).toLowerCase()) {
    problems.push('record is for ' + record.title.id + ', not ' + titleId);
  }
  if (!record.account || !HEX32.test(String(record.account.uid || ''))) {
    problems.push('record has no full account uid');
  } else if (uid && record.account.uid !== String(uid).toLowerCase()) {
    problems.push('record is for a different account');
  }
  if (!record.upstream || !HEX40.test(String(record.upstream.commit || ''))) {
    problems.push('record has no upstream commit');
  } else if (commit && record.upstream.commit !== commit) {
    problems.push('record was made for upstream ' + record.upstream.commit.slice(0, 12) +
      '…, not the pinned ' + commit.slice(0, 12) + '…');
  }
  if (!record.backup || !HEX64.test(String(record.backup.manifestSha256 || ''))) {
    problems.push('record has no backup manifest hash');
  }
  if (!Array.isArray(record.installed) || record.installed.length === 0) {
    problems.push('record lists no installed files');
    return problems;
  }
  const allowed = new Set([...(launcherFiles || []), trigger || 'save9999.dat'].map(n => '/' + n));
  const seen = new Set();
  for (const entry of record.installed) {
    if (!entry || typeof entry !== 'object') { problems.push('record entry is not an object'); continue; }
    if (!allowed.has(entry.path)) { problems.push('record lists an unexpected path ' + entry.path); continue; }
    if (seen.has(entry.path)) { problems.push('record lists ' + entry.path + ' twice'); continue; }
    seen.add(entry.path);
    if (!HEX64.test(String(entry.sha256 || ''))) problems.push('entry ' + entry.path + ' has no sha256');
    if (entry.kind !== 'add' && entry.kind !== 'replace') {
      problems.push('entry ' + entry.path + ' has kind ' + entry.kind);
    }
    if (entry.kind === 'replace' && !HEX64.test(String(entry.originalSha256 || ''))) {
      problems.push('replace entry ' + entry.path + ' has no original sha256');
    }
  }
  if (!seen.has('/' + (trigger || 'save9999.dat'))) {
    problems.push('record does not include the boot trigger');
  }
  return problems;
}

function validateOriginal(record, options = {}) {
  const problems = commonProblems(record, options);
  if (record && record.kind !== KIND_ORIGINAL) problems.push('not an original installation record');
  if (record && record.status !== 'original') problems.push('original record has status ' + record.status);
  return problems;
}

function validateTransaction(record, options = {}) {
  const problems = commonProblems(record, options);
  if (record && record.kind !== KIND_TRANSACTION) problems.push('not a transaction record');
  if (record && !STATUSES.has(record.status)) problems.push('unknown transaction status');
  if (record && !record.originalSha256) problems.push('transaction does not link the original record');
  if (record && !record.preState) problems.push('transaction has no pre-state');
  return problems;
}

// The first design's receipt becomes the original baseline. Its data is
// copied, never re-derived: this is an adoption, not a new estimate.
function adoptLegacyReceipt(legacy, {now = new Date().toISOString(), launcherFiles = null} = {}) {
  const problems = commonProblems(legacy, {
    titleId: legacy && legacy.title && legacy.title.id,
    uid: legacy && legacy.account && legacy.account.uid,
    commit: legacy && legacy.upstream && legacy.upstream.commit,
    launcherFiles,
    trigger: 'save9999.dat',
  });
  if (problems.length) return {problems};
  return {
    problems: [],
    record: {
      ...legacy,
      kind: KIND_ORIGINAL,
      status: 'original',
      origin: 'legacy-receipt',
      adoptedAt: now,
      createdAt: legacy.createdAt || now,
      updatedAt: now,
    },
  };
}

module.exports = {
  VERSION, KIND_ORIGINAL, KIND_TRANSACTION, KIND_RECEIPT, STATUSES,
  stateRoot, receiptDir, receiptPath, originalPath, transactionDir, transactionPath,
  readReceipt, readOriginal, writeReceipt, writeImmutable, writeTransaction,
  transactionId, listTransactions, latestTransaction,
  validateOriginal, validateTransaction, adoptLegacyReceipt, sha256,
};
