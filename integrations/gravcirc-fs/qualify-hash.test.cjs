const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {artifact, makeSource, parseReply} = require('./qualify-hash.cjs');

const profileDir = process.env.GC_PROFILE_DIR;

test('Gravity Circuit SHA-256 candidate matches the defined symbol and captured SDK body', t => {
  const files = profileDir ?
    ['sdk-v1.2.1-code.bin', 'sdk-v1.2.1-dynsym.bin', 'sdk-v1.2.1-dynstr.bin']
      .map(name => path.join(profileDir, name)) : [];
  if (files.length !== 3 || files.some(file => !fs.existsSync(file))) {
    t.skip('set GC_PROFILE_DIR to the captured Gravity Circuit SDK dump directory');
    return;
  }
  const [code, dynsym, dynstr] = files.map(file => fs.readFileSync(file));
  assert.equal(code.length, artifact.sdkCode.size);
  assert.equal(crypto.createHash('sha256').update(code).digest('hex'), artifact.sdkCode.sha256);
  const entry = artifact.function;
  const symbolAt = entry.symbolIndex * 24;
  const nameAt = dynsym.readUInt32LE(symbolAt);
  const nameEnd = dynstr.indexOf(0, nameAt);
  assert.equal(dynstr.toString('utf8', nameAt, nameEnd), entry.sourceSymbol);
  assert.equal(Number(dynsym.readBigUInt64LE(symbolAt + 8)), entry.offset);
  assert.equal(Number(dynsym.readBigUInt64LE(symbolAt + 16)), entry.size);
  assert.equal(dynsym.readUInt16LE(symbolAt + 6), 1);
  const captured = code.subarray(entry.offset, entry.offset + entry.size);
  assert.equal(captured.toString('hex'), entry.bytes);
  assert.equal(crypto.createHash('sha256').update(captured).digest('hex'), entry.sha256);
  assert.equal(code.subarray(artifact.adjacentSymbol.offset,
    artifact.adjacentSymbol.offset + 4).toString('hex'), entry.bytes.slice(0, 8));
  assert.equal(artifact.status, 'live-qualified');
  assert.equal(artifact.liveVerified, true);
  assert.equal(artifact.liveQualification.fsBridgeStageAfter, 'accept');
});

test('Gravity Circuit SHA-256 qualifier uses bounded owned buffers and checks guards', () => {
  const source = makeSource();
  assert.ok(Buffer.byteLength(source) < 32768);
  assert.match(source, /info\.profile=="gravity-circuit-v1\.2\.1"/);
  assert.match(source, /info\.sdk_base\+19632/);
  assert.match(source, /uint8_t\[48\]/);
  assert.match(source, /output\[40\+j\]/);
  assert.match(source, /uint8_t\[\?\]/);
  assert.match(source, /\{digest,32,input,n\}/);
  assert.match(source, /LS\.fs_bridge\.stage=='accept'/);
  assert.doesNotMatch(source, /LS\.fs_bridge\.(?:start|run|stop)|io\.open|os\.execute/);
  for (const vector of artifact.vectors) {
    assert.equal(crypto.createHash('sha256').update(Buffer.from(vector.inputHex, 'hex')).digest('hex'),
      vector.expected);
  }
});

test('Gravity Circuit SHA-256 reply rejects failures, wrong digests, and changed bridge state', () => {
  const [empty, numbers] = artifact.vectors.map(vector => vector.expected);
  const valid = `-> GC_SHA256_V1\tok\t0x7893381000\t${empty}\t${numbers}\taccept\n`;
  assert.deepEqual(parseReply(valid).vectorHashes, [empty, numbers]);
  assert.throws(() => parseReply(valid.replace(empty, '0'.repeat(64))), /wrong digest/);
  assert.throws(() => parseReply(valid.replace('accept', 'idle')), /incomplete/);
  assert.throws(() => parseReply('-> GC_SHA256_V1\tfail\tfunction-bytes\n'), /failed/);
  assert.throws(() => parseReply('-> GC_SHA256_V1\tok\t0x1\n'), /incomplete/);
});
