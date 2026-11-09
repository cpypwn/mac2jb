'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {TextDecoder} = require('node:util');

const root = path.resolve(__dirname, '../..');
const vendor = path.join(root, 'vendor/CivSwitch/installer-creator');
const backupPayload = path.join(__dirname, 'backup-single.js');
const expected = Object.freeze({
  core: '1fe1aaa68dc8c0534d79d65b1dd545f66c6b3fb3d547f01c967cdc5f70e7bdf4',
  installer: 'fa4241b5cc8e4d98b5c85ae51d87d920c03fe3712bcef48b31aaef3c021815ca',
  template: '32fa8a0d6dd0a480d8e541e63ea44c4619bc6f7be4282cfc3cb6a4f6d305dfae',
  compressor: '4d99e332009015cf54a692d4cc7d073981798a56ee7bc73a6b054be178918594',
  packageLock: 'd5fe301a4bb169c24075652f9c01097521874bd17192ae7a3ae6c31545be51e2'
});

function emit(type, fields = {}) {
  process.stdout.write('MAC2JB_CIVSWITCH ' + JSON.stringify({type, ...fields}) + '\n');
}

function digest(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function digestFile(filename) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filename, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      hash.update(chunk.subarray(0, length));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function checkedFile(name, sha256) {
  const data = fs.readFileSync(name);
  if (digest(data) !== sha256) throw Error('Bundled CivSwitch installer files failed verification: ' + path.basename(name));
  return data;
}

function consoleAddress(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part) &&
      String(Number(part)) === part && Number(part) <= 255)) {
    throw Error('Enter a valid Switch IPv4 address');
  }
  return value;
}

function sendCode(host, code, timeoutMs = 300000, onLine = null) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({host, port: 9026});
    let pending = '';
    let response = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    socket.setTimeout(timeoutMs, () => finish(Error('CivSwitch loader timed out')));
    socket.once('error', finish);
    socket.on('connect', () => socket.end(code));
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      if (pending.length > 8192 && !pending.includes('\n')) {
        finish(Error('CivSwitch loader sent an oversized response line'));
        return;
      }
      while (pending.includes('\n')) {
        const at = pending.indexOf('\n');
        const line = pending.slice(0, at).replace(/\r$/, '');
        pending = pending.slice(at + 1);
        if (onLine) {
          try { onLine(line); }
          catch (error) { finish(error); return; }
        }
        response += line + '\n';
        if (response.length > 16384) response = response.slice(-8192);
      }
    });
    socket.on('end', () => {
      if (pending.trim()) return finish(Error('CivSwitch loader response was incomplete'));
      finish();
    });
  });
}

function runUpstreamInstaller(host, spawnProcess = spawn) {
  const bundledPython = path.join(root, 'homebrew/python/bin/python3');
  const python = fs.existsSync(bundledPython) ? bundledPython : 'python3';
  const script = path.join(vendor, 'install.py');
  return new Promise((resolve, reject) => {
    const child = spawnProcess(python, [script, host], {
      cwd: vendor,
      env: {...process.env, PATH: root + path.delimiter + (process.env.PATH || ''), PYTHONUNBUFFERED: '1'},
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let pending = '';
    let done = false;
    const record = chunk => {
      pending += chunk.toString('utf8');
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (line) process.stdout.write(line + '\n');
        output = (output + line + '\n').slice(-16384);
      }
      if (pending.length > 65536) pending = pending.slice(-4096);
    };
    const stopChild = () => child.kill('SIGTERM');
    process.once('SIGTERM', stopChild);
    process.once('SIGINT', stopChild);
    const cleanup = () => {
      process.removeListener('SIGTERM', stopChild);
      process.removeListener('SIGINT', stopChild);
    };
    child.stdout.on('data', record);
    child.stderr.on('data', record);
    child.once('error', error => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (done) return;
      done = true;
      cleanup();
      if (pending.trim()) {
        process.stdout.write(pending.trim() + '\n');
        output = (output + pending).slice(-16384);
      }
      if (code !== 0 || signal || !output.includes('INSTALL DONE - reboot, Load Game')) {
        reject(Error('CivSwitch trigger install was not verified: ' + output.slice(-500).trim()));
        return;
      }
      resolve(output);
    });
  });
}

class BackupReceiver {
  constructor(backupRoot, host) {
    this.host = host;
    this.backupRoot = backupRoot;
    this.temp = null;
    this.final = null;
    this.current = null;
    this.files = [];
    this.expectedCount = null;
    this.chunkSize = null;
    this.complete = false;
    this.totalBytes = 0;
  }

  accept(line) {
    const prefix = 'MAC2JB_CIV_BACKUP ';
    if (!line.startsWith(prefix)) return;
    const split = line.indexOf(' ', prefix.length);
    if (split < 0) throw Error('Malformed CivSwitch backup response');
    const kind = line.slice(prefix.length, split);
    let value;
    try { value = JSON.parse(line.slice(split + 1)); }
    catch { throw Error('Invalid CivSwitch backup response'); }
    if (kind === 'ERROR') throw Error('CivSwitch save backup failed: ' + String(value.message || 'unknown error'));
    if (this.complete) throw Error('Unexpected CivSwitch backup response after completion');
    if (kind === 'BEGIN') return this.begin(value);
    if (kind === 'FILE') return this.beginFile(value);
    if (kind === 'CHUNK') return this.chunk(value);
    if (kind === 'FILE_END') return this.endFile(value);
    if (kind === 'END') return this.end(value);
    throw Error('Unknown CivSwitch backup response: ' + kind);
  }

  begin(value) {
    if (this.expectedCount !== null || value.version !== 1 ||
        value.directory !== 'save:/saves/Single' ||
        !Number.isInteger(value.count) || value.count < 0 || value.count > 512 ||
        value.chunkSize !== 512) throw Error('Invalid CivSwitch backup inventory');
    this.expectedCount = value.count;
    this.chunkSize = value.chunkSize;
    fs.mkdirSync(this.backupRoot, {recursive: true, mode: 0o700});
    this.temp = fs.mkdtempSync(path.join(this.backupRoot, '.pending-'));
    fs.chmodSync(this.temp, 0o700);
    fs.mkdirSync(path.join(this.temp, 'files'), {mode: 0o700});
    emit('install-backup-progress', {message: 'Backing up Civilization VII saves', files: value.count});
  }

  beginFile(value) {
    if (this.expectedCount === null || this.current || this.files.length >= this.expectedCount ||
        typeof value.nameHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value.nameHex) ||
        !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 512 * 1024 * 1024) {
      throw Error('Invalid CivSwitch backup file');
    }
    const name = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.from(value.nameHex, 'hex'));
    if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name)) {
      throw Error('Unsafe CivSwitch save filename');
    }
    const target = path.join(this.temp, 'files', name);
    const fd = fs.openSync(target, 'wx', 0o600);
    this.current = {name, target, fd, size: value.size, received: 0,
      fnv32: 2166136261, sha256: crypto.createHash('sha256')};
  }

  chunk(value) {
    const file = this.current;
    if (!file || !Number.isSafeInteger(value.offset) || value.offset !== file.received ||
        typeof value.hex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value.hex) ||
        value.hex.length > this.chunkSize * 2) throw Error('Invalid CivSwitch backup chunk');
    const data = Buffer.from(value.hex, 'hex');
    if (file.received + data.length > file.size) throw Error('CivSwitch backup exceeds declared file size');
    fs.writeSync(file.fd, data, 0, data.length, file.received);
    file.sha256.update(data);
    for (const byte of data) file.fnv32 = Math.imul(file.fnv32 ^ byte, 16777619) >>> 0;
    file.received += data.length;
    this.totalBytes += data.length;
    if (this.totalBytes > 512 * 1024 * 1024) throw Error('CivSwitch backup exceeds 512 MB');
    if (file.received === file.size || file.received % (512 * 128) === 0) {
      emit('install-backup-progress', {message: 'Backing up ' + file.name,
        fileBytes: file.received, fileSize: file.size, totalBytes: this.totalBytes});
    }
  }

  endFile(value) {
    const file = this.current;
    if (!file || value.size !== file.size || file.received !== file.size ||
        typeof value.fnv32 !== 'string' ||
        value.fnv32 !== file.fnv32.toString(16).padStart(8, '0')) {
      throw Error('CivSwitch backup file checksum or length mismatch');
    }
    fs.fsyncSync(file.fd);
    fs.closeSync(file.fd);
    file.fd = null;
    const sha256 = file.sha256.digest('hex');
    if (digestFile(file.target) !== sha256) throw Error('CivSwitch backup disk verification failed');
    this.files.push({name: file.name, size: file.size, sha256, fnv32: value.fnv32});
    this.current = null;
  }

  end(value) {
    if (this.expectedCount === null || this.current || value.count !== this.expectedCount ||
        this.files.length !== this.expectedCount) throw Error('Incomplete CivSwitch save backup');
    const metadata = {version: 1, source: 'save:/saves/Single', consoleAddress: this.host,
      capturedAt: new Date().toISOString(), files: this.files};
    const manifest = path.join(this.temp, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify(metadata, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    const finalName = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
    this.final = path.join(this.backupRoot, finalName);
    fs.renameSync(this.temp, this.final);
    this.temp = null;
    this.complete = true;
    emit('install-backup-progress', {message: 'Civilization VII save backup verified',
      path: this.final, files: this.files.length, totalBytes: this.totalBytes});
  }

  cleanup() {
    if (this.current?.fd !== null && this.current?.fd !== undefined) fs.closeSync(this.current.fd);
    if (this.temp) fs.rmSync(this.temp, {recursive: true, force: true});
    this.current = null;
    this.temp = null;
  }
}

async function install(host, backupRoot, transport = sendCode, installerRunner = runUpstreamInstaller) {
  checkedFile(path.join(root, 'vendor/CivSwitch/core.js'), expected.core);
  checkedFile(path.join(vendor, 'install.py'), expected.installer);
  const template = checkedFile(path.join(vendor, 'save_template.bin'), expected.template);
  checkedFile(path.join(vendor, 'compress_stage.js'), expected.compressor);
  checkedFile(path.join(vendor, 'package-lock.json'), expected.packageLock);
  if (template.length < 4096 || template.subarray(0, 4).toString() !== 'CIV7' ||
      !fs.existsSync(path.join(vendor, 'node_modules/terser/package.json'))) {
    throw Error('The bundled CivSwitch installer is incomplete');
  }
  let backupFolder;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const receiver = new BackupReceiver(backupRoot, host);
    try {
      const response = await transport(host, fs.readFileSync(backupPayload, 'utf8'), 600000,
        line => receiver.accept(line));
      if (!receiver.complete || !response.includes('Executed successfully')) {
        throw Error('CivSwitch save backup was not confirmed by the loader');
      }
      backupFolder = receiver.final;
      break;
    } catch (error) {
      const changed = /^CivSwitch save backup failed: save directory changed during backup(?::|$)/
        .test(String(error.message || error));
      if (!changed || attempt === 3) {
        if (changed) {
          throw Error('Civilization VII saves kept changing across 3 backup attempts. ' +
            'No trigger was installed. ' + error.message);
        }
        throw error;
      }
      emit('install-backup-progress', {
        message: 'Civilization VII saves changed; retrying backup (' + (attempt + 1) + '/3)'
      });
      await new Promise(resolve => setTimeout(resolve, attempt * 250));
    } finally {
      receiver.cleanup();
    }
  }
  emit('install-started', {message: 'Installing the persistent Civilization VII trigger',
    backup: backupFolder});
  await installerRunner(host);
  emit('install-complete', {message: 'Persistent CivSwitch trigger installed',
    backup: backupFolder});
  return backupFolder;
}

async function main() {
  if (process.argv.length !== 4) throw Error('usage: install-persistent.cjs SWITCH_IPV4 BACKUP_ROOT');
  const host = consoleAddress(process.argv[2]);
  const backupRoot = path.resolve(process.argv[3]);
  await install(host, backupRoot);
}

if (require.main === module) {
  main().catch(error => {
    emit('failed', {message: error.message});
    process.exitCode = 1;
  });
}

module.exports = {BackupReceiver, consoleAddress, install, runUpstreamInstaller, sendCode};
