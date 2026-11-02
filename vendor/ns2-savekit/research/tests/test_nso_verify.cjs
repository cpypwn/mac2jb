#!/usr/bin/env node
// Offline tests for tools/nso-verify.cjs. No console, no network, no deps.
//
//   node tests/test_nso_verify.cjs
//   NSO_FIXTURE=/path/to/real/main node tests/test_nso_verify.cjs
//
// The real-file cases need one genuine NSO. By default the Seedsow Lullaby demo
// exefs is used when present; set NSO_FIXTURE to point at any other one. Those
// cases are skipped (loudly) when no real NSO is available, so the suite still
// runs on a machine without a dump.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {parse, lz4Block} = require('../tools/nso-verify.cjs');

const TOOL = path.join(__dirname, '..', 'tools', 'nso-verify.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-test-'));
let passes = 0, failures = 0;

function test(name, fn) {
  try {
    fn();
    passes++;
    console.log('ok    ' + name);
  } catch (error) {
    failures++;
    console.log('FAIL  ' + name + '\n      ' + String(error.message).split('\n').join('\n      '));
  }
}

function run(file, args = []) {
  try {
    return {code: 0, out: execFileSync(process.execPath, [TOOL, file, ...args], {encoding: 'utf8'})};
  } catch (error) {
    return {code: error.status, out: (error.stdout || '') + (error.stderr || '')};
  }
}

// A minimal uncompressed NSO: no compress flags, no hash flags. This is the shape
// a hand-built homebrew `main` would have, and the payload must accept it.
function synthetic() {
  const name = Buffer.from('main\0', 'latin1');
  const textOff = 0x100 + name.length;
  const text = Buffer.alloc(0x1000);
  Buffer.from('fd7bbfa9', 'hex').copy(text, 0);          // stp x29,x30,[sp,#-16]!
  const rodata = Buffer.alloc(0x100, 0x41);
  const data = Buffer.alloc(0x100, 0x42);
  const roOff = textOff + text.length;
  const dataOff = roOff + rodata.length;
  const header = Buffer.alloc(0x100);
  header.write('NSO0', 0, 'latin1');
  header.writeUInt32LE(0, 4);                            // version
  header.writeUInt32LE(0, 8);                            // reserved
  header.writeUInt32LE(0, 0x0C);                         // flags: uncompressed, unhashed
  header.writeUInt32LE(textOff, 0x10);
  header.writeUInt32LE(0, 0x14);
  header.writeUInt32LE(text.length, 0x18);
  header.writeUInt32LE(0x100, 0x1C);                     // module name offset
  header.writeUInt32LE(roOff, 0x20);
  header.writeUInt32LE(0x1000, 0x24);
  header.writeUInt32LE(rodata.length, 0x28);
  header.writeUInt32LE(name.length, 0x2C);               // module name size
  header.writeUInt32LE(dataOff, 0x30);
  header.writeUInt32LE(0x2000, 0x34);
  header.writeUInt32LE(data.length, 0x38);
  header.writeUInt32LE(0x1000, 0x3C);                    // bss
  header.writeUInt32LE(text.length, 0x60);                // .text file size
  header.writeUInt32LE(rodata.length, 0x64);              // .rodata file size
  header.writeUInt32LE(data.length, 0x68);                // .data file size
  // The module name lives at 0x100, i.e. immediately after the 0x100-byte header.
  return Buffer.concat([header, name, text, rodata, data]);
}

const syntheticFile = path.join(tmp, 'synthetic.nso');
fs.writeFileSync(syntheticFile, synthetic());

test('synthetic uncompressed NSO passes', () => {
  const r = run(syntheticFile);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /valid NSO0/);
  assert.match(r.out, /"main"/);
});

test('synthetic with text offset moved into the header is rejected', () => {
  const copy = Buffer.from(synthetic());
  copy.writeUInt32LE(0x40, 0x10);
  const file = path.join(tmp, 'inside-header.nso');
  fs.writeFileSync(file, copy);
  const r = run(file);
  assert.strictEqual(r.code, 3, r.out);
  assert.match(r.out, /inside the header/);
});

test('synthetic with data section past EOF is rejected as truncated', () => {
  const copy = Buffer.from(synthetic());
  copy.writeUInt32LE(0x1000, 0x38);                      // claim 0x1000 data bytes
  copy.writeUInt32LE(0x1000, 0x68);                      // ...and that they are present
  const file = path.join(tmp, 'truncated-synth.nso');
  fs.writeFileSync(file, copy);
  const r = run(file);
  assert.strictEqual(r.code, 3, r.out);
  assert.match(r.out, /truncated/);
});

test('missing file exits 4, not 3', () => {
  const r = run(path.join(tmp, 'does-not-exist'));
  assert.strictEqual(r.code, 4, r.out);
  assert.match(r.out, /MISSING/);
});

test('bad magic is rejected', () => {
  const copy = Buffer.from(synthetic());
  copy.write('XSO0', 0, 'latin1');
  const file = path.join(tmp, 'bad-magic.nso');
  fs.writeFileSync(file, copy);
  const r = run(file);
  assert.strictEqual(r.code, 3, r.out);
  assert.match(r.out, /expected "NSO0"/);
});

test('zeroed text section is rejected', () => {
  const copy = Buffer.from(synthetic());
  copy.writeUInt32LE(0, 0x100 + 5);
  const file = path.join(tmp, 'empty-text.nso');
  fs.writeFileSync(file, copy);
  const r = run(file);
  assert.strictEqual(r.code, 3, r.out);
  assert.match(r.out, /zero word/);
});

test('LZ4 decoder rejects an out-of-range match offset', () => {
  // token: 0 literals, match length 4 (0x00), offset 1 with nothing emitted yet.
  assert.throws(() => lz4Block(Buffer.from([0x00, 0x01, 0x00]), 16), /out of range/);
  assert.throws(() => lz4Block(Buffer.from([0x00]), 16), /produced 0 bytes/);
});

test('LZ4 decoder round-trips a literal-only block', () => {
  const payload = Buffer.from('hello world', 'latin1');
  const block = Buffer.concat([Buffer.from([payload.length << 4]), payload]);
  assert.deepStrictEqual(lz4Block(block, payload.length), payload);
});

// Real-file cases. These are the ones that matter: a genuine signed title NSO has
// LZ4 sections and SHA-256 hashes, so a pass proves the decoder and the hash path.
const FIXTURE = process.env.NSO_FIXTURE ||
  path.join(os.homedir(), 'SeedsowLullabyDemo-full', 'base', 'exefs', 'main');

if (fs.existsSync(FIXTURE)) {
  test('real NSO verifies with section hashes', () => {
    const r = run(FIXTURE);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /valid NSO0/);
    const hashOk = (r.out.match(/sha256 ok/g) || []).length;
    assert.strictEqual(hashOk, 3, 'expected text, rodata and data hashes to verify:\n' + r.out);
  });

  test('one flipped byte in a real NSO fails the hash check', () => {
    const copy = Buffer.from(fs.readFileSync(FIXTURE));
    const textOff = copy.readUInt32LE(0x10);
    copy[textOff + 0x400] ^= 0xFF;                       // inside compressed .text
    const file = path.join(tmp, 'flipped.nso');
    fs.writeFileSync(file, copy);
    const r = run(file);
    assert.strictEqual(r.code, 3, r.out);
    assert.match(r.out, /INVALID/);
  });

  test('a truncated real NSO is rejected, not partially accepted', () => {
    const full = fs.readFileSync(FIXTURE);
    const file = path.join(tmp, 'truncated.nso');
    fs.writeFileSync(file, full.subarray(0, full.length - 4096));
    const r = run(file);
    assert.strictEqual(r.code, 3, r.out);
    assert.match(r.out, /truncated|needs bytes/);
  });

  test('--no-hash skips hashes but still checks structure', () => {
    const r = run(FIXTURE, ['--no-hash']);
    assert.strictEqual(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /sha256 ok/);
  });

  test('parse() reports the declared module name', () => {
    const result = parse(fs.readFileSync(FIXTURE));
    assert.strictEqual(result.ok, true, result.problems.join('; '));
    assert.ok(result.header.moduleName.length > 0);
  });
} else {
  console.log(`skip  real-NSO cases (no fixture at ${FIXTURE}; set NSO_FIXTURE)`);
}

fs.rmSync(tmp, {recursive: true, force: true});
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
