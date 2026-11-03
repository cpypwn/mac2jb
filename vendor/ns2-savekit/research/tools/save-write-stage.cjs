#!/usr/bin/env node
// Add a set of new files to another title's save data in one transaction,
// (pid=1) fsp-srv root, flush it, commit the save, then re-open read-only and
// verify every file by hash.
//
//   node save-write-root.cjs <run-directory> <program-id> <uid-hex> \
//        <save-path> <local-file> [verify-directory]
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

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

const code = value => '0x' + (Number(value) & 0x3fffff).toString(16);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const u32 = value => {const b = Buffer.alloc(4); b.writeUInt32LE(value); return b;};
const u64 = value => {const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b;};
const check = (ok, message) => {if (!ok) throw Error(message);};

async function main() {
  const [runDirectory, programText, uidText, verifyDirectory, manifestPath] =
    process.argv.slice(2);
  if (!runDirectory || !programText || !uidText || !verifyDirectory || !manifestPath) {
    console.error('usage: node save-write-stage.cjs <run-directory> <program-id> <uid-hex> ' +
      '<backup-directory> <manifest.json>');
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
  const filesystem = require(path.join(engine, 'app/filesystem.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  const programId = BigInt(/^0x/i.test(programText) ? programText : '0x' + programText);
  const uid = Buffer.from(uidText.replace(/^0x/i, ''), 'hex');
  check(uid.length === 16, 'uid must be the raw 16-byte AccountUid');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  check(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest has no files');
  const jobs = [];
  for (const entry of manifest.files) {
    const bytes = await fs.readFile(entry.local);
    check(entry.path === '/' + path.posix.basename(entry.path) && !entry.path.includes('..'),
      'Only files directly under the save root are allowed: ' + entry.path);
    jobs.push({name: path.posix.basename(entry.path), path: entry.path, bytes,
      replace: entry.replace === true});
  }

  // --- guardrails: disposable titles only, user space only, add-only, backed up ---
  const WHITELIST = new Set([
    '010012900d38a000', // Nora to Oujo to Noraneko Heart 2 trial
    '010042d022aea000', // Seedsow Lullaby demo
    '0100ee5021c9e000', // Seedsow Lullaby (full)
    '01005eb012fe2000', // Wagamama High Spec trial
  ]);
  // Optional local allowlist; the built-in list stays as the floor.
  try {
    const extra = JSON.parse(require('node:fs').readFileSync(
      path.join(__dirname, '..', 'config', 'titles.json'), 'utf8'));
    for (const entry of extra.write || []) WHITELIST.add(String(entry.id).toLowerCase());
  } catch { /* no local allowlist: use the built-in one */ }
  const idText = programId.toString(16).padStart(16, '0');
  check(WHITELIST.has(idText),
    'Refusing to write to ' + idText + ': not a whitelisted disposable title');
  check(verifyDirectory, 'A backup directory is required (pass the earlier save-pull output)');
  const backupFiles = await fs.readdir(verifyDirectory).catch(() => []);
  check(backupFiles.length > 0, 'Backup directory is empty: ' + verifyDirectory);
  for (const job of jobs) {
    if (job.replace) {
      check(backupFiles.includes(job.name),
        'Cannot replace ' + job.name + ': the backup does not contain a copy to compare');
    } else {
      check(!backupFiles.includes(job.name),
        'Refusing to add ' + job.name + ': the backup already contains it');
    }
  }

  await request(current.socketPath, {command: 'root-native-info'});
  const s = new Session('save-write-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();

  const openSave = async command => {
    const input = Buffer.alloc(0x48);
    input[0] = 1;                       // SaveDataSpaceId_User
    input.writeBigUInt64LE(programId, 8);
    uid.copy(input, 0x10);
    input[0x28] = 1;                    // SaveDataType_Account
    const reply = await s.ipc(command === 51 ? 'Open save read-write' : 'Open save read-only',
      root, command, input);
    check(!reply.result && reply.moves.length === 1,
      'Save open failed: ' + code(reply.result));
    return reply.moves[0];
  };
  const createFile = async (handle, name, size) => {
    // CreateFile is a path method too, but the read-only helper rejects it, so
    // build the pointer-send-static packet here (same layout as pathMethod).
    const {packet} = require(path.join(run, 'shared/ipc.cjs'));
    const text = Buffer.from(name, 'utf8');
    check(name.startsWith('/') && text.length < 0x301, 'Invalid create path');
    const buffer = Buffer.alloc(0x304);
    text.copy(buffer);
    const address = s.base + 0x2000;
    await s.write(address, buffer);
    const input = Buffer.alloc(16);
    input.writeUInt32LE(0, 0);
    input.writeBigUInt64LE(BigInt(size), 8);
    const bytes = packet(0, input);
    const a = BigInt(address);
    bytes.writeUInt32LE((4 | 1 << 16) >>> 0);
    bytes.writeUInt32LE(Number(0x301n << 16n | (a >> 36n & 7n) << 6n |
      ((a >> 32n) & 15n) << 12n), 8);
    bytes.writeUInt32LE(Number(a & 0xffffffffn), 12);
    return domain.send(s, 'CreateFile ' + name, handle, bytes);
  };
  const writeFile = async (handle, name, bytes) => {
    let opened = await filesystem.pathMethod(s, handle, 8, name, u32(3));
    if (opened.result) {
      // A new file has to be created first; OpenFile does not create.
      check(Number(opened.canonicalResult) === 0x202,
        'OpenFile for write failed: ' + code(opened.result));
      const made = await createFile(handle, name, bytes.length);
      check(!made.result, 'CreateFile failed: ' + code(made.result) +
        (Number(made.result) === 0x2ee002
          ? ' (this ns2jb build lacks the pointer-descriptor patch in shared/ipc.cjs; see docs/PATCHED-ENGINE.md)'
          : ''));
      opened = await filesystem.pathMethod(s, handle, 8, name, u32(3));
      check(!opened.result, 'Reopen for write failed: ' + code(opened.result));
    }
    const file = domain.oneHandle(opened);
    try {
      let reply = await s.ipc('FileSetSize', file, 3, u64(bytes.length));
      check(!reply.result, 'SetSize failed: ' + code(reply.result));
      const buffer = s.base + 0x20000;
      for (let offset = 0; offset < bytes.length;) {
        const chunk = Math.min(0x40000, bytes.length - offset);
        await s.write(buffer, bytes.subarray(offset, offset + chunk));
        reply = await s.ipc('FileWrite', file, 1,
          Buffer.concat([u32(0), u32(0), u64(offset), u64(chunk)]),
          {send: [{address: buffer, size: chunk, mode: 1}]});
        check(!reply.result, 'Write failed: ' + code(reply.result));
        offset += chunk;
      }
      reply = await s.ipc('FileFlush', file, 2);
      check(!reply.result, 'Flush failed: ' + code(reply.result));
    } finally {
      await s.close(file).catch(() => s.handles.delete(file));
    }
  };

  let save = null;
  try {
    // Add-only: confirm the target does not already exist before opening read-write.
    save = await openSave(53);
    const existing = await filesystem.listDirectory(s, save, '/', 2048);
    for (const job of jobs) {
      const present = existing.find(entry => entry.name === job.name);
      if (!present) {
        check(!job.replace, 'Cannot replace ' + job.path + ': it is not in the save');
        continue;
      }
      check(job.replace, 'Refusing to overwrite existing save file ' + job.path);
      // Only replace a file that still matches the backup we were given.
      const opened = await filesystem.openFile(s, save, job.path);
      check(!opened.result, 'Cannot open ' + job.path + ' to compare it');
      try {
        const size = Number(await filesystem.fileSize(s, opened.handle));
        const live = await filesystem.readFile(s, opened.handle, 0, size);
        const backup = await fs.readFile(path.join(verifyDirectory, job.name));
        check(sha(live) === sha(backup),
          'Live ' + job.path + ' differs from the backup; refusing to replace');
        console.log('replace ok: live ' + job.path + ' matches the backup ('
          + sha(backup).slice(0, 16) + '...)');
      } finally {
        await s.close(opened.handle).catch(() => {});
      }
    }
    console.log('pre-check ok: none of ' + jobs.map(j => j.name).join(', ') +
      ' exist; backup has ' + backupFiles.length + ' entries');
    await s.close(save); save = null;

    save = await openSave(51);
    for (const job of jobs) {
      console.log('mounted read-write; writing', job.path, job.bytes.length,
        'bytes (sha256 ' + sha(job.bytes).slice(0, 16) + '...)');
      await writeFile(save, job.path, job.bytes);
    }
    const commit = await s.ipc('Commit save data filesystem', save, 10);
    console.log('commit ->', code(commit.result));
    check(!commit.result, 'Commit failed');
    await s.close(save); save = null;

    // Re-open read-only and verify. This releases the write mount and proves
    // the committed bytes are what a later reader will see.
    save = await openSave(53);
    const listing = await filesystem.listDirectory(s, save, '/', 2048);
    const expected = Object.fromEntries((await fs.readdir(verifyDirectory)).map(name =>
      [name, path.join(verifyDirectory, name)]));
    const written = Object.fromEntries(jobs.map(job => [job.name, sha(job.bytes)]));
    for (const entry of listing) {
      const opened = await filesystem.openFile(s, save, '/' + entry.name);
      if (opened.result) {
        // Directories cannot be opened as files; report and move on.
        console.log(`  ${entry.name.padEnd(14)} <not a file: ${code(opened.result)}>`);
        continue;
      }
      const size = Number(await filesystem.fileSize(s, opened.handle));
      const bytes = await filesystem.readFile(s, opened.handle, 0, size);
      await s.close(opened.handle).catch(() => s.handles.delete(opened.handle));
      let expectedHash = null;
      if (expected[entry.name]) expectedHash = sha(await fs.readFile(expected[entry.name]));
      const match = expectedHash ? (expectedHash === sha(bytes) ? 'ok' : 'DIFFERS') : 'n/a';
      const tag = written[entry.name]
        ? '(' + (written[entry.name] === sha(bytes) ? 'written ok' : 'WRITE MISMATCH') + ')'
        : '';
      console.log(`  ${entry.name.padEnd(14)} ${String(size).padStart(7)}  ${sha(bytes).slice(0, 16)}  ${tag} ${match}`);
    }
  } finally {
    if (save !== null) await s.close(save).catch(() => s.handles.delete(save));
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
