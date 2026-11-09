'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {test} = require('node:test');
const Module = require('node:module');
const crypto = require('node:crypto');
const {profileById, sourceDigest} = require('./host-profiles.cjs');
const rangeFiles = new Set([
  'engine/switch2/process/client.cjs',
  'engine/switch2/ro/worker-control.cjs',
  'engine/switch2/ro/payload/process.c',
  'engine/switch2/ro/payload/main',
  'engine/switch2/ro/payload/manifest.json'
]);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
test('Astral inherits the pinned Kurumuz native range and SaveKit overlay inputs', () => {
  const root = path.resolve(__dirname, '..');
  for (const name of [...rangeFiles, 'engine/switch2/process/client.cjs',
    'engine/shared/ipc.cjs', 'engine/switch2/ro/ncm.cjs',
    'engine/switch2/app/mounted-save.cjs'])
    assert.equal(sha(fs.readFileSync(path.join(root, 'vendor/ns2jb-hosts/astral', name))),
      sha(fs.readFileSync(path.join(root, 'vendor/ns2jb-hosts/kurumuz', name))), name);
});
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
  if (parent?.filename.endsWith('/process/client.cjs') && request === '../tools/fs-memory.cjs')
    return {connect: async () => {throw Error('test must not open RPC');}};
  if (parent?.filename.endsWith('/process/client.cjs') && request === '../ro/export-handle.cjs')
    return {exportHandle: async () => {throw Error('test must not export a handle');}};
  return originalLoad.apply(this, arguments);
};
const clients = {};
try {
  for (const host of ['kurumuz', 'cellenseres'])
    clients[host] = require('../vendor/ns2jb-hosts/' + host + '/engine/switch2/process/client.cjs').Client;
}
finally {Module._load = originalLoad;}

for (const [host, Client] of Object.entries(clients)) {
test(host + ' distribution changes only documented local patch files', () => {
  const root = path.resolve(__dirname, '..');
  const profile = profileById(host);
  const folder = path.join(root, profile.sourceDirectory);
  const entries = file => new Map(fs.readFileSync(path.join(root, file), 'utf8').trim()
    .split('\n').map(line => line.split('  ').reverse()));
  const upstream = entries(profile.upstreamManifest);
  const distributed = entries(profile.distributionManifest);
  assert.deepEqual([...upstream.keys()].sort(), [...distributed.keys()].sort());
  const changed = new Set([...upstream.keys()].filter(name => upstream.get(name) !== distributed.get(name)));
  const cleanupPatch = host === 'cellenseres' ? 'engine/switch2/memory/fs-memory-control.cjs' : null;
  if (cleanupPatch) assert.equal(changed.delete(cleanupPatch), true);
  assert.deepEqual(changed, rangeFiles);
  for (const [name, digest] of distributed)
    assert.equal(sha(fs.readFileSync(path.join(folder, name))), digest, name);
  const patch = JSON.parse(fs.readFileSync(path.join(root, profile.localPatch), 'utf8'));
  assert.equal(patch.upstreamRevision, profile.revision);
  assert.equal(patch.upstreamManifest, profile.upstreamManifest);
  assert.equal(patch.sourceSha256, profile.sourceSha256);
  assert.equal(patch.sourceSha256, sourceDigest(folder, profile));
  assert.equal(patch.payloadSha256, distributed.get('engine/switch2/ro/payload/main'));
  if (cleanupPatch) assert.equal(patch.cleanupPatch, cleanupPatch);
});
test(host + ' native range payload maps RX and RW, verifies bounds and rolls back failures', () => {
  const root = path.resolve(__dirname, '..');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-range-test-'));
  try {
    const output = path.join(folder, 'process-range-test');
    execFileSync('xcrun', ['clang', '-std=c11', '-O0', '-Wall', '-Wextra', '-Werror',
      path.join(root, 'scripts/fixtures/kurumuz-process-range.c'),
      path.join(root, 'vendor/ns2jb-hosts', host, 'engine/switch2/ro/payload/process.c'),
      '-o', output], {stdio: 'pipe'});
    execFileSync(output, [], {stdio: 'pipe'});
  } finally {fs.rmSync(folder, {recursive: true, force: true});}
});

test(host + ' native range client preserves the ABI 3 request and response fields', async () => {
  const client = new Client();
  client.pid = '4242'; client.handle = 10; client.record = {calls: []};
  client.save = async () => {};
  const sent = [];
  client.worker = async request => {
    sent.push(request);
    const output = Buffer.alloc(80);
    output.writeBigUInt64LE(2n, 24);
    output.writeBigUInt64LE(1n, 64);
    return {transport: 0, kernelPid: client.pid, result: 0,
      data: output.toString('hex')};
  };
  const mapped = await client.mapRange(0xffff8001, 4242, 0x20000000, 0x30000000, 2, 5);
  assert.equal(mapped.mapped, 2);
  assert.equal(mapped.mode, 1);
  assert.equal(sent[0].id, 0x524f001a);
  assert.deepEqual(Array.from({length: 4}, (_, i) =>
    Buffer.from(sent[0].hex, 'hex').readBigUInt64LE(i * 8)),
  [4242n, 0x20000000n, 0x30000000n, 2n]);

  await client.mapRange(0xffff8001, 4242, 0x20000000, 0x30000000, 2, 3);
  assert.equal(sent[1].id, 0x524f001b);
  const unmapped = await client.unmapRange(0xffff8001, 4242, 0x20000000, 0x30000000, 2);
  assert.equal(sent[2].id, 0x524f001c);
  assert.equal(unmapped.unmapped, 2);
  assert.equal(unmapped.failures, 0);
});

test(host + ' native range client rejects unsupported handles and out-of-bounds addresses', async () => {
  const client = new Client();
  client.pid = '4242'; client.handle = 10; client.record = {calls: []};
  client.save = async () => {};
  client.worker = async () => {throw Error('worker must not run');};
  for (const values of [
    [4242, 0x20000000, 0x30000000, 0],
    [4242, 0x20000000, 0x30000000, 16385],
    [4242, 0x20000001, 0x30000000, 1],
    [4242, 0x20000000, 0x30000001, 1],
    [4242, 2 ** 39 - 0x1000, 0x30000000, 1],
    [0, 0x20000000, 0x30000000, 1]
  ]) await assert.rejects(client.request(0x524f001a, 0xffff8001, values));
  await assert.rejects(client.request(0x524f001a, 99,
    [4242, 0x20000000, 0x30000000, 1]));
  await assert.rejects(client.mapRange(0xffff8001, 4242, 0x20000000, 0x30000000, 1, 4));
  assert.equal(client.record.calls.length, 0);
});
}
