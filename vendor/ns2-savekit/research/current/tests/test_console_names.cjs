#!/usr/bin/env node
// Offline tests for tools/lib/console-names.cjs. No console, no network, no deps.
//
//   node tests/test_console_names.cjs
//
// The session is faked: these pin the wiring around the one read that matters
// (ns:ro command 7989, then command 0 per title), not the console's answer. Every
// failure here has to be a missing name, never an exception, because the caller
// is a listing that must not fail over a name.
const assert = require('node:assert');
const zlib = require('node:zlib');
const consoleNames = require('../tools/lib/console-names.cjs');

let passes = 0, failures = 0;
async function test(name, fn) {
  try {
    await fn();
    passes++;
    console.log('ok    ' + name);
  } catch (error) {
    failures++;
    console.log('FAIL  ' + name + '\n      ' + String(error.message).split('\n').join('\n      '));
  }
}

function nacp(text) {
  const bytes = Buffer.alloc(0x4000);
  if (text) bytes.write(text, 0);
  return bytes;
}

// A session that answers like the console: services from `services`, one NACP
// per title id, `refuse` (or `refuseShape`) for a refused control-data read.
function fakeSession({services = ['ns:ro'], names = {}, refuse = 0, refuseShape = null,
  reader = 0} = {}) {
  const state = {calls: [], closed: [], buffer: Buffer.alloc(0x4000)};
  const s = {
    base: 0x10000000,
    handles: new Set(),
    async openService(name) {
      state.services = [...(state.services || []), name];
      if (!services.includes(name)) throw Error('Service unavailable: ' + name);
      return 42;
    },
    async ipc(label, handle, command, input, options = {}) {
      if (command === consoleNames.OPEN_READER) {
        state.calls.push({command, shape: null});
        return {result: reader, moves: reader ? [] : [7]};
      }
      const shape = options.pointers ? 'pointer' : 'map-alias';
      state.calls.push({command, shape});
      if (refuse || shape === refuseShape) return {result: refuse || 0xe401, moves: []};
      const key = input.readBigUInt64LE(8).toString(16).padStart(16, '0');
      state.buffer = nacp(names[key]);
      return {result: 0, moves: []};
    },
    async readOwned(address, size) { return state.buffer.subarray(0, size); },
    async close(handle) { state.closed.push(handle); },
  };
  return {s, state};
}

const ids = ['0x0100000000000001', '0x0100000000000002'];
const reads = state => state.calls.filter(call => call.command === consoleNames.READ_CONTROL);

(async () => {
  await test('names come back per title through ns:ro', async () => {
    const notes = [];
    const {s, state} = fakeSession({names: {
      '0100000000000001': 'Nintendo Switch 2 Welcome Tour',
      '0100000000000002': 'Yoshi and the Mysterious Book',
    }});
    const names = await consoleNames.read(s, ids, {note: text => notes.push(text)});
    assert.deepStrictEqual(names, {
      '0100000000000001': 'Nintendo Switch 2 Welcome Tour',
      '0100000000000002': 'Yoshi and the Mysterious Book',
    });
    assert.ok(notes.some(text => /ns:ro/.test(text)));
    assert.ok(notes.some(text => /pointer buffer/.test(text)));
    assert.deepStrictEqual(state.calls[0], {command: consoleNames.OPEN_READER, shape: null});
    assert.deepStrictEqual(state.closed, [7]);
  });

  await test('the pointer buffer is tried first, once', async () => {
    const {s, state} = fakeSession({names: {'0100000000000001': 'Welcome Tour'}});
    await consoleNames.read(s, ids);
    // One read for the first title (the shape worked), one for the second.
    assert.strictEqual(reads(state).length, 2);
    assert.deepStrictEqual(reads(state).map(call => call.shape), ['pointer', 'pointer']);
  });

  await test('a refused pointer falls back to the map-alias buffer', async () => {
    const notes = [];
    const {s, state} = fakeSession({refuseShape: 'pointer',
      names: {'0100000000000001': 'Welcome Tour', '0100000000000002': 'Yoshi'}});
    const names = await consoleNames.read(s, ids, {note: text => notes.push(text)});
    assert.deepStrictEqual(names, {'0100000000000001': 'Welcome Tour',
      '0100000000000002': 'Yoshi'});
    assert.ok(notes.some(text => /map-alias buffer/.test(text)));
    // Two shapes for the first title, then the winner for the second.
    assert.deepStrictEqual(reads(state).map(call => call.shape),
      ['pointer', 'map-alias', 'map-alias']);
  });

  await test('both shapes refused is a missing name, reported once', async () => {
    const notes = [];
    const {s, state} = fakeSession({refuse: 0xe401});
    const names = await consoleNames.read(s, ids, {note: text => notes.push(text)});
    assert.deepStrictEqual(names, {});
    assert.strictEqual(reads(state).length, 2);
    assert.ok(notes.some(text => /refused the control-data read/.test(text)));
    assert.deepStrictEqual(state.closed, [7]);
  });

  await test('a console without ns:ro falls back to ns:am2', async () => {
    const {s, state} = fakeSession({services: ['ns:am2'],
      names: {'0100000000000001': 'Welcome Tour'}});
    const names = await consoleNames.read(s, ids);
    assert.strictEqual(names['0100000000000001'], 'Welcome Tour');
    assert.deepStrictEqual(state.services, ['ns:ro', 'ns:am2']);
  });

  await test('no name service is a missing name, not an error', async () => {
    const {s, state} = fakeSession({services: []});
    const names = await consoleNames.read(s, ids);
    assert.deepStrictEqual(names, {});
    assert.strictEqual(state.calls.length, 0);
  });

  await test('a refused reader is reported once and skipped', async () => {
    const notes = [];
    const {s, state} = fakeSession({reader: 0x615});
    const names = await consoleNames.read(s, ids, {note: text => notes.push(text)});
    assert.deepStrictEqual(names, {});
    assert.strictEqual(state.calls.length, 1);
    assert.ok(notes.some(text => /no control-data reader/.test(text)));
  });

  await test('a title with no name is skipped, the rest are kept', async () => {
    const {s} = fakeSession({names: {'0100000000000002': 'Yoshi'}});
    const names = await consoleNames.read(s, ids);
    assert.deepStrictEqual(names, {'0100000000000002': 'Yoshi'});
  });

  await test('ids are keyed lowercase without the 0x', async () => {
    const {s} = fakeSession({names: {'01000000000000ab': 'Welcome Tour'}});
    const names = await consoleNames.read(s, ['0x01000000000000AB']);
    assert.deepStrictEqual(names, {'01000000000000ab': 'Welcome Tour'});
  });

  await test('a session that throws mid-read still returns what it had', async () => {
    const {s, state} = fakeSession({names: {'0100000000000001': 'Welcome Tour'}});
    const realIpc = s.ipc;
    s.ipc = async (...args) => {
      if (reads(state).length) throw Error('transport 0xf601');
      return realIpc(...args);
    };
    const names = await consoleNames.read(s, ids);
    assert.deepStrictEqual(names, {'0100000000000001': 'Welcome Tour'});
  });

  // The deflated name block is the Switch 2 shape; make sure the wiring passes it
  // through the real parser rather than reading text.
  await test('a deflated NACP name reaches the caller intact', async () => {
    const {s} = fakeSession();
    const text = 'Nintendo Switch 2 Welcome Tour';
    const deflated = zlib.deflateRawSync(Buffer.concat([
      Buffer.from(text), Buffer.alloc(0x3000 - text.length)]));
    s.ipc = async (label, handle, command) => {
      if (command === consoleNames.OPEN_READER) return {result: 0, moves: [7]};
      const bytes = Buffer.alloc(0x4000);
      bytes.writeUInt16LE(deflated.length, 0);
      deflated.copy(bytes, 2);
      bytes[0x3215] = 1;
      s.buffer = bytes;
      return {result: 0, moves: []};
    };
    s.readOwned = async (address, size) => s.buffer.subarray(0, size);
    const names = await consoleNames.read(s, ['0x0100000000000001']);
    assert.deepStrictEqual(names, {'0100000000000001': text});
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
