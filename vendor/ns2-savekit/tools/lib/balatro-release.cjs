'use strict';
// The upstream launcher is downloaded, never vendored or executed here.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const CONFIG = require('../../config/balatro-launcher.json');
const TITLE_ID = CONFIG.titleId;
const INSTALL_PATHS = Object.freeze(CONFIG.files.map(entry => entry.path));
const CACHE_NAME = 'balatro-' + CONFIG.upstream.tag + '-' + CONFIG.upstream.sha256.slice(0, 16) + '.zip';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function verifyArchive(archive) {
  const file = path.resolve(archive);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error('Archive must be a regular file, not a symlink');
  if (stat.size !== CONFIG.upstream.size)
    throw Error('Archive size does not match the pinned Balatro release');
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(CONFIG.upstream.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    if (used !== CONFIG.upstream.size || sha256(bytes.subarray(0, used)) !== CONFIG.upstream.sha256)
      throw Error('Archive SHA-256 does not match the pinned Balatro release');
  } finally {
    await handle.close();
  }
  return file;
}

async function checkedDirectory(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.mkdir(current, {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error('Cache directory must not contain symlinks: ' + current);
  }
  return absolute;
}

async function obtainArchive({archive, cacheDir} = {}) {
  if (archive) return verifyArchive(archive);
  const cache = await checkedDirectory(cacheDir || process.env.BALATRO_CACHE ||
    path.join(os.homedir(), '.cache', 'ns2-savekit', 'balatro-launcher'));
  const cached = path.join(cache, CACHE_NAME);
  try {
    await fs.lstat(cached);
    // A bad existing cache entry is not ours to overwrite silently.
    return await verifyArchive(cached);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const response = await fetch(CONFIG.upstream.url, {signal: AbortSignal.timeout(60000)});
  if (!response.ok || !response.body || !response.url.startsWith('https:')) {
    await response.body?.cancel().catch(() => {});
    throw Error('Could not download the pinned Balatro release: HTTP ' + response.status);
  }
  const length = Number(response.headers.get('content-length'));
  if (length > CONFIG.upstream.size) {
    await response.body.cancel().catch(() => {});
    throw Error('Downloaded archive is larger than the pinned release');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > CONFIG.upstream.size)
      throw Error('Downloaded archive is larger than the pinned release');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (size !== CONFIG.upstream.size || sha256(bytes) !== CONFIG.upstream.sha256)
    throw Error('Downloaded archive SHA-256 or size does not match the pinned release');

  const temporary = await fs.mkdtemp(path.join(cache, '.download-'));
  const temporaryFile = path.join(temporary, 'release.zip');
  try {
    await fs.writeFile(temporaryFile, bytes, {flag: 'wx', mode: 0o600});
    // A hard link publishes the complete file atomically and refuses to replace
    // an existing cache entry, including one created by a concurrent process.
    try { await fs.link(temporaryFile, cached); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return await verifyArchive(cached);
  } finally {
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

async function stageArchive(archivePath, outDir) {
  const archive = await verifyArchive(archivePath);
  const directory = path.resolve(outDir);
  const helper = path.resolve(__dirname, '..', 'balatro-archive.py');
  const result = spawnSync('python3', [helper, archive, directory], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw Error('Could not stage the pinned Balatro release: ' +
      String(result.stderr || result.error || 'archive validation failed').trim());
  const staged = JSON.parse(result.stdout);
  if (staged.directory !== directory || staged.files.length !== CONFIG.files.length)
    throw Error('Archive staging returned an invalid manifest');
  for (const [index, entry] of staged.files.entries()) {
    const pinned = CONFIG.files[index];
    if (entry.path !== pinned.path || entry.local !== path.join(directory, pinned.path.slice(1)) ||
        entry.size !== pinned.size || entry.sha256 !== pinned.sha256 || entry.replace !== false)
      throw Error('Archive staging returned an unpinned file');
    const stat = await fs.lstat(entry.local);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size ||
        sha256(await fs.readFile(entry.local)) !== entry.sha256)
      throw Error('Staged file failed verification: ' + entry.path);
  }
  return staged;
}

module.exports = {CONFIG, TITLE_ID, INSTALL_PATHS, CACHE_NAME, verifyArchive, obtainArchive, stageArchive};
