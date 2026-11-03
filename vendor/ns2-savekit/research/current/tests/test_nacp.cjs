#!/usr/bin/env node
// Offline tests for tools/lib/nacp.cjs. No console, no network, no deps.
//
//   node tests/test_nacp.cjs
//
// This is the name the console itself gives a title, and for a Switch 2 title it
// is the only name there is - community titledb is a Switch 1 catalogue. The
// deflated name block (format 1) is the part that is easy to get wrong: read it
// as text and every Switch 2 title comes back with a mangled name or none.
const assert = require('node:assert');
const zlib = require('node:zlib');
const nacp = require('../tools/lib/nacp.cjs');

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

// A synthetic 0x4000-byte control NACP: names per language slot, optionally with
// the deflated name block a Switch 2 title carries.
function build(names, {format = 0} = {}) {
  const bytes = Buffer.alloc(0x4000);
  const block = Buffer.alloc(0x3000);
  names.forEach((text, slot) => { if (text) block.write(text, slot * 0x300); });
  if (format === 0) {
    block.copy(bytes, 0);
  } else {
    const deflated = zlib.deflateRawSync(block);
    bytes.writeUInt16LE(deflated.length, 0);
    deflated.copy(bytes, 2);
    bytes[nacp.FORMAT_OFFSET] = 1;
  }
  return bytes;
}

test('the English slot is preferred', () => {
  assert.strictEqual(nacp.name(build(['Yoshi and the Mysterious Book', 'ヨッシー'])),
    'Yoshi and the Mysterious Book');
});

test('an empty English slot falls back to the next name', () => {
  assert.strictEqual(nacp.name(build([null, 'Welcome Tour'])), 'Welcome Tour');
});

test('a deflated name block is inflated (format 1)', () => {
  const bytes = build(['Welcome Tour', null, 'Welcome Tour (JP)'], {format: 1});
  assert.strictEqual(nacp.name(bytes), 'Welcome Tour');
  assert.deepStrictEqual(nacp.names(bytes).slice(0, 3),
    ['Welcome Tour', null, 'Welcome Tour (JP)']);
});

test('a deflated block that is not deflate is refused, not thrown', () => {
  const bytes = build(['Yoshi'], {format: 1});
  bytes.writeUInt16LE(0x20, 0);                  // size, but garbage behind it
  bytes.fill(0xff, 2, 0x22);
  assert.strictEqual(nacp.name(bytes), null);
});

test('a short, empty or junk NACP gives no name', () => {
  assert.strictEqual(nacp.name(Buffer.alloc(0)), null);
  assert.strictEqual(nacp.name(Buffer.alloc(0x100)), null);
  assert.strictEqual(nacp.name(Buffer.alloc(0x4000)), null);
  assert.strictEqual(nacp.name(null), null);
  assert.deepStrictEqual(nacp.names(Buffer.alloc(8)), []);
});

test('invalid UTF-8 in one slot skips to the next', () => {
  const bytes = build([null, 'Game']);
  Buffer.from([0xff, 0xfe, 0xfd]).copy(bytes, 0);
  assert.strictEqual(nacp.name(bytes), 'Game');
});

test('an unterminated 0x200-byte name is still a name', () => {
  const bytes = build(['x'.repeat(0x200)]);
  assert.strictEqual(nacp.name(bytes), 'x'.repeat(0x200));
});

test('the name stops at the 0x200-byte short name', () => {
  const bytes = build([null]);
  bytes.write('short', 0);
  bytes.write('not part of the name', 0x200);    // publisher-side bytes of the slot
  assert.strictEqual(nacp.name(bytes), 'short');
});

test('control characters and runs of space are cleaned', () => {
  assert.strictEqual(nacp.clean('A\u0007B  \u202eC  '), 'A B C');
  assert.strictEqual(nacp.clean('  '), '');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
