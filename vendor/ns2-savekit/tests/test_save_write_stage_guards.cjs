'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {hashFile} = require('../tools/lib/verified-file-hash.cjs');

// Execute the actual CLI through the prewrite boundary; every console/network
// adapter is fake, and the fake write mount stops before any write operation.
async function probe({wrongSize = false, wrongHash = false, openResult = 0x202} = {}) {
  const bytes = Buffer.from('pinned payload');
  const sourcePath = path.join(__dirname, '../tools/save-write-stage.cjs');
  const manifest = {files: [{path: '/.lovegame/main.lua', local: '/new.lua', replace: false,
    size: bytes.length + (wrongSize ? 1 : 0),
    sha256: wrongHash ? '0'.repeat(64) : crypto.createHash('sha256').update(bytes).digest('hex')}]};
  let initialized = 0, writeMounts = 0, exitCode = 0;
  const errors = [];
  const fakeFs = {
    async readFile(filename) {
      if (filename.endsWith('/current-acquisition.json')) return JSON.stringify({session: 'test', socketPath: '/fake.sock'});
      if (filename.endsWith('/current-root.json')) return JSON.stringify({session: 'test', pid: 1, rootHandle: 1});
      if (filename === '/manifest.json') return JSON.stringify(manifest);
      if (filename === '/new.lua') return bytes;
      if (filename === '/backup/manifest.json') return JSON.stringify({
        titleId: '0100cd801ce5e000', programId: '0100cd801ce5e000',
        uid: 'a'.repeat(32), space: 1, type: 1, rank: 0, index: 0,
        archive: 'space=User type=Account rank=0 index=0 uid=aaaaaaaaaaaaaaaa',
        selection: {space: 1, type: 1, rank: 0, index: 0,
          staticId: 0, uid: 'a'.repeat(32)}, partial: false, files: 0, entries: [],
      });
      throw Error('Unexpected read: ' + filename);
    },
    async readdir() { return ['manifest.json']; },
    async stat() { throw Object.assign(Error('not found'), {code: 'ENOENT'}); },
  };
  class Session {
    constructor() { this.handles = new Set(); }
    async initialize() { initialized++; }
    async close() {}
    async cleanup() {}
    async ipc(_label, _handle, command) {
      if (command === 51) { writeMounts++; throw Error('write mount reached'); }
      assert.equal(command, 53);
      return {result: 0, moves: [2]};
    }
  }
  const net = {createConnection() {
    const socket = new EventEmitter();
    socket.setEncoding = socket.setTimeout = () => socket;
    socket.write = () => queueMicrotask(() => {socket.emit('data', '{}'); socket.emit('end');});
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  }};
  const context = {Buffer, __dirname: path.dirname(sourcePath), module: {exports: {}},
    console: {log() {}, error(...args) {errors.push(args.join(' '));}},
    process: {argv: ['node', sourcePath, '/fake/run', '0100cd801ce5e000', 'a'.repeat(32), '/backup', '/manifest.json'],
      exit(code) {exitCode = code; throw Error('TEST_EXIT');}},
    require(name) {
      if (name === 'node:fs/promises') return fakeFs;
      if (name === 'node:fs') return {readFileSync: () => '{"write":[{"id":"0100cd801ce5e000"}]}'};
      if (name === 'node:path' || name === 'node:crypto') return require(name);
      if (name === 'node:net') return net;
      if (name === './lib/verified-file-hash.cjs') return {hashFile};
      if (name.endsWith('/app/session.cjs')) return {Session};
      if (name.endsWith('/app/filesystem.cjs')) return {async openFile() {return {result: openResult};}};
      if (name.endsWith('/app/domain.cjs')) return {};
      throw Error('Unexpected module: ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, {filename: sourcePath});
  try { await context.module.exports.main(); }
  catch (error) { exitCode = 1; errors.push('FAILED: ' + error.message); }
  return {initialized, writeMounts, exitCode, error: errors.join('\n')};
}

test('modified staged bytes are refused before opening a console session', async () => {
  for (const options of [{wrongSize: true}, {wrongHash: true}]) {
    const result = await probe(options);
    assert.equal(result.exitCode, 1);
    assert.equal(result.initialized, 0);
    assert.equal(result.writeMounts, 0);
    assert.match(result.error, /Staged file (size|hash) differs/);
  }
});

test('only a canonical path-not-found result permits an add-only write', async () => {
  const absent = await probe({openResult: 0x202});
  assert.equal(absent.writeMounts, 1);
  assert.match(absent.error, /write mount reached/);
  for (const openResult of [0xf601, 0xe02, 0x2]) {
    const refused = await probe({openResult});
    assert.equal(refused.exitCode, 1);
    assert.equal(refused.writeMounts, 0);
    assert.match(refused.error, /Cannot establish whether/);
  }
});
