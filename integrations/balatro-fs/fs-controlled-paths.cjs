const {packet} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {pathPacket} = require('../civswitch/fs-kit/port/engine/switch2/memory/paths.cjs');
const {content} = require('./marker-content-control.cjs');
const {paths} = require('./marker-path-control.cjs');
const {relativePath} = require('./clone-control.cjs');
const {descriptorInput, belongsToTransport} = require('./fs-attempt-packets.cjs');

function quarantine(error) {
  const wrapped = new Error('Balatro controlled path read is uncertain; retain resources',
    {cause: error});
  wrapped.resourceStateUncertain = true;
  return wrapped;
}

function u32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}

async function readPaddedClone({transport, clone, nonce, which}) {
  belongsToTransport(clone, transport, 'clone');
  const descriptor = descriptorInput(nonce, which);
  const missing = Number.parseInt(transport.evidence.absentPathResult, 16);
  let openedHandle;
  try {
    await transport.native.write(transport.pathAddress, descriptor);
    const readback = await transport.native.read(transport.pathAddress,
      descriptor.length);
    if (!Buffer.isBuffer(readback) || !readback.equals(descriptor)) {
      throw new Error('padded path descriptor readback changed');
    }
    const kind = await transport.sendOwned(clone.handle,
      pathPacket(7, Buffer.alloc(0), transport.pathAddress, 0x800));
    if (kind.result === missing) {
      if (which !== 'absent' || kind.moves.length || kind.copies.length) {
        throw new Error('padded marker unexpectedly absent');
      }
      return {result: missing, type: null, bytes: null};
    }
    if (which !== 'marker' || kind.result !== 0 || kind.moves.length ||
        kind.copies.length || kind.data.length < 4 ||
        kind.data.readUInt32LE(0) !== 1) {
      throw new Error('padded path type changed');
    }
    const opened = await transport.sendOwned(clone.handle,
      pathPacket(8, u32(1), transport.pathAddress, 0x800));
    if (opened.result !== 0 || opened.moves.length !== 1 ||
        opened.copies.length !== 0) {
      throw new Error('padded file open did not transfer one handle');
    }
    const handle = opened.moves[0];
    if (!Number.isInteger(handle) || handle <= 0 || handle >= 0xffff8000 ||
        handle === clone.handle ||
        handle === transport.evidence.sessionManager.borrowedHandle ||
        transport.ownedHandles.has(handle)) {
      throw new Error('padded file handle is not distinct');
    }
    openedHandle = handle;
    transport.ownedHandles.add(handle);
    const size = await transport.sendOwned(handle, packet(4));
    if (size.result || size.moves.length || size.copies.length ||
        size.data.length < 8 || size.data.readBigUInt64LE(0) !== 16n) {
      throw new Error('padded file is not exactly 16 bytes');
    }
    await transport.native.write(transport.dataAddress, Buffer.alloc(16));
    const read = await transport.sendOwned(handle,
      packet(0, Buffer.concat([u64(0), u64(0), u64(16)]),
        {receive: [{address: transport.dataAddress, size: 16, mode: 1}]}));
    if (read.result || read.moves.length || read.copies.length ||
        read.data.length < 8 || read.data.readBigUInt64LE(0) !== 16n) {
      throw new Error('padded file read did not return 16 bytes');
    }
    const bytes = await transport.native.read(transport.dataAddress, 16);
    if (!Buffer.isBuffer(bytes) || !bytes.equals(content(nonce))) {
      throw new Error('padded file content changed');
    }
    return {result: 0, type: 1, bytes};
  } catch (error) {
    throw quarantine(error);
  } finally {
    if (openedHandle !== undefined) {
      try {
        await transport.closeOwned(openedHandle);
      } catch (error) {
        throw quarantine(error);
      }
    }
  }
}

async function readControlledPaths({transport, clone, nonce}) {
  belongsToTransport(clone, transport, 'clone');
  const owned = paths(nonce);
  try {
    const original = {
      marker: await transport.readOriginal(owned.marker),
      absent: await transport.readOriginal(owned.absent),
    };
    const cloned = {
      marker: await transport.readClone(clone.handle, relativePath(owned.marker)),
      absent: await transport.readClone(clone.handle, relativePath(owned.absent)),
    };
    const padded = {
      marker: await readPaddedClone({transport, clone, nonce, which: 'marker'}),
      absent: await readPaddedClone({transport, clone, nonce, which: 'absent'}),
    };
    return {original, cloned, padded, explicitSaveWrites: 0};
  } catch (error) {
    if (error.resourceStateUncertain === true) throw error;
    throw quarantine(error);
  }
}

module.exports = {readPaddedClone, readControlledPaths};
