#!/usr/bin/env node
'use strict';

// Delete only launcher files whose current contents match a fresh backup manifest.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { TITLE_ID, INSTALL_PATHS } = require('./lib/balatro-release.cjs');
const { hashFile } = require('./lib/verified-file-hash.cjs');
const { exitForErrorText } = require('./lib/delete-result.cjs');

const NOT_FOUND = 0x202;
const MAX_FILE_SIZE = 64 * 1024 * 1024;
const allowedPaths = new Set(INSTALL_PATHS);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const hex = value => '0x' + value.toString(16);

function validateManifest(manifest, uid, confirm) {
  check(confirm === true, 'Removal requires --confirm');
  check(typeof uid === 'string' && /^[0-9a-f]{32}$/i.test(uid) && !/^0+$/.test(uid),
    'UID must be exactly 32 hexadecimal characters and nonzero');
  check(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Invalid removal manifest');
  check(manifest.programId === TITLE_ID, 'Unsupported program ID in removal manifest');
  check(typeof manifest.uid === 'string' && /^[0-9a-f]{32}$/i.test(manifest.uid) &&
    manifest.uid.toLowerCase() === uid.toLowerCase(), 'Removal manifest UID does not match');
  check(manifest.space === 1 && manifest.type === 1, 'Only account saves in space 1 are supported');
  check(Array.isArray(manifest.files) && manifest.files.length <= INSTALL_PATHS.length, 'Invalid removal manifest files');
  const seen = new Set();
  return manifest.files.map(entry => {
    check(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid removal manifest entry');
    check(typeof entry.path === 'string' && allowedPaths.has(entry.path), 'Unsupported removal path: ' + String(entry.path));
    check(!seen.has(entry.path), 'Duplicate removal path: ' + entry.path);
    seen.add(entry.path);
    check(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_FILE_SIZE,
      'Invalid file size for ' + entry.path);
    check(typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256),
      'Invalid SHA-256 for ' + entry.path);
    return { path: entry.path, size: entry.size, sha256: entry.sha256.toLowerCase() };
  });
}

// Do not coerce missing or malformed results into success. Zero is success only
// when the actual raw result is zero; only the canonical FS not-found result is
// resumable. A bare 0x2 is not FS not-found.
function resultCode(response, operation) {
  check(response && Number.isInteger(response.result) && response.result >= 0 &&
    response.result <= 0xffffffff, operation + ' returned an invalid result');
  if (response.canonicalResult !== undefined) {
    check(Number.isInteger(response.canonicalResult) && response.canonicalResult >= 0 &&
      response.canonicalResult <= 0x3fffff &&
      response.canonicalResult === (response.result & 0x3fffff),
    operation + ' returned an invalid canonical result');
  }
  if (response.result === 0) return 0;
  const canonical = response.result & 0x3fffff;
  check(canonical !== 0, operation + ' returned an invalid success result');
  return canonical;
}

function fileHandle(response, operation) {
  check(Number.isInteger(response.handle) && response.handle > 0,
    operation + ' returned an invalid file handle');
  return response.handle;
}

function boundedSize(value, name) {
  if (typeof value === 'bigint') {
    check(value >= 0n && value <= BigInt(MAX_FILE_SIZE), 'Invalid save file size for ' + name);
    return Number(value);
  }
  check(Number.isSafeInteger(value) && value >= 0 && value <= MAX_FILE_SIZE,
    'Invalid save file size for ' + name);
  return value;
}

async function removeTransaction({ session, filesystem, openSave, deleteFile, manifest, uid, confirm }) {
  const entries = validateManifest(manifest, uid, confirm);
  if (entries.length === 0) return { removed: 0, alreadyAbsent: 0, verifiedAbsent: 0 };
  const present = [];
  let alreadyAbsent = 0;
  const readSave = await openSave(53);
  try {
    for (const entry of entries) {
      const operation = 'OpenFile ' + entry.path;
      const opened = await filesystem.openFile(session, readSave, entry.path);
      const result = resultCode(opened, operation);
      if (result === NOT_FOUND) { alreadyAbsent++; continue; }
      check(result === 0, operation + ' failed: ' + hex(result));
      const handle = fileHandle(opened, operation);
      try {
        const size = boundedSize(await filesystem.fileSize(session, handle), entry.path);
        check(size === entry.size, 'File changed since backup (size): ' + entry.path);
        const actual = await hashFile(session, filesystem, handle, size);
        check(actual === entry.sha256, 'File changed since backup (SHA-256): ' + entry.path);
        present.push(entry);
      } finally {
        await session.close(handle);
      }
    }
  } finally {
    // A failed close aborts before the writable mount is acquired.
    await session.close(readSave);
  }

  let removed = 0;
  if (present.length > 0) {
    const writeSave = await openSave(51);
    try {
      for (const entry of present) {
        const result = resultCode(await deleteFile(writeSave, entry.path), 'DeleteFile ' + entry.path);
        check(result === 0 || result === NOT_FOUND, 'DeleteFile ' + entry.path + ' failed: ' + hex(result));
        if (result === 0) removed++;
        else alreadyAbsent++;
      }
      if (removed > 0) {
        const result = resultCode(await session.ipc('Commit save data filesystem', writeSave, 10), 'Commit');
        check(result === 0, 'Commit failed: ' + hex(result));
      }
    } finally {
      await session.close(writeSave);
    }
  }

  const verifySave = await openSave(53);
  try {
    for (const entry of entries) {
      const operation = 'Verify absence ' + entry.path;
      const opened = await filesystem.openFile(session, verifySave, entry.path);
      const result = resultCode(opened, operation);
      if (result === 0) {
        await session.close(fileHandle(opened, operation));
        throw new Error('File still present after removal: ' + entry.path);
      }
      check(result === NOT_FOUND, operation + ' failed: ' + hex(result));
    }
  } finally {
    await session.close(verifySave);
  }
  return { removed, alreadyAbsent, verifiedAbsent: entries.length };
}

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(120000, () => socket.destroy(new Error('memory request timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', part => { input += part; });
    socket.on('end', () => {
      try {
        const result = JSON.parse(input);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  check(argv.length === 4 && argv[3] === '--confirm',
    'Usage: node tools/balatro-remove.cjs <run> <uid> <manifest.json> --confirm');
  const [runDirectory, uidText, manifestPath] = argv;
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const entries = validateManifest(manifest, uidText, true);
  if (entries.length === 0) {
    console.log(JSON.stringify({ removed: 0, alreadyAbsent: 0, verifiedAbsent: 0 }));
    return;
  }
  const run = path.resolve(runDirectory);
  const engine = path.join(run, 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const rootProof = JSON.parse(await fs.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  check(rootProof.session === current.session && rootProof.pid === 1 && rootProof.rootHandle,
    'The run has no promoted fsp-srv root');
  const root = rootProof.rootHandle;
  const { Session } = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  const { packet } = require(path.join(run, 'shared/ipc.cjs'));
  const filesystem = require(path.join(engine, 'app/filesystem.cjs'));
  const programId = BigInt('0x' + TITLE_ID);
  const uid = Buffer.from(uidText, 'hex');
  await request(current.socketPath, { command: 'root-native-info' });
  const session = new Session('balatro-remove-' + Date.now(), 0x80000);
  session.record = async () => {};
  try {
    await session.initialize();
    const openSave = async command => {
      const input = Buffer.alloc(0x48);
      input[0] = 1;
      input.writeBigUInt64LE(programId, 8);
      uid.copy(input, 0x10);
      input[0x28] = 1;
      const opened = await session.ipc(command === 51 ? 'Open save read-write' : 'Open save read-only', root, command, input);
      const result = resultCode(opened, 'Open save');
      check(result === 0 && Array.isArray(opened.moves) && opened.moves.length === 1,
        'Save open failed: ' + hex(result));
      check(Number.isInteger(opened.moves[0]) && opened.moves[0] > 0, 'Save open returned an invalid handle');
      return opened.moves[0];
    };
    const deleteFile = async (handle, name) => {
      check(allowedPaths.has(name), 'Unsupported removal path: ' + name);
      const buffer = Buffer.alloc(0x304);
      Buffer.from(name, 'utf8').copy(buffer);
      const address = session.base + 0x2000;
      await session.write(address, buffer);
      const bytes = packet(1, Buffer.alloc(0));
      const a = BigInt(address);
      bytes.writeUInt32LE((4 | 1 << 16) >>> 0);
      bytes.writeUInt32LE(Number(0x301n << 16n | (a >> 36n & 7n) << 6n |
        ((a >> 32n) & 15n) << 12n), 8);
      bytes.writeUInt32LE(Number(a & 0xffffffffn), 12);
      return domain.send(session, 'DeleteFile ' + name, handle, bytes);
    };
    const result = await removeTransaction({ session, filesystem, openSave, deleteFile, manifest, uid: uidText, confirm: true });
    console.log(JSON.stringify(result));
  } finally {
    await session.cleanup();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || String(error));
    process.exitCode = exitForErrorText(String(error.message || error));
  });
}

module.exports = { validateManifest, removeTransaction, resultCode, main };
