const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const targetModule = require('../civswitch/fs-kit/port/engine/shared/target.cjs');
const profile = require('./profile.v1.2.1.json');
const fsLayout = require('./sdk-fs-layout.v1.2.1.json');
const timing = require('./sdk-timing.v1.2.1.json');
const crc = require('./sdk-crc32.v1.2.1.json');
const sha = require('./sdk-sha256.v1.2.1.json');
const profileDir = process.env.GC_PROFILE_DIR;

test('Gravity Circuit target materializes only its measured artifacts', async t => {
  const target = targetModule.loadTarget('gravcirc');
  assert.equal(target.programIds.host[0], '01008d9019128000');
  assert.equal(target.hello.sdkCrc32, profile.sdkCrc32);
  assert.equal(target.crc32.expected, crc.sdkCheck.expected);
  assert.equal(target.crc32.function, 'crc32');
  assert.equal(target.sdkBytes, profile.sdkBytes);
  assert.equal(target.sdkSha256, fsLayout.sdkCode.sha256);
  assert.equal(target.timing.sdkFrequency, timing.functions.frequency.returnedHz);
  assert.equal(target.timing.nativeFrequency, timing.nativeCounterHz);
  assert.equal(target.timing.mode, 'measured');
  assert.equal(target.programIds.ro, '0x01008d9019128000');
  assert.equal(target.smServiceOffset, 0);
  assert.equal(target.retainedCaptureBytes, 0);
  assert.equal(target.appWorkerQualification.qualified, true);
  const artifacts = targetModule.validateArtifacts(target);
  assert.equal(artifacts.sdkLayout.value.mountTableOffset, fsLayout.mountTable.offset);
  assert.deepEqual(Object.keys(artifacts.app).sort(),
    ['event-code.json', 'hash-code.json', 'sdk-proxy-code.json',
      'thread-code.json', 'thread-scheduling-reference.json', 'timing-code.json',
      'worker-qualification.json']);
  const workerProof = artifacts.app['worker-qualification.json'];
  assert.equal(workerProof.value.verified, true);
  assert.equal(workerProof.value.cleanedUp, true);
  assert.equal(workerProof.value.worker.joined, true);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(workerProof.file)).digest('hex'),
    target.appWorkerQualification.proof.slice(7));
  assert.equal(artifacts.app['sdk-proxy-code.json'].value.globalOffset, fsLayout.proxy.globalOffset);
  assert.equal(artifacts.app['hash-code.json'].value.offset, sha.function.offset);
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'gravcirc-target-'));
  t.after(() => fs.rmSync(destination, {recursive: true, force: true}));
  fs.mkdirSync(path.join(destination, 'shared'));
  fs.mkdirSync(path.join(destination, 'switch2/app'), {recursive: true});
  const copies = await targetModule.materializeTarget(target, destination);
  assert.equal(copies.length, 9);
  assert.equal(fs.readFileSync(path.join(destination, 'shared/sdk-functions.json'), 'utf8'),
    fs.readFileSync(artifacts.sdkFunctions.file, 'utf8'));
  assert.equal(fs.readFileSync(path.join(destination, 'switch2/app/thread-code.json'), 'utf8'),
    fs.readFileSync(artifacts.app['thread-code.json'].file, 'utf8'));
});

test('Gravity Circuit canary gate accepts measured geometry while full FS remains closed', () => {
  const target = targetModule.loadTarget('gravcirc');
  assert.equal(targetModule.assertWorkerSupported(target), target);
  assert.equal(targetModule.assertCanarySupported(target), target);
  assert.throws(() => targetModule.assertFullSupported(target),
    /gravcirc retained capture size/);
  const missing = targetModule.loadTarget('gravcirc');
  missing.artifacts.sdkFunctions = null;
  assert.throws(() => targetModule.assertCanarySupported(missing),
    /gravcirc SDK function artifact/);
});

test('Gravity Circuit target artifacts pin captured SDK instruction bytes', t => {
  const file = profileDir ? path.join(profileDir, 'sdk-v1.2.1-code.bin') : null;
  if (!file || !fs.existsSync(file)) {
    t.skip('set GC_PROFILE_DIR to the captured Gravity Circuit SDK dump directory');
    return;
  }
  const code = fs.readFileSync(file);
  const target = targetModule.loadTarget('gravcirc');
  assert.equal(code.length, target.sdkBytes);
  assert.equal(crypto.createHash('sha256').update(code).digest('hex'), target.sdkSha256);
  const artifacts = targetModule.validateArtifacts(target);
  const entries = [
    ...Object.values(artifacts.sdkFunctions.value),
    ...artifacts.sdkLayout.value.verifiedFunctions,
    ...Object.values(artifacts.app['timing-code.json'].value.functions),
    ...Object.values(artifacts.app['event-code.json'].value.functions),
    ...Object.values(artifacts.app['thread-code.json'].value.functions),
    ...Object.values(artifacts.app['thread-code.json'].value.rawSvc.functions),
    ...Object.values(artifacts.app['thread-scheduling-reference.json'].value.functions),
    artifacts.app['hash-code.json'].value,
    {offset: artifacts.app['sdk-proxy-code.json'].value.functionOffset,
      bytes: artifacts.app['sdk-proxy-code.json'].value.bytes}
  ];
  for (const entry of entries)
    assert.equal(code.subarray(entry.offset, entry.offset + entry.bytes.length / 2).toString('hex'),
      entry.bytes, `SDK +0x${entry.offset.toString(16)}`);
});

test('Gravity Circuit native FS-stage wrappers are pinned to the captured SDK', t => {
  const file = profileDir ? path.join(profileDir, 'sdk-v1.2.1-code.bin') : null;
  if (!file || !fs.existsSync(file)) {
    t.skip('set GC_PROFILE_DIR to the captured Gravity Circuit SDK dump directory');
    return;
  }
  const code = fs.readFileSync(file);
  const target = targetModule.loadTarget('gravcirc');
  assert.equal(crypto.createHash('sha256').update(code).digest('hex'), target.sdkSha256);
  const expected = {
    cancelSynchronization: [0x158ae0, '210300d4c0035fd6'],
    waitZero: [0x158ac8, 'e00f1ff8010300d4e20340f9410000b9ff430091c0035fd6'],
    threadId: [0x158b48, 'e00f1ff8a10400d4e20340f9410000f9ff430091c0035fd6'],
    processInfo: [0x158b78, 'e00f1ff8210500d4e20340f9410000f9ff430091c0035fd6']
  };
  for (const [name, [offset, bytes]] of Object.entries(expected)) {
    const entry = targetModule.nativeEntry(name, target);
    assert.equal(entry.offset, offset);
    assert.equal(entry.bytes, bytes);
    assert.equal(code.subarray(offset, offset + bytes.length / 2).toString('hex'), bytes);
    assert.equal(code.indexOf(Buffer.from(bytes, 'hex')), offset);
    assert.equal(code.lastIndexOf(Buffer.from(bytes, 'hex')), offset);
  }
  const scan = targetModule.nativeOffset('eventSyscallScan', target);
  assert.equal(scan, 0x158a78);
  const eventCode = code.subarray(scan, scan + 0x120);
  for (const [offset, bytes] of [[0x158a80, '210200d4c0035fd6'],
    [0x158a88, '410200d4c0035fd6']]) {
    const signature = Buffer.from(bytes, 'hex');
    assert.equal(eventCode.indexOf(signature), offset - scan);
    assert.equal(eventCode.lastIndexOf(signature), offset - scan);
  }
  const capture = targetModule.nativeOffset('syscallCapture', target);
  assert.equal(capture, 0x158000);
  assert.equal(crypto.createHash('sha256').update(code.subarray(capture, capture + 4096)).digest('hex'),
    '0e7d8376bd685c3429010e94fd64f008838f68b055ed9dffd4308b0395290daa');
});
