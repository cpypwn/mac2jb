'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {validateModsFolder, modsFolderFromCommand, stage, installArguments, modloaderHost} = require('./gui-modloader.cjs');
const {modSourceForRun, stagedEntries, createSdTransport, uploadSelectedMods} =
  require('./gui-modloader-sd.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-modloader-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const run = path.join(root, 'switch2-test'), mods = path.join(root, 'mods');
  fs.mkdirSync(run, {mode: 0o700});
  fs.mkdirSync(path.join(mods, 'contents', '0400f5802371e000', 'romfs'), {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(mods, 'contents', '0400f5802371e000', 'romfs', 'test.bin'), 'mod data');
  return {root, run, mods};
}

test('stages only a validated unpacked mod tree beside the held run', t => {
  const {run, mods} = fixture(t);
  assert.equal(validateModsFolder(mods), mods);
  const result = stage(run, mods);
  assert.deepEqual(result.games, ['0400f5802371e000']);
  assert.equal(result.patches, 0);
  assert.equal(fs.readFileSync(path.join(result.staging, 'contents', '0400f5802371e000', 'romfs', 'test.bin'), 'utf8'), 'mod data');
  assert.equal(fs.existsSync(path.join(result.staging, 'install.cjs')), true);
  assert.equal(fs.existsSync(path.join(result.staging, 'native', 'prebuilt', 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(result.staging, 'vendor', 'OunceCake', 'engine', 'session.cjs')), true);
  assert.equal(fs.existsSync(path.join(result.staging, 'vendor', 'OunceCake', 'LICENSE')), true);
  assert.equal(typeof require(path.join(result.staging, 'lib', 'game-files', 'session.cjs')).attachGame,
    'function');
  assert.equal(fs.existsSync(path.join(result.staging, 'state')), false);
  assert.equal(path.dirname(result.staging), run);
});

test('SD install stages the runtime without uploading Mac mods or overriding the SD root', t => {
  const {run} = fixture(t);
  assert.equal(modsFolderFromCommand({source: 'sd'}), null);
  const staged = stage(run, null);
  assert.deepEqual(staged.games, []);
  assert.equal(staged.patches, 0);
  assert.equal(fs.existsSync(path.join(staged.staging, 'install.cjs')), true);
  assert.equal(fs.existsSync(path.join(staged.staging, 'contents')), false);
  assert.equal(fs.existsSync(path.join(staged.staging, 'exefs_patches')), false);
  assert.deepEqual(installArguments(staged.staging, run),
    [path.join(staged.staging, 'install.cjs'), '--run-dir', run]);
  assert.equal(require('../integrations/ns2jb-modloader/install.cjs').options([]).modSource,
    '/ns2jb-modloader');
  assert.throws(() => modsFolderFromCommand({source: 'sd', modsFolder: '/tmp/mods'}),
    /does not use a Mac mod folder/);
});

test('Mac upload remains an explicit secondary mod source', t => {
  const {run, mods} = fixture(t);
  assert.equal(modsFolderFromCommand({source: 'mac', modsFolder: mods}), mods);
  const staged = stage(run, mods);
  const source = '/ns2jb-modloader/switch2-test/upload';
  assert.deepEqual(installArguments(staged.staging, run, source),
    [path.join(staged.staging, 'install.cjs'), '--run-dir', run, '--mod-source', source]);
  assert.throws(() => modsFolderFromCommand({source: 'mac'}), /unpacked mod folder/);
});

test('uploads selected mods to a private SD session and verifies readback', async t => {
  const {run, mods} = fixture(t);
  const staged = stage(run, mods);
  const source = modSourceForRun(run, staged.staging);
  assert.match(source, /^\/ns2jb-modloader\/switch2-test\/[A-Za-z0-9_-]+$/);
  const rows = stagedEntries(staged.staging, source);
  assert.deepEqual(rows.filter(row => row.type === 'file').map(row => row.remote),
    [source + '/contents/0400f5802371e000/romfs/test.bin']);
  const directories = new Set(), files = new Map(), createdDirectories = [];
  let created = 0, written = 0, closed = 0;
  const factory = async selectedRun => {
    assert.equal(selectedRun, run);
    return {
      type: async remote => directories.has(remote) ? 'directory' :
        files.has(remote) ? 'file' : 'missing',
      mkdir: async remote => {
        const parent = path.posix.dirname(remote);
        assert.ok(parent === '/' || directories.has(parent), 'Missing SD parent for ' + remote);
        directories.add(remote);
        createdDirectories.push(remote);
      },
      create: async (remote, size) => {files.set(remote, Buffer.alloc(size)); created++;},
      write: async (remote, local, size) => {
        const bytes = fs.readFileSync(local);
        assert.equal(bytes.length, size);
        files.set(remote, bytes);
        written++;
      },
      digest: async (remote, size) => {
        assert.equal(files.get(remote)?.length, size);
        return crypto.createHash('sha256').update(files.get(remote)).digest('hex');
      },
      close: async () => {closed++;}
    };
  };
  assert.deepEqual(await uploadSelectedMods(run, staged.staging, factory), {source, files: 1});
  assert.deepEqual(createdDirectories.slice(0, 3),
    ['/ns2jb-modloader', '/ns2jb-modloader/switch2-test', source]);
  assert.deepEqual(await uploadSelectedMods(run, staged.staging, factory), {source, files: 1});
  assert.equal(created, 1);
  assert.equal(written, 1);
  assert.equal(closed, 2);
  files.set(rows.find(row => row.type === 'file').remote, Buffer.from('bad data'));
  await assert.rejects(uploadSelectedMods(run, staged.staging, factory), /readback hash differs/);
  assert.equal(written, 1);
  assert.equal(closed, 3);
});

test('rejects unsafe session names and changed staged files before SD access', async t => {
  const {run, mods} = fixture(t);
  const staged = stage(run, mods);
  assert.throws(() => modSourceForRun('/tmp/a.b', staged.staging), /Invalid modloader session/);
  const local = path.join(staged.staging, 'contents', '0400f5802371e000', 'romfs', 'test.bin');
  fs.rmSync(local);
  fs.symlinkSync(path.join(mods, 'contents', '0400f5802371e000', 'romfs', 'test.bin'), local);
  await assert.rejects(uploadSelectedMods(run, staged.staging, async () => {
    assert.fail('SD transport opened for an invalid staged file');
  }), /staged mod changed/);
});

test('does not replay an interrupted SD write', async t => {
  const {run, mods} = fixture(t);
  const staged = stage(run, mods);
  let writes = 0, closed = 0;
  await assert.rejects(uploadSelectedMods(run, staged.staging, async () => ({
    type: async () => 'missing',
    mkdir: async () => {},
    create: async () => {},
    write: async () => {writes++; throw Error('Memory request timed out');},
    digest: async () => assert.fail('Readback followed an interrupted write'),
    close: async () => {closed++;}
  })), /timed out/);
  assert.equal(writes, 1);
  assert.equal(closed, 1);
});

test('SD transport writes 256 KiB chunks, flushes, and reads every byte back', async t => {
  const {run, mods} = fixture(t);
  const local = path.join(mods, 'contents', '0400f5802371e000', 'romfs', 'test.bin');
  const bytes = crypto.randomBytes(0x80011);
  fs.writeFileSync(local, bytes);
  const staged = stage(run, mods);
  const memory = new Map(), directories = new Set(), files = new Map();
  const writes = [];
  let flushed = 0, closed = 0;
  const base = 0x100000;
  const fake = {
    root: 'root',
    s: {
      base,
      async write(address, data) {memory.set(String(address), Buffer.from(data));},
      async ipc(label, handle, command, input, options) {
        if (command === 18 && handle === 'root') return {result: 0, handle: 'sd'};
        const remote = String(handle).slice('write:'.length);
        if (command === 1) {
          const offset = Number(input.readBigUInt64LE(8));
          const size = Number(input.readBigUInt64LE(16));
          assert.ok(size <= 0x40000);
          const chunk = memory.get(String(options.send[0].address));
          assert.equal(chunk.length, size);
          chunk.copy(files.get(remote), offset);
          writes.push(size);
          return {result: 0};
        }
        if (command === 2) {flushed++; return {result: 0};}
        assert.fail('Unexpected SD IPC command ' + command);
      },
      async close() {}
    },
    domain: {
      oneHandle: result => result.handle,
      async send(s, label, handle, packet) {
        assert.equal(handle, 'sd');
        const command = Number(label.slice(label.lastIndexOf(' ') + 1));
        const remote = memory.get(String(base + 0x2000)).toString('utf8').split('\0')[0];
        if (command === 7) {
          if (directories.has(remote) || files.has(remote)) {
            const data = Buffer.alloc(4);
            data.writeUInt32LE(directories.has(remote) ? 0 : 1);
            return {result: 0, data};
          }
          return {result: 0x202, canonicalResult: 0x202};
        }
        if (command === 2) {directories.add(remote); return {result: 0};}
        if (command === 0) {
          files.set(remote, Buffer.alloc(Number(packet.readBigUInt64LE(40))));
          return {result: 0};
        }
        if (command === 8) return {result: 0, handle: 'write:' + remote};
        assert.fail('Unexpected SD path command ' + command);
      }
    },
    filesystem: {
      openFile: async (s, sd, remote) => ({result: 0, handle: 'read:' + remote}),
      fileSize: async (s, handle) => BigInt(files.get(handle.slice('read:'.length)).length),
      readFile: async (s, handle, offset, size) =>
        files.get(handle.slice('read:'.length)).subarray(offset, offset + size)
    },
    async close() {closed++;}
  };
  const upload = await uploadSelectedMods(run, staged.staging,
    selectedRun => createSdTransport(selectedRun, async () => fake));
  assert.equal(upload.files, 1);
  assert.deepEqual(writes, [0x40000, 0x40000, 0x11]);
  assert.equal(flushed, 1);
  assert.equal(closed, 1);
  assert.deepEqual(files.get(upload.source + '/contents/0400f5802371e000/romfs/test.bin'), bytes);
});

test('refuses a linked top-level contents folder', t => {
  const {root, mods} = fixture(t);
  fs.renameSync(path.join(mods, 'contents'), path.join(root, 'external'));
  fs.symlinkSync(path.join(root, 'external'), path.join(mods, 'contents'));
  assert.throws(() => validateModsFolder(mods), /real directory/);
});

test('refuses a dangling top-level mod link', t => {
  const {mods} = fixture(t);
  fs.symlinkSync(path.join(mods, 'missing'), path.join(mods, 'exefs_patches'));
  assert.throws(() => validateModsFolder(mods), /real directory/);
});

test('refuses a linked file inside a mod and unrelated runtime components', t => {
  const {root, mods} = fixture(t);
  const romfs = path.join(mods, 'contents', '0400f5802371e000', 'romfs');
  fs.symlinkSync(path.join(root, 'outside'), path.join(romfs, 'linked.bin'));
  assert.throws(() => validateModsFolder(mods), /regular files and directories/);
  fs.unlinkSync(path.join(romfs, 'linked.bin'));
  fs.mkdirSync(path.join(mods, 'contents', '0400f5802371e000', 'plugins'));
  assert.throws(() => validateModsFolder(mods), /Unsupported component/);
});

test('refuses empty folders before creating a stage', t => {
  const {run, mods} = fixture(t);
  fs.rmSync(path.join(mods, 'contents'), {recursive: true});
  assert.throws(() => stage(run, mods), /No supported mods found/);
  assert.deepEqual(fs.readdirSync(run), []);
});

test('accepts a prepared CivSwitch FS run only with a matching target and source digest', async () => {
  const result = {directory:'/staged/engine/runs/switch2-test',connection:{addresses:{target:'civ7'}}};
  const report = {target:'civ7',sourceSha256:'pinned-source'};
  let verified = 0;
  const verify = async (root, run) => {
    assert.equal(root, null);
    assert.equal(run, result.directory);
    verified++;
    return {target:'civ7',sourceSha256:'pinned-source'};
  };
  assert.equal(await modloaderHost('/runtime', result, report, verify), 'civ7');
  assert.equal(verified, 1);
  await assert.rejects(modloaderHost('/runtime', result, {...report,target:'switch2'}, verify), /unexpected target/);
  assert.equal(verified, 1);
  await assert.rejects(modloaderHost('/runtime', result, report,
    async () => ({target:'civ7',sourceSha256:'different-source'})), /does not match/);
});

test('preserves pinned ns2jb hosts and rejects unknown targets', async () => {
  const profile = require('./host-profiles.cjs').profiles.find(row => row.supportsModloader);
  assert.ok(profile);
  const result = {directory:'/run',connection:{addresses:{target:'switch2'}}};
  assert.equal(await modloaderHost('/runtime', result,{sourceSha256:profile.sourceSha256}), 'switch2');
  await assert.rejects(modloaderHost('/runtime', result,{target:'civ7',sourceSha256:profile.sourceSha256}),
    /verified ns2jb or CivSwitch FS/);
  await assert.rejects(modloaderHost('/runtime',
    {directory:'/run',connection:{addresses:{target:'unknown'}}},{sourceSha256:profile.sourceSha256}),
    /verified ns2jb or CivSwitch FS/);
});
