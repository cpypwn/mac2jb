'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {inspectPackage, inspectHost, refuseLiveLaunch} = require('./contract.cjs');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function packageFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbrew-native-package-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'build'));
  const manifest = {id: 'sample-native', name: 'Sample Native', version: '1.0.0',
    abi: 3, kind: 'native', assets: []};
  const code = Buffer.alloc(0x1000, 0x5a), data = Buffer.from('native data');
  const report = {format: 'hblauncher-native-app/1', id: manifest.id,
    kind: 'native', abi: 3, codeBase: '0x0c000000', dataBase: '0x0d000000',
    entry: '0x0c000000', codeBytes: code.length, codePages: 1,
    dataBytes: data.length, dataRegionBytes: 0x1000,
    codeSha256: sha(code), dataSha256: sha(data)};
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'build/report.json'), JSON.stringify(report));
  fs.writeFileSync(path.join(root, 'build/code.bin'), code);
  fs.writeFileSync(path.join(root, 'build/data.bin'), data);
  return {root, manifest, report};
}

function hostFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mintbrew-native-host-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const native = path.join(root, 'native'), kurumuz = path.join(root, 'kurumuz');
  fs.mkdirSync(path.join(native, 'sdk'), {recursive: true});
  fs.mkdirSync(path.join(native, 'host/lib'), {recursive: true});
  fs.mkdirSync(path.join(native, 'launcher/build'), {recursive: true});
  fs.mkdirSync(path.join(native, 'assets'), {recursive: true});
  fs.mkdirSync(path.join(kurumuz, 'engine/switch2/ro/payload'), {recursive: true});
  fs.writeFileSync(path.join(native, 'sdk/abi.json'), JSON.stringify({abiVersion: 3}));
  fs.writeFileSync(path.join(native, 'host/lib/runtime.cjs'), '');
  fs.writeFileSync(path.join(native, 'assets/font_atlas.r8'), Buffer.alloc(1024 * 1024));
  const code = Buffer.from('launcher');
  fs.writeFileSync(path.join(native, 'launcher/build/code.bin'), code);
  fs.writeFileSync(path.join(native, 'launcher/build/data.bin'), Buffer.alloc(0));
  fs.writeFileSync(path.join(native, 'launcher/build/report.json'),
    JSON.stringify({abi: 3, kind: 'launcher', codeBytes: code.length, dataBytes: 0,
      codeSha256: sha(code), dataSha256: sha(Buffer.alloc(0))}));
  const hello = path.join(native, 'apps/hello-cpu');
  fs.mkdirSync(path.join(hello, 'build'), {recursive: true});
  const helloCode = Buffer.alloc(0x1000, 0x5a), helloData = Buffer.alloc(0);
  fs.writeFileSync(path.join(hello, 'manifest.json'), JSON.stringify({id: 'hello-cpu',
    name: 'Hello CPU', version: '1.0.0', abi: 3, kind: 'native', assets: []}));
  fs.writeFileSync(path.join(hello, 'build/code.bin'), helloCode);
  fs.writeFileSync(path.join(hello, 'build/data.bin'), helloData);
  fs.writeFileSync(path.join(hello, 'build/report.json'), JSON.stringify({
    format: 'hblauncher-native-app/1', id: 'hello-cpu', kind: 'native', abi: 3,
    codeBase: '0x0c000000', dataBase: '0x0d000000', entry: '0x0c000000',
    codeBytes: helloCode.length, codePages: 1, codeSha256: sha(helloCode),
    dataBytes: 0, dataRegionBytes: 0x1000, dataSha256: sha(helloData)}));
  const payload = path.join(kurumuz, 'engine/switch2/ro/payload/process.c');
  fs.writeFileSync(payload,
    'if (command == 0x524f001a) {}\nif (command == 0x524f001b) {}\nif (command == 0x524f001c) {}\n');
  return {native, kurumuz, payload};
}

test('accepts a complete ABI 3 native package without changing the GPU ABI 1 path', t => {
  const {root} = packageFixture(t);
  const item = inspectPackage(root);
  assert.deepEqual([item.id, item.abi, item.kind, item.codeBytes],
    ['sample-native', 3, 'native', 0x1000]);
  assert.equal(item.authoritativeValidationRequired, true);
  fs.writeFileSync(path.join(root, 'app.json'), '{}');
  assert.throws(() => inspectPackage(root), /GPU ABI 1 packages/);
});

test('rejects changed images and conflicting native memory ranges', t => {
  const {root, report} = packageFixture(t);
  fs.writeFileSync(path.join(root, 'build/code.bin'), Buffer.alloc(0x1000, 0x33));
  assert.throws(() => inspectPackage(root), /code image/);
  fs.writeFileSync(path.join(root, 'build/code.bin'), Buffer.alloc(0x1000, 0x5a));
  report.dataBase = '0x08000000';
  fs.writeFileSync(path.join(root, 'build/report.json'), JSON.stringify(report));
  assert.throws(() => inspectPackage(root), /resident HBLauncher/);
  report.dataBase = report.codeBase;
  fs.writeFileSync(path.join(root, 'build/report.json'), JSON.stringify(report));
  assert.throws(() => inspectPackage(root), /code and data images overlap/);
});

test('Mac source preflight separates runtime readiness from optional build tools', t => {
  const {native, kurumuz, payload} = hostFixture(t);
  let host = inspectHost({nativeRoot: native, hostRoot: kurumuz,
    toolAvailable: () => true});
  assert.equal(host.nativeSource, true);
  assert.equal(host.builtLauncher, true);
  assert.equal(host.builtHello, true);
  assert.equal(host.fontAtlas, true);
  assert.equal(host.bulkMapSource, true);
  assert.equal(host.readyForLiveLaunch, true);
  assert.equal(host.mintbrewHandoffReady, false);
  assert.equal(host.consoleTested, false);
  assert.equal(refuseLiveLaunch(host), true);
  fs.writeFileSync(payload, 'if (command == 0x524f0012) {}');
  host = inspectHost({nativeRoot: native, hostRoot: kurumuz,
    toolAvailable: name => name !== 'llvm-objcopy'});
  assert.equal(host.bulkMapSource, false);
  assert.deepEqual(host.missingBuildTools, ['llvm-objcopy']);
  assert.equal(host.readyForLiveLaunch, false);
  assert.match(host.blockers.join(' '), /bulk map commands/);
  assert.throws(() => refuseLiveLaunch(host), /bulk map commands/);
});
