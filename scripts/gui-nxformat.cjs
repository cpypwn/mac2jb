'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120000;
const COMMAND_TIMEOUT_MS = 4 * 60 * 60 * 1000;

function check(condition, message) {
  if (!condition) throw Error(message);
}

async function manifestFor(root) {
  const data = await fsp.readFile(path.join(root, 'packaging/NXFormat-source.json'));
  check(data.length < 4096, 'NXFormat manifest is too large');
  const manifest = JSON.parse(data);
  check(manifest.repository === 'https://github.com/fab918/nxformat' &&
    manifest.release === 'V1.0.3' && manifest.version === '1.0.3' &&
    manifest.archive === 'https://github.com/fab918/nxformat/releases/download/V1.0.3/nxformat-1.0.3-macos-universal.tar.gz' &&
    manifest.archiveBytes === 63966246 &&
    manifest.archiveSha256 === 'b61fecfad224d2f0b6a040c23663e5f6915eb500be9fc36016e3ffcb0aa66e52' &&
    manifest.binarySha256 === '16bb123a70617c668e5236ec1cc8efe7889ebebac28dac6d2f58c3d11d04fdd0' &&
    manifest.binaryPath === 'bin/nxconvert' &&
    manifest.checksumSource === 'https://github.com/fab918/nxformat/releases/download/V1.0.3/SHA256SUMS',
  'The pinned NXFormat manifest is invalid');
  return manifest;
}

function cacheFor(manifest) {
  const parent = process.env.MAC2JB_NXFORMAT_TEST_CACHE ||
    path.join(os.homedir(), 'Library/Application Support/mac2jb/Tools/NXFormat');
  return path.join(parent, manifest.release);
}

function bundledFor(root, manifest) {
  return path.join(root, 'tools/nxformat', manifest.version);
}

async function sha256File(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function verifyBinary(folder, manifest) {
  const info = await fsp.lstat(folder);
  check(info.isDirectory() && !info.isSymbolicLink(), 'The stored NXFormat folder is unsafe');
  const binary = path.join(folder, manifest.binaryPath);
  const stat = await fsp.lstat(binary);
  check(stat.isFile() && !stat.isSymbolicLink() &&
    await sha256File(binary) === manifest.binarySha256,
  'The stored NXConvert binary failed its pinned integrity check');
  await fsp.access(binary, fs.constants.X_OK);
  return binary;
}

async function availableBinary(root, manifest) {
  const bundled = bundledFor(root, manifest);
  if (await fsp.lstat(bundled).catch(() => null)) {
    return verifyBinary(bundled, manifest);
  }
  return verifyBinary(cacheFor(manifest), manifest);
}

async function downloadArchive(manifest, destination, signal) {
  const timeout = setTimeout(() => signal.abort(), DOWNLOAD_TIMEOUT_MS);
  let file;
  try {
    const response = await fetch(manifest.archive, {signal: signal.signal});
    const final = new URL(response.url);
    check(response.ok && final.protocol === 'https:' &&
      ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(final.hostname),
    `Could not fetch the pinned NXConvert release (HTTP ${response.status})`);
    check(response.body, 'The NXConvert release returned no data');
    file = await fsp.open(destination, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      check(size <= manifest.archiveBytes, 'The NXConvert archive is larger than its pinned size');
      hash.update(chunk);
      await file.write(chunk);
    }
    check(size === manifest.archiveBytes && hash.digest('hex') === manifest.archiveSha256,
      'The NXConvert release failed its pinned size or SHA-256 check');
  } finally {
    clearTimeout(timeout);
    await file?.close();
  }
}

function run(program, args, {signal, timeoutMs = COMMAND_TIMEOUT_MS, forward = true} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {stdio: ['ignore', 'pipe', 'pipe'], signal});
    let forwardedBytes = 0;
    let lastProgressAt = 0;
    let lastProgress = '';
    let truncated = false;
    let tail = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const emit = line => {
      if (!forward) return;
      if (line.startsWith('@PROGRESS')) {
        lastProgress = line;
        if (Date.now() - lastProgressAt < 250) return;
        lastProgressAt = Date.now();
      }
      const bytes = Buffer.from(line + '\n');
      if (forwardedBytes + bytes.length > MAX_OUTPUT_BYTES) {
        if (!truncated) process.stdout.write('NXConvert output truncated; conversion continues\n');
        truncated = true;
        return;
      }
      forwardedBytes += bytes.length;
      process.stdout.write(bytes);
    };
    for (const stream of [child.stdout, child.stderr]) {
      let pending = '';
      stream.on('data', data => {
        tail = (tail + data.toString('utf8')).slice(-4096);
        pending += data.toString('utf8');
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
          emit(pending.slice(0, at).replace(/\r$/, ''));
          pending = pending.slice(at + 1);
        }
        if (pending.length > 16384) pending = pending.slice(-4096);
      });
      stream.once('end', () => {if (pending) emit(pending);});
    }
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (forward && lastProgress && !truncated) process.stdout.write(lastProgress + '\n');
      if (code !== 0) reject(Error(tail.trim() || `NXConvert exited with status ${code}`));
      else resolve(tail.trim());
    });
  });
}

async function prepare(root, manifest, options = {}) {
  const bundled = bundledFor(root, manifest);
  if (await fsp.lstat(bundled).catch(() => null)) {
    return verifyBinary(bundled, manifest);
  }
  const target = cacheFor(manifest);
  try { return await verifyBinary(target, manifest); }
  catch (error) {
    if (await fsp.lstat(target).catch(() => null)) {
      throw Error('The stored NXConvert binary changed. Move its Tools/NXFormat folder aside and try again');
    }
  }
  const parent = path.dirname(target);
  await fsp.mkdir(parent, {recursive: true, mode: 0o700});
  const stage = await fsp.mkdtemp(path.join(parent, '.nxformat-'));
  const signal = options.signal || new AbortController();
  try {
    const archive = path.join(stage, 'release.tar.gz');
    await downloadArchive(manifest, archive, signal);
    const unpacked = path.join(stage, 'unpacked');
    await fsp.mkdir(unpacked, {mode: 0o700});
    await run('/usr/bin/tar', ['-xzf', archive, '-C', unpacked, manifest.binaryPath, 'LICENSE'],
      {signal: signal.signal, timeoutMs: 30000, forward: false});
    await fsp.chmod(path.join(unpacked, manifest.binaryPath), 0o700);
    await verifyBinary(unpacked, manifest);
    await fsp.rename(unpacked, target);
    return path.join(target, manifest.binaryPath);
  } finally {
    await fsp.rm(stage, {recursive: true, force: true});
  }
}

async function inputFile(file, extension) {
  check(file && path.isAbsolute(file) && file.toLowerCase().endsWith(extension),
    `Choose a ${extension} file`);
  const stat = await fsp.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink(), 'The selected file is unsafe or missing');
}

async function packArguments(source, destination) {
  check(source && destination && path.isAbsolute(source) && path.isAbsolute(destination) &&
    destination.toLowerCase().endsWith('.nx'), 'Choose a dump folder or .nup file and a .nx destination');
  check(!(await fsp.lstat(destination).catch(() => null)), 'The .nx destination already exists');
  const parent = await fsp.lstat(path.dirname(destination));
  check(parent.isDirectory() && !parent.isSymbolicLink(), 'The destination folder is unsafe or missing');
  const stat = await fsp.lstat(source);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    return ['pack-tree', source, destination, '--platform', 'switch2', '--no-trail', '--frontend'];
  }
  check(stat.isFile() && !stat.isSymbolicLink() && source.toLowerCase().endsWith('.nup'),
    'Choose an extracted dump folder or a .nup file');
  return ['pack-nup', source, destination, '--platform', 'switch2', '--no-trail', '--frontend'];
}

async function operation(root, name, first, second, options = {}) {
  const manifest = await manifestFor(root);
  const binary = options.binary || await availableBinary(root, manifest).catch(() => {
    throw Error('NXConvert is missing or failed its integrity check');
  });
  const execute = options.run || run;
  const signal = options.signal?.signal;
  if (name === 'pack') {
    check(second && !(await fsp.lstat(second).catch(() => null)),
      'The .nx destination already exists');
    const temporary = `${second}.mac2jb-${crypto.randomBytes(5).toString('hex')}.partial.nx`;
    const args = await packArguments(first, temporary);
    try {
      await execute(binary, args, {signal});
      await inputFile(temporary, '.nx');
      await execute(binary, ['verify', temporary], {signal});
      check(!(await fsp.lstat(second).catch(() => null)), 'The .nx destination already exists');
      await fsp.link(temporary, second);
      return `Saved ${second}`;
    } finally {
      await fsp.rm(temporary, {force: true});
    }
  }
  await inputFile(first, '.nx');
  check(['info', 'contents', 'verify'].includes(name), 'Unknown NXFormat operation');
  return execute(binary, [name, first], {signal});
}

async function main(args) {
  const [name, root, first, second] = args;
  check(name && root && path.isAbsolute(root), 'Usage: gui-nxformat.cjs ACTION RUNTIME [INPUT] [OUTPUT]');
  const manifest = await manifestFor(root);
  const signal = new AbortController();
  process.once('SIGTERM', () => signal.abort());
  process.once('SIGINT', () => signal.abort());
  if (name === '--self-test') {
    await verifyBinary(bundledFor(root, manifest), manifest);
    console.log(`Pinned NXFormat ${manifest.version} manifest verified`);
  } else if (name === 'status') {
    await availableBinary(root, manifest);
    console.log(`NXConvert ${manifest.version} is ready`);
  } else if (name === 'prepare') {
    const binary = await prepare(root, manifest, {signal});
    console.log(`NXConvert ${manifest.version} is ready at ${binary}`);
  } else {
    const result = await operation(root, name, first, second, {signal});
    if (result) console.log(result);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = {manifestFor, cacheFor, verifyBinary, availableBinary, packArguments, operation, prepare, sha256File};
