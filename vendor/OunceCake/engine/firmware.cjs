const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  success,
  packet,
  pathRequest,
  closeHandles,
  throwIfCancelled,
  resultError,
} = require('./protocol.cjs');
const {
  discoverSystemPrograms,
  discoverSystemData,
  resolveProgramContent,
  resolveSystemDataContent,
} = require('./content.cjs');
const { readRomfs } = require('./mounts.cjs');
const { createProgramMounts, prepareInstalledLicense } = require('./program.cjs');

// Firmware-side dump orchestrator: walks SystemProgram and SystemData meta records
// from BuiltInSystem storage, mounts their ExeFS/RomFS through the retained Loader
// root, and streams every file to disk with a SHA-256 journal.

// Streaming chunk size — matches the 64 KiB window used throughout the engine.
const STREAM_CHUNK = 0x10000;

// Nintendo result codes we treat as "section not present, skip".
const RESULT_PARTITION_NOT_FOUND = 0x7d202; ///< No RomFS section in the NCA.
const RESULT_LICENSE_NEEDED = 0x7d802;      ///< ES license must be prepared first.
const CODEFS_ABSENT = new Set([0x7d202, 0x7d402, 0x408, 0x1408, 0x7d002]);

const PATH_UNSAFE = /[\0\/\\:*?"<>|\x00-\x1f]/g;

/// Replace characters disallowed on common filesystems and reject '.' / '..'.
function sanitizeSegment(name) {
  const cleaned = name.replace(PATH_UNSAFE, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

/// Build a local filesystem path from an in-mount POSIX path.
function localPath(baseDir, mountPath) {
  const parts = mountPath.replace(/^\//, '').split('/').map(sanitizeSegment);
  return path.join(baseDir, ...parts);
}

/// Ensure a directory exists.
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/// Open a RomFS IStorage for a Program NCA described by `source`, using the
/// retained FS root's `OpenDataStorageByPath` (command 206, section type 1 =
/// RomFS). This is the path for SystemProgram titles.
async function openProgramRomfsStorage(attachment, source) {
  const { s, root, domain } = attachment;
  const filename = Buffer.alloc(0x301);
  filename.write(source.contentPath);
  await s.write(s.base + 0x2000, filename);

  const input = Buffer.alloc(8);
  input[0] = source.attributes;
  input.writeUInt32LE(1, 4); // Section type 1 = RomFS.

  const reply = await domain.send(
    s,
    'Open firmware RomFS',
    root,
    pathRequest(206, input, s.base + 0x2000),
  );

  if (reply.result) throw resultError('Open firmware RomFS', reply.result);

  const handle = domain.oneHandle(reply);
  const sizeReply = success(await s.ipc('Firmware storage size', handle, 4), 'Firmware storage size');
  return { handle, size: Number(sizeReply.data.readBigUInt64LE()) };
}

/// Open a Data NCA's RomFS IStorage by DataId. Uses `OpenDataStorageByDataId`
/// (command 202 on IFileSystemProxy): the correct path for SystemData archives
/// since OpenDataStorageByPath only accepts Program NCAs on this console.
async function openDataIdStorage(attachment, title, storage) {
  const { s, root, domain } = attachment;

  // Raw input layout: storageId (u8 @ 0) + 7 bytes pad + dataId (u64 LE @ 8).
  const input = Buffer.alloc(16);
  input[0] = storage;
  input.writeBigUInt64LE(BigInt('0x' + title), 8);

  const reply = await domain.send(
    s,
    'OpenDataStorageByDataId',
    root,
    packet(202, input),
  );

  if (reply.result) throw resultError('OpenDataStorageByDataId', reply.result);

  const handle = domain.oneHandle(reply);
  const sizeReply = success(await s.ipc('System data storage size', handle, 4), 'System data storage size');
  return { handle, size: Number(sizeReply.data.readBigUInt64LE()) };
}

/// Walk a CodeFS tree (filesystem handle from `OpenCodeFileSystem`) recursively
/// and return a flat list of entries.
async function walkCodeFs(attachment, codeHandle) {
  const { s, domain, filesystem } = attachment;
  const pending = ['/'];
  const entries = [];

  while (pending.length) {
    const dir = pending.pop();
    const mode = Buffer.alloc(4);
    mode.writeUInt32LE(3); // Both files and directories.

    const opened = success(
      await filesystem.pathMethod(s, codeHandle, 9, dir, mode),
      'Open firmware CodeFS directory',
    );
    const dirHandle = domain.oneHandle(opened);

    try {
      for (;;) {
        const reply = success(
          await s.ipc('Read firmware CodeFS directory', dirHandle, 0, Buffer.alloc(0), {
            receive: [{ address: s.base + 0x6000, size: 32 * 0x310, mode: 0 }],
          }),
          'Read firmware CodeFS directory',
        );
        const count = Number(reply.data.readBigUInt64LE());

        if (!count) break;

        const bytes = await s.readOwned(s.base + 0x6000, count * 0x310);

        for (let i = 0; i < count; i++) {
          const row = bytes.subarray(i * 0x310, (i + 1) * 0x310);
          const end = row.subarray(0, 0x301).indexOf(0);
          const name = row.subarray(0, end).toString('utf8');
          const type = row[0x304] === 1 ? 'file' : 'directory';
          const size = Number(row.readBigUInt64LE(0x308));
          const child = dir.replace(/\/$/, '') + '/' + name;

          entries.push({ path: child, type, size });

          if (type === 'directory') pending.push(child);
        }
      }
    } finally {
      await s.close(dirHandle);
    }
  }

  return entries;
}

/// Stream a single CodeFS file to disk, returning its SHA-256 hex digest.
async function streamCodeFile(attachment, codeHandle, mountPath, size, outFile) {
  const { s, filesystem } = attachment;
  const opened = success(
    await filesystem.openFile(s, codeHandle, mountPath),
    'Open firmware CodeFS file',
  );
  const file = opened.handle;
  const hasher = crypto.createHash('sha256');
  const out = await fs.open(outFile, 'w');

  try {
    for (let at = 0; at < size; at += STREAM_CHUNK) {
      const length = Math.min(STREAM_CHUNK, size - at);
      const chunk = await filesystem.readFile(s, file, at, length);
      hasher.update(chunk);
      await out.write(chunk);
    }
    return hasher.digest('hex');
  } finally {
    await out.close();
    await s.close(file);
  }
}

/// Stream a RomFS file extent (contiguous bytes in the IStorage) to disk,
/// returning its SHA-256 hex digest.
async function streamRomfsExtent(attachment, storageHandle, offset, size, outFile) {
  const { s, filesystem } = attachment;
  const hasher = crypto.createHash('sha256');
  const out = await fs.open(outFile, 'w');

  try {
    for (let at = 0; at < size; at += STREAM_CHUNK) {
      const length = Math.min(STREAM_CHUNK, size - at);
      const chunk = await filesystem.readStorage(s, storageHandle, offset + at, length);
      hasher.update(chunk);
      await out.write(chunk);
    }
    return hasher.digest('hex');
  } finally {
    await out.close();
  }
}

/// Dump a RomFS section into `<outputDir>/romfs/` using `openStorage` as the
/// mount constructor. Returns a manifest, or `null` if the NCA has no RomFS
/// section. If `source` is supplied and the server requests a license, falls
/// back through `prepareInstalledLicense` and retries once.
async function dumpRomfs({ attachment, openStorage, outputDir, cancel, source, titleForLicense }) {
  cancel();
  let mount;

  try {
    mount = await openStorage();
  } catch (error) {
    const code = error.nativeResult?.canonical;

    if (code === RESULT_PARTITION_NOT_FOUND) {
      console.log('  no RomFS section (0x7d202), skipping');
      return null;
    }

    if (code === RESULT_LICENSE_NEEDED && source) {
      console.log('  license needed, preparing...');
      await prepareInstalledLicense({ ...attachment, title: titleForLicense, source });
      cancel();
      mount = await openStorage();
    } else {
      throw error;
    }
  }

  const { handle, size } = mount;
  const romfsDir = path.join(outputDir, 'romfs');
  await ensureDir(romfsDir);

  try {
    const entries = await readRomfs(async (offset, length) => {
      cancel();
      return attachment.filesystem.readStorage(attachment.s, handle, offset, length);
    }, size);

    const files = [];
    let totalBytes = 0;

    for (const entry of entries) {
      cancel();
      const abs = localPath(romfsDir, entry.path);

      if (entry.type === 'directory') {
        await ensureDir(abs);
        continue;
      }

      await ensureDir(path.dirname(abs));
      const sha256 = await streamRomfsExtent(attachment, handle, entry.offset, entry.size, abs);
      files.push({ path: entry.path, size: entry.size, sha256 });
      totalBytes += entry.size;
    }

    console.log('  RomFS: ' + files.length + ' files, ' + totalBytes + ' bytes');
    return { storageSize: size, files };
  } finally {
    await closeHandles(attachment.s, [handle]);
  }
}

/// Dump an ExeFS section (CodeFS) for a SystemProgram `source` into
/// `<outputDir>/exefs/`. Returns a manifest, or `null` if the NCA has no CodeFS
/// (unusual for SystemProgram, so this is a safety net).
async function dumpExefs({ attachment, source, title, outputDir, cancel, openCode }) {
  cancel();
  const { s, root, domain } = attachment;

  // Learn the runtime ProgramId for this NCA (Loader root method 618).
  const filename = Buffer.alloc(0x301);
  filename.write(source.contentPath);
  await s.write(s.base + 0x2000, filename);

  const identity = success(
    await domain.send(
      s,
      'Read firmware NCA ProgramId',
      root,
      pathRequest(618, Buffer.from([source.attributes]), s.base + 0x2000),
    ),
    'Read firmware NCA ProgramId',
  );
  const runtimeProgramId = identity.data.readBigUInt64LE().toString(16).padStart(16, '0');

  let codeHandle;

  try {
    codeHandle = await openCode({
      title: runtimeProgramId,
      storage: source.storage,
      attributes: source.attributes,
      source,
    });
  } catch (error) {
    const code = error.nativeResult?.canonical;

    if (code !== undefined && CODEFS_ABSENT.has(code)) {
      console.log('  no CodeFS (0x' + code.toString(16) + '), skipping');
      return null;
    }

    throw error;
  }

  const exefsDir = path.join(outputDir, 'exefs');
  await ensureDir(exefsDir);

  try {
    const entries = await walkCodeFs(attachment, codeHandle);
    const files = [];
    let totalBytes = 0;

    for (const entry of entries) {
      cancel();
      const abs = localPath(exefsDir, entry.path);

      if (entry.type === 'directory') {
        await ensureDir(abs);
        continue;
      }

      await ensureDir(path.dirname(abs));
      const sha256 = await streamCodeFile(attachment, codeHandle, entry.path, entry.size, abs);
      files.push({ path: entry.path, size: entry.size, sha256 });
      totalBytes += entry.size;
    }

    console.log('  ExeFS: ' + files.length + ' files, ' + totalBytes + ' bytes');
    return { runtimeProgramId, files };
  } finally {
    await s.close(codeHandle);
  }
}

/// Choose which records to process based on the optional `--titles` filter.
function filterRecords(records, titleFilter) {
  if (!titleFilter || !titleFilter.size) return records;
  return records.filter((r) => titleFilter.has(r.contentTitle.toLowerCase()));
}

/// Keep only the newest version per contentTitle, since NCM may return multiple
/// generations.
function dedupeLatest(records) {
  const byTitle = new Map();

  for (const record of records) {
    const existing = byTitle.get(record.contentTitle);

    if (!existing || record.version > existing.version) byTitle.set(record.contentTitle, record);
  }

  return [...byTitle.values()].sort((a, b) => a.contentTitle.localeCompare(b.contentTitle));
}

/// Orchestrate a full firmware dump. `outDir` receives per-title subdirectories
/// plus a `firmware-dump.json` journal.
async function dumpFirmware({
  attachment,
  outDir,
  titles,
  includePrograms = true,
  includeData = true,
  shouldStop = () => false,
}) {
  const cancel = () => throwIfCancelled(shouldStop);
  const { s, domain, service } = attachment;

  await ensureDir(outDir);

  // Build the cached Loader-root-backed openCode helper once; it clones the
  // retained Loader root on first use and memoizes the clone for all titles.
  const { openCode } = createProgramMounts(attachment);

  const titleFilter = titles && titles.length
    ? new Set(titles.map((t) => t.toLowerCase()))
    : null;

  const journal = {
    generated: new Date().toISOString(),
    includedPrograms: includePrograms,
    includedData: includeData,
    titles: [],
  };

  async function recordProgram(record) {
    const title = record.contentTitle;
    console.log('[system-program] ' + title + ' v' + record.version);
    cancel();

    const source = await resolveProgramContent({
      s, domain, service, title, storage: record.storage,
    });
    const outputDir = path.join(outDir, 'system-programs', title);
    await ensureDir(outputDir);

    let exefs = null;
    let romfs = null;

    try {
      exefs = await dumpExefs({ attachment, source, title, outputDir, cancel, openCode });
    } catch (error) {
      console.log('  ExeFS failed: ' + error.message);
    }

    try {
      romfs = await dumpRomfs({
        attachment,
        openStorage: () => openProgramRomfsStorage(attachment, source),
        outputDir,
        cancel,
        source,
        titleForLicense: title,
      });
    } catch (error) {
      console.log('  RomFS failed: ' + error.message);
    }

    journal.titles.push({
      kind: 'system-program',
      title,
      version: record.version,
      storage: record.storage,
      contentId: source.contentId,
      attributes: source.attributes,
      exefs,
      romfs,
    });
  }

  async function recordData(record) {
    const title = record.contentTitle;
    console.log('[system-data] ' + title + ' v' + record.version);
    cancel();

    const source = await resolveSystemDataContent({
      s, domain, service, title, storage: record.storage,
    });
    const outputDir = path.join(outDir, 'system-data', title);
    await ensureDir(outputDir);

    let romfs = null;

    try {
      romfs = await dumpRomfs({
        attachment,
        openStorage: () => openDataIdStorage(attachment, title, record.storage),
        outputDir,
        cancel,
        source,
        titleForLicense: title,
      });
    } catch (error) {
      console.log('  RomFS failed: ' + error.message);
    }

    journal.titles.push({
      kind: 'system-data',
      title,
      version: record.version,
      storage: record.storage,
      contentId: source.contentId,
      attributes: source.attributes,
      romfs,
    });
  }

  if (includePrograms) {
    console.log('Enumerating SystemProgram titles...');
    const records = filterRecords(dedupeLatest(await discoverSystemPrograms({ s, domain, service })), titleFilter);
    console.log('  ' + records.length + ' SystemProgram title(s) selected');

    for (const record of records) {
      cancel();

      try {
        await recordProgram(record);
      } catch (error) {
        console.log('  title ' + record.contentTitle + ' failed: ' + error.message);
        journal.titles.push({
          kind: 'system-program',
          title: record.contentTitle,
          version: record.version,
          storage: record.storage,
          error: error.message,
        });
      }
    }
  }

  if (includeData) {
    console.log('Enumerating SystemData titles...');
    const records = filterRecords(dedupeLatest(await discoverSystemData({ s, domain, service })), titleFilter);
    console.log('  ' + records.length + ' SystemData title(s) selected');

    for (const record of records) {
      cancel();

      try {
        await recordData(record);
      } catch (error) {
        console.log('  title ' + record.contentTitle + ' failed: ' + error.message);
        journal.titles.push({
          kind: 'system-data',
          title: record.contentTitle,
          version: record.version,
          storage: record.storage,
          error: error.message,
        });
      }
    }
  }

  const journalPath = path.join(outDir, 'firmware-dump.json');
  await fs.writeFile(journalPath, JSON.stringify(journal, null, 2));

  console.log('Journal written: ' + journalPath);
  return { journalPath, journal };
}

module.exports = { dumpFirmware };
