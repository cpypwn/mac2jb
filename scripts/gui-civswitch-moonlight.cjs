#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const source = require('../packaging/Moonlight-CivSwitch-source.json');

const PREFIX = 'MAC2JB_CIV_MOONLIGHT ';
const MAX_FRAME = 48 * 1024 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;

function emit(type, fields = {}) {
  process.stdout.write(PREFIX + JSON.stringify({type, ...fields}) + '\n');
}

function verifyPin() {
  if (source.repository !== 'https://github.com/XITRIX/Moonlight-CivSwitch' ||
      source.tag !== 'v0.1.3' ||
      source.asset !== 'https://github.com/XITRIX/Moonlight-CivSwitch/releases/download/v0.1.3/moonlight.civapp' ||
      source.assetSize !== 1953490 ||
      source.assetSha256 !== '7986a1655431a6fbddc7a48d6c0ea9c76a5fd487f97ac446ad2155aeac5e35fc' ||
      source.packageId !== 'moonlight-civswitch' || source.packageRelease !== '0.1.3')
    throw Error('Moonlight release pin is invalid');
  return source;
}

function validAddress(address, allowLoopback = false) {
  if (!net.isIPv4(address)) return false;
  if (allowLoopback && address === '127.0.0.1') return true;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168;
}

function inspectPackage(bytes, pin = source) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== pin.assetSize)
    throw Error('The Moonlight package size does not match the pinned release');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== pin.assetSha256)
    throw Error('The Moonlight package checksum does not match the pinned release');
  let item;
  try { item = JSON.parse(bytes.toString('utf8')); }
  catch { throw Error('The Moonlight package is not valid JSON'); }
  if (!item || item.format !== 'civswitch-app' || item.version !== 1 ||
      item.id !== pin.packageId || item.name !== 'Moonlight' ||
      item.metadata?.release !== pin.packageRelease || item.metadata?.api !== 1 ||
      !Array.isArray(item.scripts) || !item.scripts.length || item.scripts.length > 64 ||
      item.scripts.some(part => !part || typeof part.name !== 'string' ||
        typeof part.source !== 'string' || !part.source.trim()))
    throw Error('The Moonlight package metadata does not match the pinned release');
  return item;
}

async function cacheDirectory(root, options = {}) {
  let current = path.resolve(options.cacheRoot || os.homedir());
  let stat = await fs.lstat(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe Moonlight cache root');
  if (options.cacheRoot) return current;
  for (const component of ['Library', 'Application Support', 'mac2jb', 'CivSwitch', 'Moonlight']) {
    current = path.join(current, component);
    try { await fs.mkdir(current, {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe Moonlight cache directory');
  }
  return current;
}

async function cachePath(root, options = {}) {
  return path.join(await cacheDirectory(root, options), 'moonlight-v0.1.3.civapp');
}

async function readCached(root, pin = source, options = {}) {
  const file = await cachePath(root, options);
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unsafe Moonlight cache file');
  const bytes = await fs.readFile(file);
  return {file, bytes, package: inspectPackage(bytes, pin)};
}

async function downloadPackage(url = source.asset, fetcher = globalThis.fetch, pin = source) {
  const response = await fetcher(url, {signal: AbortSignal.timeout(45000)});
  if (!response.ok || !response.body) throw Error('Moonlight download failed: HTTP ' + response.status);
  if (!response.url.startsWith('https://github.com/') &&
      !response.url.startsWith('https://release-assets.githubusercontent.com/') &&
      !response.url.startsWith('https://objects.githubusercontent.com/'))
    throw Error('Moonlight download redirected to an unexpected host');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > pin.assetSize) throw Error('Moonlight download exceeded the pinned size');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  inspectPackage(bytes, pin);
  return bytes;
}

async function prepare(root, options = {}) {
  const pin = options.pin || source;
  const cached = await readCached(root, pin, options);
  if (cached) return {...cached, downloaded: false};
  const bytes = await downloadPackage(pin.asset, options.fetcher, pin);
  const file = await cachePath(root, options);
  const temporary = file + '.' + crypto.randomBytes(8).toString('hex') + '.part';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); }
    finally { await handle.close(); }
    const existing = await readCached(root, pin, options);
    if (existing) return {...existing, downloaded: false};
    try { await fs.link(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return {...await readCached(root, pin, options), downloaded: false};
    }
    return {file, bytes, package: inspectPackage(bytes, pin), downloaded: true};
  } finally {
    await fs.rm(temporary, {force: true}).catch(() => {});
  }
}

function asciiJSON(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function companionRequest(address, operation, options = {}) {
  const port = options.port ?? 9027;
  if (!validAddress(address, options.allowLoopback)) throw Error('Enter a private Switch IPv4 address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid CivHomebrew companion port');
  const body = Buffer.from(asciiJSON({protocol: 1, ...operation}), 'ascii');
  if (!body.length || body.length > MAX_FRAME) throw Error('CivHomebrew request exceeds 48 MiB');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host: address, port});
    let settled = false;
    let pending = Buffer.alloc(0);
    let expected = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(options.timeoutMs ?? (operation.op === 'install' ? 180000 : 12000),
      () => finish(Error('CivHomebrew companion timed out; inspect the Switch before retrying')));
    socket.once('connect', () => socket.write(frame));
    socket.on('data', chunk => {
      if (settled) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length >= 4 && expected === null) {
        expected = pending.readUInt32BE(0);
        if (!expected || expected > MAX_RESPONSE) return finish(Error('Invalid CivHomebrew response length'));
      }
      if (expected !== null && pending.length >= expected + 4) {
        let reply;
        try { reply = JSON.parse(pending.subarray(4, expected + 4).toString('utf8')); }
        catch { return finish(Error('Invalid CivHomebrew response JSON')); }
        if (!reply || reply.ok !== true)
          return finish(Error(typeof reply?.error === 'string' ? reply.error : 'CivHomebrew rejected the request'));
        finish(null, reply);
      }
    });
    socket.once('end', () => finish(Error('CivHomebrew closed before replying; inspect the Switch before retrying')));
    socket.once('error', error => finish(Error('CivHomebrew connection failed: ' + (error.code || error.message))));
  });
}

async function probe(address, options = {}) {
  const hello = await companionRequest(address, {op: 'hello'}, options);
  if (hello.app !== 'CivHomebrew' || hello.protocol !== 1 || hello.packageVersion !== 1)
    throw Error('The service on port 9027 is not a compatible CivHomebrew companion');
  const state = await companionRequest(address, {op: 'status'}, options);
  const list = await companionRequest(address, {op: 'list'}, options);
  if (!state.state || !Array.isArray(list.entries)) throw Error('CivHomebrew status is incomplete');
  return {state: state.state, entries: list.entries};
}

async function install(root, address, options = {}) {
  const pin = options.pin || source;
  const companion = await probe(address, options);
  if (companion.state.busy || companion.state.mode === 'app' || companion.state.closed)
    throw Error('Close the current CivHomebrew app and wait for the launcher before installing Moonlight');
  const item = await prepare(root, options);
  const reply = await companionRequest(address, {op: 'install', package: item.package}, options);
  if (reply.entry?.id !== pin.packageId || reply.entry?.name !== 'Moonlight')
    throw Error('CivHomebrew did not confirm the Moonlight installation; inspect the Switch before retrying');
  return {file: item.file, entry: reply.entry, downloaded: item.downloaded};
}

async function launch(address, options = {}) {
  const pin = options.pin || source;
  const companion = await probe(address, options);
  if (companion.state.busy || companion.state.mode !== 'launcher' || companion.state.closed)
    throw Error('Return to the CivHomebrew launcher before opening Moonlight');
  if (!companion.entries.some(entry => entry.id === pin.packageId))
    throw Error('Install Moonlight in CivHomebrew before opening it');
  const reply = await companionRequest(address, {op: 'run', id: pin.packageId}, options);
  if (reply.state !== 'accepted' || reply.name !== 'Moonlight')
    throw Error('CivHomebrew did not confirm Moonlight launch; inspect the Switch before retrying');
  return reply;
}

async function main(args = process.argv.slice(2), options = {}) {
  if (args[0] === '--self-test' && args.length === 2) {
    verifyPin();
    const root = path.resolve(args[1]);
    const script = await fs.lstat(path.join(root, 'scripts/gui-civswitch-moonlight.cjs'));
    const manifest = await fs.lstat(path.join(root, 'packaging/Moonlight-CivSwitch-source.json'));
    if (!script.isFile() || script.isSymbolicLink() || !manifest.isFile() || manifest.isSymbolicLink())
      throw Error('Moonlight runtime files are missing or unsafe');
    (options.emit || emit)('self-test', {version: source.packageRelease,
      message: 'Pinned Moonlight installer is ready; no network request sent'});
    return {selfTest: true};
  }
  if (args.length !== 3 || !['status', 'prepare', 'install', 'launch'].includes(args[0]))
    throw Error('usage: gui-civswitch-moonlight.cjs status|prepare|install|launch RUNTIME_ROOT SWITCH_IPV4');
  const [action, root, address] = args;
  const pin = options.pin || source;
  if (!validAddress(address, options.allowLoopback)) throw Error('Enter a private Switch IPv4 address');
  const report = options.emit || emit;
  if (action === 'prepare') {
    report('status', {message: 'Verifying Moonlight v' + pin.packageRelease});
    const item = await prepare(root, options);
    report('prepared', {version: pin.packageRelease, path: item.file, downloaded: item.downloaded,
      message: item.downloaded ? 'Moonlight package downloaded and verified' : 'Moonlight package verified'});
    return item;
  }
  if (action === 'status') {
    let cached = false;
    let cacheError;
    try { cached = !!(await readCached(root, pin, options)); }
    catch (error) { cacheError = error.message; }
    try {
      const companion = await probe(address, options);
      const installed = companion.entries.some(entry => entry.id === pin.packageId);
      const result = {connected: true, prepared: cached, installed, busy: !!companion.state.busy,
        mode: companion.state.mode, version: pin.packageRelease,
        ...(cacheError ? {cacheError} : {}), message: installed ? 'Moonlight is installed in CivHomebrew' :
          'CivHomebrew is ready for Moonlight'};
      report('status', result);
      return result;
    } catch (error) {
      const result = {connected: false, prepared: cached, installed: false, version: pin.packageRelease,
        ...(cacheError ? {cacheError} : {}), message: error.message};
      report('status', result);
      return result;
    }
  }
  if (action === 'launch') {
    report('status', {message: 'Opening Moonlight through CivHomebrew'});
    await launch(address, options);
    report('launched', {message: 'Moonlight is opening on your Switch'});
    return {launched: true};
  }
  report('status', {message: 'Checking CivHomebrew on ' + address + ':9027'});
  const result = await install(root, address, options);
  report('installed', {version: pin.packageRelease, path: result.file, downloaded: result.downloaded,
    message: 'Moonlight installed in CivHomebrew. Open it on your Switch to pair with Sunshine'});
  return result;
}

if (require.main === module) main().catch(error => {
  emit('error', {message: error.message});
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});

module.exports = {source, validAddress, inspectPackage, cachePath, readCached, downloadPackage,
  prepare, asciiJSON, companionRequest, probe, install, launch, verifyPin, main};
