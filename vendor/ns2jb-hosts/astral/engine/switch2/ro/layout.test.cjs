'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {capturedLayout, sdkPageHeader} = require('./layout.cjs');

function fixture(vtableShift) {
  const range = {address: 0x6000000000, length: 0x4d8000};
  const bytes = Buffer.alloc(range.length);
  const sdk = range.address + 0x500000;
  const rootVptr = sdk - 0xf38be0 - vtableShift;
  const domain = range.address + 0x400;
  const manager = range.address + 0x1000;
  const table = range.address + 0x2000;
  const object = range.address + 0x3000;
  const put = (address, offset, value) => bytes.writeBigUInt64LE(BigInt(value), address - range.address + offset);
  put(domain, 0, rootVptr + 0x28e0);
  put(domain, 8, rootVptr + 0x2938);
  put(domain, 0x18, manager);
  bytes.writeUInt32LE(0x4000, manager - range.address + 0x10);
  put(manager, 0x18, table);
  put(table, 0x18, domain);
  put(table, 0x20, object);
  put(table, 0x28, rootVptr + 0x5880);
  const page = Buffer.alloc(0x1000);
  page.writeBigUInt64LE(BigInt(sdk + 0x10000), 0x830);
  page.writeBigUInt64LE(BigInt(sdk + 0x668), 0x838);
  page.writeUInt32LE(25, 0x848);
  return {range, bytes, sdk, rootVptr, domain, manager, page};
}

for (const shift of [0, 0x4000]) {
  test(`keeps SDK page fixed with vtable shift 0x${shift.toString(16)}`, () => {
    const f = fixture(shift);
    const layout = capturedLayout(f.bytes, f.range);
    assert.equal(layout.sdk, f.sdk);
    assert.equal(layout.rootVptr, f.rootVptr);
    assert.equal(layout.manager, f.manager);
    assert.equal(layout.target.domain, f.domain);
    assert.deepEqual(sdkPageHeader(f.page, f.sdk), {first: f.sdk + 0x10000, count: 25});
  });
}

test('rejects a metadata page without the thread-ring backlink', () => {
  const f = fixture(0x4000);
  f.page.writeBigUInt64LE(0n, 0x838);
  assert.throws(() => sdkPageHeader(f.page, f.sdk), /thread-ring header/);
});
