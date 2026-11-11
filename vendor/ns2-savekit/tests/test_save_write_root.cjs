'use strict';
// Exercise the real writer with in-memory adapters for the external engine.
// No console, sockets or save files are touched.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {hashFile} = require('../tools/lib/verified-file-hash.cjs');

async function run({sameBytes = false, staleBackup = false, corruptTarget = false,
  corruptSibling = false, missingTarget = false, unreadableTarget = false} = {}) {
  const original = Buffer.from('original save bytes');
  const replacement = sameBytes ? Buffer.from(original) : Buffer.alloc(0x40001, 0x42);
  const backup = new Map([['saveg.dat', original], ['system.dat', Buffer.from('unchanged settings')]]);
  const live = new Map([...backup].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  if (staleBackup) live.set('saveg.dat', Buffer.from('newer live save bytes'));
  const handles = new Map();
  let nextHandle = 100, committed = false, exitCode = 0, writeMounts = 0;
  const logs = [], errors = [];
  const open = name => { const handle = nextHandle++; handles.set(handle, name); return handle; };
  const fakeFs = {
    async readFile(filename) {
      if (filename.endsWith('/current-acquisition.json')) return JSON.stringify({session:'offline', socketPath:'/never-opened.sock'});
      if (filename.endsWith('/current-root.json')) return JSON.stringify({session:'offline', pid:1, rootHandle:1});
      if (filename === '/fixture/new.bin') return replacement;
      if (filename.startsWith('/fixture/backup/')) {
        const bytes = backup.get(path.basename(filename));
        if (bytes) return bytes;
      }
      throw Error('Unexpected file read: ' + filename);
    },
    async readdir(filename) {
      assert.equal(filename, '/fixture/backup');
      return [...backup.keys()];
    },
  };
  class Session {
    constructor() { this.base = 0x100000; this.handles = new Set(); }
    async initialize() {}
    async cleanup() {}
    async close(handle) { handles.delete(handle); }
    async write(_address, bytes) { this.scratch = Buffer.from(bytes); }
    async ipc(label, handle, command, input) {
      if (label.startsWith('Open save ')) {
        if (command === 51) writeMounts++;
        return {result:0, moves:[2]};
      }
      if (label === 'FileSetSize') {
        live.set(handles.get(handle), Buffer.alloc(Number(input.readBigUInt64LE(0))));
      } else if (label === 'FileWrite') {
        const offset = Number(input.readBigUInt64LE(8));
        const size = Number(input.readBigUInt64LE(16));
        this.scratch.copy(live.get(handles.get(handle)), offset, 0, size);
      } else if (label === 'Commit save data filesystem') {
        committed = true;
        if (corruptTarget) live.get('saveg.dat')[0] ^= 1;
        if (corruptSibling) live.get('system.dat')[0] ^= 1;
        if (missingTarget) live.delete('saveg.dat');
      } else if (label !== 'FileFlush') throw Error('Unexpected IPC: ' + label);
      return {result:0};
    }
  }
  const filesystem = {
    async listDirectory() { return [...live.keys()].map(name => ({name})); },
    async openFile(_session, _save, filename) {
      const name = path.basename(filename);
      if (committed && unreadableTarget && name === 'saveg.dat') return {result:0x202};
      return live.has(name) ? {result:0, handle:open(name)} : {result:0x202};
    },
    async fileSize(_session, handle) { return BigInt(live.get(handles.get(handle)).length); },
    async readFile(_session, handle, offset, size) { return live.get(handles.get(handle)).subarray(offset, offset + size); },
    async pathMethod(_session, _save, command, filename) {
      assert.equal(command, 8);
      assert.ok(live.has(path.basename(filename)));
      return {result:0, moves:[open(path.basename(filename))]};
    },
  };
  const fakeNet = {createConnection() {
    const socket = new EventEmitter();
    socket.setEncoding = () => socket;
    socket.setTimeout = () => socket;
    socket.write = () => queueMicrotask(() => {socket.emit('data', '{}'); socket.emit('end');});
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  }};
  const sourcePath = path.join(__dirname, '..', 'tools/save-write-root.cjs');
  const context = {
    Buffer,
    __dirname:path.dirname(sourcePath),
    console:{log:(...args) => logs.push(args.join(' ')), error:(...args) => errors.push(args.join(' '))},
    process:{argv:['node', sourcePath, '/fixture/run', '010042d022aea000', '00'.repeat(16), '/saveg.dat', '/fixture/new.bin', '/fixture/backup', '--replace'],
      exit(code) {exitCode = code; throw Error('OFFLINE_PROCESS_EXIT');}},
    require(name) {
      if (name === 'node:fs/promises') return fakeFs;
      if (name === 'node:fs') return {readFileSync:() => '{"write":[]}'};
      if (name === 'node:net') return fakeNet;
      if (name === 'node:path' || name === 'node:crypto') return require(name);
      if (name === './lib/verified-file-hash.cjs') return {hashFile};
      if (name.endsWith('/app/session.cjs')) return {Session};
      if (name.endsWith('/app/filesystem.cjs')) return filesystem;
      if (name.endsWith('/app/domain.cjs')) return {oneHandle:reply => reply.moves[0]};
      throw Error('Unexpected module: ' + name);
    },
  };
  try {await vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, {filename:sourcePath});}
  catch (error) {if (error.message !== 'OFFLINE_PROCESS_EXIT') throw error;}
  return {exitCode, committed, writeMounts,
    writtenBytesMatch:live.get('saveg.dat')?.equals(replacement) ?? false,
    errors:errors.join('\n'), logs:logs.join('\n')};
}


test('changed replacement verifies against its new bytes and preserves the other file', async () => {
  const result = await run();
  assert.equal(result.exitCode, 0, result.errors);
  assert.equal(result.committed, true);
  assert.equal(result.writtenBytesMatch, true);
  assert.equal(result.errors, '');
  assert.match(result.logs, /saveg\.dat[^\n]*\(written ok\) ok/);
  assert.match(result.logs, /system\.dat[^\n]* ok/);
  assert.doesNotMatch(result.logs, /DIFFERS|MISMATCH/);
});

test('identical replacement remains valid', async () => {
  const result = await run({sameBytes:true});
  assert.equal(result.exitCode, 0, result.errors);
  assert.equal(result.committed, true);
  assert.equal(result.writtenBytesMatch, true);
});

test('stale backup is rejected before a read-write mount or commit', async () => {
  const result = await run({staleBackup:true});
  assert.equal(result.exitCode, 1);
  assert.equal(result.writeMounts, 0);
  assert.equal(result.committed, false);
  assert.match(result.errors, /Live \/saveg\.dat differs from the backup/);
});

test('corrupted target read-back is rejected', async () => {
  const result = await run({corruptTarget:true});
  assert.equal(result.exitCode, 1);
  assert.equal(result.committed, true);
  assert.equal(result.writtenBytesMatch, false);
  assert.match(result.errors, /Written file differs after commit/);
  assert.match(result.logs, /WRITE MISMATCH/);
});

test('corrupted preserved file is rejected', async () => {
  const result = await run({corruptSibling:true});
  assert.equal(result.exitCode, 1);
  assert.equal(result.committed, true);
  assert.equal(result.writtenBytesMatch, true);
  assert.match(result.logs, /system\.dat[^\n]*DIFFERS/);
  assert.match(result.errors, /Preserved file differs after commit/);
});

test('missing committed target is rejected', async () => {
  const result = await run({missingTarget:true});
  assert.equal(result.exitCode, 1);
  assert.equal(result.committed, true);
  assert.match(result.errors, /Written file was not found after commit/);
});

test('unreadable committed target is rejected', async () => {
  const result = await run({unreadableTarget:true});
  assert.equal(result.exitCode, 1);
  assert.equal(result.committed, true);
  assert.match(result.errors, /Written file was not found after commit/);
});
