const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const layout = require('./sdk-thread-layout.v1.2.1.json');
const dumpPath = process.env.GC_SDK_CODE_DUMP ||
  (process.env.GC_PROFILE_DIR ? path.join(process.env.GC_PROFILE_DIR, 'sdk-v1.2.1-code.bin') : null);

function word(bytes, name) {
  const item = layout.evidence[name];
  assert.equal(bytes.subarray(item.offset, item.offset + 4).toString('hex'), item.bytes, name);
  return bytes.readUInt32LE(item.offset);
}

function addOffset(instruction) {
  return ((instruction >>> 10) & 0xfff) << (((instruction >>> 22) & 1) ? 12 : 0);
}

function pairOffset(instruction) {
  const immediate = (instruction >>> 15) & 0x7f;
  return (immediate >= 64 ? immediate - 128 : immediate) * 8;
}

function adrpPage(instruction, pc) {
  let immediate = (((instruction >>> 5) & 0x7ffff) << 2) | ((instruction >>> 29) & 3);
  if (immediate & 0x100000) immediate -= 0x200000;
  return (pc & ~0xfff) + immediate * 0x1000;
}

test('Gravity Circuit thread layout agrees with its captured SDK code', (t) => {
  if (!dumpPath || !fs.existsSync(dumpPath)) {
    t.skip('set GC_SDK_CODE_DUMP to the captured Gravity Circuit SDK code dump');
    return;
  }
  const bytes = fs.readFileSync(dumpPath);
  assert.equal(bytes.length, layout.sdkCode.size);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), layout.sdkCode.sha256);
  for (const name of Object.keys(layout.evidence)) word(bytes, name);

  const globalPage = adrpPage(word(bytes, 'managerPage'), layout.evidence.managerPage.offset);
  const globalLoad = word(bytes, 'managerLoad');
  assert.equal(globalPage + (((globalLoad >>> 10) & 0xfff) * 8), layout.manager.globalPointerOffset);
  assert.equal(addOffset(word(bytes, 'managerBias')), layout.manager.bias);
  assert.equal(addOffset(word(bytes, 'sentinelAddress')), layout.manager.listSentinelOffset);
  assert.equal(((word(bytes, 'sentinelSelfLink') >>> 10) & 0xfff) * 8,
    layout.manager.listSentinelOffset);

  assert.equal(pairOffset(word(bytes, 'nodeSelfLinks')), layout.manager.nextOffset);
  assert.equal(((word(bytes, 'nodeNext') >>> 10) & 0xfff) * 8, layout.manager.nextOffset);
  assert.equal(((word(bytes, 'nodePrevious') >>> 10) & 0xfff) * 8,
    layout.manager.previousOffset);
  assert.equal(pairOffset(word(bytes, 'nodeArgument')) + 8, layout.node.argumentOffset);
  assert.equal(pairOffset(word(bytes, 'nodeEntry')), layout.node.entryOffset);
  assert.equal(((word(bytes, 'storeKernelHandle') >>> 10) & 0xfff) * 4,
    layout.node.kernelHandleOffset);
  assert.equal(((word(bytes, 'loadKernelHandle') >>> 10) & 0xfff) * 4,
    layout.node.kernelHandleOffset);

  const argumentRegister = word(bytes, 'pthreadArgumentRegister');
  const entryRegister = word(bytes, 'pthreadEntryRegister');
  assert.equal((argumentRegister & 31) | (((argumentRegister >>> 16) & 31) << 5), 20 | (3 << 5));
  assert.equal((entryRegister & 31) | (((entryRegister >>> 16) & 31) << 5), 21 | (2 << 5));
  assert.equal(addOffset(word(bytes, 'pthreadNodeAddress')), layout.pthread.nodeOffset);
  const entryArgumentPair = word(bytes, 'pthreadEntryArgument');
  assert.equal(entryArgumentPair & 31, 20);
  assert.equal((entryArgumentPair >>> 10) & 31, 21);
  assert.equal(pairOffset(entryArgumentPair), layout.pthread.argumentOffset);
  assert.equal(pairOffset(entryArgumentPair) + 8, layout.pthread.entryOffset);
});
