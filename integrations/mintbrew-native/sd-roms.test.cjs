'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {validSDRomFolder, compatibleINES, readMacRoms, readSDRoms, stageApps} =
  require('./sd-roms.cjs');

function rom() {
  const bytes = Buffer.alloc(16 + 16384);
  Buffer.from([0x4e, 0x45, 0x53, 0x1a]).copy(bytes);
  bytes[4] = 1;
  return bytes;
}

function fixture(t, files = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-sd-rom-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const entries = Object.entries(files).map(([name, bytes]) => ({name, type: 'file', size: bytes.length}));
  const calls = [];
  const session = {base: 0x2000, handles: new Set([2]), threads: new Set()};
  const attachment = {s: session, async close() {
    calls.push('attachment-close'); session.base = 0; session.handles.clear();
  }};
  const storage = {mounts: ['sd'],
    async list(folder) {
      calls.push('list:' + folder);
      if (folder === '/sd') return [{name: 'roms', type: 'dir'}];
      if (folder === '/sd/roms') return [{name: 'nes', type: 'dir'}];
      if (folder === '/sd/roms/nes') return entries;
      throw Error('Unexpected folder ' + folder);
    },
    async openRead(file) {calls.push('open:' + file); return {handle: file, size: files[path.posix.basename(file)].length};},
    async read(file, offset, count) {calls.push('read:' + offset); return files[path.posix.basename(file.handle)].subarray(offset, offset + count);},
    async close(file) {calls.push('file-close:' + file.handle);}};
  const options = {verifySource: async () => {}, attachGame: async () => attachment,
    createStorage: async () => storage};
  return {directory, calls, session, attachment, storage, options};
}

test('SD ROM folder is confined to a canonical SD directory', () => {
  assert.equal(validSDRomFolder(), '/sd/roms/nes');
  assert.equal(validSDRomFolder('/sd/NES ROMs'), '/sd/NES ROMs');
  for (const value of ['/sd/../user', '/sd//roms', '/sd/roms/', '/user/roms',
    '/sd/roms\\nes', '/sd/roms\nnes'])
    assert.throws(() => validSDRomFolder(value), /SD ROM folder/);
});

test('only bounded mapper-0 iNES ROMs are compatible', () => {
  const good = rom();
  assert.equal(compatibleINES(good.subarray(0, 16), good.length), true);
  const mapper1 = Buffer.from(good.subarray(0, 16)); mapper1[6] = 0x10;
  assert.equal(compatibleINES(mapper1, good.length), false);
  const trainer = Buffer.from(good.subarray(0, 16)); trainer[6] = 4;
  assert.equal(compatibleINES(trainer, good.length), false);
  const nes2 = Buffer.from(good.subarray(0, 16)); nes2[7] = 0x08;
  assert.equal(compatibleINES(nes2, good.length), false);
  assert.equal(compatibleINES(good.subarray(0, 16), good.length - 1), false);
});

test('persistent Mac ROM folder accepts only small compatible regular files', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-mac-roms-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  fs.writeFileSync(path.join(folder, 'Good.nes'), rom());
  const nes2 = Buffer.from(rom()); nes2[7] = 0x08;
  fs.writeFileSync(path.join(folder, 'NES2.nes'), nes2);
  fs.writeFileSync(path.join(folder, 'Large.nes'), Buffer.alloc(65537));
  fs.symlinkSync(path.join(folder, 'Good.nes'), path.join(folder, 'Link.nes'));
  const found = await readMacRoms(folder, 3);
  assert.deepEqual(found.roms.map(item => item.name), ['Good.nes']);
  assert.deepEqual(found.skipped, ['Large.nes', 'Link.nes', 'NES2.nes']);
  assert.equal(found.roms[0].bytes.length, rom().length);
  assert.equal((await readMacRoms(path.join(folder, 'missing'))).missing, true);
});

test('read-only SD import reads compatible files and closes all owned handles', async t => {
  const {directory, calls, session, options} = fixture(t,
    {'One.nes': rom(), 'Mapper1.nes': Buffer.from(rom())});
  const bad = Buffer.from(rom()); bad[6] = 0x10;
  const result = await readSDRoms(directory, {...options,
    createStorage: async () => ({...options.createStorage && await options.createStorage(),
      async list(folder) {
        if (folder === '/sd') return [{name: 'roms', type: 'dir'}];
        if (folder === '/sd/roms') return [{name: 'nes', type: 'dir'}];
        return [{name: 'One.nes', type: 'file', size: rom().length},
          {name: 'Mapper1.nes', type: 'file', size: bad.length}];
      },
      async openRead(file) {return {handle: file, size: rom().length};},
      async read(file, offset, count) {
        return (file.handle.endsWith('Mapper1.nes') ? bad : rom()).subarray(offset, offset + count);
      },
      async close(file) {calls.push('file-close:' + file.handle);}})});
  assert.deepEqual(result.roms.map(item => item.name), ['One.nes']);
  assert.deepEqual(result.skipped, ['Mapper1.nes']);
  assert(calls.includes('attachment-close'));
  assert.equal(session.base, 0);
  assert.equal(session.handles.size, 0);
  assert.equal(calls.some(value => value.startsWith('write:')), false);
});

test('absent SD folder uses bundled ROMs and still releases attachment', async t => {
  const {directory, calls, options} = fixture(t);
  options.createStorage = async () => ({mounts: ['sd'],
    async list() {return [];}});
  const result = await readSDRoms(directory, options);
  assert.equal(result.missing, true);
  assert.deepEqual(result.roms, []);
  assert(calls.includes('attachment-close'));
});

test('an attachment that cannot confirm cleanup blocks native mapping', async t => {
  const {directory, attachment, options} = fixture(t);
  attachment.close = async () => {};
  await assert.rejects(readSDRoms(directory, options), error =>
    error.cleanupBlocked === true && /cleanup failed/.test(error.message));
});

function packageFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-native-apps-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const apps = path.join(directory, 'apps');
  fs.mkdirSync(apps);
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  for (const id of ['hello-cpu', 'mintnes']) {
    const folder = path.join(apps, id), build = path.join(folder, 'build');
    fs.mkdirSync(build, {recursive: true});
    const code = Buffer.alloc(0x1000, 0x5a), data = Buffer.alloc(0);
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
      id, name: id, version: '1.0.0', abi: 3, kind: 'native',
      assets: id === 'mintnes' ? ['*.nes'] : []}));
    fs.writeFileSync(path.join(build, 'code.bin'), code);
    fs.writeFileSync(path.join(build, 'data.bin'), data);
    fs.writeFileSync(path.join(build, 'report.json'), JSON.stringify({
      format: 'hblauncher-native-app/1', id, kind: 'native', abi: 3,
      codeBase: '0x0c000000', dataBase: '0x0d000000', entry: '0x0c000000',
      codeBytes: code.length, codePages: 1, codeSha256: digest(code),
      dataBytes: 0, dataRegionBytes: 0x1000, dataSha256: digest(data)}));
    if (id === 'mintnes') {
      fs.mkdirSync(path.join(folder, 'assets'));
      fs.writeFileSync(path.join(folder, 'assets/Bundled.nes'), rom());
    }
  }
  return {directory, apps};
}

test('session copy adds Mac and SD ROMs while preserving bundled and other native apps', async t => {
  const {directory, apps} = packageFixture(t);
  const sourceRom = fs.readFileSync(path.join(apps, 'mintnes/assets/Bundled.nes'));
  const staged = await stageApps(directory, apps, [
    {name: 'Mac.nes', bytes: rom()}, {name: 'External.nes', bytes: rom()},
    {name: 'Bundled.nes', bytes: rom()}]);
  assert.deepEqual(staged.imported, ['Mac.nes', 'External.nes']);
  const scan = require('./upstream/host/lib/packages.cjs').scan(staged.appsDir);
  assert.deepEqual(scan.packages.map(item => item.manifest.id), ['hello-cpu', 'mintnes']);
  assert.deepEqual(scan.packages.find(item => item.manifest.id === 'mintnes').assets
    .map(item => item.name), ['Bundled.nes', 'External.nes', 'Mac.nes']);
  assert.deepEqual(fs.readFileSync(path.join(apps, 'mintnes/assets/Bundled.nes')), sourceRom);
  assert.equal(fs.existsSync(path.join(apps, 'mintnes/assets/External.nes')), false);
  await fs.promises.rm(staged.stageDir, {recursive: true, force: true});
});
