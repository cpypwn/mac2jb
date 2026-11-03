#!/usr/bin/env node
const fs = require('node:fs/promises');
const {createReadStream} = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {classifyFsResult, decideDelete} = require('./lib/delete-result.cjs');
const {walk} = require('./lib/save-tree.cjs');

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(120000, () => socket.destroy(new Error('memory request timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', part => {input += part;});
    socket.on('end', () => {
      try {
        const result = JSON.parse(input);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) {reject(error);}
    });
  });
}

const code = value => '0x' + (Number(value) & 0x3fffff).toString(16);
const check = (ok, message) => {if (!ok) throw Error(message);};
const safeRootName = name => typeof name === 'string' && name &&
  name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') &&
  !/[\x00-\x1f\x7f]/.test(name) && Buffer.byteLength(name) < 0x300;
const safeSavePath = name => typeof name === 'string' && name.startsWith('/') &&
  name !== '/' && name === path.posix.normalize(name) &&
  Buffer.byteLength(name) < 0x301 && name.split('/').slice(1).every(safeRootName);

async function hashFile(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function verifyBackupFiles(directory, manifest) {
  check(manifest.partial !== true &&
    (manifest.failed === undefined || Array.isArray(manifest.failed) && manifest.failed.length === 0) &&
    Number.isSafeInteger(manifest.files) && manifest.files > 0 &&
    manifest.files <= 65536 && Array.isArray(manifest.entries) &&
    manifest.entries.length === manifest.files,
  'The backup is partial or incomplete');
  const info = await fs.lstat(directory);
  check(info.isDirectory() && !info.isSymbolicLink(), 'The backup folder is invalid');
  const root = await fs.realpath(directory);
  const seen = new Set();
  let bytes = 0;
  for (const entry of manifest.entries) {
    check(entry && safeSavePath(entry.path) && !seen.has(entry.path) &&
      Number.isSafeInteger(entry.size) && entry.size >= 0 &&
      /^[a-f0-9]{64}$/.test(entry.sha256), 'The backup manifest has an invalid file');
    seen.add(entry.path);
    const file = path.join(directory, entry.path.slice(1));
    const stat = await fs.lstat(file);
    const resolved = await fs.realpath(file);
    check(stat.isFile() && !stat.isSymbolicLink() &&
      resolved.startsWith(root + path.sep) && stat.size === entry.size &&
      await hashFile(file) === entry.sha256,
    'The backup file failed SHA-256 verification: ' + entry.path);
    bytes += stat.size;
    check(Number.isSafeInteger(bytes), 'The backup size is invalid');
  }
  if (manifest.bytes !== undefined)
    check(manifest.bytes === bytes, 'The backup byte count differs from its manifest');
}

function assertMatchingFiles(expected, actual) {
  const before = new Map(expected.map(entry => [entry.path, entry]));
  check(before.size === expected.length && actual.length === expected.length,
    'The live save file list differs from the backup');
  const seen = new Set();
  for (const entry of actual) {
    check(entry && !seen.has(entry.path), 'The live save repeats a file path');
    seen.add(entry.path);
    const backedUp = before.get(entry.path);
    check(backedUp && backedUp.size === entry.size && backedUp.sha256 === entry.sha256,
      'The live save differs from the backup: ' + entry.path);
  }
}

function assertPreservedFiles(expected, actual, deletedPath) {
  const before = new Map();
  const after = new Map();
  for (const entry of expected) {
    check(typeof entry.path === 'string' && entry.path.startsWith('/') &&
      entry.path.split('/').slice(1).every(safeRootName) &&
      Number.isSafeInteger(entry.size) && entry.size >= 0 &&
      /^[a-f0-9]{64}$/.test(entry.sha256) && !before.has(entry.path),
    'The backup manifest contains an invalid or repeated file');
    before.set(entry.path, entry);
  }
  check(before.has(deletedPath), 'The backup has no selected file');
  for (const entry of actual) {
    check(!after.has(entry.path), 'The live save repeats a file path');
    after.set(entry.path, entry);
  }
  check(!after.has(deletedPath), 'The deleted file is still present after commit');
  check(after.size === before.size - 1, 'Other save files changed after deletion');
  for (const [name, entry] of before) {
    if (name === deletedPath) continue;
    const current = after.get(name);
    check(current && current.size === entry.size && current.sha256 === entry.sha256,
      'Another save file changed after deletion: ' + name);
  }
}

async function main() {
  const [runDirectory, programText, uidText, savePath, backupDirectory] = process.argv.slice(2);
  if (!runDirectory || !programText || !uidText || !savePath || !backupDirectory) {
    console.error('usage: node save-delete-root.cjs <run-directory> <program-id> <uid-hex> <save-path> <backup-directory>');
    process.exit(2);
  }
  const run = path.resolve(runDirectory);
  const engine = path.join(run, 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const rootProof = JSON.parse(await fs.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  check(rootProof.session === current.session && rootProof.pid === 1 && rootProof.rootHandle,
    'The run has no promoted fsp-srv root');
  const root = rootProof.rootHandle;
  const {Session} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  const filesystem = require(path.join(engine, 'app/filesystem.cjs'));
  const {packet} = require(path.join(run, 'shared/ipc.cjs'));
  check(/^(?:0x)?[a-f0-9]{16}$/i.test(programText), 'Program ID must be 16 hexadecimal digits');
  check(/^(?:0x)?[a-f0-9]{32}$/i.test(uidText), 'Account ID must be 32 hexadecimal digits');
  const programId = BigInt(/^0x/i.test(programText) ? programText : '0x' + programText);
  const uid = Buffer.from(uidText.replace(/^0x/i, ''), 'hex');
  const id = programId.toString(16).padStart(16, '0');
  check(savePath?.startsWith('/') && safeRootName(savePath.slice(1)),
    'Only one file at the save root can be deleted');
  const backupManifest = JSON.parse(await fs.readFile(path.join(backupDirectory, 'manifest.json'), 'utf8'));
  const backupEntry = Array.isArray(backupManifest.entries)
    ? backupManifest.entries.find(entry => entry.path === savePath) : null;
  const backupId = backupManifest.titleId ?? backupManifest.programId;
  const selected = backupManifest.selection ?? {space: backupManifest.space,
    type: backupManifest.type, rank: backupManifest.rank, index: backupManifest.index,
    staticId: 0, uid: backupManifest.uid};
  check(backupId === id && selected.space === 1 &&
    selected.type === 1 && selected.rank === 0 &&
    selected.index === 0 && selected.staticId === 0 &&
    selected.uid === uid.toString('hex') &&
    backupManifest.archive === 'space=User type=Account rank=0 index=0 uid=' +
      uid.toString('hex').slice(0, 16) && Array.isArray(backupManifest.entries) &&
    backupEntry?.sha256, 'The backup does not prove the selected title, file and account');
  if (Object.hasOwn(backupManifest, 'titleId') && Object.hasOwn(backupManifest, 'programId'))
    check(backupManifest.titleId === backupManifest.programId,
      'The backup has conflicting program IDs');
  for (const [key, value] of Object.entries({programId: id,
    uid: uid.toString('hex'), space: 1, type: 1, rank: 0, index: 0}))
    if (Object.hasOwn(backupManifest, key))
      check(backupManifest[key] === value, 'The backup has conflicting ' + key + ' fields');
  await verifyBackupFiles(backupDirectory, backupManifest);

  await request(current.socketPath, {command: 'root-native-info'});
  const s = new Session('save-delete-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();

  const pathCall = async (handle, command, name) => {
    const text = Buffer.from(name, 'utf8');
    check(name.startsWith('/') && safeRootName(name.slice(1)) && text.length < 0x301,
      'Invalid delete path');
    const buffer = Buffer.alloc(0x304);
    text.copy(buffer);
    const address = s.base + 0x2000;
    await s.write(address, buffer);
    const bytes = packet(command, Buffer.alloc(0));
    const a = BigInt(address);
    bytes.writeUInt32LE((4 | 1 << 16) >>> 0);
    bytes.writeUInt32LE(Number(0x301n << 16n | (a >> 36n & 7n) << 6n |
      ((a >> 32n) & 15n) << 12n), 8);
    bytes.writeUInt32LE(Number(a & 0xffffffffn), 12);
    return domain.send(s, 'DeleteFile ' + name, handle, bytes);
  };

  let save = null;
  try {
    const liveFileHash = async (handle, filePath) => {
      const file = await filesystem.openFile(s, handle, filePath);
      check(!file.result, 'A save file is missing: ' + filePath);
      try {
        const size = Number(await filesystem.fileSize(s, file.handle));
        check(Number.isSafeInteger(size) && size >= 0, 'Invalid save file size: ' + filePath);
        const digest = crypto.createHash('sha256');
        for (let offset = 0; offset < size;) {
          const data = await filesystem.readFile(s, file.handle, offset,
            Math.min(0x40000, size - offset));
          check(data.length > 0, 'Short save file read: ' + filePath);
          digest.update(data);
          offset += data.length;
        }
        return {path: filePath, size, sha256: digest.digest('hex')};
      } finally {await s.close(file.handle).catch(() => s.handles.delete(file.handle));}
    };
    const liveFiles = async handle => {
      const found = [];
      await walk(handle, '/', {
        list: (save, folder, limit) => filesystem.listDirectory(s, save, folder, limit)
      }, {
        file: async name => { found.push(await liveFileHash(handle, name)); }
      });
      return found;
    };
    const input = Buffer.alloc(0x48);
    input[0] = 1;
    input.writeBigUInt64LE(programId, 8);
    uid.copy(input, 0x10);
    input[0x28] = 1;
    let opened = await s.ipc('Open save read-only', root, 53, input);
    check(!opened.result && opened.moves.length === 1, 'Save read-only open failed: ' + code(opened.result));
    save = opened.moves[0];
    assertMatchingFiles(backupManifest.entries, await liveFiles(save));
    await s.close(save); save = null;
    opened = await s.ipc('Open save read-write', root, 51, input);
    check(!opened.result && opened.moves.length === 1, 'Save open failed: ' + code(opened.result));
    save = opened.moves[0];
    assertMatchingFiles(backupManifest.entries, await liveFiles(save));
    const reply = await pathCall(save, 1, savePath);
    const deleteResult = Number(reply.canonicalResult ?? reply.result) & 0x3fffff;
    console.log('delete', savePath, '->', code(deleteResult));
    check(classifyFsResult(deleteResult) === 'deleted',
      'Delete failed: ' + code(deleteResult));
    const commit = await s.ipc('Commit save data filesystem', save, 10);
    console.log('commit ->', code(commit.result));
    check(decideDelete({fsResult: deleteResult,
      commitResult: Number(commit.result)}).reason !== 'commit-failed', 'Commit failed');
    await s.close(save); save = null;
    opened = await s.ipc('Open save read-only', root, 53, input);
    check(!opened.result && opened.moves.length === 1, 'Save verification open failed: ' + code(opened.result));
    save = opened.moves[0];
    const listing = await liveFiles(save);
    assertPreservedFiles(backupManifest.entries, listing, savePath);
    console.log('verified deleted ' + savePath + ' after commit');
  } finally {
    if (save !== null) await s.close(save).catch(() => s.handles.delete(save));
    await s.cleanup().catch(() => {});
  }
}

module.exports = {safeRootName, assertPreservedFiles, assertMatchingFiles, verifyBackupFiles};
if (require.main === module)
  main().catch(error => {console.error('FAILED:', error.message); process.exit(1);});
