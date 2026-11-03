'use strict';
/*
 * Host-side tests: package parsing, catalog layout, dispatch construction, ABI
 * sync and the complete launcher lifecycle against the mock backend.
 *
 * Run: node tests/host/lifecycle.test.cjs   (or sh tests/run.sh)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const {execFileSync} = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const {scan, buildCatalog, loadPackage, decodePng} = require(path.join(ROOT, 'host/lib/packages.cjs'));
const {buildDispatch, parseDispatchHeader} = require(path.join(ROOT, 'host/lib/dispatch.cjs'));
const {Runtime, ABI} = require(path.join(ROOT, 'host/lib/runtime.cjs'));
const {LiveTarget, MockTarget} = require(path.join(ROOT, 'host/lib/target.cjs'));
const {createMockCallHandler} = require(path.join(ROOT, 'host/lib/mock-device.cjs'));
const {Log} = require(path.join(ROOT, 'host/lib/common.cjs'));

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const log = new Log({quiet: true});

test('large app image unmaps in one shortened range and one page', async () => {
  const entry = {source: 0x60000000, destination: 0x0d000000, pages: 124};
  const calls = [];
  const target = new LiveTarget({runDir: '', log});
  target.pid = 4242;
  target.mapped.push(entry);
  target.client = {request: async (id, handle, args) => {
    calls.push({id, args});
    assert.strictEqual(handle, 0xffff8001);
    if (id === 0x524f001c) {
      assert.strictEqual(args[4], undefined);
      assert(args[3] + 1 <= entry.pages);
      const values = Array(10).fill(0n);
      values[3] = BigInt(args[3]);
      return {result: 0, values};
    }
    assert.strictEqual(id, 0x524f0013);
    return {result: 0};
  }};
  await target.unmapImage(entry);
  assert.deepStrictEqual(calls.map(call => [call.id, call.args[3]]),
    [[0x524f001c, 123], [0x524f0013, 4096]]);
  assert.strictEqual(calls[1].args[1], entry.source + 123 * 4096);
  assert.strictEqual(calls[1].args[2], entry.destination + 123 * 4096);
  assert.strictEqual(target.mapped.length, 0);
});

test('failed range unmap retains mapping instead of retrying uncertain cleanup', async () => {
  const entry = {source: 0x60000000, destination: 0x0d000000, pages: 124};
  let calls = 0;
  const target = new LiveTarget({runDir: '', log});
  target.pid = 4242;
  target.mapped.push(entry);
  target.client = {request: async () => {
    calls++;
    const values = Array(10).fill(0n);
    values[3] = 3n;
    values[5] = 0xd002n;
    values[6] = 1n;
    return {result: 0xd002, values};
  }};
  await assert.rejects(() => target.unmapImage(entry), /unmap 0xd000000 failed/);
  assert.strictEqual(calls, 1);
  assert.strictEqual(target.mapped.length, 1);
});

test('ABI json matches the C headers', () => {
  execFileSync('python3', [path.join(ROOT, 'tools/gen_abi.py'), '--check'], {stdio: 'pipe'});
});

test('dispatch header parses in declaration order', () => {
  const fields = parseDispatchHeader(path.join(ROOT, 'sdk/include/hbx_vk.h'));
  assert(fields.length > 60, 'expected the full table');
  assert.strictEqual(fields[0], 'vkCreateInstance');
  assert(fields.includes('vkQueueSubmit'));
  assert(fields.includes('vkCmdBeginRendering'));
  assert.strictEqual(new Set(fields).size, fields.length);
});

test('dispatch table resolves symbols and rejects gaps', () => {
  const fields = parseDispatchHeader(path.join(ROOT, 'sdk/include/hbx_vk.h'));
  const module = {
    base: 0x3000000000,
    symbols: fields.map((name, index) => ({name, offset: 0x1000 + index * 0x40,
      section: 1, type: 2}))
  };
  const built = buildDispatch(module);
  assert.strictEqual(built.buffer.length, fields.length * 8);
  assert.strictEqual(built.buffer.readBigUInt64LE(0), BigInt(0x3000000000 + 0x1000));
  assert.strictEqual(built.missing.length, 0);

  const broken = {base: 0x1000, symbols: module.symbols.filter(s => s.name !== 'vkQueueSubmit')};
  assert.throws(() => buildDispatch(broken), /vkQueueSubmit/);
});

test('every app package parses', () => {
  const {packages, errors} = scan(path.join(ROOT, 'apps'));
  assert.strictEqual(errors.length, 0, JSON.stringify(errors));
  assert.deepStrictEqual(packages.map(pkg => pkg.manifest.id).sort(),
    ['gpu-triangle', 'hello-cpu', 'mintnes']);
  const kinds = new Set(packages.map(pkg => pkg.manifest.kind));
  assert.deepStrictEqual([...kinds], ['native']);
  for (const pkg of packages) {
    assert.strictEqual(pkg.manifest.abi, 3);
    assert(pkg.icon && pkg.icon.length === 96 * 96 * 4, pkg.manifest.id + ' icon');
  }
});

test('catalog layout matches struct hbx_catalog', () => {
  const {packages} = scan(path.join(ROOT, 'apps'));
  const catalog = buildCatalog(packages);
  const block = catalog.block;
  assert.strictEqual(block.readUInt32LE(0), ABI.catalogMagic);
  assert.strictEqual(block.readUInt32LE(4), packages.length);
  const stringsOff = block.readUInt32LE(8);
  assert(stringsOff >= 32 + packages.length * 32);
  const firstName = block.readUInt32LE(32 + 4);
  assert(block.subarray(stringsOff + firstName, stringsOff + firstName + 20)
    .toString().startsWith(packages[0].manifest.name));
  assert.strictEqual(catalog.iconLayers, packages.length);
  assert.strictEqual(catalog.icons.length, packages.length * 96 * 96 * 4);
});

test('invalid packages are rejected', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hbl-pkg-'));
  const write = (id, manifest) => {
    const dir = path.join(temp, id);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    return dir;
  };
  assert.throws(() => loadPackage(write('Bad', {id: 'Bad', name: 'x', version: '1.0.0',
    abi: 3, kind: 'native'})), /invalid id/);
  assert.throws(() => loadPackage(write('ok-id', {id: 'ok-id', name: 'x', version: '1.0.0',
    abi: 9, kind: 'native'})), /unsupported abi/);
  assert.throws(() => loadPackage(write('ok-kind', {id: 'ok-kind', name: 'x', version: '1.0.0',
    abi: 3, kind: 'pray'})), /unsupported kind/);
  assert.throws(() => loadPackage(write('ok-build', {id: 'ok-build', name: 'x', version: '1.0.0',
    abi: 3, kind: 'native'})), /report.json/);
  fs.rmSync(temp, {recursive: true, force: true});
});

test('icon PNG decodes to RGBA', () => {
  const png = fs.readFileSync(path.join(ROOT, 'apps/hello-cpu/icon.png'));
  const image = decodePng(png);
  assert.strictEqual(image.width, 96);
  assert.strictEqual(image.height, 96);
  assert.strictEqual(image.rgba.length, 96 * 96 * 4);
});

test('runtime lifecycle: launch, return, exit', async () => {
  const handler = createMockCallHandler({appFrames: 42});
  const target = new MockTarget({log, onCall: handler});
  const runtime = new Runtime({target, log, appsDir: path.join(ROOT, 'apps')});
  await runtime.open();
  assert.strictEqual(runtime.packages.length, scan(path.join(ROOT, 'apps')).packages.length);
  assert.strictEqual(runtime.catalog.iconLayers, runtime.packages.length);
  assert.strictEqual(runtime.launcher.entry, Number(BigInt(runtime.launcher.report.entry)));
  handler.setEntries(runtime.launcher.entry, Number(BigInt(runtime.packages[0].report.entry)));
  const result = await runtime.run({maxEntries: 8});
  assert.strictEqual(result.launches, 1);
  assert.strictEqual(handler.state.appCalls, 1);
  assert.strictEqual(handler.state.entries[1].resume, true,
    'the launcher must be re-entered with the resume flag after an app');
  /* App images are unmapped; the launcher image is still resident. */
  const mapped = runtime.mappedImages.map(entry => entry.label);
  assert(mapped.includes('launcher-code'), 'launcher stays mapped');
  assert(!mapped.some(label => label.includes('gpu-triangle')), 'app images are released');
  await runtime.stop();
});

test('runtime aborts on a launcher failure status', async () => {
  const target = new MockTarget({log, onCall: async (address, args, t) => {
    const ctx = await t.read(args[0], ABI.ctxSize);
    const status = Buffer.alloc(8);
    status.writeBigUInt64LE(4n);
    await t.write(args[0] + ABI.ctx.status, status);
    return {result: 0};
  }});
  const runtime = new Runtime({target, log, appsDir: path.join(ROOT, 'apps')});
  await runtime.open();
  await assert.rejects(() => runtime.run({maxEntries: 2}), /status 4/);
  await runtime.stop();
});

test('asset globs expand to sorted matching files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbl-glob-'));
  try {
    fs.cpSync(path.join(ROOT, 'apps/hello-cpu'), dir, {recursive: true});
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
    manifest.assets = ['*.rom', 'b.rom'];
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    fs.mkdirSync(path.join(dir, 'assets'), {recursive: true});
    for (const name of ['b.rom', 'A.ROM', 'skip.txt']) fs.writeFileSync(path.join(dir, 'assets', name), name);
    const pkg = loadPackage(dir);
    assert.deepStrictEqual(pkg.assets.map(a => a.name), ['A.ROM', 'b.rom']);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('asset block keeps every name and payload intact', () => {
  const runtime = new Runtime({target: new MockTarget({log}), log, appsDir: path.join(ROOT, 'apps')});
  const assets = [{name: "sample-one.nes", bytes: Buffer.from('NES\x1aAAAA')},
                  {name: 'sample-two.nes', bytes: Buffer.from('NES\x1aBBBBBBBB')},
                  {name: 'c', bytes: Buffer.alloc(3, 9)}];
  const block = runtime.buildAssetBlock({manifest: {id: 't'}, assets});
  assert.strictEqual(block.readUInt32LE(4), 3);
  assets.forEach((asset, i) => {
    const nameAt = block.readUInt32LE(16 + i * 16), dataAt = block.readUInt32LE(20 + i * 16);
    const size = block.readUInt32LE(24 + i * 16);
    assert.strictEqual(block.toString('utf8', nameAt, nameAt + Buffer.byteLength(asset.name)), asset.name);
    assert.deepStrictEqual(block.subarray(dataAt, dataAt + size), asset.bytes);
  });
});

test('native asset refresh replaces the live ROM table after files change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hbl-rom-refresh-'));
  const appDir = path.join(root, 'mintnes');
  try {
    fs.cpSync(path.join(ROOT, 'apps/mintnes'), appDir, {recursive: true});
    const assets = path.join(appDir, 'assets');
    fs.rmSync(assets, {recursive: true, force: true});
    fs.mkdirSync(assets);
    const rom = Buffer.alloc(16);
    rom.write('NES\x1a', 0, 'binary');
    fs.writeFileSync(path.join(assets, 'first.nes'), rom);
    const pkg = loadPackage(appDir);
    const target = new MockTarget({log});
    const runtime = new Runtime({target, log, appsDir: root});
    runtime.ctxBlock = await target.allocate(ABI.ctxSize);
    const retained = [];
    await runtime.refreshNativeAssets(pkg, retained);
    const ctx = await target.read(runtime.ctxBlock, ABI.ctxSize);
    const firstBase = Number(ctx.readBigUInt64LE(ABI.ctx.assets));
    assert.strictEqual(Number(ctx.readBigUInt64LE(ABI.ctx.data_base)), firstBase);
    assert.strictEqual((await target.read(firstBase, 8)).readUInt32LE(4), 1);
    fs.writeFileSync(path.join(assets, 'second.nes'), rom);
    await runtime.refreshNativeAssets(pkg, retained);
    const next = await target.read(runtime.ctxBlock, ABI.ctxSize);
    const secondBase = Number(next.readBigUInt64LE(ABI.ctx.assets));
    assert.notStrictEqual(secondBase, firstBase);
    assert.strictEqual((await target.read(secondBase, 8)).readUInt32LE(4), 2);
    assert.strictEqual(retained.length, 2);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('save block round-trips through saves/<id>.sav only when dirty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbl-saves-'));
  const previous = process.env.HBL_SAVES_DIR;
  process.env.HBL_SAVES_DIR = dir;
  try {
    const target = new MockTarget({log});
    const runtime = new Runtime({target, log, appsDir: path.join(ROOT, 'apps')});
    const pkg = {manifest: {id: 'demo'}, saveBytes: 0x10000};
    let block = await runtime.loadSave(pkg);
    assert.strictEqual((await target.read(block, 4)).readUInt32LE(0), 0, 'fresh block has no magic');
    const body = Buffer.alloc(64, 7);
    body.writeUInt32LE(0x56534248, 0); body.writeUInt32LE(1, 4);
    body.writeUInt32LE(64, 8); body.writeUInt32LE(0, 12);
    await target.write(block, body);
    await runtime.storeSave(pkg, block);
    assert(!fs.existsSync(path.join(dir, 'demo.sav')), 'a clean block is not written');
    body.writeUInt32LE(1, 12);
    await target.write(block, body);
    await runtime.storeSave(pkg, block);
    const stored = fs.readFileSync(path.join(dir, 'demo.sav'));
    assert.strictEqual(stored.length, 64);
    assert.strictEqual(stored.readUInt32LE(12), 0, 'dirty flag is cleared on disk');
    block = await runtime.loadSave(pkg);
    assert.deepStrictEqual(await target.read(block + 16, 48), body.subarray(16));
  } finally {
    if (previous === undefined) delete process.env.HBL_SAVES_DIR; else process.env.HBL_SAVES_DIR = previous;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log(`ok   ${item.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${item.name}\n     ${error.message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} host tests passed`);
  process.exit(failed ? 1 : 0);
})();
