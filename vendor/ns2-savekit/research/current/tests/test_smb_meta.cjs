#!/usr/bin/env node
// Offline tests for tools/smb-meta.cjs, using the real SmileBASIC META sample when
// it is present (saves/ is gitignored, so the suite skips cleanly without it).
//
//   node tests/test_smb_meta.cjs
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {parse, HEADER, WIDTH, HEIGHT, ICON_BYTES} = require('../tools/smb-meta.cjs');

const TOOL = path.join(__dirname, '..', 'tools', 'smb-meta.cjs');
const SAMPLE = path.join(__dirname, '..', 'saves/all/SmileBASIC-4-demo/f/###/META');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smb-meta-'));
let passes = 0, failures = 0;
const test = (name, fn) => {
  try { fn(); passes++; console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + '\n      ' + error.message); }
};
const run = (args) => {
  try { return {code: 0, out: execFileSync(process.execPath, [TOOL, ...args], {encoding: 'utf8'})}; }
  catch (error) { return {code: error.status, out: (error.stdout || '') + (error.stderr || '')}; }
};

const synthetic = () => {
  // 0x70 header + one 40x69 BGRA icon, with the tag and a name in the icon's first
  // pixels exactly as measured on the console.
  const buffer = Buffer.alloc(HEADER + ICON_BYTES);
  buffer.writeUInt32LE(0x40004, 0);
  buffer.writeUInt32LE(ICON_BYTES, 8);
  Buffer.from('PCPM0005', 'latin1').copy(buffer, 0x70);
  Buffer.from('[WORKSPACE]\0', 'utf16le').copy(buffer, 0x78);
  return buffer;
};

test('synthetic META parses with the measured layout', () => {
  const file = path.join(tmp, 'synthetic.bin');
  fs.writeFileSync(file, synthetic());
  const info = parse(fs.readFileSync(file));
  assert.strictEqual(info.size, HEADER + ICON_BYTES);
  assert.strictEqual(info.name, '[WORKSPACE]');
  assert.strictEqual(info.nameOffset, 0x78);
  assert.strictEqual(info.nameCapacity, 22);
  assert.deepStrictEqual(info.problems, []);
});

test('a short name is written and the file size is unchanged', () => {
  const file = path.join(tmp, 'short.bin');
  const original = synthetic();
  fs.writeFileSync(file, original);
  const r = run(['name', file, 'HOMEBREW']);
  assert.strictEqual(r.code, 0, r.out);
  const after = fs.readFileSync(file);
  assert.strictEqual(after.length, original.length);
  assert.strictEqual(parse(after).name, 'HOMEBREW');
});

test('the slot does not shrink after a shorter name', () => {
  const file = path.join(tmp, 'shrink.bin');
  fs.writeFileSync(file, synthetic());
  assert.strictEqual(run(['name', file, 'AB']).code, 0);
  const info = parse(fs.readFileSync(file));
  assert.strictEqual(info.nameCapacity, 22, 'capacity must stay the block size');
  assert.strictEqual(run(['name', file, 'ABCDEFGHIJK']).code, 0,
    'an 11-character name must still fit after a 2-character one');
});

test('12 characters is refused without --allow-overlap', () => {
  const file = path.join(tmp, 'long.bin');
  const before = synthetic();
  fs.writeFileSync(file, before);
  const r = run(['name', file, 'ABCDEFGHIJKL']);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /11 UTF-16 characters/);
  assert.deepStrictEqual(fs.readFileSync(file), before, 'a refused write must not touch the file');
});

test('--allow-overlap writes past the block and keeps the size', () => {
  const file = path.join(tmp, 'overlap.bin');
  fs.writeFileSync(file, synthetic());
  const r = run(['name', file, 'HOMEBREWLAUNCHER', '--allow-overlap']);
  assert.strictEqual(r.code, 0, r.out);
  const after = fs.readFileSync(file);
  assert.strictEqual(after.length, HEADER + ICON_BYTES);
  assert.strictEqual(parse(after).name, 'HOMEBREWLAUNCHER');
});

if (fs.existsSync(SAMPLE)) {
  test('the real console sample parses as 11152 bytes, 40x69, name [WORKSPACE]', () => {
    const info = parse(fs.readFileSync(SAMPLE));
    assert.strictEqual(info.size, 11152);
    assert.strictEqual(info.icon.width, WIDTH);
    assert.strictEqual(info.icon.height, HEIGHT);
    assert.strictEqual(info.name, '[WORKSPACE]');
    assert.strictEqual(info.declaredPayload, ICON_BYTES);
  });

  test('writing the real sample changes only the name block', () => {
    const file = path.join(tmp, 'real.bin');
    const original = fs.readFileSync(SAMPLE);
    fs.writeFileSync(file, original);
    assert.strictEqual(run(['name', file, 'HOMEBREW']).code, 0);
    const after = fs.readFileSync(file);
    assert.strictEqual(after.length, original.length);
    const blockEnd = 0x90;                       // tag + 24-byte name block
    for (let i = 0; i < original.length; i++) {
      if (i >= 0x70 && i < blockEnd) continue;
      if (original[i] !== after[i]) throw Error('byte 0x' + i.toString(16) + ' changed outside the name block');
    }
  });
} else {
  console.log('skip  real-sample cases (no ' + SAMPLE + ')');
}

fs.rmSync(tmp, {recursive: true, force: true});
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
