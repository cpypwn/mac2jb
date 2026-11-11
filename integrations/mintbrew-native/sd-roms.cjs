'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_SD_ROM_FOLDER = '/sd/roms/nes';
const MAX_ROMS = 16;
const MAX_ROM_BYTES = 65536;

function macRomDirectory() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'mac2jb',
    'MintNES', 'roms');
}

function check(value, message) {
  if (!value) throw Error(message);
}

function validSDRomFolder(value = DEFAULT_SD_ROM_FOLDER) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= 240 &&
    value.startsWith('/sd/') && !value.endsWith('/') &&
    value.split('/').slice(1).every(part => part && part !== '.' && part !== '..') &&
    !/[\\\x00-\x1f\x7f]/.test(value),
  'Invalid SD ROM folder: use an absolute folder under /sd');
  return value;
}

function compatibleINES(header, size) {
  if (!Buffer.isBuffer(header) || header.length < 16 ||
    !header.subarray(0, 4).equals(Buffer.from([0x4e, 0x45, 0x53, 0x1a]))) return false;
  const prg = header[4], chr = header[5], flags = header[6];
  return (prg === 1 || prg === 2) && chr <= 1 && (flags & 0x0c) === 0 &&
    ((flags >> 4) | (header[7] & 0xf0)) === 0 && (header[7] & 0x0c) !== 0x08 &&
    size >= 16 + prg * 16384 + chr * 8192 && size <= MAX_ROM_BYTES;
}

async function folderEntries(storage, folder) {
  let current = '/sd';
  for (const part of folder.split('/').slice(2)) {
    const entries = await storage.list(current);
    const found = entries.find(entry => entry.name === part);
    if (!found) return null;
    check(found.type === 'dir', 'The SD ROM folder path contains a file: ' + part);
    current += '/' + part;
  }
  return storage.list(current);
}

async function readROM(storage, file, size) {
  const opened = await storage.openRead(file);
  let failure, bytes, unsupported = false;
  try {
    check(opened.size === size && size >= 16 && size <= MAX_ROM_BYTES,
      'SD ROM size changed while opening ' + path.posix.basename(file));
    const header = await storage.read(opened, 0, 16);
    unsupported = !compatibleINES(header, size);
    if (!unsupported) {
      bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const chunk = await storage.read(opened, offset, Math.min(32768, size - offset));
        check(Buffer.isBuffer(chunk) && chunk.length > 0 && offset + chunk.length <= size,
          'SD ROM read was truncated: ' + path.posix.basename(file));
        chunk.copy(bytes, offset);
        offset += chunk.length;
      }
      check(compatibleINES(bytes.subarray(0, 16), bytes.length),
        'SD ROM header changed while reading ' + path.posix.basename(file));
    }
  } catch (error) {failure = error;}
  finally {
    try {await storage.close(opened);} catch (error) {failure ||= error;}
  }
  if (failure) throw failure;
  return unsupported ? null : bytes;
}

function cleanAttachment(attachment) {
  const session = attachment.s;
  return !!session && session.base === 0 && session.handles?.size === 0 &&
    session.threads?.size === 0;
}

async function createSDStorage(attachment) {
  const {s, root, domain, filesystem} = attachment;
  const opened = await s.ipc('Open SD filesystem', root, 18);
  check(!opened.result, 'The SD filesystem is unavailable in this held session');
  const handle = domain.oneHandle(opened);
  function sdPath(value) {
    check(value === '/sd' || value.startsWith('/sd/'), 'Path is outside the SD filesystem');
    const relative = value.slice(3) || '/';
    check(!relative.split('/').some(part => part === '.' || part === '..'),
      'Invalid SD filesystem path');
    return relative;
  }
  return {
    mounts: ['sd'],
    async list(value) {
      const entries = await filesystem.listDirectory(s, handle, sdPath(value), 1024);
      return entries.map(entry => {
        const size = Number(entry.size);
        check(Number.isSafeInteger(size) && size >= 0, 'Invalid SD directory entry size');
        check(entry.type === 0 || entry.type === 1, 'Invalid SD directory entry type');
        return {name: entry.name, type: entry.type === 0 ? 'dir' : 'file', size};
      });
    },
    async openRead(value) {
      const file = await filesystem.openFile(s, handle, sdPath(value));
      check(!file.result, 'Could not open SD ROM: ' + path.posix.basename(value));
      try {
        const size = Number(await filesystem.fileSize(s, file.handle));
        check(Number.isSafeInteger(size) && size >= 0, 'Invalid SD ROM size');
        return {handle: file.handle, size};
      } catch (error) {
        await s.close(file.handle);
        throw error;
      }
    },
    read: (file, offset, count) => filesystem.readFile(s, file.handle, offset, count),
    close: file => s.close(file.handle),
    release: () => s.close(handle),
  };
}

async function readSDRoms(runDirectory, options = {}) {
  const folder = validSDRomFolder(options.folder);
  const attach = options.attachGame || require('../../vendor/OunceCake/engine/session.cjs').attachGame;
  const createStorage = options.createStorage || createSDStorage;
  const notify = options.progress || (() => {});
  const stop = options.shouldStop || (() => false);
  const limit = options.limit === undefined ? MAX_ROMS - 1 : options.limit;
  check(Number.isInteger(limit) && limit >= 0 && limit <= MAX_ROMS,
    'Invalid SD ROM import limit');
  let attachment, storage, attachAttempted = false, result, failure;
  try {
    check(!stop(), 'SD ROM import stopped');
    attachAttempted = true;
    attachment = await attach(runDirectory);
    storage = await createStorage(attachment);
    check(storage.mounts.includes('sd'), 'The SD filesystem is unavailable in this held session');
    const entries = await folderEntries(storage, folder);
    if (!entries) {
      result = {folder, missing: true, roms: [], skipped: []};
    } else {
      const roms = [], skipped = [], seen = new Set();
      const candidates = entries.filter(entry => entry.type === 'file' && /\.nes$/i.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of candidates) {
        check(!stop(), 'SD ROM import stopped');
        const name = entry.name.normalize('NFC');
        const key = name.toLowerCase();
        if (seen.has(key) || Buffer.byteLength(name) > 120 ||
            !name || /[\/\\\x00-\x1f\x7f]/.test(name) ||
            !Number.isSafeInteger(entry.size) || entry.size < 16 || entry.size > MAX_ROM_BYTES) {
          skipped.push(entry.name); continue;
        }
        seen.add(key);
        if (roms.length >= limit) {skipped.push(entry.name); continue;}
        const bytes = await readROM(storage, folder + '/' + entry.name, entry.size);
        if (!bytes) {skipped.push(entry.name); continue;}
        roms.push({name, bytes});
        notify('Read ' + name + ' from Switch SD');
      }
      result = {folder, missing: false, roms, skipped};
    }
  } catch (error) {
    failure = error;
    if (attachAttempted && !attachment) failure.cleanupBlocked = true;
  }
  if (storage?.release) {
    try {await storage.release();}
    catch (error) {
      const unsafe = Error('SD ROM filesystem handle did not close: ' + error.message);
      unsafe.cleanupBlocked = true;
      failure = failure ? Object.assign(Error(failure.message + '; ' + unsafe.message),
        {cleanupBlocked: true}) : unsafe;
    }
  }
  if (attachment) {
    try {
      await attachment.close();
      check(cleanAttachment(attachment), 'SD filesystem attachment did not release its handles');
    } catch (error) {
      const unsafe = Error('SD ROM import cleanup failed: ' + error.message);
      unsafe.cleanupBlocked = true;
      failure = failure ? Object.assign(Error(failure.message + '; ' + unsafe.message),
        {cleanupBlocked: true}) : unsafe;
    }
  }
  if (failure) throw failure;
  return result;
}

async function readMacRoms(folder = macRomDirectory(), limit = MAX_ROMS - 1) {
  check(Number.isInteger(limit) && limit >= 0 && limit <= MAX_ROMS,
    'Invalid Mac ROM import limit');
  let entries;
  try {entries = await fsp.readdir(folder, {withFileTypes: true});}
  catch (error) {
    if (error.code === 'ENOENT') return {folder, missing: true, roms: [], skipped: []};
    throw error;
  }
  const roms = [], skipped = [], seen = new Set();
  for (const entry of entries.filter(item => /\.nes$/i.test(item.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name.normalize('NFC');
    const key = name.toLowerCase();
    if (!entry.isFile() || seen.has(key) || Buffer.byteLength(name) > 120 ||
        !name || /[\/\\\x00-\x1f\x7f]/.test(name) || roms.length >= limit) {
      skipped.push(entry.name);
      continue;
    }
    seen.add(key);
    const file = await fsp.open(path.join(folder, entry.name),
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const stat = await file.stat();
      if (stat.isFile() && stat.size >= 16 && stat.size <= MAX_ROM_BYTES) {
        bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        if (offset !== bytes.length) bytes = null;
      }
    } finally {await file.close();}
    if (!bytes || !compatibleINES(bytes.subarray(0, 16), bytes.length)) {
      skipped.push(entry.name);
      continue;
    }
    roms.push({name, bytes});
  }
  return {folder, missing: false, roms, skipped};
}

async function copyFile(source, destination) {
  const info = await fsp.lstat(source);
  check(info.isFile() && !info.isSymbolicLink(), 'Invalid bundled native package file');
  await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  await fsp.chmod(destination, 0o600);
}

async function stageApps(runDirectory, appsRoot, roms) {
  check(Array.isArray(roms), 'Invalid SD ROM list');
  if (!roms.length) return {appsDir: appsRoot, stageDir: null, imported: []};
  const mintnes = path.join(appsRoot, 'mintnes');
  check(fs.statSync(mintnes).isDirectory(), 'MintNES is not bundled in the native launcher');
  const stageDir = await fsp.mkdtemp(path.join(runDirectory, 'native-apps-'));
  await fsp.chmod(stageDir, 0o700);
  const imported = [];
  try {
    for (const entry of await fsp.readdir(appsRoot, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const source = path.join(appsRoot, entry.name);
      if (!fs.existsSync(path.join(source, 'manifest.json')) ||
          !fs.existsSync(path.join(source, 'build/report.json'))) continue;
      const target = path.join(stageDir, entry.name);
      if (entry.name !== 'mintnes') {
        await fsp.symlink(source, target, 'dir');
        continue;
      }
      await fsp.mkdir(target, {mode: 0o700});
      await fsp.mkdir(path.join(target, 'build'), {mode: 0o700});
      await fsp.mkdir(path.join(target, 'assets'), {mode: 0o700});
      for (const name of ['manifest.json', 'icon.png']) {
        if (fs.existsSync(path.join(source, name)))
          await copyFile(path.join(source, name), path.join(target, name));
      }
      for (const name of ['report.json', 'code.bin', 'data.bin'])
        await copyFile(path.join(source, 'build', name), path.join(target, 'build', name));
      const names = new Set();
      if (fs.existsSync(path.join(source, 'assets'))) {
        for (const name of await fsp.readdir(path.join(source, 'assets'))) {
          const original = path.join(source, 'assets', name);
          await copyFile(original, path.join(target, 'assets', name));
          if (/\.nes$/i.test(name)) names.add(name.normalize('NFC').toLowerCase());
        }
      }
      for (const rom of roms) {
        check(typeof rom.name === 'string' && /^[^\/\\\x00-\x1f\x7f]+\.nes$/i.test(rom.name) &&
          Buffer.byteLength(rom.name) <= 120 && compatibleINES(rom.bytes.subarray(0, 16), rom.bytes.length),
          'Invalid staged SD ROM');
        const key = rom.name.normalize('NFC').toLowerCase();
        if (names.has(key) || names.size >= MAX_ROMS) continue;
        names.add(key);
        await fsp.writeFile(path.join(target, 'assets', rom.name), rom.bytes,
          {mode: 0o600, flag: 'wx'});
        imported.push(rom.name);
      }
    }
    check(fs.existsSync(path.join(stageDir, 'mintnes/manifest.json')),
      'MintNES session package could not be staged');
    return {appsDir: stageDir, stageDir, imported};
  } catch (error) {
    await fsp.rm(stageDir, {recursive: true, force: true});
    throw error;
  }
}

module.exports = {DEFAULT_SD_ROM_FOLDER, MAX_ROMS, validSDRomFolder, compatibleINES,
  macRomDirectory, readMacRoms, createSDStorage, readSDRoms, stageApps};
