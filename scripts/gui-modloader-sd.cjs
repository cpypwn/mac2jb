'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {attachGame} = require('../integrations/ns2jb-modloader/lib/game-files/session.cjs');
const {pathRequest} = require('../integrations/ns2jb-modloader/lib/game-files/protocol.cjs');
const {check, romPath, hashFile} = require('../integrations/ns2jb-modloader/lib/common.cjs');
const {guardSession} = require('../integrations/ns2jb-modloader/lib/game-files/uncertain.cjs');

const ignored = new Set(['.DS_Store', 'Thumbs.db', '.gitkeep']);
const chunkSize = 0x40000;

function modSourceForRun(run, staging) {
  const session = path.basename(run);
  check(/^[A-Za-z0-9_-]{1,100}$/.test(session), 'Invalid modloader session name');
  check(path.dirname(staging) === path.resolve(run), 'The staged mods do not belong to this session');
  const match = /^\.mac2jb-modloader-([A-Za-z0-9_-]{1,64})$/.exec(path.basename(staging));
  check(match, 'Invalid staged mod attempt name');
  return '/ns2jb-modloader';
}

function stagedEntries(staging, source) {
  const entries = [];
  function visit(local, remote) {
    const info = fs.lstatSync(local);
    check(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()),
      'A staged mod changed before SD transfer: ' + local);
    check(Buffer.byteLength(remote) < 0x301, 'SD mod path exceeds the filesystem limit: ' + remote);
    romPath(remote);
    if (info.isDirectory()) {
      entries.push({local, remote, type: 'directory'});
      for (const name of fs.readdirSync(local).sort()) {
        if (!ignored.has(name)) visit(path.join(local, name), remote + '/' + name);
      }
    } else {
      check(Number.isSafeInteger(info.size) && info.size >= 0, 'Invalid staged mod size: ' + local);
      entries.push({local, remote, type: 'file', size: info.size});
    }
  }
  for (const name of ['contents', 'exefs_patches']) {
    const local = path.join(staging, name);
    if (fs.existsSync(local)) visit(local, source + '/' + name);
  }
  return entries;
}

async function createSdTransport(run, connect = attachGame) {
  const a = await connect(run, {guardSession});
  const {s, domain, filesystem} = a;
  let sd;
  try {
    const opened = await s.ipc('Open SD for selected mods', a.root, 18);
    check(!opened.result, 'Cannot open the console SD for mods');
    sd = domain.oneHandle(opened);
  } catch (error) {
    await a.close();
    throw error;
  }
  async function pathCommand(command, remote, input = Buffer.alloc(0)) {
    romPath(remote);
    check((remote === '/ns2jb-modloader' || remote.startsWith('/ns2jb-modloader/')) &&
      Buffer.byteLength(remote) < 0x301 && [0, 2, 7, 8].includes(command),
    'Invalid modloader SD path operation');
    const text = Buffer.alloc(0x304);
    text.write(remote);
    await s.write(s.base + 0x2000, text);
    return domain.send(s, 'Selected mod SD path ' + command, sd,
      pathRequest(command, input, s.base + 0x2000));
  }
  return {
    async type(remote) {
      const result = await pathCommand(7, remote);
      if (result.canonicalResult === 0x202) return 'missing';
      check(!result.result, 'Cannot inspect SD mod path: ' + remote);
      const kind = result.data.readUInt32LE();
      check(kind === 0 || kind === 1, 'Unexpected SD mod path type: ' + remote);
      return kind === 0 ? 'directory' : 'file';
    },
    async mkdir(remote) {
      check(!(await pathCommand(2, remote)).result, 'Cannot create SD mod directory: ' + remote);
    },
    async create(remote, size) {
      const input = Buffer.alloc(16);
      input.writeBigUInt64LE(BigInt(size), 8);
      check(!(await pathCommand(0, remote, input)).result, 'Cannot create SD mod file: ' + remote);
    },
    async write(remote, local, size) {
      const mode = Buffer.alloc(4);
      mode.writeUInt32LE(3);
      const opened = await pathCommand(8, remote, mode);
      check(!opened.result, 'Cannot open SD mod for writing: ' + remote);
      const handle = domain.oneHandle(opened);
      let fd;
      try {
        fd = fs.openSync(local, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        check(fs.fstatSync(fd).size === size, 'Staged mod changed during SD transfer: ' + local);
        const resize = Buffer.alloc(8);
        resize.writeBigUInt64LE(BigInt(size));
        check(!(await s.ipc('Resize selected SD mod', handle, 3, resize)).result,
          'Cannot resize SD mod file: ' + remote);
        const buffer = Buffer.alloc(chunkSize);
        for (let offset = 0; offset < size;) {
          const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
          check(count > 0, 'Short staged mod read: ' + local);
          await s.write(s.base + 0x6000, buffer.subarray(0, count));
          const input = Buffer.alloc(24);
          input.writeBigUInt64LE(BigInt(offset), 8);
          input.writeBigUInt64LE(BigInt(count), 16);
          check(!(await s.ipc('Write selected SD mod', handle, 1, input,
            {send: [{address: s.base + 0x6000, size: count, mode: 1}]})).result,
          'SD mod write failed: ' + remote);
          offset += count;
        }
        check(fs.fstatSync(fd).size === size, 'Staged mod changed during SD transfer: ' + local);
        check(!(await s.ipc('Flush selected SD mod', handle, 2)).result,
          'SD mod flush failed: ' + remote);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (!s.uncertainError) await s.close(handle);
      }
    },
    async digest(remote, size) {
      const opened = await filesystem.openFile(s, sd, remote);
      check(!opened.result, 'Cannot verify SD mod: ' + remote);
      const handle = opened.handle;
      try {
        if (await filesystem.fileSize(s, handle) !== BigInt(size)) return null;
        const hash = crypto.createHash('sha256');
        for (let offset = 0; offset < size; offset += chunkSize) {
          const count = Math.min(chunkSize, size - offset);
          const bytes = await filesystem.readFile(s, handle, offset, count);
          check(bytes.length === count, 'Short SD mod readback: ' + remote);
          hash.update(bytes);
        }
        return hash.digest('hex');
      } finally {
        if (!s.uncertainError) await s.close(handle);
      }
    },
    close: () => a.close()
  };
}

async function uploadSelectedMods(run, staging, transportFactory = createSdTransport) {
  const source = modSourceForRun(run, staging);
  const entries = stagedEntries(staging, source);
  check(entries.some(entry => entry.type === 'file'), 'No staged mod files to upload');
  const transport = await transportFactory(run);
  let files = 0;
  try {
    for (const entry of [{remote: source, type: 'directory'}, ...entries]) {
      const type = await transport.type(entry.remote);
      if (entry.type === 'directory') {
        if (type === 'missing') await transport.mkdir(entry.remote);
        else check(type === 'directory', 'SD mod path is not a directory: ' + entry.remote);
        continue;
      }
      check(type === 'missing' || type === 'file',
        'SD mod path is not a file: ' + entry.remote);
      const expected = await hashFile(entry.local);
      if (type === 'missing') await transport.create(entry.remote, entry.size);
      if (type === 'missing' || await transport.digest(entry.remote, entry.size) !== expected) {
        await transport.write(entry.remote, entry.local, entry.size);
      }
      check(await transport.digest(entry.remote, entry.size) === expected,
        'SD mod readback hash differs: ' + entry.remote);
      files++;
    }
    return {source, files};
  } finally {
    await transport.close();
  }
}

module.exports = {modSourceForRun, stagedEntries, createSdTransport, uploadSelectedMods};
