'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const readline = require('node:readline');

const root = path.resolve(__dirname, '../..');
const upstream = path.join(__dirname, 'upstream');
const manifestDigest = '337c04fdde259a971190761dd1ceb76e8744447e9a8bfd86c4a531474ebbca36';

function check(value, message) { if (!value) throw Error(message); }
function hash(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function emit(type, fields = {}) {
  process.stdout.write('MAC2JB_SDFTP ' + JSON.stringify({type, ...fields}) + '\n');
}

async function verifySource(folder = upstream) {
  const inventory = await fsp.readFile(path.join(folder, 'SOURCE-MANIFEST.json'));
  check(hash(inventory) === manifestDigest, 'The bundled Super File Bros. inventory changed');
  const manifest = JSON.parse(inventory);
  check(manifest.version === '0.1.0' && manifest.platform === 'source' &&
    Object.keys(manifest.files).length === 79, 'The bundled Super File Bros. version changed');
  for (const [name, digest] of Object.entries(manifest.files)) {
    check(!path.isAbsolute(name) && name.split('/').every(part => part && part !== '.' && part !== '..') &&
      /^[a-f0-9]{64}$/.test(digest), 'Invalid Super File Bros. inventory entry');
    const filename = path.join(folder, name);
    const info = await fsp.lstat(filename);
    check(info.isFile() && !info.isSymbolicLink(), 'Super File Bros. contains an unsupported file');
    check(hash(await fsp.readFile(filename)) === digest, 'Changed Super File Bros. source: ' + name);
  }
}

function privateJSON(filename) {
  const info = fs.lstatSync(filename);
  check(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    (info.mode & 0o077) === 0 && info.size <= 8 * 1024 * 1024,
  'The held run contains an unsafe session record');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function verifiedRun(runDirectory, consoleAddress, runtimeRoot = root) {
  check(net.isIPv4(consoleAddress), 'Enter the Switch IPv4 address');
  const vendor = fs.realpathSync(path.join(runtimeRoot, 'vendor'));
  const run = fs.realpathSync(runDirectory);
  const info = fs.lstatSync(runDirectory);
  check(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    (info.mode & 0o077) === 0 && run.startsWith(vendor + path.sep) &&
    path.basename(path.dirname(run)) === 'runs' &&
    /^switch2-[A-Za-z0-9_-]+$/.test(path.basename(run)),
  'Choose the current held FS RPC run in this mac2jb session');
  const result = privateJSON(path.join(run, 'result.json'));
  const proof = privateJSON(path.join(run, 'switch2/fs-execution-current.json'));
  const connection = privateJSON(path.join(run, 'connection.json'));
  const acquisition = privateJSON(path.join(run, 'switch2/current-acquisition.json'));
  const rootProof = privateJSON(path.join(run, 'switch2/ro/root/current-root.json'));
  const session = connection.addresses?.session;
  check(typeof session === 'string' && session.length > 0 &&
    result.verified === true && result.fs?.verified === true && result.fs?.restored === true &&
    result.fs?.cleanup?.deferred === true && result.fs?.cleanup?.donor?.cleanedUp === true &&
    result.fs?.retainedEndpoint?.ready === true && result.fs?.retainedEndpoint?.session === session &&
    result.rpc?.mode === 'held' && result.rpc?.state === 'listening' && !result.completed && !result.error &&
    proof.verified === true && proof.restored === true && proof.cleanup?.deferred === true &&
    proof.retainedEndpoint?.ready === true && proof.session === session &&
    proof.retainedEndpoint.session === session && acquisition.session === session &&
    rootProof.session === session && rootProof.pid === 1 && rootProof.rootHandle,
  'The run is not a verified live held FS RPC session');
  return {run, host: consoleAddress, session};
}

function readOnlySD(storage) {
  const directory = {type: 'dir', size: 0};
  const valid = value => {
    check(typeof value === 'string' && (value === '/sd' || value.startsWith('/sd/')),
      'Only the SD filesystem is available in this export');
    return value;
  };
  return {
    list: value => value === '/' ? [{name: 'sd', ...directory}] : storage.list(valid(value)),
    stat: value => value === '/' ? directory : storage.stat(valid(value)),
    openRead: value => storage.openRead(valid(value)),
    read: (file, offset, count) => storage.read(file, offset, count),
    close: file => storage.close(file)
  };
}

async function exportReadOnly(runDirectory, consoleAddress, {runtimeRoot = root,
  sourceRoot = upstream, onEvent = emit} = {}) {
  await verifySource(sourceRoot);
  const session = verifiedRun(runDirectory, consoleAddress, runtimeRoot);
  const hostFolder = path.dirname(path.dirname(session.run));
  const live = async () => {
    verifiedRun(session.run, session.host, runtimeRoot);
    const state = await require(path.join(hostFolder, 'rpc.cjs')).request(session.run, {command: 'status'});
    check(state?.ready === true, 'The original held RPC session is no longer ready');
  };
  await live();
  const library = require(path.join(sourceRoot, 'tools/dolphin-fs-rpc/library.cjs'));
  const port = await library.availablePort(session.host);
  let attachment, server, panel, pumping, stopping = false, stopRequested = false, failure;
  const requestStop = () => { stopRequested = true; };
  const input = readline.createInterface({input: process.stdin});
  const stopOnInput = line => {
    try { if (JSON.parse(line).action === 'stop') requestStop(); } catch {}
  };
  process.on('SIGTERM', requestStop);
  process.on('SIGINT', requestStop);
  input.on('line', stopOnInput);
  input.on('close', requestStop);
  try {
    check(!stopRequested, 'Read-only SD FTP stopped before opening the filesystem');
    attachment = await require(path.join(sourceRoot,
      'modules/iz-exchange/server/ouncecake/engine/session.cjs')).attachGame(session.run);
    check(!stopRequested, 'Read-only SD FTP stopped before opening the filesystem');
    const storage = await require(path.join(sourceRoot, 'tools/dolphin-fs-rpc/storage.cjs'))
      .createStorage(attachment);
    check(storage.mounts.includes('sd'), 'The SD filesystem is unavailable in this held session');
    check(!stopRequested, 'Read-only SD FTP stopped before opening the listener');
    const rpc = require(path.join(session.run, 'shared/rpc.cjs'));
    const native = await require(path.join(sourceRoot, 'core/console/host/ftp-native.cjs'))
      .create(rpc, session.run);
    const safeStorage = readOnlySD(storage);
    server = require(path.join(sourceRoot, 'core/console/host/ftp-server.cjs')).create({
      ...native, storage: safeStorage, readOnly: true,
      greeting: 'mac2jb SD files, read-only'
    });
    await server.start(port);
    pumping = (async () => {
      while (!stopping) {
        await server.pump();
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();
    pumping.catch(error => { failure ||= error; requestStop(); });
    const listing = await library.probeFtp(session.host, port);
    check(listing.some(line => /(?:^|\s)sd$/.test(line)), 'The SD FTP listing did not verify');
    check(!stopRequested, 'Read-only SD FTP stopped before verification');
    panel = await require('./read-only-panel.cjs').createPanel(safeStorage,
      {ftpURL: 'ftp://' + session.host + ':' + port + '/sd/'});
    onEvent('ready', {url: 'ftp://' + session.host + ':' + port + '/sd/', port,
      browserURL: panel.url, mounts: ['sd'], readOnly: true,
      message: 'Read-only SD browser and FTP are ready'});
    let checked = Date.now();
    while (!stopRequested) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (Date.now() - checked >= 10000) { await live(); checked = Date.now(); }
    }
  } catch (error) { failure = error; }
  finally {
    try { await panel?.close(); } catch (error) { failure ||= error; }
    stopping = true;
    try { await pumping; } catch (error) { failure ||= error; }
    try { await server?.stop(); } catch (error) { failure ||= error; }
    try { await attachment?.close(); } catch (error) { failure ||= error; }
    process.off('SIGTERM', requestStop);
    process.off('SIGINT', requestStop);
    input.off('line', stopOnInput);
    input.off('close', requestStop);
    input.close();
  }
  if (failure) throw failure;
  onEvent('stopped', {message: 'Read-only SD FTP stopped'});
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') {
    await verifySource();
    console.log('Super File Bros. v0.1.0 source verified');
    return;
  }
  check(args.length === 2, 'Usage: read-only-export.cjs <held-run-directory> <Switch-IPv4>');
  await exportReadOnly(args[0], args[1]);
}

module.exports = {verifySource, verifiedRun, readOnlySD, exportReadOnly};
if (require.main === module) main().catch(error => {
  emit('failed', {message: error.message});
  process.exitCode = 1;
});
