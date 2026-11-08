'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const launcherDir = path.resolve(__dirname, '../vendor/MintBrew/homebrew-launcher');

test('MintBrew imports inventory has valid retail and demo 4.4.6 tables', () => {
  const displayRetail = JSON.parse(fs.readFileSync(path.join(launcherDir, 'display-imports.json'), 'utf8'));
  const displayDemo = JSON.parse(fs.readFileSync(path.join(launcherDir, 'display-imports-demo.json'), 'utf8'));
  const inputRetail = JSON.parse(fs.readFileSync(path.join(launcherDir, 'input-imports.json'), 'utf8'));
  const inputDemo = JSON.parse(fs.readFileSync(path.join(launcherDir, 'input-imports-demo.json'), 'utf8'));

  assert.equal(Object.keys(displayRetail).length, 8);
  assert.equal(Object.keys(displayDemo).length, 8);
  assert.deepEqual(Object.keys(displayRetail).sort(), Object.keys(displayDemo).sort());

  for (const [name, entry] of Object.entries(displayDemo)) {
    assert(Number.isSafeInteger(entry.slot) && entry.slot > 0, `Invalid slot for ${name}`);
    assert(Number.isSafeInteger(entry.plt) && entry.plt > 0, `Invalid plt for ${name}`);
    assert(/^[0-9a-f]{32}$/.test(entry.bytes), `Invalid bytes for ${name}`);
  }

  assert.equal(Object.keys(inputRetail).length, 7);
  assert.equal(Object.keys(inputDemo).length, 7);
  assert.deepEqual(Object.keys(inputRetail).sort(), Object.keys(inputDemo).sort());

  for (const [name, entry] of Object.entries(inputDemo)) {
    assert(Number.isSafeInteger(entry.slot) && entry.slot > 0, `Invalid slot for ${name}`);
  }
});

test('inspect-display and inspect-input modules export main and compile cleanly', () => {
  const inspectDisplay = require(path.join(launcherDir, 'inspect-display.cjs'));
  const inspectInput = require(path.join(launcherDir, 'inspect-input.cjs'));
  assert.equal(typeof inspectDisplay.main, 'function');
  assert.equal(typeof inspectInput.main, 'function');
});

test('decodePltSlot correctly decodes ARM64 PLT stubs for Demo 4.4.6', () => {
  const {decodePltSlot} = require(path.join(launcherDir, 'inspect-input.cjs'));
  // Demo PAD PLT stub at 2738128 (mainBase + 2738128)
  const bytes = Buffer.from('703900b011de44f910e2269120021fd6', 'hex');
  const mainBase = 0x49200000;
  const pc = mainBase + 2738128;
  const decodedSlot = decodePltSlot(bytes, 0, pc);
  assert.equal(decodedSlot, mainBase + 10262968);
});
