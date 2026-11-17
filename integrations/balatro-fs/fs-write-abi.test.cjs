const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const profile = require('./fs-write-abi.v1.0.1f.json');
const captureDir = process.env.BALATRO_PROFILE_DIR;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function symbolIndex(dynsym, dynstr) {
  const names = new Set(Object.values(profile.functions).map(entry => entry.symbol));
  const index = new Map();
  for (let at = 0; at < dynsym.length; at += profile.capture.dynsym.entrySize) {
    const nameOffset = dynsym.readUInt32LE(at);
    if (nameOffset >= dynstr.length) continue;
    const end = dynstr.indexOf(0, nameOffset);
    if (end < 0) continue;
    const name = dynstr.toString('utf8', nameOffset, end);
    if (!names.has(name)) continue;
    const records = index.get(name) || [];
    records.push({
      info: dynsym.readUInt8(at + 4),
      offset: Number(dynsym.readBigUInt64LE(at + 8)),
      size: Number(dynsym.readBigUInt64LE(at + 16))
    });
    index.set(name, records);
  }
  return index;
}

test('FS write ABI profile identifies the Balatro build and call sequence', () => {
  assert.equal(profile.gameProfile, 'balatro-physical-base-v1.0.1f');
  assert.equal(profile.runtimeVersion, '1.0.1f-FULL');
  assert.match(profile.sdkCodeSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(profile.scratchSequence.write,
    ['createFile', 'openFile', 'writeFile', 'flushFile', 'closeFile', 'commit']);
  assert.deepEqual(profile.scratchSequence.cleanup, ['deleteFile', 'commit']);
  assert.equal(profile.functions.commit.symbol, '_ZN2nn2fs14CommitSaveDataEPKc');
  assert.ok(profile.functions.entryType.body, 'read-only entryType body is embedded');
  assert.ok(profile.functions.freeSpace.body, 'read-only freeSpace body is embedded');
  assert.equal(profile.flags.resultSuccess, 0);
  assert.equal(profile.flags.openModeRead, 1);
  assert.equal(profile.flags.openModeWrite, 2);
  assert.equal(profile.flags.writeOptionNone, 0);
  for (const [name, entry] of Object.entries(profile.functions)) {
    assert.match(entry.symbol, /^_ZN2nn2fs/, name);
    assert.ok(Number.isSafeInteger(entry.offset) && entry.offset >= 0, name);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0, name);
    assert.equal(entry.head.length, Math.min(entry.size, 16) * 2, name);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, name);
    assert.ok(Array.isArray(entry.arguments) && entry.arguments.length > 0, name);
    if (entry.body) {
      const body = Buffer.from(entry.body, 'hex');
      assert.equal(body.length, entry.size, `${name} embedded body size`);
      assert.equal(sha256(body), entry.sha256, `${name} embedded body SHA-256`);
      assert.equal(body.subarray(0, 16).toString('hex'), entry.head,
        `${name} embedded code head`);
    }
  }
});

test('FS write ABI symbols and full bodies match the captured 1.0.1f SDK', (t) => {
  const paths = captureDir ? Object.fromEntries(Object.entries(profile.capture)
    .map(([name, item]) => [name, path.join(captureDir, item.file)])) : {};
  if (Object.keys(paths).length !== Object.keys(profile.capture).length ||
      Object.values(paths).some(file => !fs.existsSync(file))) {
    t.skip('set BALATRO_PROFILE_DIR to the captured 1.0.1f SDK directory');
    return;
  }
  const captured = Object.fromEntries(Object.entries(paths).map(([name, file]) =>
    [name, fs.readFileSync(file)]));
  for (const [name, item] of Object.entries(profile.capture)) {
    assert.equal(captured[name].length, item.size, `${name} size`);
    if (item.sha256) assert.equal(sha256(captured[name]), item.sha256, `${name} SHA-256`);
  }
  assert.equal(captured.dynsym.length % profile.capture.dynsym.entrySize, 0);
  assert.equal(sha256(captured.code), profile.sdkCodeSha256, 'SDK code SHA-256');

  const symbols = symbolIndex(captured.dynsym, captured.dynstr);
  for (const [name, entry] of Object.entries(profile.functions)) {
    const records = symbols.get(entry.symbol) || [];
    assert.equal(records.length, 1, `${name} has one exact exported symbol`);
    assert.equal(records[0].info & 0xf, 2, `${name} is an ELF function symbol`);
    assert.equal(records[0].offset, entry.offset, `${name} symbol offset`);
    assert.equal(records[0].size, entry.size, `${name} symbol size`);
    const body = captured.code.subarray(entry.offset, entry.offset + entry.size);
    assert.equal(body.length, entry.size, `${name} lies inside captured code`);
    assert.equal(body.subarray(0, Math.min(entry.size, 16)).toString('hex'),
      entry.head, `${name} code head`);
    assert.equal(sha256(body), entry.sha256, `${name} full function SHA-256`);
    if (entry.body) assert.equal(body.toString('hex'), entry.body, `${name} embedded full body`);
  }
  for (const [name, item] of Object.entries(profile.instructionEvidence)) {
    const size = item.bytes.length / 2;
    assert.equal(captured.code.subarray(item.offset, item.offset + size).toString('hex'),
      item.bytes, `${name} instruction`);
  }

  // The two one-argument commit wrappers select distinct static options, then
  // enter the same internal routine. This is an address relationship, not a
  // claim that either option has been qualified by a live Balatro call.
  function branchTarget(pc) {
    const word = captured.code.readUInt32LE(pc);
    assert.equal(word >>> 26, 0b000101);
    let immediate = word & 0x3ffffff;
    if (immediate & 0x2000000) immediate -= 0x4000000;
    return pc + immediate * 4;
  }
  assert.equal(branchTarget(profile.functions.commit.offset + 8), 0xa4580);
  assert.equal(branchTarget(profile.functions.commitPlain.offset + 8), 0xa4580);
});
