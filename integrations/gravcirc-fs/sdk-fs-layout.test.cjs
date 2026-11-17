const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const layout = require('./sdk-fs-layout.v1.2.1.json');
const profileDir = process.env.GC_PROFILE_DIR;
const codePath = profileDir ? path.join(profileDir, 'sdk-v1.2.1-code.bin') : null;
const dataPath = profileDir ? path.join(profileDir, 'sdk-v1.2.1-data.bin') : null;

function adrpPage(instruction, pc) {
  assert.equal((instruction & 0x9f000000) >>> 0, 0x90000000);
  let immediate = (((instruction >>> 5) & 0x7ffff) << 2) | ((instruction >>> 29) & 3);
  if (immediate & 0x100000) immediate -= 0x200000;
  return (pc & ~0xfff) + immediate * 0x1000;
}

function addImmediate(instruction) {
  assert.equal(instruction & 0x7f000000, 0x11000000);
  return ((instruction >>> 10) & 0xfff) << (((instruction >>> 22) & 1) ? 12 : 0);
}

function pointer(data, offset) {
  return Number(data.readBigUInt64LE(offset - layout.sdkData.offset));
}

function verifiedOffset(code, name) {
  const entry = layout.verifiedFunctions.find(item => item.name === name);
  assert.ok(entry, name);
  assert.equal(code.subarray(entry.offset, entry.offset + entry.bytes.length / 2).toString('hex'), entry.bytes, name);
  return entry.offset;
}

test('Gravity Circuit FS offsets match the captured SDK code and data', (t) => {
  if (!codePath || !dataPath || !fs.existsSync(codePath) || !fs.existsSync(dataPath)) {
    t.skip('set GC_PROFILE_DIR to the captured Gravity Circuit SDK dump directory');
    return;
  }
  const code = fs.readFileSync(codePath);
  const data = fs.readFileSync(dataPath);
  assert.equal(code.length, layout.sdkCode.size);
  assert.equal(data.length, layout.sdkData.size);
  assert.equal(crypto.createHash('sha256').update(code).digest('hex'), layout.sdkCode.sha256);
  assert.equal(crypto.createHash('sha256').update(data).digest('hex'), layout.sdkData.sha256);
  for (const entry of layout.verifiedFunctions) verifiedOffset(code, entry.name);

  for (const [name, displacement] of [['detail.Register', 12], ['detail.Find', 16]]) {
    const pc = verifiedOffset(code, name) + displacement;
    assert.equal(adrpPage(code.readUInt32LE(pc), pc) + addImmediate(code.readUInt32LE(pc + 4)),
      layout.mountTable.offset);
  }

  const constructor = verifiedOffset(code, 'FileSystemAccessor.constructor');
  assert.equal(addImmediate(code.readUInt32LE(constructor + 24)), layout.mountTable.nodeNextOffset);
  const table = layout.mountTable.offset;
  const first = pointer(data, table + layout.mountTable.headNextOffset);
  const last = pointer(data, table);
  assert.ok(first > 0 && first < 2 ** 39 && last > 0 && last < 2 ** 39 && first !== last);
  assert.equal(layout.mountTable.nodeToAccessorBias, -8);
  assert.equal(layout.mountTable.accessorNameOffset, 24);
  assert.equal(layout.mountTable.accessorImplementationOffset, 40);

  const getter = verifiedOffset(code, 'detail.GetFileSystemProxyServiceObject');
  const initPc = getter + 28;
  assert.equal(adrpPage(code.readUInt32LE(initPc), initPc) + addImmediate(code.readUInt32LE(initPc + 4)),
    layout.proxy.initializedOffset);
  const globalLoad = code.readUInt32LE(getter + 48);
  const globalPagePc = getter + 40;
  assert.equal(adrpPage(code.readUInt32LE(globalPagePc), globalPagePc) +
    (((globalLoad >>> 10) & 0xfff) * 8), layout.proxy.globalOffset);
  assert.ok(data[layout.proxy.initializedOffset - layout.sdkData.offset] & 1);
  assert.equal(pointer(data, layout.proxy.globalOffset) - layout.sdkData.captureSdkBase,
    layout.proxy.objectOffset);
  assert.equal(pointer(data, layout.proxy.objectOffset) - layout.sdkData.captureSdkBase,
    layout.proxy.vtableOffset);
  assert.equal(pointer(data, layout.proxy.objectOffset + layout.proxy.managerPointerOffset) -
    layout.sdkData.captureSdkBase, layout.proxy.managerOffset);
  assert.equal(data.readUInt32LE(layout.proxy.objectOffset + layout.proxy.objectIdOffset -
    layout.sdkData.offset), layout.proxy.capturedObjectId);
  assert.equal(data.readUInt32LE(layout.proxy.managerOffset + layout.proxy.managerStateSizeOffset -
    layout.sdkData.offset), layout.proxy.managerStateSize);
  assert.equal(data.readUInt32LE(layout.proxy.managerOffset + layout.proxy.managerStateOffset -
    layout.sdkData.offset), layout.proxy.managerStateValue);

  for (const item of Object.values(layout.observedVtables)) {
    assert.deepEqual(item.firstEightEntryCodeOffsets,
      Array.from({length: 8}, (_, index) => pointer(data, item.offset + index * 8) -
        layout.sdkData.captureSdkBase));
    assert.ok(item.firstEightEntryCodeOffsets.every(offset => offset >= 0 && offset < code.length));
  }
});
