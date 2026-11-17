const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { getArgs } = require('../ouncecake.cjs');
const { loadCiv7Artifacts } = require('../engine/civ7-ftp.cjs');
const { encodeConfiguration, readCiv7Image } = require('../engine/civ7-runtime.cjs');
const { planTar } = require('../engine/tar.cjs');

async function fixture(targetName = 'civ7') {
  const run = await fs.mkdtemp(path.join(os.tmpdir(), 'ouncecake-civ7-test-'));
  await fs.mkdir(path.join(run, 'shared'), { recursive: true });
  await fs.writeFile(path.join(run, 'connection.json'), JSON.stringify({ addresses: { target: targetName } }));
  await fs.writeFile(path.join(run, 'shared/target.civ7.json'), JSON.stringify({
    name: 'civ7', sdkBytes: 0x100000,
  }));
  await fs.writeFile(path.join(run, 'shared/sdk-functions.json'), JSON.stringify({
    send: { offset: 0x200, bytes: '410400d4c0035fd6' },
    close: { offset: 0x204, bytes: 'c10200d4c0035fd6' },
    free: { offset: 0x208, bytes: '00000000' },
  }));
  return run;
}

test('CLI exposes only the Civ7 backend and tar mode', () => {
  const defaults = getArgs(['/tmp/run']);
  assert.equal(defaults.tar, false);
  assert.equal(defaults.run, '/tmp/run');

  const options = getArgs(['/tmp/run', '--tar']);
  assert.equal(options.tar, true);

  for (const oldFlag of ['--native-ftp', '--civ7-native-ftp', '--host-ftp', '--port']) {
    assert.throws(() => getArgs(['/tmp/run', oldFlag]), /Unknown option/);
  }
});

test('Civ7 configuration keeps the validated eight-client layout', () => {
  const encoded = encodeConfiguration({
    functions: 0x1000,
    index: 0x2000,
    indexBytes: 64,
    sourceAddress: 0x3000,
    sources: [{ handle: 7, kind: 0, size: 123, objectId: 8 }],
    data: 0x4000,
    dataBytes: 0x400000,
    outputBytes: 0,
    ipcBuffer: 0x5000,
    slots: 0x6000,
    slotBytes: 4096,
    maxClients: 8,
    port: 2121,
  });
  assert.equal(encoded.config.toString('ascii', 0, 8), 'NS2FTP01');
  assert.equal(encoded.config.readUInt32LE(24), 2121);
  assert.equal(encoded.config.readUInt32LE(28), 8);
  assert.equal(encoded.sources.length, 24);
});

test('repository contains the Civ7 payload', async () => {
  const image = await readCiv7Image();
  assert.ok(image.length > 4096);
});

test('tar planning preserves offsets beyond the connector deadline and 4 GiB', () => {
  const size = 24n * 1024n ** 3n + 123n;
  const archive = planTar({
    path: '/base/program/0/romfs',
    kind: 'filesystem',
    entries: [{ path: '/large.bin', type: 'file', size }],
  });
  assert.ok(archive.size > size);
  assert.equal(archive.members[1].size, size);
  assert.ok(archive.members[1].end > 2n ** 32n);
});

test('native payload batches bounded raw and tar slices between renewals', async () => {
  const [native, tar] = await Promise.all([
    fs.readFile(path.join(__dirname, '../engine/oz-code/native.c'), 'utf8'),
    fs.readFile(path.join(__dirname, '../engine/oz-code/tar.h'), 'utf8'),
  ]);
  assert.match(native, /u64 offset;/);
  assert.match(native, /transfer_step\(Server \*s,CivClientSlot \*slot\)/);
  assert.match(native, /#define TRANSFER_BATCH_SLICES 32/);
  assert.match(native, /if\(\+\+transfer_slices>=TRANSFER_BATCH_SLICES\)return 1;/);
  assert.doesNotMatch(native,
    /if\(!transfer_step\(s,slot\)\)civ_client_close\(s,slot\);\n\s*return 1;/);
  assert.match(tar, /tar_transfer_slice/);
  assert.doesNotMatch(tar, /static int tar_transfer\(/);
});

test('Civ7 loader rejects a connector run for another target', async (t) => {
  const run = await fixture('smilebasic');
  t.after(() => fs.rm(run, { recursive: true, force: true }));
  await assert.rejects(loadCiv7Artifacts(run), /not Civ7/);
});

test('Civ7 loader accepts materialized SDK artifacts', async (t) => {
  const run = await fixture();
  t.after(() => fs.rm(run, { recursive: true, force: true }));
  const artifacts = await loadCiv7Artifacts(run);
  assert.equal(artifacts.target.name, 'civ7');
  assert.equal(artifacts.sdkFunctions.send.offset, 0x200);
  assert.equal(artifacts.sdkFunctions.free.offset, 0x208);
});
