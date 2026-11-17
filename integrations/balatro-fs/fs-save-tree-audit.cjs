const {createHash} = require('node:crypto');
const {packet} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const {BalatroCloneTransport} = require('./clone-transport.cjs');

const ENTRY_BYTES = 0x310;
const ENTRIES_PER_READ = 4;
const READ_BYTES = 0x10000;
const LIMITS = Object.freeze({entries: 1024, files: 512, directories: 256,
  depth: 64, fileBytes: 16 * 1024 * 1024, totalBytes: 32 * 1024 * 1024});
const LOG_PATH = '/.lovegame/bl_log.txt';

function check(condition, reason) {
  if (!condition) throw Error(`Balatro save-tree audit: ${reason}`);
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

function makePathPacket(command, input, address) {
  check([8, 9].includes(command) && Buffer.isBuffer(input) &&
    Number.isSafeInteger(address) && address > 0 && address < 2 ** 39,
  'invalid path request');
  const a = BigInt(address);
  const bytes = packet(command, input);
  bytes.writeUInt32LE(4 | 1 << 16);
  bytes.writeUInt32LE(Number(0x600n << 16n | ((a >> 36n) & 7n) << 6n |
    ((a >> 32n) & 15n) << 12n), 8);
  bytes.writeUInt32LE(Number(a & 0xffffffffn), 12);
  return bytes;
}

function parseEntries(bytes, count) {
  check(Buffer.isBuffer(bytes) && Number.isInteger(count) &&
    count >= 0 && count <= ENTRIES_PER_READ &&
    bytes.length === count * ENTRY_BYTES,
  'directory entry buffer is incomplete');
  const result = [];
  for (let index = 0; index < count; index++) {
    const row = bytes.subarray(index * ENTRY_BYTES, (index + 1) * ENTRY_BYTES);
    const nameField = row.subarray(0, 0x301);
    const end = nameField.indexOf(0);
    check(end > 0 && end <= 0x300, 'directory name lacks a terminator');
    const encoded = nameField.subarray(0, end);
    const name = encoded.toString('utf8');
    check(Buffer.from(name, 'utf8').equals(encoded) &&
      !name.includes('/') && !name.includes('\\') &&
      !name.includes(':') && name !== '.' && name !== '..',
    'directory name is unsafe or not exact UTF-8');
    const type = row[0x304];
    const size = row.readBigUInt64LE(0x308);
    check([0, 1].includes(type) && size <= BigInt(LIMITS.fileBytes),
      'directory type or size is outside the bounded inventory');
    result.push({name, type, size: Number(size)});
  }
  return result;
}

function createOwnedSaveIo(transport, cloneHandle) {
  check(transport instanceof BalatroCloneTransport &&
    transport.initialized === true &&
    Number.isInteger(cloneHandle) &&
    transport.ownedHandles.has(cloneHandle) &&
    cloneHandle !== transport.evidence.sessionManager.borrowedHandle,
  'a verified owned cloned save handle is required');
  const baseline = new Set(transport.ownedHandles);
  const active = new Set();

  function validatePath(path) {
    check(typeof path === 'string' && path.startsWith('/') &&
      Buffer.byteLength(path, 'utf8') < 0x600 &&
      !path.includes('\0') && path !== '/.' && path !== '/..' &&
      !path.includes('\\') && !path.includes(':') &&
      !path.split('/').some((part, index) => index > 0 && path !== '/' &&
        (part === '' || part === '.' || part === '..')),
    'save path is outside the cloned root');
    return path;
  }

  async function open(role, path) {
    validatePath(path);
    const input = role === 'directory' ? u32(3) : u32(1);
    const command = role === 'directory' ? 9 : 8;
    const bytes = Buffer.alloc(0x600);
    bytes.write(path, 0, 'utf8');
    check(Buffer.byteLength(path, 'utf8') < 0x600,
      'encoded save path is too long');
    await transport.native.write(transport.pathAddress, bytes);
    const reply = await transport.sendOwned(cloneHandle,
      makePathPacket(command, input, transport.pathAddress));
    check(reply.result === 0 && reply.copies.length === 0 &&
      reply.moves.length === 1,
    'save open did not transfer one owned handle');
    const handle = reply.moves[0];
    check(Number.isInteger(handle) && handle > 0 && handle < 0xffff8000 &&
      handle !== cloneHandle &&
      handle !== transport.evidence.sessionManager.borrowedHandle &&
      !transport.ownedHandles.has(handle),
    'save open returned an aliased or invalid handle');
    transport.ownedHandles.add(handle);
    const lease = {handle, role, closeAttempted: false};
    active.add(lease);
    return lease;
  }

  function live(lease, role) {
    check(active.has(lease) && lease.role === role &&
      lease.closeAttempted === false &&
      transport.ownedHandles.has(lease.handle),
    'save handle is not an open owned lease');
  }

  return {
    openDirectory: path => open('directory', path),
    openFile: path => open('file', path),
    async readDirectory(lease) {
      live(lease, 'directory');
      const reply = await transport.sendOwned(lease.handle,
        packet(0, Buffer.alloc(0), {receive: [{address: transport.dataAddress,
          size: ENTRIES_PER_READ * ENTRY_BYTES, mode: 0}]}));
      check(reply.result === 0 && reply.copies.length === 0 &&
        reply.moves.length === 0 && reply.data.length >= 8,
      'directory read IPC failed');
      const count = reply.data.readBigUInt64LE();
      check(count <= BigInt(ENTRIES_PER_READ),
        'directory read count exceeded its buffer');
      if (count === 0n) return [];
      return parseEntries(await transport.native.read(transport.dataAddress,
        Number(count) * ENTRY_BYTES), Number(count));
    },
    async fileSize(lease) {
      live(lease, 'file');
      const reply = await transport.sendOwned(lease.handle, packet(4));
      check(reply.result === 0 && reply.copies.length === 0 &&
        reply.moves.length === 0 && reply.data.length >= 8,
      'file-size IPC failed');
      const size = reply.data.readBigUInt64LE();
      check(size <= BigInt(LIMITS.fileBytes), 'file exceeds inventory byte cap');
      return Number(size);
    },
    async readFile(lease, offset, size) {
      live(lease, 'file');
      check(Number.isSafeInteger(offset) && offset >= 0 &&
        Number.isInteger(size) && size > 0 && size <= READ_BYTES,
      'file read exceeds a bounded chunk');
      const input = Buffer.concat([u64(0), u64(offset), u64(size)]);
      const reply = await transport.sendOwned(lease.handle,
        packet(0, input, {receive: [{address: transport.dataAddress,
          size, mode: 1}]}));
      check(reply.result === 0 && reply.copies.length === 0 &&
        reply.moves.length === 0 && reply.data.length >= 8 &&
        reply.data.readBigUInt64LE() === BigInt(size),
      'file read did not return the exact chunk');
      const bytes = await transport.native.read(transport.dataAddress, size);
      check(Buffer.isBuffer(bytes) && bytes.length === size,
        'native file readback was incomplete');
      return bytes;
    },
    async close(lease) {
      check(active.has(lease) && lease.closeAttempted === false &&
        transport.ownedHandles.has(lease.handle),
      'save handle close would replay or target an unowned handle');
      lease.closeAttempted = true;
      await transport.closeOwned(lease.handle);
      active.delete(lease);
    },
    assertClosed() {
      check(active.size === 0 &&
        transport.ownedHandles.size === baseline.size &&
        [...baseline].every(handle => transport.ownedHandles.has(handle)),
      'save inventory left an owned handle open');
    },
  };
}

async function withLease(io, open, path, read) {
  const lease = await open(path);
  let failure;
  try {return await read(lease);} catch (error) {failure = error;}
  finally {
    try {await io.close(lease);} catch (closeError) {
      if (failure) throw new AggregateError([failure, closeError],
        'Balatro inventory read and handle cleanup failed');
      throw closeError;
    }
  }
  throw failure;
}

async function probeSaveRoot({io, path = '/'}) {
  check(io && ['openDirectory', 'readDirectory', 'close', 'assertClosed']
    .every(name => typeof io[name] === 'function') &&
    ['/', '/.lovegame'].includes(path),
  'root protocol probe needs owned directory IO');
  let entries;
  try {
    entries = await withLease(io, io.openDirectory, path, async lease => {
      const batch = await io.readDirectory(lease);
      check(Array.isArray(batch) && batch.length <= ENTRIES_PER_READ,
        'root protocol probe returned an invalid batch');
      return batch;
    });
    io.assertClosed();
  } catch (error) {
    try {io.assertClosed();} catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        'Balatro root probe and owned-handle cleanup failed');
    }
    throw error;
  }
  return {coverage: 'first-root-directory-batch-only', complete: false,
    path, entries};
}

async function snapshotSaveTree({io, logPrefixBytes = null,
  limits = LIMITS}) {
  check(io && ['openDirectory', 'readDirectory', 'openFile', 'fileSize',
    'readFile', 'close', 'assertClosed'].every(name =>
      typeof io[name] === 'function') &&
    Object.keys(LIMITS).every(key => Number.isInteger(limits[key]) &&
      limits[key] > 0 && limits[key] <= LIMITS[key]) &&
    (logPrefixBytes === null || Number.isSafeInteger(logPrefixBytes) &&
      logPrefixBytes >= 0),
  'inventory dependencies or caps are invalid');
  const directories = [];
  const files = Object.create(null);
  const queue = [{path: '/', depth: 0}];
  let entries = 0;
  let totalBytes = 0;
  try {
    while (queue.length) {
      const {path, depth} = queue.shift();
      check(depth <= limits.depth && directories.length < limits.directories,
        'directory depth or count exceeded its cap');
      directories.push(path);
      const children = await withLease(io, io.openDirectory, path,
        async lease => {
          const rows = [];
          for (;;) {
            const batch = await io.readDirectory(lease);
            check(Array.isArray(batch) && batch.length <= ENTRIES_PER_READ,
              'directory reader returned an invalid batch');
            if (!batch.length) break;
            entries += batch.length;
            check(entries <= limits.entries,
              'directory entry count exceeded its cap');
            rows.push(...batch);
          }
          return rows;
        });
      const names = new Set();
      for (const child of children) {
        check(typeof child.name === 'string' && child.name.length > 0 &&
          !child.name.includes('/') && !child.name.includes('\\') &&
          !child.name.includes(':') && child.name !== '.' &&
          child.name !== '..' && !names.has(child.name) &&
          [0, 1].includes(child.type) &&
          Number.isSafeInteger(child.size) && child.size >= 0,
        'directory listing contains an invalid or duplicate entry');
        names.add(child.name);
        const childPath = path === '/' ? `/${child.name}` :
          `${path}/${child.name}`;
        check(Buffer.byteLength(childPath, 'utf8') < 0x600,
          'save path exceeds the IPC path buffer');
        if (child.type === 0) {
          check(child.size === 0, 'directory has an unexpected file size');
          queue.push({path: childPath, depth: depth + 1});
          continue;
        }
        check(Object.keys(files).length < limits.files &&
          child.size <= limits.fileBytes,
        'file count or size exceeded its cap');
        check(totalBytes + child.size <= limits.totalBytes,
          'save content exceeds the total byte cap');
        const file = await withLease(io, io.openFile, childPath,
          async lease => {
            const size = await io.fileSize(lease);
            check(size === child.size ||
              childPath === LOG_PATH && size >= child.size,
              'file size changed between directory listing and open');
            const prefixBytes = childPath === LOG_PATH &&
              logPrefixBytes !== null ? logPrefixBytes : size;
            check(prefixBytes <= size,
              'activity log shrank before its prefix could be audited');
            const hash = createHash('sha256');
            for (let offset = 0; offset < prefixBytes;) {
              const count = Math.min(READ_BYTES, prefixBytes - offset);
              const bytes = await io.readFile(lease, offset, count);
              check(Buffer.isBuffer(bytes) && bytes.length === count,
                'file bytes changed or readback was incomplete');
              hash.update(bytes);
              offset += count;
            }
            return {size, prefixBytes, sha256: hash.digest('hex')};
          });
        totalBytes += file.size;
        check(totalBytes <= limits.totalBytes,
          'save content exceeds the total byte cap');
        files[childPath] = file;
      }
    }
    const logPresent = Object.hasOwn(files, LOG_PATH);
    check(logPresent || logPrefixBytes === null,
      'RPC activity log disappeared after its baseline was recorded');
    io.assertClosed();
    return {coverage: 'bounded-cloned-save-tree', complete: true,
      directories: directories.sort(), files, totalBytes,
      entries, logPath: LOG_PATH, logPresent};
  } catch (error) {
    try {io.assertClosed();} catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        'Balatro inventory and owned-handle cleanup failed');
    }
    throw error;
  }
}

function compareSaveTrees(before, after) {
  check(before?.coverage === 'bounded-cloned-save-tree' &&
    after?.coverage === before.coverage &&
    before.complete === true && after.complete === true &&
    Array.isArray(before.directories) &&
    Array.isArray(after.directories) &&
    before.files && after.files &&
    before.logPath === LOG_PATH && after.logPath === LOG_PATH &&
    before.logPresent === Object.hasOwn(before.files, LOG_PATH) &&
    after.logPresent === Object.hasOwn(after.files, LOG_PATH),
  'two complete cloned-save inventories are required');
  check(before.logPresent === after.logPresent,
    'RPC activity log appeared or disappeared between inventories');
  const changedPaths = [];
  const beforeDirs = new Set(before.directories);
  const afterDirs = new Set(after.directories);
  for (const path of new Set([...beforeDirs, ...afterDirs])) {
    if (beforeDirs.has(path) !== afterDirs.has(path)) changedPaths.push(`save:${path}`);
  }
  for (const path of new Set([...Object.keys(before.files),
    ...Object.keys(after.files)])) {
    const a = before.files[path];
    const b = after.files[path];
    if (path === LOG_PATH) {
      check(a && b && a.prefixBytes === a.size &&
        b.prefixBytes === a.size && b.size >= a.size &&
        b.sha256 === a.sha256,
      'RPC activity log was not append-only');
    } else if (!a || !b || a.size !== b.size ||
      a.prefixBytes !== a.size || b.prefixBytes !== b.size ||
      a.sha256 !== b.sha256) {
      changedPaths.push(`save:${path}`);
    }
  }
  return {coverage: 'bounded-cloned-save-tree', completeSaveTreeVerified: true,
    changedPaths: changedPaths.sort(),
    logGrowthBytes: before.logPresent ?
      after.files[LOG_PATH].size - before.files[LOG_PATH].size : 0,
    logPrefixVerified: before.logPresent,
    logState: before.logPresent ? 'append-only' : 'absent-on-both'};
}

module.exports = {ENTRY_BYTES, ENTRIES_PER_READ, READ_BYTES, LIMITS,
  LOG_PATH, makePathPacket, parseEntries, createOwnedSaveIo,
  probeSaveRoot, snapshotSaveTree, compareSaveTrees};
