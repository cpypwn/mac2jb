// Game-mount helper derived from IZ2S-Platform/OunceCake (GPL-2.0).
// See lib/game-files/COPYING and https://github.com/byizmysh/IZ2S-Platform
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { success, pathRequest, idBytes, resultError, cleanup, closeHandles, throwIfCancelled } = require('./protocol.cjs');
const { discoverUpdates, discoverDlc, resolveProgramContent, resolveDlcContent, programMatchesApplication } = require('./content.cjs');
const { createProgramMounts, prepareInstalledLicense } = require('./program.cjs');

// ncm mounts + metadata used for getting the ftp server ready

const MAX_CHUNK = 0x40000;
const safeSize = (n) => { // lol, ai put this in. in what situation would this ever happen
  return Number(n);
};

function createGameFiles(attachment) {
  const { openCode, openUpdate } = createProgramMounts(attachment);
  let originalSource;
  const { s, root, domain, filesystem, service } = attachment;

  const send = async (label, handle, bytes) => success(await domain.send(s, label, handle, bytes), label);

  async function open({ title, storage, section = 'romfs', update, dlc }) {
    let source;
    let mounted;

    try {
      source = await (dlc ? resolveDlcContent : resolveProgramContent)({
        s,
        domain,
        service,
        title,
        storage: update?.storage ?? dlc?.storage ?? storage,
        update,
        dlc,
      });

      const { contentPath, attributes } = source;
      const filename = Buffer.alloc(0x301);
      filename.write(contentPath);

      if (update || dlc || section === 'exefs') {
        await s.write(s.base + 0x2000, filename);

        const identity = await send(
          'Read selected NCA ProgramId',
          root,
          pathRequest(618, Buffer.from([attributes]), s.base + 0x2000),
        );

        const runtimeId = identity.data.readBigUInt64LE().toString(16).padStart(16, '0');

        if (dlc) {
        } else {
          source.runtimeProgramId = runtimeId;
        }
      }

      let handle;

      if (update) {
        handle = await openUpdate({ title, storage, attributes, source, section, originalSource });
      } else if (section === 'exefs') {
        handle = await openCode({ title: source.runtimeProgramId, storage, attributes, source });
      } else {
        // use type 1 for base romfs, type 6 for dlc
        await s.write(s.base + 0x2000, filename);

        const input = Buffer.alloc(8);
        input[0] = attributes;
        input.writeUInt32LE(dlc ? 6 : 1, 4);

        try {
          handle = domain.oneHandle(
            await send('OpenDataStorageByPath', root, pathRequest(206, input, s.base + 0x2000)),
          );
        } catch (error) {
          if (!dlc && error.nativeResult?.canonical === 0x7d202) error.code = 'GAME_ROMFS_ABSENT';

          throw error;
        }
      }

      mounted = {
        handle,
        kind: section === 'exefs' ? 'filesystem' : 'storage',
        source,
        title,
      };

      if (mounted.kind === 'storage') {
        const reply = success(await s.ipc('Game storage size', handle, 4), 'Game storage size');
        mounted.size = safeSize(reply.data.readBigUInt64LE());
      }

      if (!update && !dlc) originalSource = source;
      return mounted;
    } catch (error) {
      if (source) error.source = source;

      await cleanup([() => closeHandles(s, mounted ? [mounted.handle] : [])], error);
    }
  }

  async function list(mount, path, shouldStop) {

    const mode = Buffer.alloc(4);
    mode.writeUInt32LE(3);

    const handle = domain.oneHandle(
      success(await filesystem.pathMethod(s, mount.handle, 9, path, mode), 'Open game directory'),
    );
    const entries = [];

    try {
      for (;;) {
        if (shouldStop()) {
          throw Object.assign(new Error('FTP preparation cancelled'), { code: 'FTP_CANCELLED' });
        }

        const reply = success(
          await s.ipc('Read game directory', handle, 0, Buffer.alloc(0), {
            receive: [{ address: s.base + 0x6000, size: 32 * 0x310, mode: 0 }],
          }),
          'Read game directory',
        );
        const count = safeSize(reply.data.readBigUInt64LE());

        if (!count) return entries;

        const bytes = await filesystem.verifiedBytes(s, s.base + 0x6000, count * 0x310, { directory: path });

        for (let i = 0; i < count; i++) {
          const row = bytes.subarray(i * 0x310, (i + 1) * 0x310);
          const end = row.subarray(0, 0x301).indexOf(0);

          const name = row.subarray(0, end).toString('utf8');
          const type = row[0x304];
          entries.push({
            name,
            type: type === 1 ? 'file' : 'directory',
            size: safeSize(row.readBigUInt64LE(0x308)),
          });
        }
      }
    } finally {
      await s.close(handle);
    }
  }

  async function read(mount, offset, length) {

    const bytes = length ? await filesystem.readStorage(s, mount.handle, offset, length) : Buffer.alloc(0);
    return bytes;
  }

  async function close(mount) {
    await s.close(mount.handle);
  }

  return {
    open,
    list,
    read,
    close,
  };
}

// pc side romfs metadata reader. used for getting the file list together

const utf8 = new TextDecoder('utf-8', { fatal: true });
const NONE = 0xffffffff;
const MAX_METADATA = 64 * 1024 * 1024;

function checkRomfs(ok, why) {
  if (!ok) throw new Error('Invalid RomFS: ' + why);
}

function integer(value) {
  checkRomfs(value <= BigInt(Number.MAX_SAFE_INTEGER), 'offset exceeds numeric precision');
  return Number(value);
}

function name(bytes, root = false) {
  const value = utf8.decode(bytes);
  checkRomfs((root || value.length > 0) && !/[\/\\\0]/.test(value) && !['.', '..'].includes(value), 'entry name');
  return value;
}

async function readRomfs(read, storageSize) {
  checkRomfs(Number.isSafeInteger(storageSize) && storageSize >= 0x50, 'storage size');

  async function exact(offset, length) {
    checkRomfs(
      Number.isSafeInteger(offset) && offset >= 0 && length >= 0 && offset + length <= storageSize,
      'range',
    );

    const parts = [];

    for (let at = 0; at < length; at += 0x40000) {
      const n = Math.min(0x40000, length - at);
      const part = await read(offset + at, n);
      parts.push(part);
    }

    return Buffer.concat(parts);
  }

  const header = await exact(0, 0x50);
  const h = Array.from({ length: 10 }, (_, i) => integer(header.readBigUInt64LE(i * 8)));
  checkRomfs(h[0] === 0x50, 'header size');

  const ranges = [];

  for (let i = 1; i < 9; i += 2) {
    checkRomfs(
      h[i] >= 0x50 &&
        h[i + 1] <= MAX_METADATA &&
        Number.isSafeInteger(h[i] + h[i + 1]) &&
        h[i] + h[i + 1] <= storageSize,
      'metadata extent',
    );
    ranges.push([h[i], h[i] + h[i + 1]]);
  }

  ranges.sort((a, b) => a[0] - b[0]);
  checkRomfs(
    ranges.every((r, i) => !i || r[0] >= ranges[i - 1][1]),
    'overlapping metadata',
  );
  checkRomfs(h[4] >= 24 && h[4] + h[8] <= MAX_METADATA && h[9] >= 0x50 && h[9] <= storageSize, 'metadata budget');

  const dirs = await exact(h[3], h[4]);
  const files = await exact(h[7], h[8]);

  const dirSlots = new Uint8Array(Math.ceil(dirs.length / 4));
  const fileSlots = new Uint8Array(Math.ceil(files.length / 4));

  function entry(table, offset, fixed, root = false) {
    checkRomfs(offset % 4 === 0 && offset + fixed <= table.length, 'entry offset');

    const n = table.readUInt32LE(offset + fixed - 4);
    checkRomfs(n <= 0x300 && offset + fixed + n <= table.length, 'entry length');

    // make sure our offsets for reading point to the *start* of each entry and not somewhere inside one
    const slots = table === dirs ? dirSlots : fileSlots;
    const first = offset / 4;
    const end = Math.ceil((offset + fixed + n) / 4);
    checkRomfs(slots[first] !== 2, 'overlapping entries');

    if (slots[first] !== 1) {
      for (let i = first; i < end; i++) {
        checkRomfs(!slots[i], 'overlapping entries');
      }

      slots.fill(2, first, end);
      slots[first] = 1;
    }

    return {
      name: name(table.subarray(offset + fixed, offset + fixed + n), root),
      bytes: table.subarray(offset, offset + fixed),
    };
  }

  const output = [];
  const stack = [{ offset: 0, path: '/', parent: 0 }];
  const seenDirs = new Set([0]);
  const seenFiles = new Set();

  while (stack.length) {
    const dir = stack.pop();
    const current = entry(dirs, dir.offset, 24, dir.offset === 0);

    if (dir.offset) checkRomfs(current.bytes.readUInt32LE() === dir.parent, 'directory parent');

    let child = current.bytes.readUInt32LE(8);
    let file = current.bytes.readUInt32LE(12);

    while (child !== NONE) {
      checkRomfs(!seenDirs.has(child), 'directory cycle or duplicate');
      seenDirs.add(child);

      const e = entry(dirs, child, 24);
      const childPath = dir.path.replace(/\/$/, '') + '/' + e.name;
      output.push({ path: childPath, type: 'directory', size: 0 });
      stack.push({ offset: child, path: childPath, parent: dir.offset });
      child = e.bytes.readUInt32LE(4);
    }

    while (file !== NONE) {
      checkRomfs(!seenFiles.has(file), 'file cycle or duplicate');
      seenFiles.add(file);

      const e = entry(files, file, 32);
      checkRomfs(e.bytes.readUInt32LE() === dir.offset, 'file parent');

      const relative = integer(e.bytes.readBigUInt64LE(8));
      const size = integer(e.bytes.readBigUInt64LE(16));
      const offset = h[9] + relative;
      checkRomfs(Number.isSafeInteger(offset + size) && offset + size <= storageSize, 'file extent');
      checkRomfs(
        !size || ranges.every(([start, end]) => offset + size <= start || offset >= end),
        'file overlaps metadata',
      );
      output.push({ path: dir.path.replace(/\/$/, '') + '/' + e.name, type: 'file', size, offset });
      file = e.bytes.readUInt32LE(4);
    }
  }

  return output;
}

module.exports = { createGameFiles, readRomfs };
