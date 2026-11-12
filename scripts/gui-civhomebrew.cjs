'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {createOverlay, buildLauncherPackage} = require('./civhomebrew-catalog-overlay.cjs');

const PREFIX = 'MAC2JB_CIVHOMEBREW ';
const COMMIT = 'ebb3857ebd2c80e4978ab7934651f2bcbefa78b7';
const ARCHIVE_SHA256 = 'c38cb1c193362fb8b1599b6776b4315b5c64aa8dada3d21944de4e67cd68a542';
const TREE_SHA256 = 'fe5b5c4891261c45cf869873169b01d34fec0187051b58feb0e5d9f3524045d5';
const MAX_ARCHIVE = 16 * 1024 * 1024;
const MAX_FRAME = 1024 * 1024;

function emit(type, fields = {}) {
  process.stdout.write(PREFIX + JSON.stringify({type, ...fields}) + '\n');
}

function sourceMetadata(runtimeRoot, options = {}) {
  const metadata = options.metadata || JSON.parse(fs.readFileSync(
    path.join(runtimeRoot, 'packaging/CivHomebrew-source.json'), 'utf8'));
  if (!options.metadata && (metadata.commit !== COMMIT || metadata.archiveSha256 !== ARCHIVE_SHA256 ||
      metadata.treeSha256 !== TREE_SHA256 || metadata.fileCount !== 107 || metadata.version !== '0.4.3' ||
      metadata.url !== 'https://codeload.github.com/XITRIX/CivHomebrew/zip/' + COMMIT)) {
    throw Error('The bundled CivHomebrew source pin does not match this app');
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.commit) ||
      !/^[0-9a-f]{64}$/.test(metadata.archiveSha256) ||
      !/^[0-9a-f]{64}$/.test(metadata.treeSha256) ||
      !Number.isInteger(metadata.fileCount) || metadata.fileCount < 1 || metadata.fileCount > 500 ||
      !/^https:\/\/codeload\.github\.com\//.test(metadata.url)) {
    throw Error('Invalid CivHomebrew source metadata');
  }
  return metadata;
}

function cacheLocation(options = {}) {
  return options.cacheRoot || path.join(os.homedir(), 'Library/Application Support/mac2jb/CivHomebrew');
}

function sourceLocation(metadata, options = {}) {
  return path.join(cacheLocation(options), 'source', metadata.commit);
}

async function sourceDigest(root) {
  const files = [];
  async function visit(directory, relative = '') {
    for (const entry of await fsp.readdir(directory, {withFileTypes: true})) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(location, name);
      else if (entry.isFile()) files.push([name, location]);
      else throw Error('CivHomebrew cache contains a special file: ' + name);
    }
  }
  const info = await fsp.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('CivHomebrew cache is not a regular directory');
  await visit(root);
  files.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const tree = crypto.createHash('sha256');
  for (const [name, file] of files) {
    const digest = crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');
    tree.update(name + '\0' + digest + '\n');
  }
  return {fileCount: files.length, sha256: tree.digest('hex')};
}

async function verifySource(directory, metadata) {
  const actual = await sourceDigest(directory);
  if (actual.fileCount !== metadata.fileCount || actual.sha256 !== metadata.treeSha256) {
    throw Error('CivHomebrew source cache changed; it was preserved and will not be executed');
  }
  return directory;
}

async function removeGeneratedBytecode(root) {
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, {withFileTypes: true})) {
      const location = path.join(directory, entry.name);
      if (entry.name === '__pycache__') {
        const info = await fsp.lstat(location);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const children = await fsp.readdir(location);
        if (!children.length) { await fsp.rmdir(location); continue; }
        const generated = await Promise.all(children.map(async name => {
          const file = path.join(location, name);
          const stat = await fsp.lstat(file);
          return name.endsWith('.pyc') && stat.isFile() && !stat.isSymbolicLink() ? file : null;
        }));
        if (generated.some(file => file === null)) continue;
        for (const file of generated) await fsp.unlink(file);
        await fsp.rmdir(location);
      } else if (entry.isDirectory()) {
        await visit(location);
      }
    }
  }
  await visit(root);
}

async function verifyCachedSource(directory, metadata) {
  try { return await verifySource(directory, metadata); }
  catch (error) {
    if (!error.message.startsWith('CivHomebrew source cache changed;')) throw error;
    await removeGeneratedBytecode(directory);
    return verifySource(directory, metadata);
  }
}

async function sourceStatus(runtimeRoot, options = {}) {
  const metadata = sourceMetadata(runtimeRoot, options);
  const directory = sourceLocation(metadata, options);
  try {
    await fsp.lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return {available: false, version: metadata.version, commit: metadata.commit};
    throw error;
  }
  try {
    await verifyCachedSource(directory, metadata);
    return {available: true, path: directory, version: metadata.version, commit: metadata.commit};
  } catch (error) {
    if (!error.message.startsWith('CivHomebrew source cache changed;')) throw error;
    return {available: false, repairable: true, version: metadata.version, commit: metadata.commit};
  }
}

function fetchArchive(url, progress = () => {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {headers: {'User-Agent': 'mac2jb-CivHomebrew/1'}}, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(Error('CivHomebrew source download returned HTTP ' + response.statusCode));
        return;
      }
      const sizeHeader = Number(response.headers['content-length']);
      if (Number.isFinite(sizeHeader) && sizeHeader > MAX_ARCHIVE) {
        response.destroy(Error('CivHomebrew source archive is too large'));
        return;
      }
      const chunks = [];
      let size = 0, lastReported = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_ARCHIVE) return response.destroy(Error('CivHomebrew source archive is too large'));
        chunks.push(chunk);
        if (size - lastReported >= 65536) {progress(size); lastReported = size;}
      });
      response.once('end', () => {progress(size); resolve(Buffer.concat(chunks));});
      response.once('error', reject);
    });
    request.setTimeout(30000, () => request.destroy(Error('CivHomebrew source download timed out')));
    request.once('error', reject);
  });
}

const EXTRACT_CODE = String.raw`
import pathlib, stat, sys, zipfile
archive, destination, top = sys.argv[1:]
root = pathlib.Path(destination)
total = 0
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    if not entries or len(entries) > 500:
        raise ValueError('Invalid CivHomebrew archive inventory')
    for entry in entries:
        name = entry.filename
        if '\\' in name or '\x00' in name:
            raise ValueError('Unsafe CivHomebrew archive name')
        parts = name.rstrip('/').split('/')
        if parts[0] != top or any(part in ('', '.', '..') for part in parts):
            raise ValueError('Unsafe CivHomebrew archive path')
        rel = parts[1:]
        if not rel:
            continue
        kind = stat.S_IFMT(entry.external_attr >> 16)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError('CivHomebrew archive contains a special file')
        target = root.joinpath(*rel)
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        total += entry.file_size
        if entry.file_size > 16 * 1024 * 1024 or total > 64 * 1024 * 1024:
            raise ValueError('CivHomebrew archive exceeds extraction limit')
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open(entry) as stream, target.open('xb') as output:
            while True:
                block = stream.read(65536)
                if not block: break
                output.write(block)
`;

function pythonEnvironment(runtimeRoot, inherited = process.env) {
  const environment = {...inherited,
    PATH: [runtimeRoot, path.join(runtimeRoot, 'homebrew/python/bin'), inherited.PATH || '/usr/bin:/bin'].join(path.delimiter),
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1'};
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  return environment;
}

function pythonExecutable(runtimeRoot) {
  const executable = path.join(runtimeRoot, 'homebrew/python/bin/python3');
  try { fs.accessSync(executable, fs.constants.X_OK); }
  catch { throw Error('The bundled Python runtime is missing'); }
  return executable;
}

function verifyRuntime(runtimeRoot, options = {}) {
  const metadata = sourceMetadata(runtimeRoot, options);
  const node = path.join(runtimeRoot, 'node');
  try { fs.accessSync(node, fs.constants.X_OK); }
  catch { throw Error('The bundled Node runtime is missing'); }
  pythonExecutable(runtimeRoot);
  return metadata;
}

async function extractArchive(runtimeRoot, archive, destination, metadata) {
  const python = pythonExecutable(runtimeRoot);
  const top = 'CivHomebrew-' + metadata.commit;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', '-c', EXTRACT_CODE, archive, destination, top],
      {env: pythonEnvironment(runtimeRoot), stdio: ['ignore', 'ignore', 'pipe']});
    let errorText = '';
    child.stderr.on('data', data => {errorText = (errorText + data).slice(-2048);});
    child.once('error', reject);
    child.once('close', code => resolve({code, errorText}));
  });
  if (result.code !== 0) throw Error('CivHomebrew archive extraction failed: ' + result.errorText.trim());
}

async function prepareSource(runtimeRoot, options = {}) {
  const metadata = sourceMetadata(runtimeRoot, options);
  const destination = sourceLocation(metadata, options);
  try {
    await fsp.lstat(destination);
    try {
      await verifyCachedSource(destination, metadata);
      return {path: destination, cached: true, metadata};
    } catch (error) {
      if (!error.message.startsWith('CivHomebrew source cache changed;')) throw error;
      const quarantine = destination + '.changed-' + crypto.randomUUID();
      await fsp.rename(destination, quarantine);
      (options.emit || emit)('source-repair', {message: 'Refreshing the pinned CivHomebrew source cache'});
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(destination);
  await fsp.mkdir(parent, {recursive: true, mode: 0o700});
  const working = await fsp.mkdtemp(path.join(parent, '.download-'));
  try {
    const bytes = await (options.fetchArchive || fetchArchive)(metadata.url,
      size => (options.emit || emit)('source-download', {bytes: size}));
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARCHIVE ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== metadata.archiveSha256) {
      throw Error('The downloaded CivHomebrew source archive did not match its pinned SHA-256');
    }
    const archive = path.join(working, 'source.zip');
    const extracted = path.join(working, 'source');
    await fsp.writeFile(archive, bytes, {flag: 'wx', mode: 0o600});
    await fsp.mkdir(extracted, {mode: 0o700});
    await (options.extractArchive || extractArchive)(runtimeRoot, archive, extracted, metadata);
    await verifySource(extracted, metadata);
    try { await fsp.rename(extracted, destination); }
    catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
      await verifySource(destination, metadata);
    }
    return {path: destination, cached: false, metadata};
  } finally {
    await fsp.rm(working, {recursive: true, force: true});
  }
}

function validAddress(value) {
  if (!net.isIPv4(value)) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168;
}

function companionRequest(address, request, options = {}) {
  const port = options.port || 9027;
  const timeout = options.timeout || 10000;
  const bytes = Buffer.from(JSON.stringify({protocol: 1, ...request}));
  if (!(validAddress(address) || options.allowLoopback && address === '127.0.0.1') ||
      bytes.length > MAX_FRAME) throw Error('Invalid CivHomebrew companion request');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: address, port});
    let pending = Buffer.alloc(0), expected = null, finished = false;
    const done = (error, result) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(timeout, () => done(Error('CivHomebrew companion timed out')));
    socket.once('connect', () => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      socket.write(Buffer.concat([length, bytes]));
    });
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      if (expected === null && pending.length >= 4) {
        expected = pending.readUInt32BE(0);
        if (expected < 1 || expected > MAX_FRAME) return done(Error('Invalid CivHomebrew companion response length'));
      }
      if (expected !== null && pending.length >= expected + 4) {
        let reply;
        try { reply = JSON.parse(pending.subarray(4, expected + 4).toString('utf8')); }
        catch {return done(Error('Invalid CivHomebrew companion response'));}
        if (!reply || reply.ok !== true) return done(Error(reply?.error || 'CivHomebrew companion rejected the request'));
        done(null, reply);
      }
      if (pending.length > MAX_FRAME + 4) done(Error('CivHomebrew companion response is too large'));
    });
    socket.once('error', done);
    socket.once('end', () => done(Error('CivHomebrew companion closed before its response')));
  });
}

async function probeCompanion(address, options = {}) {
  const hello = await companionRequest(address, {op: 'hello'}, options);
  if (hello.app !== 'CivHomebrew' || hello.protocol !== 1 || hello.core !== 1) {
    throw Error('Port 9027 did not identify a compatible CivHomebrew core');
  }
  const status = await companionRequest(address, {op: 'status'}, options);
  if (!status.state || typeof status.state.mode !== 'string' || status.state.closed) {
    throw Error('CivHomebrew companion status was invalid');
  }
  return status.state;
}

async function refreshRunningLauncher(runtimeRoot, address, options = {}) {
  const report = options.emit || emit;
  let state = options.initialState || await probeCompanion(address, options);
  if (state.mode !== 'launcher' || state.busy || !state.launcher) {
    return state;
  }
  const prepared = await prepareSource(runtimeRoot, {...options, emit: report});
  const built = options.testLauncherPackage
    ? {package: options.testLauncherPackage, cleanup: async () => {}}
    : await buildLauncherPackage(prepared.path);
  try {
    report('refresh-start', {message: 'Updating CivHomebrew on the Switch'});
    await companionRequest(address, {op: 'update', package: built.package}, options);
  } finally {
    await built.cleanup();
  }
  const deadline = Date.now() + (options.refreshTimeout || 20000);
  await new Promise(resolve => setTimeout(resolve, options.refreshInitialDelay ?? 800));
  while (Date.now() < deadline) {
    try {
      state = await probeCompanion(address, {...options, timeout: Math.min(options.timeout || 10000, 2000)});
      if (state.mode === 'launcher' && !state.busy && state.launcher) {
        report('refresh-ready', {message: 'CivHomebrew updated on the Switch'});
        return state;
      }
    } catch (error) {
      if (error.message.includes('did not identify a compatible CivHomebrew core')) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, options.refreshPollInterval || 200));
  }
  throw Error('CivHomebrew did not confirm the updated launcher. Return to its launcher and connect again');
}

async function stopCompanion(address, options = {}) {
  const state = await probeCompanion(address, options);
  if (state.mode === 'app') {
    return {blocked: true,
      message: 'Close the foreground app on your Switch and return to CivHomebrew, then press Stop again'};
  }
  if (state.busy) {
    return {blocked: true,
      message: 'CivHomebrew is changing apps. Wait for its launcher, then press Stop again'};
  }
  await companionRequest(address, {op: 'shutdown'}, options);
  const deadline = Date.now() + (options.stopTimeout || 5000);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, options.stopInterval || 200));
    try {
      const reply = await companionRequest(address, {op: 'status'}, {...options, timeout: 1000});
      if (reply.state?.closed === true) return {stopped: true};
    } catch (error) {
      if (error.code === 'ECONNREFUSED') return {stopped: true};
      throw error;
    }
  }
  throw Error('CivHomebrew did not confirm shutdown. Check the Switch before retrying');
}

function spawnPython(runtimeRoot, source, script, args, options = {}) {
  return (options.spawn || spawn)(pythonExecutable(runtimeRoot), ['-B', path.join(source, script), ...args],
    {cwd: source, env: pythonEnvironment(runtimeRoot, options.environment || process.env),
      stdio: ['ignore', 'pipe', 'pipe']});
}

function collectLines(child, report) {
  let lastLine = '', logBytes = 0, sawReady = false;
  const handle = stream => {
    let pending = '';
    stream.on('data', chunk => {
      pending += chunk.toString('utf8');
      let position;
      while ((position = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, position).replace(/\r$/, '');
        pending = pending.slice(position + 1);
        lastLine = line || lastLine;
        if (line.includes('CIVHOME_BREW_READY')) sawReady = true;
        logBytes += Buffer.byteLength(line);
        if (logBytes <= 2 * 1024 * 1024) report('log', {message: line.slice(0, 4096)});
      }
      if (pending.length > 16384) pending = pending.slice(-4096);
    });
    stream.once('end', () => {
      if (pending) {
        lastLine = pending;
        if (pending.includes('CIVHOME_BREW_READY')) sawReady = true;
        report('log', {message: pending.slice(0, 4096)});
      }
    });
  };
  handle(child.stdout); handle(child.stderr);
  return {get lastLine() {return lastLine;}, get sawReady() {return sawReady;}};
}

async function finiteAction(action, runtimeRoot, address, source, options = {}) {
  const report = options.emit || emit;
  const backups = path.join(cacheLocation(options), 'backups', address);
  await fsp.mkdir(backups, {recursive: true, mode: 0o700});
  const args = [address, '--backup-dir', backups];
  if (action === 'restore') args.push('--restore');
  report('install-start', {action, backupPath: backups});
  const child = spawnPython(runtimeRoot, source, 'tools/install_homebrew.py', args, options);
  const lines = collectLines(child, report);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  if (result.code !== 0) throw Error(lines.lastLine || 'CivHomebrew ' + action + ' failed');
  report(action === 'restore' ? 'restored' : 'installed', {backupPath: backups,
    message: action === 'restore' ? 'Original CivSwitch trigger restored' : 'CivHomebrew boot trigger installed'});
  return {backupPath: backups};
}

async function launchTemporary(runtimeRoot, address, source, options = {}) {
  const report = options.emit || emit;
  report('launch-start', {message: 'Sending CivHomebrew to the open CivSwitch loader'});
  const child = spawnPython(runtimeRoot, source, 'tools/payload_menu.py', ['menu', address], options);
  const lines = collectLines(child, report);
  let closed = false, stopping = false, announced = false;
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {closed = true; resolve({code, signal});});
  });
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      if (announced) {
        await companionRequest(address, {op: 'shutdown'}, {timeout: 5000});
        await Promise.race([completion, new Promise(resolve => setTimeout(resolve, 5000))]);
      }
    } catch { /* the sender still needs to be reaped */ }
    if (!closed) child.kill('SIGTERM');
  };
  const onSignal = () => {void stop();};
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    const deadline = Date.now() + 30000;
    while (!closed && Date.now() < deadline) {
      if (lines.sawReady) {
        try {
          const state = await probeCompanion(address, {timeout: 1500});
          if (closed) break;
          announced = true;
          report('ready', {mode: state.mode, launcher: state.launcher, ftp: state.ftp,
            message: 'CivHomebrew is running on the Switch'});
          break;
        } catch { /* the listener can become reachable just after its ready marker */ }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!announced && !closed) {
      await stop();
      throw Error('CivHomebrew did not confirm its companion service on port 9027');
    }
    const result = await completion;
    if (!announced) throw Error(lines.lastLine || 'CivHomebrew stopped before readiness');
    if (result.code !== 0 && !stopping) throw Error(lines.lastLine || 'CivHomebrew stopped unexpectedly');
    report('stopped', {message: 'CivHomebrew stopped'});
    return result;
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    if (!closed) {child.kill('SIGTERM'); await completion.catch(() => {});}
  }
}

async function main(args = process.argv.slice(2), options = {}) {
  const [action, rootArg, address] = args;
  if (!['--self-test', 'status', 'prepare', 'probe', 'launch', 'install', 'restore', 'shutdown'].includes(action) ||
      !rootArg || (['--self-test', 'status', 'prepare'].includes(action) ? args.length !== 2 :
        args.length !== 3 || !(validAddress(address) || options.allowLoopback && address === '127.0.0.1'))) {
    throw Error('usage: gui-civhomebrew.cjs --self-test|status|prepare RUNTIME_ROOT or probe|launch|install|restore|shutdown RUNTIME_ROOT SWITCH_IPV4');
  }
  const runtimeRoot = path.resolve(rootArg);
  const report = options.emit || emit;
  if (action === '--self-test') {
    const metadata = verifyRuntime(runtimeRoot, options);
    report('self-test', {version: metadata.version, commit: metadata.commit,
      message: 'Pinned CivHomebrew source and bundled runtimes verified offline'});
    return {selfTest: true};
  }
  if (action === 'status') {
    const status = await sourceStatus(runtimeRoot, options);
    report('source-status', status);
    return status;
  }
  if (action === 'probe') {
    const initial = await probeCompanion(address, options);
    let state = initial, refreshError = null;
    if (initial.mode === 'launcher' && !initial.busy && initial.launcher) {
      try {
        state = await refreshRunningLauncher(runtimeRoot, address, {...options, initialState: initial});
      } catch (error) {
        refreshError = error;
        state = await probeCompanion(address, options).catch(() => initial);
      }
    }
    report('probe-ready', {mode: state.mode, launcher: state.launcher, ftp: state.ftp});
    if (state.mode !== 'launcher' || state.busy || !state.launcher) {
      report('refresh-deferred', {message: 'Return to the CivHomebrew launcher, then connect again to update it'});
    } else if (refreshError) {
      report('refresh-failed', {message: 'CivHomebrew is connected, but its UI update failed: ' + refreshError.message});
    }
    return state;
  }
  if (action === 'shutdown') {
    const result = await stopCompanion(address, options);
    report(result.blocked ? 'blocked' : 'stopped', {message: result.message || 'CivHomebrew closed'});
    return result;
  }
  const prepared = await prepareSource(runtimeRoot, {...options, emit: report});
  report('source-ready', {path: prepared.path, cached: prepared.cached,
    version: prepared.metadata.version, commit: prepared.metadata.commit});
  if (action === 'prepare') return prepared;
  if (action === 'restore') return finiteAction(action, runtimeRoot, address, prepared.path, options);
  const overlay = await createOverlay(prepared.path);
  try {
    if (action === 'launch') return await launchTemporary(runtimeRoot, address, overlay.path, options);
    return await finiteAction(action, runtimeRoot, address, overlay.path, options);
  } finally {
    await overlay.cleanup();
  }
}

if (require.main === module) main().catch(error => {
  emit('failed', {message: error.message});
  process.exitCode = 1;
});

module.exports = {main, sourceMetadata, sourceStatus, sourceDigest, verifySource, prepareSource,
  pythonEnvironment, verifyRuntime, validAddress, companionRequest, probeCompanion, refreshRunningLauncher, stopCompanion,
  fetchArchive, launchTemporary};
