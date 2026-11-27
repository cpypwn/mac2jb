'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const {BackupReceiver, consoleAddress} = require('../civswitch/install-persistent.cjs');

const provenance = require('./provenance.json');
const relativeRoot = path.join('integrations', 'civswitchfs-kaihen');
const applicationSupport = path.join(os.homedir(), 'Library', 'Application Support', 'mac2jb', 'CivSwitchFS-kaiHEN');
let activeSocket = null;
let cancelled = false;
let activePhase = 'preflight';

function emit(type, phase, message, fields = {}) {
  if (type === 'progress') activePhase = phase;
  process.stdout.write('MAC2JB_CIV_KAIHEN ' + JSON.stringify({type, phase, message, ...fields}) + '\n');
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function checkedFile(filename, expected) {
  const data = fs.readFileSync(filename);
  if (digest(data) !== expected) throw Error('Bundled CivSwitchFS-kaiHEN file failed verification: ' + path.basename(filename));
  return data;
}

function paths(runtimeRoot) {
  const root = path.resolve(runtimeRoot, relativeRoot);
  return {
    root,
    chain: path.join(root, 'upstream', 'dist', 'chain.js'),
    bootstrap: path.join(root, 'upstream', 'dist', 'persist', 'persist-bootstrap.js'),
    template: path.join(root, 'upstream', 'dist', 'persist', 'save-template.bin'),
    manifest: path.join(root, 'upstream', 'dist', 'persist', 'install-image.json'),
    backup: path.join(runtimeRoot, 'integrations', 'civswitch', 'backup-single.js')
  };
}

function verifyAssets(runtimeRoot) {
  const files = paths(runtimeRoot);
  checkedFile(files.chain, provenance.chainSha256);
  checkedFile(files.bootstrap, provenance.persistBootstrapSha256);
  checkedFile(files.template, provenance.saveTemplateSha256);
  const manifest = JSON.parse(fs.readFileSync(files.manifest, 'utf8'));
  if (manifest.version !== 'civswitchfs-0.1.0+kaihen' ||
      !Number.isInteger(manifest.bytes) || manifest.bytes <= 0 ||
      manifest.bytes >= 500000) throw Error('Bundled CivSwitchFS-kaiHEN manifest is incompatible');
  return files;
}

function assertActive() {
  if (cancelled) throw Error('Operation cancelled');
}

function send(host, code, timeoutMs = 300000, onLine = () => {}) {
  if (Buffer.byteLength(code) >= 500000) throw Error('Remote JS loader payload exceeds 500 KB');
  assertActive();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host, port: 9026});
    activeSocket = socket;
    let pending = '';
    let response = '';
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      if (activeSocket === socket) activeSocket = null;
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    }
    socket.setTimeout(timeoutMs, () => finish(Error('CivSwitch Remote JS loader timed out')));
    socket.once('error', finish);
    socket.on('connect', () => socket.end(code));
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      if (pending.length > 65536 && !pending.includes('\n')) {
        finish(Error('Remote JS loader sent an oversized response line'));
        return;
      }
      while (pending.includes('\n')) {
        const at = pending.indexOf('\n');
        const line = pending.slice(0, at).replace(/\r$/, '');
        pending = pending.slice(at + 1);
        try { onLine(line); }
        catch (error) { finish(error); return; }
        response = (response + line + '\n').slice(-32768);
      }
    });
    socket.on('end', () => {
      if (pending.trim()) return finish(Error('Remote JS loader response was incomplete'));
      finish();
    });
  });
}

function requireMarker(output, marker) {
  const failure = output.split('\n').find(line => line.startsWith('Installation failed: '));
  if (failure) throw Error(failure);
  if (!output.split('\n').includes(marker)) {
    throw Error('Remote JS loader did not acknowledge this step: ' + output.slice(-300).trim());
  }
}

async function backup(host, files, transport = send, backupRoot = path.join(applicationSupport, 'backups', host)) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    assertActive();
    const receiver = new BackupReceiver(backupRoot, host);
    try {
      emit('progress', 'backup', 'Backing up Civilization VII saves', {attempt});
      const code = fs.readFileSync(files.backup, 'utf8');
      const response = await transport(host, code, 600000, line => receiver.accept(line));
      if (!receiver.complete || !response.includes('Executed successfully')) {
        throw Error('Civilization VII save backup was not confirmed by the loader');
      }
      emit('progress', 'backup', 'Civilization VII save backup verified', {backup: receiver.final});
      return receiver.final;
    } catch (error) {
      lastError = error;
      const changed = /^CivSwitch save backup failed: save directory changed during backup(?::|$)/.test(error.message);
      if (!changed || attempt === 3) break;
      emit('log', 'backup', 'Save directory changed; retrying verified backup');
    } finally {
      receiver.cleanup();
    }
  }
  throw lastError;
}

async function install(host, runtimeRoot, transport = send, options = {}) {
  const files = verifyAssets(runtimeRoot);
  const backupFolder = await backup(host, files, transport, options.backupRoot);
  assertActive();
  const bootstrap = fs.readFileSync(files.bootstrap, 'ascii');
  const encoded = fs.readFileSync(files.template).toString('base64');
  const token = crypto.randomUUID().replace(/-/g, '');
  emit('progress', 'transfer', 'Preparing the persistent kaiHEN trigger');
  requireMarker(await transport(host, bootstrap + '\nlog("Installer ready.");', 60000), 'Installer ready.');
  const size = 400000;
  const count = Math.ceil(encoded.length / size);
  for (let offset = 0, index = 1; offset < encoded.length; offset += size, index++) {
    assertActive();
    const marker = `Template ${index}/${count} received.`;
    const code = 'window.__cfsPersistInstaller.stageChunk(' + JSON.stringify(token) + ',' + index + ',' + offset + ',' + JSON.stringify(encoded.slice(offset, offset + size)) + ');log(' + JSON.stringify(marker) + ');';
    let acknowledged = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const output = await transport(host, code, 60000);
      if (output.split('\n').includes(marker)) { acknowledged = true; break; }
    }
    if (!acknowledged) throw Error('Persistent template chunk was not acknowledged');
    emit('progress', 'transfer', 'Sending the persistent trigger', {current: index, total: count});
  }
  const marker = 'Installed. Restart the game, then open Load Game menu.';
  const code = '(async function(){try{await window.__cfsPersistInstaller.installFromTemplate();await log(' + JSON.stringify(marker) + ');}catch(error){await log("Installation failed: "+error.message);}finally{window.__cfsPersistInstaller.dispose();delete window.__cfsPersistInstaller;}})()';
  requireMarker(await transport(host, code, 300000), marker);
  emit('complete', 'installed', 'Persistent kaiHEN trigger installed', {backup: backupFolder});
  return backupFolder;
}

function chainProgress(line) {
  if (line.includes('Preparing file-system access and save data'))
    return {phase: 'fs-preparation', message: 'Preparing filesystem access'};
  if (line.includes('Checking the canary window'))
    return {phase: 'canary', message: 'Checking the canary window'};
  if (line.includes('MEMORY ADDRESS VERIFIED'))
    return {phase: 'memory-verified', message: 'Memory address verified'};
  if (line.includes('CHAIN: promotion retained a session'))
    return {phase: 'hen-starting', message: 'Starting kaiHEN'};
  return null;
}

async function runOnce(host, runtimeRoot, transport = send) {
  const files = verifyAssets(runtimeRoot);
  const chain = fs.readFileSync(files.chain, 'ascii');
  let running = false;
  let failure = null;
  emit('progress', 'running', 'Sending the CivSwitchFS-kaiHEN chain');
  await transport(host, chain, 900000, line => {
    if (line.includes('=== HEN IS RUNNING ===')) running = true;
    const progress = chainProgress(line);
    if (progress) emit('progress', progress.phase, progress.message);
    if (line.includes('FAILED at stage') || line.startsWith('PAYLOAD ERROR:'))
      failure = line;
    if (line) emit('log', 'running', line);
  });
  if (!running) throw Error(failure || 'The kaiHEN chain ended without confirming HEN is running');
  emit('complete', 'running', 'kaiHEN is running for this boot');
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if ((command === 'install' || command === 'run-once') && args.length === 3) {
    const host = consoleAddress(args[1]);
    emit('progress', 'preflight', 'Checking bundled CivSwitchFS-kaiHEN files');
    return command === 'install' ? install(host, args[2]) : runOnce(host, args[2]);
  }
  throw Error('usage: launch.cjs install SWITCH_IPV4 RUNTIME_ROOT | run-once SWITCH_IPV4 RUNTIME_ROOT');
}

if (require.main === module) {
  process.on('SIGINT', () => { cancelled = true; activeSocket?.destroy(Error('Operation cancelled')); });
  process.on('SIGTERM', () => { cancelled = true; activeSocket?.destroy(Error('Operation cancelled')); });
  main().catch(error => {
    emit('failed', activePhase, error.message);
    process.exitCode = 1;
  });
}

module.exports = {paths, verifyAssets, backup, install, runOnce, chainProgress, main};
