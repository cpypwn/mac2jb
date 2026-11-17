const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const {MARKER, makeSource, parseReply} = require('./probe-domain-readonly.cjs');

const nonce = '0123456789abcdef';
const sdkBase = 0x57390b4000;
const manager = sdkBase + 0xd52940;
const vtable = sdkBase + 0xcea800;
const fields = [MARKER, 'ok', nonce, sdkBase, 0x49646472a8, 0x49646472a0,
  0x4964689680, 0x4964689700, vtable, 0xcea800, manager, 154, 153, 2048,
  3, manager + 0x80, 0x321, manager + 0xa0, 3, '00000202', 'ac8a9d29'];
const reply = `-> ${fields.join('\t')}\n`;

test('domain probe pins live SDK identity before reading mounted objects', () => {
  const source = makeSource({nonce});
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /info\.version=='1\.0\.1f-FULL'/);
  assert.match(source, /local checks=\{/);
  assert.match(source, /crc-vector/);
  assert.match(source, /sdk-crc/);
  assert.match(source, /love\.ffi\.declare\('uint32_t',\{'uint32_t','const void \*','uint64_t'\},base\+/);
  assert.match(source, /pcall\(crc,0,vector,9\)/);
  assert.match(source, /pcall\(crc,0,ffi\.cast\('const void\*',base\),6160384\)/);
  assert.match(source, /save-mount-missing/);
  assert.match(source, /service-vtable-offset/);
  assert.match(source, /manager-state/);
  assert.match(source, /session-slot-map/);
  assert.match(source, /session-pool-lists/);
  assert.match(source, /local selectedNode=idleHead/);
  assert.match(source, /borrowed-handle/);
  assert.match(source, /absent-path-result/);
  assert.ok(source.indexOf('sdk-crc') < source.indexOf('local head=base+'));
  assert.ok(source.indexOf('local checks={') < source.indexOf('local head=base+'));
  assert.ok(source.includes(`${profile.mounts.tableOffset}`));
  assert.doesNotMatch(source, /local (?:copyObject|createFile|deleteFile|commit|closeHandle)=/);
});

test('domain source compiles and refuses absent target before native calls', () => {
  const result = spawnSync('luajit', ['-e', 'local f=assert(loadstring(io.read("*a")));io.write(f())'],
    {input: makeSource({nonce}), encoding: 'utf8'});
  if (result.error?.code === 'ENOENT') return;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${MARKER}\tfail\t${nonce}\tidentity`);
});

test('domain reply includes live-relative mounted service and borrowed session evidence', () => {
  const evidence = parseReply(reply, {nonce});
  assert.equal(evidence.sdkBase, `0x${sdkBase.toString(16)}`);
  assert.equal(evidence.sdkCodeSha256, profile.sdkCode.sha256);
  assert.equal(evidence.mount.serviceVtableOffset, '0xcea800');
  assert.equal(evidence.mount.manager, `0x${manager.toString(16)}`);
  assert.equal(evidence.mount.objectId, 154);
  assert.equal(evidence.proxy.objectId, 153);
  assert.equal(evidence.sessionManager.borrowedHandle, 0x321);
  assert.equal(evidence.sessionManager.selectedNode, `0x${(manager + 0xa0).toString(16)}`);
  assert.equal(evidence.sessionManager.idleCount, 3);
  assert.equal(evidence.sessionManager.livenessVerified, false);
  assert.equal(evidence.absentPathResult, '0x00000202');
  assert.match(evidence.status, /read-only/);
});

test('domain parser fails closed on stale or malformed evidence', () => {
  assert.throws(() => parseReply(reply, {nonce: 'ffffffffffffffff'}), /nonce mismatch/);
  assert.throws(() => parseReply(reply + reply, {nonce}), /duplicated/);
  assert.throws(() => parseReply(reply.replace('ac8a9d29', '00000000'), {nonce}), /unverified/);
  assert.throws(() => parseReply(reply.replace('00000202', '00000402'), {nonce}), /unverified/);
  assert.throws(() => parseReply(reply.replace(String(manager), String(manager + 8)), {nonce}), /invalid fields/);
  assert.throws(() => parseReply(reply.replace('\t154\t153\t', '\t153\t153\t'), {nonce}), /invalid fields/);
  assert.throws(() => makeSource({nonce: 'invalid'}), /nonce must be/);
});
