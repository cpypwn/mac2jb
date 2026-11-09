'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {metadataWindow} = require('./metadata-window.cjs');

test('first-page link keeps the established 16 KiB probe', () => {
  const base = 0x6000000000;
  assert.deepEqual(metadataWindow(base + 0x978), {
    address: base, length: 0x4000, anchorOffset: 0x978,
    originalBlockOffset: 0x978, selection: 'observed-link',
  });
});

test('later-page link probes only its verified 4 KiB page', () => {
  const base = 0x6000000000;
  assert.deepEqual(metadataWindow(base + 0x2978), {
    address: base + 0x2000, length: 0x1000, anchorOffset: 0x978,
    originalBlockOffset: 0x2978, selection: 'observed-link',
  });
  assert.equal(metadataWindow(base + 0x2978, '0').length, 0x4000);
  assert.equal(metadataWindow(base + 0x978, '1').length, 0x1000);
});

test('invalid overrides and addresses fail closed', () => {
  assert.throws(() => metadataWindow(0), /canonical/);
  assert.throws(() => metadataWindow(0x6000000978, 'yes'), /must be 0 or 1/);
});
