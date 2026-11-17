const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const {helpers, verifyCapturedSdk, makeSource, parseReply} = require('./qualify-owned.cjs');
const live = require('./live-readonly-map.v1.0.1f.json');

const captureDir = process.env.BALATRO_PROFILE_DIR;
const capturePaths = captureDir ? ['code', 'dynsym', 'dynstr'].map(name =>
  path.join(captureDir, `sdk-1.0.1f-${name}.bin`)) : [];
const captured = capturePaths.length === 3 && capturePaths.every(file => fs.existsSync(file));
const nonce = '0123456789abcdef';

function capture() {
  return Object.fromEntries(['code', 'dynsym', 'dynstr'].map((name, index) =>
    [name, fs.readFileSync(capturePaths[index])]));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('pinned captured SDK verifies all heads, full helper bodies and symbols', {skip: !captured}, () => {
  const result = verifyCapturedSdk(capture());
  assert.equal(result.gameProfile, 'balatro-physical-base-v1.0.1f');
  assert.equal(result.verifiedCodeHeads, 41);
  assert.deepEqual(result.verifiedHelpers,
    ['allocate', 'free', 'getService', 'queryMemory', 'closeHandle']);
});

test('captured SDK rejects a changed instruction and a changed helper symbol', {skip: !captured}, () => {
  const original = capture();
  const changedCode = {...original, code: Buffer.from(original.code)};
  changedCode.code[helpers.functions.allocate.offset] ^= 1;
  assert.throws(() => verifyCapturedSdk(changedCode), /does not match the pinned/);

  const changedSymbols = {...original, dynsym: Buffer.from(original.dynsym)};
  const nameOffset = original.dynstr.indexOf(Buffer.from(helpers.functions.allocate.symbol));
  assert.notEqual(nameOffset, -1);
  let changed = false;
  for (let at = 0; at < changedSymbols.dynsym.length; at += 24) {
    if (changedSymbols.dynsym.readUInt32LE(at) === nameOffset &&
        Number(changedSymbols.dynsym.readBigUInt64LE(at + 8)) === helpers.functions.allocate.offset) {
      changedSymbols.dynsym.writeBigUInt64LE(BigInt(helpers.functions.allocate.size + 4), at + 16);
      changed = true;
      break;
    }
  }
  assert.ok(changed, 'the captured allocate symbol was found');
  assert.throws(() => verifyCapturedSdk(changedSymbols), /allocate symbol differs/);
});

test('owned helper sources pin identity, mappings, code and bounded cleanup', () => {
  const allocation = makeSource({phase: 'allocation', nonce,
    skipMountCheck: false});
  const service = makeSource({phase: 'service', nonce,
    skipMountCheck: false});
  const allocationSkipped = makeSource({phase: 'allocation', nonce});
  assert.doesNotMatch(allocationSkipped, /return fail\('mount-head'\)/);
  assert.match(service, /fsp-srv handle verified and closed/);
  assert.ok(service.indexOf("if tonumber(closeRc)~=0 then") <
    service.indexOf("local showcase=package.loaded['bl.lovera1n_showcase']"));
  for (const source of [allocation, service]) {
    assert.ok(Buffer.byteLength(source) <= 32768);
    assert.match(source, /info\.version=='1\.0\.1f-FULL'/);
    assert.match(source, /info\.sdk_base%4096~=0/);
    assert.match(source, /local checks=\{/);
    assert.ok(source.includes(`local dataMap,why=mapping(base+${Number(BigInt(live.mountTable.sdkOffset))})`));
    assert.match(source, /return fail\('mount-head'\)/);
    assert.match(source, /return fail\('proxy-id'\)/);
    assert.ok(source.indexOf('local codeMap,why=') < source.indexOf('local checks={'));
    assert.doesNotMatch(source, /local (?:createFile|writeFile|commit|deleteFile|createThread)=|canary/);
  }
  assert.match(allocation, /pcall\(allocate,[^\n]*,4096\)/);
  assert.match(allocation, /love\.ffi\.declare\('uint32_t',\{'uint64_t \*','uint64_t'\}/);
  assert.ok(allocation.indexOf("if return32~=0 then return fail('allocate-return32:'") <
    allocation.indexOf('local addr=tonumber(out[1])'));
  assert.match(allocation, /pcall\(release,addr,4096\)/);
  assert.match(allocation, /local manager=tonumber\(ffi\.cast/);
  assert.ok(allocation.includes(`managerMap.base~=base+${Number(BigInt(live.mappings.allocatorManager.base)) - Number(BigInt(live.identity.sdkBase))}`));
  assert.ok(allocation.includes(`managerMap.size~=${Number(BigInt(live.mappings.allocatorManager.size))}`));
  assert.match(allocation, /managerMap\.type~=4 or managerMap\.perm~=3/);
  assert.match(allocation, /manager<managerMap\.base or manager\+0x3f8>managerMap\.base\+managerMap\.size/);
  assert.match(allocation, /addr>=lower and addr\+4096<=lower\+extent/);
  assert.ok(allocation.indexOf('local manager=') < allocation.indexOf('pcall(allocate,'));
  assert.ok(allocation.indexOf('local safe=') < allocation.indexOf('pcall(release,'));
  assert.match(service, /'fsp-srv'/);
  assert.match(service, /pcall\(closeHandle,handle\)/);
  assert.throws(() => makeSource({phase: 'write', nonce}), /phase must be/);
  assert.throws(() => makeSource({phase: 'service', nonce: 'bad'}), /nonce must be/);
});

test('owned helper chunks compile and reject an absent target before native calls', () => {
  for (const phase of ['allocation', 'service']) {
    const source = makeSource({phase, nonce});
    const result = spawnSync('luajit', ['-e', 'local f=assert(loadstring(io.read("*a")));io.write(f())'],
      {input: source, encoding: 'utf8'});
    if (result.error?.code === 'ENOENT') return;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `BAL_OWNED_V1\t${phase}\tfail\t${nonce}\tidentity`);
  }
});

test('reply parser accepts one matching completion and rejects stale or incomplete replies', () => {
  const context = {phase: 'allocation', nonce};
  const valid = `-> BAL_OWNED_V1\tallocation\tok\t${nonce}\t0x1000\tfree-returned\n`;
  assert.equal(parseReply(valid, context).status,
    'native call returned; no save transaction tested');
  assert.throws(() => parseReply(valid.replace(nonce, 'ffffffffffffffff'), context), /phase and nonce/);
  assert.throws(() => parseReply(valid + valid, context), /duplicated/);
  assert.throws(() => parseReply(valid.replace('free-returned', 'free-unknown'), context), /incomplete/);
  assert.throws(() => parseReply(`-> BAL_OWNED_V1\tallocation\tfail\t${nonce}\tcode:nn::fs::OpenFile\n`, context),
    /failed: code:nn::fs::OpenFile/);
  assert.throws(() => parseReply(`-> BAL_OWNED_V1\tallocation\tfail\t${nonce}\n`, context),
    /does not match/);
  assert.equal(parseReply(`-> BAL_OWNED_V1\tservice\tok\t${nonce}\t00000153\tclosed\n`,
    {phase: 'service', nonce}).cleanup, 'closed');
  assert.throws(() => parseReply('compile error: bad opcode\n', context), /compile error/);
});

test('helper artifact records exact bytes and hashes for all native targets', () => {
  assert.equal(helpers.functions.allocate.return, 'unqualified');
  for (const entry of Object.values(helpers.functions)) {
    const bytes = Buffer.from(entry.bytes, 'hex');
    assert.equal(bytes.length, entry.size);
    assert.equal(sha256(bytes), entry.sha256);
  }
});
