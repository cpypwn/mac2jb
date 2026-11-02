#!/usr/bin/env node
// Pull another title's save data through the exploit's promoted (pid=1) fsp-srv
// root, enumerating account uids with the CMIF pointer-buffer ListAllUsers call.
//
//   node save-pull-root.cjs <run-directory> <program-id> <output-directory> [uid-hex]
//        [--space N] [--type N] [--rank N] [--index N] [--static-id N]
//        [--all] [--list-only] [--list-uids] [--keep-open]
//
// Why the promoted root: a normal application session gets FS 6400
// (PermissionDenied) for another title's save. The exploit already promotes the
// cached PID of its dedicated fsp-srv root (ro/root/current-root.json, pid 1),
// which passes fsp-srv's save-data access check. Read-only command 53 is used
// so the save is never modified; it is closed before the process exits.
//
// A title can own more than one archive. The default sweep stops at the first
// that opens: Account saves per user, then the common uid 0, then Device/Bcat/
// Cache/Temporary (attribute all-zero except Type). --all keeps going and pulls
// every archive into its own subdirectory. It is opt-in because a long sweep is
// what wedges a session (docs/RESULTS.md).
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {build, openCommand, plan} = require('./lib/save-attr.cjs');

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
const SPACES = {0: 'System', 1: 'User', 2: 'SdSystem', 3: 'Temporary', 4: 'SdUser',
  100: 'ProperSystem', 101: 'SafeMode', 102: 'ProperUser'};
const TYPES = {0: 'System', 1: 'Account', 2: 'Bcat', 3: 'Device', 4: 'Temporary',
  5: 'Cache', 6: 'SystemBcat', 7: 'StreamPlay'};

const uidLabel = uid => uid.toString('hex').slice(0, 16);
const archiveText = archive => `space=${SPACES[archive.space] ?? archive.space} ` +
  `type=${TYPES[archive.type] ?? archive.type} rank=${archive.rank} index=${archive.index} ` +
  `uid=${uidLabel(archive.uid)}`;
const archiveDir = archive => `archive-space${archive.space}-type${archive.type}` +
  `-rank${archive.rank}-index${archive.index}-${uidLabel(archive.uid).slice(0, 8)}`;

async function main() {
  const argv = process.argv.slice(2);
  // `known` is what exists; `given` is what was passed. Testing membership of the
  // known set made every boolean flag true on every run (a pull that only listed uids
  // and exited 0), which is what made pull-all report six archives with no files.
  const known = new Set(['--list-only', '--list-uids', '--keep-open', '--filetime', '--all']);
  const given = new Set(argv.filter(a => known.has(a)));
  const valued = ['--space', '--type', '--rank', '--index', '--static-id'];
  const value = {};
  const optionValue = name => {
    const at = argv.indexOf(name);
    if (at < 0) return undefined;
    const text = argv[at + 1];
    if (!/^[0-9]+$/.test(text)) throw Error(name + ' needs a number');
    return Number(text);
  };
  for (const name of valued) value[name] = optionValue(name);
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg) && !valued.includes(arg))
      throw Error('unknown option ' + arg);
  }
  const positional = argv.filter((arg, i) =>
    !known.has(arg) && !valued.includes(arg) && !(i > 0 && valued.includes(argv[i - 1])));
  const [runDirectory, programText, outputDirectory, forcedUid] = positional;
  if (!runDirectory || !programText || !outputDirectory) {
    console.error('usage: node save-pull-root.cjs <run-directory> <program-id> <output-directory> ' +
      '[uid-hex] [--space N] [--type N] [--rank N] [--index N] [--static-id N] ' +
      '[--all] [--list-only]');
    process.exit(2);
  }
  const listOnly = given.has('--list-only');
  const listUids = given.has('--list-uids');
  const keepOpen = given.has('--keep-open');
  const all = given.has('--all');
  if (value['--space'] !== undefined && value['--space'] > 255) throw Error('--space is a u8');
  if (value['--type'] !== undefined && value['--type'] > 255) throw Error('--type is a u8');
  if (value['--rank'] !== undefined && value['--rank'] > 1) throw Error('--rank is 0 (Primary) or 1 (Secondary)');
  if (value['--index'] !== undefined && value['--index'] > 0xffff) throw Error('--index is a u16');
  const run = path.resolve(runDirectory);
  const engine = path.join(run, 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const rootProof = JSON.parse(await fs.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  if (rootProof.session !== current.session || rootProof.pid !== 1 || !rootProof.rootHandle)
    throw Error('The run has no promoted fsp-srv root (expected pid 1)');
  const root = rootProof.rootHandle;
  const {Session, u64} = require(path.join(engine, 'app/session.cjs'));
  const filesystem = require(path.join(engine, 'app/filesystem.cjs'));
  const programId = BigInt(/^0x/i.test(programText) ? programText : '0x' + programText);

  await request(current.socketPath, {command: 'root-native-info'});
  const s = new Session('save-pull-root-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();

  // Raw 16-byte AccountUid values. Do not round-trip them through BigInt hex:
  // an AccountUid is two little-endian u64s, so the numeric hex is byte-swapped.
  const uids = [];
  try {
    const acc = await s.openService('acc:u0');
    const init = await s.ipc('acc InitializeApplicationInfo', acc, 140, u64(0), {pid: true});
    if (init.result) throw Error('acc:u0 initialization failed: ' + code(init.result));
    const at = s.base + 0x3000;
    await s.write(at, Buffer.alloc(0x80));
    const listed = await s.ipc('ListAllUsers', acc, 2, Buffer.alloc(0),
      {pointers: {receive: [{address: at, size: 0x80}]}});
    if (listed.result) throw Error('ListAllUsers failed: ' + code(listed.result));
    const bytes = await s.read(at, 0x80);
    for (let i = 0; i < 0x80 / 16; i++) {
      const uid = bytes.subarray(i * 16, (i + 1) * 16);
      if (uid.some(byte => byte !== 0)) uids.push(uid);
    }
    console.error('account users:', uids.length);
  } catch (error) {
    console.error('account enumeration failed:', error.message);
  }
  if (listUids) {
    for (const uid of uids) console.log(uid.toString('hex'));
    await s.cleanup().catch(() => {});
    return;
  }
  if (forcedUid) uids.splice(0, uids.length, Buffer.from(forcedUid.replace(/^0x/i, ''), 'hex'));
  if (uids.some(uid => uid.length !== 16)) throw Error('uid must be 16 raw bytes');

  const spaces = value['--space'] === undefined ? [1, 4] : [value['--space']];
  const types = value['--type'] === undefined ? [1, 3, 2, 5, 4] : [value['--type']];
  const ranks = value['--rank'] === undefined ? (all ? [0, 1] : [0]) : [value['--rank']];
  const index = value['--index'] === undefined ? 0 : value['--index'];
  const staticId = value['--static-id'] === undefined ? 0 : value['--static-id'];
  // uid 0 is savecommon for Account saves and the documented shape for Device/
  // Bcat/Cache; plan() orders it correctly and dedupes an explicit zero uid.
  const candidates = plan({spaces, types, ranks, index, staticId, uids, all});
  if (all) console.error('--all: probing every selected space/type/rank/user; ' +
    'narrow with --space/--type if the session drops');

  const archives = [];
  let openHandle = null;
  try {
    for (const candidate of candidates) {
      const referenceId = candidate.type === 0 || candidate.type === 6 ? 0n : programId;
      const input = build({...candidate, referenceId});
      const reply = await s.ipc('Open save data (read-only)', root,
        openCommand(candidate.type), input);
      console.error(`  ${archiveText(candidate)} -> ${reply.result ? code(reply.result) : 'ok'}`);
      if (reply.result || reply.moves.length !== 1) continue;
      archives.push({handle: reply.moves[0], ...candidate});
      if (!all) break;
    }
    if (archives.length === 0) {
      throw Error('No save filesystem opened for 0x' + programId.toString(16) +
        ' (tried ' + candidates.length + ' attribute combinations)');
    }

    if (given.has('--filetime')) {
      if (archives.length !== 1)
        throw Error('--filetime needs exactly one archive; add --space/--type/--rank');
      openHandle = archives[0].handle;
      // Probe IFileSystem's timestamp command: same technique that found the
      // working save-info reader (try the plausible shapes, print each result).
      const {packet} = require(path.join(run, 'shared/ipc.cjs'));
      const domain = require(path.join(engine, 'app/domain.cjs'));
      const out = s.base + 0x6000;
      const pathAddr = s.base + 0x2000;
      const target = process.env.FTIMEPATH || '/account.sav';
      for (const outSize of [8, 0x10, 0x18, 0x20, 0x28]) {
        for (const [variant, pathSize] of [['exact', Buffer.byteLength(target) + 1],
                                            ['padded', 0x301]]) {
          const buf = Buffer.alloc(0x304);
          Buffer.from(target).copy(buf);
          await s.write(pathAddr, buf);
          await s.write(out, Buffer.alloc(0x40));
          const bytes = packet(12, Buffer.alloc(0), {pointers: {
            send: [{address: pathAddr, size: pathSize}],
            receive: [{address: out, size: outSize}]}});
          try {
            const reply = await domain.send(s, 'filetime', openHandle, bytes);
            const result = Number(reply.result) & 0x3fffff;
            const data = result ? null : await s.read(out, outSize);
            console.log(`12 out=${outSize} path=${variant} -> 0x${result.toString(16)}` +
              (data ? '  ' + data.toString('hex') : ''));
          } catch (error) {
            console.log(`12 out=${outSize} path=${variant} -> threw ${error.message}`);
          }
        }
      }
      return;
    }

    async function show(save, directory, state) {
      const entries = await filesystem.listDirectory(s, save, directory, 2048);
      for (const entry of entries) {
        const full = (directory.endsWith('/') ? directory : directory + '/') + entry.name;
        const opened = await filesystem.openFile(s, save, full);
        if (!opened.result) {
          const size = Number(await filesystem.fileSize(s, opened.handle));
          await s.close(opened.handle).catch(() => s.handles.delete(opened.handle));
          console.log(`${String(size).padStart(9)}  ${full}`);
          if (state.stampTargets.length < 8) state.stampTargets.push(full);
          state.count += 1; state.total += size;
        } else {
          console.log(`${'<dir>'.padStart(9)}  ${full}/`);
          await show(save, full, state);
        }
      }
    }

    async function newestStamp(save, targets) {
      // Newest write time, if the filesystem exposes GetFileTimeStampRaw (cmd 12).
      let newest = 0;
      try {
        const {packet} = require(path.join(run, 'shared/ipc.cjs'));
        const {u64} = require(path.join(engine, 'app/session.cjs'));
        const domain = require(path.join(engine, 'app/domain.cjs'));
        const out = s.base + 0x6000;
        for (const full of targets) {
          const text = Buffer.from(full, 'utf8');
          if (text.length >= 0x301) continue;
          const pathBuf = Buffer.alloc(0x304);
          text.copy(pathBuf);
          await s.write(s.base + 0x2000, pathBuf);
          const bytes = packet(12, Buffer.alloc(0), {pointers: {
            send: [{address: s.base + 0x2000}],
            receive: [{address: out, size: 0x20}],
          }});
          const reply = await domain.send(s, 'GetFileTimeStampRaw ' + full, save, bytes)
            .catch(() => null);
          if (!reply || reply.result) continue;
          const raw = await s.read(out, 0x20);
          const value = Number(raw.readBigUInt64LE(0));
          if (value > newest) newest = value;
        }
      } catch { /* timestamps are optional */ }
      return newest;
    }

    async function walk(save, directory, disk, state) {
      const entries = await filesystem.listDirectory(s, save, directory, 2048);
      await fs.mkdir(disk, {recursive: true});
      for (const entry of entries) {
        const full = (directory.endsWith('/') ? directory : directory + '/') + entry.name;
        const target = path.join(disk, entry.name);
        const opened = await filesystem.openFile(s, save, full);
        if (!opened.result) {
          const size = Number(await filesystem.fileSize(s, opened.handle));
          const file = await fs.open(target, 'w');
          // Hash while copying: the console already proves each chunk against a hash it
          // computed, and this local digest makes the pulled archive verifiable later
          // (tools/verify-save-manifest.cjs) without trusting the transfer.
          const hash = crypto.createHash('sha256');
          let offset = 0;
          while (offset < size) {
            const chunk = Math.min(0x40000, size - offset);
            const data = await filesystem.readFile(s, opened.handle, offset, chunk);
            if (!data.length) throw Error('Short read at ' + full + ' +' + offset);
            await file.write(data);
            hash.update(data);
            offset += data.length;
          }
          await file.close();
          await s.close(opened.handle).catch(() => s.handles.delete(opened.handle));
          state.files += 1; state.bytes += size;
          (state.entries ||= []).push({path: full, size, sha256: hash.digest('hex')});
          console.error(`  ${full} (${size} bytes)`);
        } else {
          await walk(save, full, target, state);
        }
      }
    }

    for (const archive of archives) {
      openHandle = archive.handle;
      console.error(`mounted ${archiveText(archive)}`);
      if (listOnly) {
        if (all) console.log(`archive ${archiveText(archive)}`);
        const state = {count: 0, total: 0, stampTargets: []};
        await show(openHandle, '/', state);
        const newest = await newestStamp(openHandle, state.stampTargets);
        console.log(`listed ${state.count} files, ${state.total} bytes` +
          (newest ? `, newest ${Math.floor(newest / 1000000000)}` : '') +
          ' (read-only, nothing written)');
      } else {
        const target = all ? path.join(outputDirectory, archiveDir(archive)) : outputDirectory;
        const state = {files: 0, bytes: 0, entries: []};
        await walk(openHandle, '/', target, state);
        await fs.writeFile(path.join(target, 'manifest.json'),
          JSON.stringify({archive: archiveText(archive), files: state.files,
            bytes: state.bytes, entries: state.entries}, null, 2) + '\n');
        console.error(`done: ${state.files} files, ${state.bytes} bytes -> ${target}`);
      }
      if (!keepOpen) {
        await s.close(openHandle).catch(() => s.handles.delete(openHandle));
        openHandle = null;
      }
    }
  } finally {
    if (keepOpen) {
      console.error('--keep-open: leaving the save mounted and the session alive');
      return;
    }
    if (openHandle !== null) await s.close(openHandle).catch(() => s.handles.delete(openHandle));
    await s.cleanup().catch(() => {});
  }
}

const SESSION_LOST = /transport (?:failed )?(0xf601|62977)/i;
const NO_HOST = /ENOENT.*memory\.sock/i;
function fail(error) {
  if (NO_HOST.test(error.message || '')) {
    console.error('');
    console.error('NO LIVE HOST - that run directory has no host attached.');
    console.error('Start one with: node ~/ns2jb-rpc/run.cjs --rpc <this-mac-ip>');
    console.error('Then use the run folder it prints.');
    process.exit(4);
  }
  if (SESSION_LOST.test(error.message || '')) {
    console.error('');
    console.error('SESSION LOST - the console stopped answering this session.');
    console.error('Close SmileBASIC on the console, reopen it, run the bootstrap, then');
    console.error('start a new host (run.cjs) and retry. Nothing was changed on the save.');
    process.exit(3);
  }
  console.error('FAILED:', error.message);
  process.exit(1);
}

main().catch(fail);
