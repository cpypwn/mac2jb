#!/usr/bin/env node
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {setTimeout: sleep} = require('node:timers/promises');
const {constants} = require('node:fs');
const crypto = require('node:crypto');
const {create, safeDiagnostic} = require('./server.cjs');
const {build} = require('./package.cjs');
const PREFIX = 'MAC2JB_CIV_STREMIO ';
const emit = (type, fields = {}) => process.stdout.write(PREFIX + JSON.stringify({type, ...fields}) + '\n');
const BRIDGE_PORT = 39384;
let activityLog = null;

async function createActivityLog(support) {
  const directory = path.join(support, 'CivHomebrew', 'Logs');
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const file = path.join(directory, 'stremio.log');
  const handle = await fs.open(file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const info = await handle.stat();
  if (!info.isFile() || info.uid !== process.getuid()) {
    await handle.close(); throw Error('Stremio activity log permissions are unsafe');
  }
  await handle.chmod(0o600);
  let size = info.size, pending = Promise.resolve();
  const write = (kind, message) => {
    const line = Buffer.from(`${new Date().toISOString()} ${kind} ${safeDiagnostic(message)}\n`);
    pending = pending.then(async () => {
      if (size + line.length > 256 * 1024) { await handle.truncate(0); size = 0; }
      await handle.writeFile(line); size += line.length;
    });
    return pending;
  };
  return {file, write, async close() { await pending; await handle.close(); }};
}

function report(type, fields = {}) {
  emit(type, fields);
  if (fields.message) activityLog?.write(type, fields.message).catch(() => {});
}

async function installToken(file) {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077))
      throw Error('Stremio install token permissions are unsafe');
    const current = (await fs.readFile(file, 'utf8')).trim();
    if (!/^[0-9a-f]{48}$/.test(current)) throw Error('Stremio install token is invalid');
    return current;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = crypto.randomBytes(24).toString('hex');
  try { await fs.writeFile(file, token + '\n', {flag: 'wx', mode: 0o600}); return token; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return installToken(file);
}

async function readInstallState(file) {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077))
      return null;
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!value || typeof value.initialAddress !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest) ||
        !/^[0-9a-f]{8}$/.test(value.checksum)) return null;
    return value;
  } catch { return null; }
}

async function writeInstallState(file, value) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600});
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, {force: true}).catch(() => {}); }
}

async function readConfig(stream = process.stdin, maximum = 2 * 1024 * 1024) {
  let bytes = 0, parts = [];
  for await (const part of stream) {
    bytes += part.length;
    if (bytes > maximum) throw Error('Stremio account settings exceed the size limit');
    parts.push(part);
  }
  let config;
  try { config = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw Error('Invalid Stremio account settings'); }
  if (!config || !Array.isArray(config.addonUrls) || !Array.isArray(config.libraryItems))
    throw Error('Stremio account settings must contain addonUrls and libraryItems arrays');
  return config;
}

function installedChecksum(item) {
  const hash = value => {
    let result = 2166136261;
    for (let index = 0; index < value.length; index++)
      result = Math.imul(result ^ value.charCodeAt(index), 16777619);
    return (result >>> 0).toString(16).padStart(8, '0');
  };
  const icon = item.icon ? Buffer.from(item.icon.slice('data:image/png;base64,'.length), 'base64') : null;
  const metadata = {author: item.metadata?.author || '', release: item.metadata?.release || '',
    description: item.metadata?.description || '', api: 1};
  const manifest = {format: 'civswitch-installed-app', version: 1, id: item.id, name: item.name,
    metadata,
    scripts: item.scripts.map(script => ({name: script.name, path: 'scripts/' + script.name,
      bytes: Buffer.byteLength(script.source, 'utf8'), checksum: hash(script.source)})),
    icon: icon ? {path: 'icon.png', bytes: icon.length, checksum: hash(icon.toString('latin1'))} : null};
  return hash(JSON.stringify(manifest));
}

async function installClient({projectRoot, consoleIP, support, probe, request, localAddress} = {}) {
  const token = await installToken(path.join(support, 'civ-stremio-install-token'));
  const stateFile = path.join(support, 'civ-stremio-install-state.json');
  const companion = await probe(consoleIP);
  if (companion.state.busy || companion.state.closed || companion.state.mode !== 'launcher')
    throw Error('Return to the CivHomebrew launcher before installing Stremio');
  const previous = await readInstallState(stateFile);
  const initialAddress = `${await localAddress(consoleIP)}:${BRIDGE_PORT}`;
  const {item, bytes} = await build({projectRoot, installToken: token, initialAddress});
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const checksum = installedChecksum(item);
  const existing = companion.entries.find(entry => entry.id === item.id);
  if (existing?.checksum === checksum) {
    if (previous?.checksum !== checksum || previous.digest !== digest || previous.initialAddress !== initialAddress)
      await writeInstallState(stateFile, {initialAddress, digest, checksum});
    return {item, bytes, installed: false};
  }
  const installed = await request(consoleIP, {op: 'install', package: item});
  if (installed.entry?.id !== item.id || installed.entry.checksum !== checksum)
    throw Error('CivHomebrew did not confirm Stremio installation');
  await writeInstallState(stateFile, {initialAddress, digest, checksum});
  return {item, bytes, installed: true};
}

async function prepareBridgeClient({projectRoot, consoleIP, support, probe, request,
  localAddress, install = false} = {}) {
  const stateFile = path.join(support, 'civ-stremio-install-state.json');
  const previous = await readInstallState(stateFile);
  const companion = await probe(consoleIP);
  if (companion.state.busy || companion.state.closed)
    throw Error('Wait for CivHomebrew to finish its current action');
  if (companion.state.mode !== 'launcher' &&
      !(companion.state.mode === 'app' && companion.state.app === 'civ-stremio'))
    throw Error('Open the CivHomebrew launcher before preparing Stremio');
  const token = await installToken(path.join(support, 'civ-stremio-install-token'));
  const initialAddress = `${await localAddress(consoleIP)}:${BRIDGE_PORT}`;
  const {item, bytes} = await build({projectRoot, installToken: token, initialAddress});
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const checksum = installedChecksum(item);
  const existing = companion.entries.find(entry => entry.id === item.id);
  if (existing?.checksum === checksum) {
    if (previous?.checksum !== checksum || previous.digest !== digest || previous.initialAddress !== initialAddress)
      await writeInstallState(stateFile, {initialAddress, digest, checksum});
    return {item, bytes, token, initialAddress, installed: false};
  }
  if (!install && !existing) return null;
  if (companion.state.mode !== 'launcher' && !install)
    return {item, bytes, token, initialAddress, installed: false, pendingUpdate: true};
  if (companion.state.mode !== 'launcher')
    throw Error('Return to the CivHomebrew launcher to update Stremio for this Mac');
  const result = await request(consoleIP, {op: 'install', package: item});
  if (result.entry?.id !== item.id || result.entry.checksum !== checksum)
    throw Error('CivHomebrew did not confirm Stremio installation');
  await writeInstallState(stateFile, {initialAddress, digest, checksum});
  return {item, bytes, token, initialAddress, installed: true};
}

async function superviseBridge({getStatus, openBridge, onEvent = () => {}, signal,
  pollMs = 750, ownerAlive = () => true, refreshWhenReady, watchForInstall = false,
  refreshIntervalMs = 5000, isReady = () => true} = {}) {
  let session = null, closing = null, awaitingExit = false, statusFailures = 0, lastError = '';
  let refreshPending = typeof refreshWhenReady === 'function', nextRefresh = 0;
  if (refreshPending && !watchForInstall)
    onEvent('status', {message: 'Return to CivHomebrew to update Stremio'});
  const closeSession = reason => {
    if (closing) return closing;
    if (!session) return Promise.resolve();
    const current = session;
    session = null;
    closing = Promise.resolve().then(() => current.close()).then(() => {
      onEvent('bridge-closed', {message: reason});
    }).finally(() => { closing = null; });
    return closing;
  };
  const clientClosed = () => {
    awaitingExit = true;
    closeSession('Stremio closed on the Switch').catch(error =>
      onEvent('error', {message: safeDiagnostic(error.message)}));
  };
  try {
    while (!signal?.aborted && ownerAlive()) {
      let state;
      try {
        const response = await getStatus();
        state = response?.state;
        if (!state || typeof state.mode !== 'string') throw Error('CivHomebrew status is incomplete');
        statusFailures = 0;
      } catch (error) {
        statusFailures++;
        if (statusFailures === 3) {
          await closeSession('Stremio connection ended');
          onEvent('error', {message: safeDiagnostic(error.message)});
        }
        await sleep(pollMs, undefined, {signal}).catch(() => {});
        continue;
      }
      const active = !state.closed && state.mode === 'app' && state.app === 'civ-stremio';
      if (!active) {
        awaitingExit = false;
        lastError = '';
        await closeSession('Stremio closed on the Switch');
        if (refreshPending && !state.busy && !state.closed && state.mode === 'launcher' &&
            Date.now() >= nextRefresh) {
          try {
            const updated = await refreshWhenReady();
            if (updated !== false) {
              refreshPending = watchForInstall;
              if (updated === undefined || updated.installed)
                onEvent('installed', {message: 'Stremio updated in CivHomebrew'});
            }
            nextRefresh = Date.now() + (watchForInstall ? refreshIntervalMs : 0);
          } catch (error) {
            nextRefresh = Date.now() + refreshIntervalMs;
            onEvent('error', {message: safeDiagnostic(error.message)});
          }
        }
      } else if (!awaitingExit && !session && !closing && isReady()) {
        try {
          const current = await openBridge({onClientClose: clientClosed});
          if (signal?.aborted || awaitingExit) {
            await current.close();
          } else {
            session = current;
            lastError = '';
            onEvent('bridge-ready', {message: 'Stremio ready in CivHomebrew',
              bridgeHost: current.host, bridgePort: current.port});
          }
        } catch (error) {
          const detail = error.code === 'EADDRINUSE' ?
            'Another mac2jb instance is using the Stremio bridge. Close its Stremio session' :
            safeDiagnostic(error.message);
          if (detail !== lastError) onEvent('error', {message: detail});
          lastError = detail;
        }
      }
      await sleep(pollMs, undefined, {signal}).catch(() => {});
    }
  } finally {
    await closeSession('Stremio session stopped');
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 2 && args[0] === '--self-test') {
    const {item, bytes} = await build({projectRoot: path.resolve(args[1]),
      installToken: 'f'.repeat(48)});
    const script = name => item.scripts.find(entry => entry.name === name)?.source || '';
    if (bytes.length < 1024 || !script('native-player.js').includes('JellyfinNativePlayer') ||
        !script('native-http.js').includes('JellyfinNativeHttp') ||
        !script('app.js').includes('CivStremioConfig'))
      throw Error('CivHomebrew Stremio media components are incomplete');
    emit('ready', {message: 'CivHomebrew Stremio package self-test passed', packageBytes: bytes.length});
    return;
  }
  const installing = args.length === 3 && args[0] === 'install';
  const serving = args.length === 5 && args[0] === 'serve' &&
    ['--install', '--if-installed'].includes(args[3]) && args[4] === '--config-stdin';
  if (!installing && !serving)
    throw Error('Usage: node run.cjs install PROJECT_ROOT SWITCH_IP | serve PROJECT_ROOT SWITCH_IP --install|--if-installed --config-stdin');
  const [, root, consoleIP] = args;
  const projectRoot = path.resolve(root);
  const support = path.join(os.homedir(), 'Library', 'Application Support', 'mac2jb');
  activityLog = await createActivityLog(support);
  const {probe, companionRequest} = require(path.join(projectRoot, 'scripts/gui-civswitch-moonlight.cjs'));
  if (installing) {
    const {routeAddress} = require(path.join(projectRoot, 'stremio/receiver.cjs'));
    report('status', {message: 'Checking CivHomebrew on the Switch'});
    const result = await installClient({projectRoot, consoleIP, support, probe,
      request: companionRequest, localAddress: routeAddress});
    report('installed', {message: result.installed ? 'Stremio installed in CivHomebrew' :
      'Stremio is already installed in CivHomebrew', packageBytes: result.bytes.length});
    await activityLog.close(); activityLog = null;
    return;
  }
  report('status', {message: 'Reading Stremio account settings'});
  const config = await readConfig();
  const {routeAddress} = require(path.join(projectRoot, 'stremio/receiver.cjs'));
  report('status', {message: 'Checking CivHomebrew on the Switch'});
  let client = await prepareBridgeClient({projectRoot, consoleIP, support, probe,
    request: companionRequest, localAddress: routeAddress, install: args[3] === '--install'});
  if (!client) report('absent', {message: 'Waiting for Stremio to be installed in CivHomebrew'});
  if (client.installed)
    report('installed', {message: 'Stremio installed in CivHomebrew', packageBytes: client.bytes.length});
  report('status', {message: 'Watching CivHomebrew for Stremio'});
  const {SourcePreferences} = require(path.join(projectRoot, 'stremio/source-preferences.cjs'));
  const sourcePreferences = await SourcePreferences.load(path.join(os.homedir(), 'Library',
    'Application Support', 'mac2jb', 'stremio-last-sources.json'));
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
  const ownerPID = process.ppid;
  const ownerAlive = () => {
    if (process.ppid !== ownerPID) return false;
    try { process.kill(ownerPID, 0); return true; }
    catch { return false; }
  };
  report('watching', {message: 'Stremio will start when opened in CivHomebrew',
    packageBytes: client?.bytes.length || 0});
  try {
    await superviseBridge({signal: stop.signal, ownerAlive,
      getStatus: () => companionRequest(consoleIP, {op: 'status'}, {timeoutMs: 3000}),
      watchForInstall: true,
      isReady: () => !!client && !client.pendingUpdate,
      refreshWhenReady: async () => {
        const updated = await prepareBridgeClient({projectRoot, consoleIP, support, probe,
          request: companionRequest, localAddress: routeAddress});
        if (!updated || updated.pendingUpdate) return false;
        client = updated;
        return updated;
      },
      openBridge: ({onClientClose}) => create({projectRoot, consoleIP, port: BRIDGE_PORT,
        token: client.token, addonUrls: config.addonUrls, libraryItems: config.libraryItems,
        sourcePreferences, quality: config.quality || '720p', onClientClose,
        onLog: message => report('activity', {message: safeDiagnostic(message)}),
        onAccountProgress: watchProgress => emit('account-progress', {watchProgress})}),
      onEvent: report});
  } finally {
    report('stopped', {message: 'Stremio session stopped'});
    await activityLog.close(); activityLog = null;
  }
}

if (require.main === module) main().catch(async error => {
  report('error', {message: safeDiagnostic(error.message)});
  await activityLog?.close().catch(() => {});
  process.exitCode = 1;
});
module.exports = {main, readConfig, installToken, readInstallState, writeInstallState,
  installedChecksum, installClient, prepareBridgeClient, superviseBridge, createActivityLog, BRIDGE_PORT, PREFIX};
