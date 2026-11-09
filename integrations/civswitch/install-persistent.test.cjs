'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {BackupReceiver, consoleAddress, install, runUpstreamInstaller} = require('./install-persistent.cjs');

function frame(kind, data) {
  return 'MAC2JB_CIV_BACKUP ' + kind + ' ' + JSON.stringify(data);
}

function checksum(data) {
  let value = 2166136261;
  for (const byte of data) value = Math.imul(value ^ byte, 16777619) >>> 0;
  return value.toString(16).padStart(8, '0');
}

test('backs up every inventoried file before reporting a complete folder', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civswitch-backup-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const receiver = new BackupReceiver(root, '192.0.2.1');
  const first = Buffer.from('CIV7-save-one');
  const second = Buffer.from('CIV7-save-two');
  receiver.accept(frame('BEGIN', {version: 1, directory: 'save:/saves/Single', count: 2, chunkSize: 512}));
  for (const [name, data] of [['one.Civ7Save', first], ['two.Civ7Save', second]]) {
    receiver.accept(frame('FILE', {nameHex: Buffer.from(name).toString('hex'), size: data.length}));
    receiver.accept(frame('CHUNK', {offset: 0, hex: data.toString('hex')}));
    receiver.accept(frame('FILE_END', {size: data.length, fnv32: checksum(data)}));
  }
  receiver.accept(frame('END', {count: 2}));
  assert.equal(receiver.complete, true);
  for (const [name, data] of [['one.Civ7Save', first], ['two.Civ7Save', second]]) {
    assert.deepEqual(fs.readFileSync(path.join(receiver.final, 'files', name)), data);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(receiver.final, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].sha256, crypto.createHash('sha256').update(first).digest('hex'));
  receiver.cleanup();
});

test('rejects unsafe names and incomplete or changed file data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civswitch-backup-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const receiver = new BackupReceiver(root, '192.0.2.1');
  receiver.accept(frame('BEGIN', {version: 1, directory: 'save:/saves/Single', count: 1, chunkSize: 512}));
  assert.throws(() => receiver.accept(frame('FILE', {nameHex: Buffer.from('../bad').toString('hex'), size: 1})), /Unsafe/);
  receiver.accept(frame('FILE', {nameHex: Buffer.from('safe.Civ7Save').toString('hex'), size: 2}));
  receiver.accept(frame('CHUNK', {offset: 0, hex: '12'}));
  assert.throws(() => receiver.accept(frame('FILE_END', {size: 2, fnv32: '00000000'})), /mismatch/);
  assert.equal(receiver.complete, false);
  receiver.cleanup();
  assert.equal(fs.readdirSync(root).length, 0);
});

test('validates console addresses without accepting hostnames or leading-zero octets', () => {
  assert.equal(consoleAddress('192.168.1.2'), '192.168.1.2');
  for (const bad of ['example.com', '127.0.0.01', '256.0.0.1', '::1']) {
    assert.throws(() => consoleAddress(bad), /IPv4/);
  }
});

test('does not send the installer if the backup response is incomplete', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civswitch-backup-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let calls = 0;
  const transport = async (_host, _code, _timeout, onLine) => {
    calls++;
    onLine(frame('BEGIN', {version: 1, directory: 'save:/saves/Single', count: 1, chunkSize: 512}));
    return 'Executed successfully\n';
  };
  let installerCalls = 0;
  await assert.rejects(install('192.0.2.1', root, transport, async () => { installerCalls++; }),
    /backup was not confirmed/);
  assert.equal(calls, 1);
  assert.equal(installerCalls, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('only starts the upstream installer after the complete backup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civswitch-backup-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let completed = false;
  let installerCalls = 0;
  const transport = async (_host, code, _timeout, onLine) => {
    assert.equal(code.includes('MAC2JB_CIV_BACKUP '), true);
    onLine(frame('BEGIN', {version: 1, directory: 'save:/saves/Single', count: 0, chunkSize: 512}));
    onLine(frame('END', {count: 0}));
    completed = true;
    return 'Executed successfully\n';
  };
  const saved = await install('192.0.2.1', root, transport, async host => {
    assert.equal(host, '192.0.2.1');
    assert.equal(completed, true);
    installerCalls++;
  });
  assert.equal(installerCalls, 1);
  assert.deepEqual(fs.readdirSync(saved), ['files', 'manifest.json']);
});

test('retries a changed save directory with a fresh backup before installing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civswitch-backup-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let attempts = 0;
  let installs = 0;
  const transport = async (_host, _code, _timeout, onLine) => {
    attempts++;
    if (attempts === 1) {
      onLine(frame('BEGIN', {version: 1, directory: 'save:/saves/Single', count: 1, chunkSize: 512}));
      onLine(frame('ERROR', {message: 'save directory changed during backup: 1 before, 2 after; added autosave'}));
    }
    onLine(frame('BEGIN', {version: 1, directory: 'save:/saves/Single', count: 0, chunkSize: 512}));
    onLine(frame('END', {count: 0}));
    return 'Executed successfully\n';
  };
  const saved = await install('192.0.2.1', root, transport, async () => { installs++; });
  assert.equal(attempts, 2);
  assert.equal(installs, 1);
  assert.deepEqual(fs.readdirSync(root), [path.basename(saved)]);
});

test('never installs when saves change on all three backup attempts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civswitch-backup-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let attempts = 0;
  let installs = 0;
  const transport = async (_host, _code, _timeout, onLine) => {
    attempts++;
    onLine(frame('BEGIN', {version: 1, directory: 'save:/saves/Single', count: 1, chunkSize: 512}));
    onLine(frame('ERROR', {message: 'save directory changed during backup: 1 before, 2 after'}));
  };
  await assert.rejects(install('192.0.2.1', root, transport, async () => { installs++; }),
    /kept changing across 3 backup attempts/);
  assert.equal(attempts, 3);
  assert.equal(installs, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('save inventory reads past a short directory batch before backing up', async () => {
  const memory = Buffer.alloc(128 * 1024);
  let next = 256;
  let cursor = 0;
  let currentFile = '';
  let directoryReads = 0;
  const files = new Map([['one.Civ7Save', Buffer.from('one')], ['two.Civ7Save', Buffer.from('two')]]);
  const write64 = (address, value) => memory.writeBigUInt64LE(BigInt(value), Number(address));
  const read64 = address => memory.readBigUInt64LE(Number(address));
  const pathAt = address => {
    let end = Number(address);
    while (memory[end]) end++;
    return memory.subarray(Number(address), end).toString('utf8');
  };
  const messages = [];
  const sdk = {
    sdk_base: 0n,
    malloc(size) { const address = next; next += Number(size) + 8; return BigInt(address); },
    free() {},
    text_encode(value) { return Buffer.from(value); },
    write8(address, value) { memory.writeUInt8(Number(value), Number(address)); },
    read8(address) { return BigInt(memory.readUInt8(Number(address))); },
    write64,
    read64,
    read32(address) { return BigInt(memory.readUInt32LE(Number(address))); },
    call_rop(functionAddress, ...args) {
      if (functionAddress === 0xa7bb0n) {
        assert.equal(pathAt(args[1]), 'save:/saves/Single');
        cursor = 0;
        write64(args[0], 1n);
        return 0n;
      }
      if (functionAddress === 0xa5840n) {
        directoryReads++;
        const nextFile = Array.from(files.entries())[cursor++];
        write64(args[0], nextFile ? 1n : 0n);
        if (nextFile) {
          const start = Number(args[1]);
          memory.fill(0, start, start + 0x310);
          Buffer.from(nextFile[0]).copy(memory, start);
          memory.writeUInt32LE(1, start + 0x304);
          memory.writeBigUInt64LE(BigInt(nextFile[1].length), start + 0x308);
        }
        return 0n;
      }
      if (functionAddress === 0xa78a0n) {
        currentFile = pathAt(args[1]).split('/').pop();
        assert.ok(files.has(currentFile));
        write64(args[0], 2n);
        return 0n;
      }
      if (functionAddress === 0xa5bf0n) {
        files.get(currentFile).copy(memory, Number(args[2]), Number(args[1]), Number(args[1] + args[3]));
        return 0n;
      }
      if (functionAddress === 0xa5a70n || functionAddress === 0xa57b0n) return 0n;
      throw Error('Unexpected filesystem call: ' + functionAddress.toString(16));
    },
    log(value) { messages.push(value); return Promise.resolve(); }
  };
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'backup-single.js'), 'utf8'), sdk);
  assert.equal(directoryReads, 6);
  const frames = messages.filter(line => line.startsWith('MAC2JB_CIV_BACKUP '));
  assert.equal(frames.filter(line => line.includes(' FILE ')).length, 2);
  assert.equal(frames.filter(line => line.includes(' END ')).length, 1);
  assert.equal(frames.some(line => line.includes(' ERROR ')), false);
});

test('an absent Single save directory stays an empty backup, but disappearance is rejected', async () => {
  async function run(singleInitiallyExists) {
    const memory = Buffer.alloc(128 * 1024);
    let next = 256;
    let singleOpens = 0;
    const messages = [];
    const pathAt = address => {
      let end = Number(address);
      while (memory[end]) end++;
      return memory.subarray(Number(address), end).toString('utf8');
    };
    const sdk = {
      sdk_base: 0n,
      malloc(size) { const address = next; next += Number(size) + 8; return BigInt(address); },
      free() {},
      text_encode(value) { return Buffer.from(value); },
      write8(address, value) { memory.writeUInt8(Number(value), Number(address)); },
      read8(address) { return BigInt(memory.readUInt8(Number(address))); },
      write64(address, value) { memory.writeBigUInt64LE(BigInt(value), Number(address)); },
      read64(address) { return memory.readBigUInt64LE(Number(address)); },
      read32(address) { return BigInt(memory.readUInt32LE(Number(address))); },
      call_rop(functionAddress, ...args) {
        if (functionAddress === 0xa7bb0n) {
          const path = pathAt(args[1]);
          if (path === 'save:/saves/Single') {
            singleOpens++;
            if (!singleInitiallyExists || singleOpens > 1) return 0x202n;
          } else {
            assert.equal(path, 'save:/saves');
          }
          sdk.write64(args[0], 1n);
          return 0n;
        }
        if (functionAddress === 0xa5840n) {
          sdk.write64(args[0], 0n);
          return 0n;
        }
        if (functionAddress === 0xa57b0n) return 0n;
        throw Error('Unexpected filesystem call: ' + functionAddress.toString(16));
      },
      log(value) { messages.push(value); return Promise.resolve(); }
    };
    let failure = null;
    try {
      await vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'backup-single.js'), 'utf8'), sdk);
    } catch (error) {
      failure = error;
    }
    return {messages, failure};
  }

  const unchanged = await run(false);
  assert.equal(unchanged.failure, null);
  assert.equal(unchanged.messages.some(line => line.includes(' END ')), true);
  assert.equal(unchanged.messages.some(line => line.includes(' ERROR ')), false);

  const disappeared = await run(true);
  assert.match(disappeared.failure.message, /Single save directory disappeared/);
  assert.equal(disappeared.messages.some(line => line.includes(' END ')), false);
  assert.equal(disappeared.messages.some(line => line.includes('Single save directory disappeared')), true);
});

test('executes the bundled Python installer command with bundled Node on PATH', async () => {
  let invocation;
  const spawnProcess = (executable, args, options) => {
    invocation = {executable, args, options};
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('INSTALL DONE - reboot, Load Game\n'));
      child.emit('close', 0, null);
    });
    return child;
  };
  await runUpstreamInstaller('192.0.2.1', spawnProcess);
  assert.equal(path.basename(invocation.executable), 'python3');
  assert.deepEqual(invocation.args, [path.join(__dirname, '../../vendor/CivSwitch/installer-creator/install.py'), '192.0.2.1']);
  assert.equal(invocation.options.cwd, path.join(__dirname, '../../vendor/CivSwitch/installer-creator'));
  assert.equal(invocation.options.env.PATH.split(path.delimiter)[0], path.join(__dirname, '../..'));
});

test('rejects a Python zero exit without upstream success marker', async () => {
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  await assert.rejects(runUpstreamInstaller('192.0.2.1', spawnProcess), /not verified/);
});
