const fs = require('node:fs');
const path = require('node:path');
const { success, withCleanup, closeHandles, throwIfCancelled } = require('./protocol.cjs');
const { resolveContent } = require('./content.cjs');

const CONTENT_TYPES = [
  { id: 1, name: 'program' },
  { id: 2, name: 'data' },
  { id: 3, name: 'control' },
  { id: 4, name: 'manual' },
  { id: 5, name: 'legal' },
];
const CONTENT_STORAGES = { 3: 0, 4: 1, 5: 2 };

async function dumpAllNcas({ attachment, title, outDir, skipProgram, shouldStop = () => false }) {
  const { s, root, domain, filesystem, service } = attachment;
  const handles = [];
  const stores = new Map();
  const bulkDownloads = s.bulkDownloads;
  const chunkSize = Math.min(0x400000, (s.bytes || 0) - 0x6000);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 0x10000)
    throw new Error('Owned allocation is too small for NCA export');

  return withCleanup(async () => {
    const sources = [];
    for (const type of CONTENT_TYPES) {
      throwIfCancelled(shouldStop);
      if (skipProgram && type.id === 1) continue;
      try {
        const source = await resolveContent({ s, domain, service, title, contentType: type.id });
        sources.push({ name: type.name, source });
      } catch (error) {
        if (error.nativeResult?.canonical !== 0xe05) throw error;
      }
    }
    if (!sources.length) throw new Error('No content found for ' + title);
    fs.mkdirSync(outDir, { recursive: true });
    s.bulkDownloads = true;
    const results = [];

    for (const { name, source } of sources) {
      throwIfCancelled(shouldStop);
      const storage = CONTENT_STORAGES[source.storage];
      if (storage === undefined) throw new Error('Unsupported raw NCA storage: ' + source.storage);
      if (!stores.has(storage)) {
        const input = Buffer.alloc(4);
        input.writeUInt32LE(storage);
        const opened = success(await s.ipc('OpenContentStorageFileSystem', root, 110, input),
          'OpenContentStorageFileSystem');
        const handle = domain.oneHandle(opened);
        handles.push(handle);
        stores.set(storage, handle);
      }
      const ncaPath = '/' + source.contentPath.replace(new RegExp('^@[^:]+://'), '');
      const file = success(await filesystem.openFile(s, stores.get(storage), ncaPath), 'Open NCA');
      await withCleanup(async () => {
        const size = Number(await filesystem.fileSize(s, file.handle));
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid NCA size');
        const outPath = path.join(outDir, source.contentId + '.nca');
        const partial = outPath + '.partial';
        if (fs.existsSync(outPath)) throw new Error('Output already exists: ' + outPath);
        const fd = fs.openSync(partial, 'wx');
        console.log(name + ': ' + outPath + ' (' + size + ' bytes)');
        try {
          for (let offset = 0; offset < size;) {
            throwIfCancelled(shouldStop);
            const length = Math.min(chunkSize, size - offset);
            const bytes = await filesystem.readFile(s, file.handle, offset, length);
            if (!Buffer.isBuffer(bytes) || bytes.length !== length)
              throw new Error('Short NCA read at ' + offset + '; incomplete export: ' + partial);
            for (let written = 0; written < bytes.length;) {
              const n = fs.writeSync(fd, bytes, written, bytes.length - written);
              if (!n) throw new Error('Short local NCA write: ' + partial);
              written += n;
            }
            offset += length;
          }
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        if (fs.existsSync(outPath)) throw new Error('Output already exists: ' + outPath);
        fs.renameSync(partial, outPath);
        results.push({ name, contentId: source.contentId, size, path: outPath });
      }, () => s.close(file.handle));
    }
    return results;
  }, () => closeHandles(s, handles), () => { s.bulkDownloads = bulkDownloads; });
}

module.exports = { dumpAllNcas };
