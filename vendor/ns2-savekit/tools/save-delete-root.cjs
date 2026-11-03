#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

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
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const safeRootName = name => typeof name === 'string' && name &&
  name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') &&
  !/[\x00-\x1f\x7f]/.test(name) && Buffer.byteLength(name) < 0x300;

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
  const backupEntry = backupManifest.entries?.find(entry => entry.path === savePath);
  check(backupManifest.titleId === id && backupManifest.selection?.space === 1 &&
    backupManifest.selection?.type === 1 && backupManifest.selection?.rank === 0 &&
    backupManifest.selection?.index === 0 && backupManifest.selection?.staticId === 0 &&
    backupManifest.selection?.uid === uid.toString('hex') &&
    backupManifest.archive === 'space=User type=Account rank=0 index=0 uid=' +
      uid.toString('hex').slice(0, 16) && Array.isArray(backupManifest.entries) &&
    backupEntry?.sha256, 'The backup does not prove the selected title, file and account');
  const backup = await fs.readFile(path.join(backupDirectory, savePath.slice(1)));
  check(backup.length === backupEntry.size && sha(backup) === backupEntry.sha256,
    'The backup file failed SHA-256 verification');

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
    const liveFiles = async (handle, folder = '/') => {
      const found = [];
      for (const entry of await filesystem.listDirectory(s, handle, folder, 2048)) {
        check(safeRootName(entry.name), 'The live save has an unsafe file name');
        const name = (folder === '/' ? '' : folder) + '/' + entry.name;
        const file = await filesystem.openFile(s, handle, name);
        if (!file.result) {
          await s.close(file.handle).catch(() => s.handles.delete(file.handle));
          found.push(await liveFileHash(handle, name));
        } else found.push(...await liveFiles(handle, name));
      }
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
    const preflight = await liveFileHash(save, savePath);
    check(preflight.size === backupEntry.size && preflight.sha256 === backupEntry.sha256,
      'The live file changed after the backup');
    await s.close(save); save = null;
    opened = await s.ipc('Open save read-write', root, 51, input);
    check(!opened.result && opened.moves.length === 1, 'Save open failed: ' + code(opened.result));
    save = opened.moves[0];
    const beforeDelete = await liveFileHash(save, savePath);
    check(beforeDelete.size === backupEntry.size && beforeDelete.sha256 === backupEntry.sha256,
      'The live file changed before deletion on the write mount');
    const reply = await pathCall(save, 1, savePath);
    console.log('delete', savePath, '->', code(reply.canonicalResult ?? reply.result));
    check(!reply.result, 'Delete failed: ' + code(reply.result));
    const commit = await s.ipc('Commit save data filesystem', save, 10);
    console.log('commit ->', code(commit.result));
    check(!commit.result, 'Commit failed');
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

module.exports = {safeRootName, assertPreservedFiles};
if (require.main === module)
  main().catch(error => {console.error('FAILED:', error.message); process.exit(1);});
