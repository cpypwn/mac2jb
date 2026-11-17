'use strict';

// Balatro write-size cap probe. The CivSwitch reference flips the canary only
// when the commit IStorage::Write size is 8 MiB; Gravity Circuit rejects >960 KiB.
// This issues IStorage::Write (opcode 1) on an opened save file at several sizes
// and reports the max size that returns result 0 plus each failure's canonical
// result.
const {packet, response} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {pathPacket} = require('../civswitch/fs-kit/port/engine/switch2/memory/paths.cjs');
const {markerCleanupVerified, markerCleanupSummary} =
  require('./fs-marker-cleanup.cjs');

const SIZES = [0xF0000, 0x100000, 0x200000, 0x400000, 0x800000];
const PATH_BYTES = 0x301;
const BUFFER_BYTES = 0x2400000;

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function check(condition, message) {
  if (!condition) throw Error(`Balatro write-size: ${message}`);
}

async function runWriteSize({preflight, adapter, executeSource, host,
  onPhase = () => {}}) {
  const prepared = await adapter.prepare(preflight);
  const transport = prepared.transport;
  const cloneHandle = prepared.clone.handle;
  const borrowed = transport.evidence.sessionManager.borrowedHandle;

  async function send(handle, bytes, label) {
    check(transport.ownedHandles.has(handle) && handle !== borrowed &&
      Buffer.isBuffer(bytes) && bytes.length === 256,
    `${label} targeted an unowned handle or packet`);
    const raw = await transport.sendPacket(handle, bytes);
    return response(raw);
  }

  onPhase('allocate-write-buffer');
  const allocSource = [
    'local ffi=require(\'ffi\')',
    'local buf=ffi.new(\'uint8_t[?]\',' + BUFFER_BYTES + ')',
    'local raw=tonumber(ffi.cast(\'uintptr_t\',buf))',
    'local aligned=raw+0x100+(0x1000-(raw+0x100)%0x1000)%0x1000',
    'return string.format(\'0x%x\',aligned)',
  ].join('\n');
  const allocReply = await executeSource({host, port: 9026,
    source: allocSource, timeoutMs: 30000});
  const line = allocReply.trimEnd().split('\n')
    .map(item => item.trim()).find(item => /^->\s*0x[0-9a-f]+$/.test(item));
  check(line, 'write buffer allocation did not return an address');
  const dataAddress = Number.parseInt(line.replace(/^->\s*/, ''), 16);
  check(Number.isSafeInteger(dataAddress) && dataAddress % 0x1000 === 0 &&
    dataAddress >= 0x1000 && dataAddress + BUFFER_BYTES < 2 ** 39,
  'write buffer address is not a bounded page-aligned user region');

  const pathname = '/bal-write-size-test';
  const pathBytes = Buffer.alloc(PATH_BYTES);
  pathBytes.write(pathname, 0, 'ascii');
  await transport.native.write(transport.pathAddress, pathBytes);

  const results = [];
  for (const size of SIZES) {
    onPhase(`write-0x${size.toString(16)}`);
    const create = await send(cloneHandle,
      pathPacket(0, Buffer.concat([u64(0), u64(size)]),
        transport.pathAddress, PATH_BYTES), 'create');
    check(create.result === 0, `create file failed with ${create.result}`);
    const open = await send(cloneHandle,
      pathPacket(8, u32(3), transport.pathAddress, PATH_BYTES), 'open');
    check(open.result === 0 && open.moves.length === 1 && open.copies.length === 0,
      `open file failed with ${open.result}`);
    const fileHandle = open.moves[0];
    check(Number.isInteger(fileHandle) && fileHandle > 0 &&
      fileHandle < 0xffff8000 && fileHandle !== cloneHandle &&
      fileHandle !== borrowed && !transport.ownedHandles.has(fileHandle),
    'file handle was not a fresh owned move');
    transport.ownedHandles.add(fileHandle);
    try {
      await transport.native.write(dataAddress, Buffer.alloc(0x10000, 0x66));
      const write = await send(fileHandle,
        packet(1, Buffer.concat([u64(0), u64(0), u64(size)]),
          {send: [{address: dataAddress, size, mode: 1}]}), 'write');
      results.push({size, result: write.result,
        canonicalResult: write.canonicalResult});
    } finally {
      await transport.closeOwned(fileHandle);
    }
    const del = await send(cloneHandle,
      pathPacket(1, Buffer.alloc(0), transport.pathAddress, PATH_BYTES),
      'delete');
    check(del.result === 0, `delete file failed with ${del.result}`);
    const commit = await send(cloneHandle, packet(10), 'commit');
    check(commit.result === 0, `commit failed with ${commit.result}`);
  }

  const accepted = results.filter(row => row.result === 0)
    .map(row => row.size);
  const maxAccepted = accepted.length ? Math.max(...accepted) : null;
  const cleaned = await adapter.cleanup(prepared);
  check(cleaned?.ownedHandlesClosed === true &&
    markerCleanupVerified(cleaned) &&
    cleaned.borrowedSession === 'preserved' &&
    cleaned.arena === 'released', 'owned resource cleanup was not verified');
  return {writeSizeResults: results, maxAcceptedSize: maxAccepted,
    cleanup: 'verified', ...markerCleanupSummary(cleaned),
    status: maxAccepted === 0x800000 ?
      'Balatro accepts the 8 MiB IStorage write' :
      `Balatro write cap is below 8 MiB (max accepted ${maxAccepted === null ? 'none' : '0x' + maxAccepted.toString(16)})`};
}

module.exports = {SIZES, runWriteSize};
