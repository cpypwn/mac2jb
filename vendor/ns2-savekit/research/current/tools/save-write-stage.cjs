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
      '<backup-directory> <manifest.json> [--space N] [--type N] [--restore] [--confirm-restore]');
    process.exit(2);
  }
  // Space/type make this work outside User/Account (Sports Resort is a Device save);
  // --restore is what lets it put an older save back, which means replacing live bytes
  // that deliberately differ from the backup. That needs an explicit second flag.
  const flag = name => process.argv.includes(name);
  const option = name => {
    const at = process.argv.indexOf(name);
    if (at < 0) return null;
    const text = process.argv[at + 1];
    if (!/^[0-9]+$/.test(text || '')) throw Error(name + ' needs a number');
    return Number(text);
  };
  const space = option('--space') ?? 1;
  const type = option('--type') ?? 1;
  const restore = flag('--restore');
  if (restore) check(flag('--confirm-restore'),
    '--restore overwrites live save data; pass --confirm-restore after the backup');
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
    check(entry.path.startsWith('/') && !entry.path.includes('..') && !entry.path.includes('\0'),
      'Invalid save path: ' + entry.path);
    const rel = entry.path.slice(1);
    jobs.push({name: rel, path: entry.path, bytes, replace: entry.replace === true,
      local: path.join(verifyDirectory, rel)});
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
    const inBackup = await fs.stat(job.local).then(st => st.isFile()).catch(() => false);
    if (job.replace) {
      check(inBackup, 'Cannot replace ' + job.path +
        ': the backup does not contain a copy to compare');
    } else {
      check(!inBackup, 'Refusing to add ' + job.path + ': the backup already contains it');
    }
  }

  await request(current.socketPath, {command: 'root-native-info'});
  const s = new Session('save-write-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();

  const openSave = async command => {
    const input = Buffer.alloc(0x48);
    input[0] = space;                   // SaveDataSpaceId (1 User, 4 SdUser)
    input.writeBigUInt64LE(programId, 8);
    uid.copy(input, 0x10);
    input[0x28] = type;                 // SaveDataType (1 Account, 3 Device)
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
    for (const job of jobs) {
      const opened = await filesystem.openFile(s, save, job.path);
      const present = !opened.result;
      if (!present) {
        check(!job.replace, 'Cannot replace ' + job.path + ': it is not in the save');
        continue;
      }
      check(job.replace, 'Refusing to overwrite existing save file ' + job.path);
      // Replace-mode compares against the backup; restore-mode deliberately does not.
      check(!opened.result, 'Cannot open ' + job.path + ' to compare it');
      try {
        const size = Number(await filesystem.fileSize(s, opened.handle));
        const live = await filesystem.readFile(s, opened.handle, 0, size);
        const backup = await fs.readFile(job.local);
        if (restore) {
          // Say exactly what changes: with --restore this log line is the record of
          // the overwrite, and the caller's pre-restore backup is the way back.
          console.log('restore: ' + job.path + ' live ' + live.length + 'B ' +
            sha(live).slice(0, 16) + '... -> ' + backup.length + 'B ' +
            sha(backup).slice(0, 16) + '...');
        } else {
          check(sha(live) === sha(backup),
            'Live ' + job.path + ' differs from the backup; refusing to replace ' +
            '(use --restore --confirm-restore to put a backup back)');
          console.log('replace ok: live ' + job.path + ' matches the backup ('
            + sha(backup).slice(0, 16) + '...)');
        }
      } finally {
        await s.close(opened.handle).catch(() => {});
      }
    }
    console.log('pre-check ok: none of ' + jobs.map(j => j.name).join(', ') +
      ' exist; backup has ' + backupFiles.length + ' entries');
    await s.close(save); save = null;

    save = await openSave(51);
    // Parent directories first: Nora keeps /debug/lua/index.lua. Already-exists replies
    // are expected here; a real failure shows up on the file write itself.
    for (const job of jobs) {
      const parts = job.path.split('/').filter(Boolean);
      let prefix = '';
      for (let i = 0; i < parts.length - 1; i++) {
        prefix += '/' + parts[i];
        await filesystem.pathMethod(s, save, 1, prefix, Buffer.alloc(0)).catch(() => {});
      }
    }
    for (const job of jobs) {
      console.log('mounted read-write; writing', job.path, job.bytes.length,
        'bytes (sha256 ' + sha(job.bytes).slice(0, 16) + '...)');
      await writeFile(save, job.path, job.bytes);
    }
    const commit = await s.ipc('Commit save data filesystem', save, 10);
    console.log('commit ->', code(commit.result));
    check(!commit.result, 'Commit failed');
    await s.close(save); save = null;

    // Re-open read-only and verify by path: a nested file has to be read at its own
    // path, and this is the check that proves the committed bytes are readable.
    save = await openSave(53);
    let mismatches = 0;
    for (const job of jobs) {
      const opened = await filesystem.openFile(s, save, job.path);
      check(!opened.result, 'Verify could not open ' + job.path + ': ' + code(opened.result));
      const size = Number(await filesystem.fileSize(s, opened.handle));
      const bytes = await filesystem.readFile(s, opened.handle, 0, size);
      await s.close(opened.handle).catch(() => s.handles.delete(opened.handle));
      const got = sha(bytes);
      const ok = got === sha(job.bytes) && size === job.bytes.length;
      if (!ok) mismatches++;
      console.log('  ' + job.path.padEnd(30) + String(size).padStart(8) + '  ' +
        got.slice(0, 16) + '  ' + (ok ? 'ok' : 'MISMATCH'));
    }
    check(mismatches === 0, mismatches + ' file(s) did not read back as written');
  } finally {
    if (save !== null) await s.close(save).catch(() => s.handles.delete(save));
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
