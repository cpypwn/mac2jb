#!/usr/bin/env node
// Offline tests for tools/lib/content-names.cjs. No console, no network, no deps.
//
//   node tests/test_content_names.cjs
//
// This is the read that names titles on hardware when the ns reader will not
// answer (ouncecake's control-NCA path). The session, domain and filesystem are
// faked: these pin the command order, the storage routing and the parsing, not
// the console.
const assert = require('node:assert');
const contentNames = require('../tools/lib/content-names.cjs');

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
  bytes.write(text, 0);
  return bytes;
}

// A session that answers the four ncm commands for every id in `titles`.
// `store` answers command 8 with a path; `root` answers command 10 with a
// filesystem handle; `filesystem` serves /control.nacp.
function fakeConsole({titles, storageOf = {}, noContent = [], noMount = []}) {
  const state = {calls: [], closed: [], handles: 1};
  const s = {
    base: 0x10000000,
    handles: new Set(),
    async ipc(label, handle, command, input) {
      state.calls.push({kind: 'ipc', command, storage: input[0], label});
      if (command === 5) return {result: 0, moves: [state.handles++]};           // meta db
      if (command === 4) return {result: 0, moves: [state.handles++]};           // content storage
      const id = Buffer.from(input.subarray(input.length === 8 ? 0 : 8,
        (input.length === 8 ? 0 : 8) + 8)).readBigUInt64LE().toString(16).padStart(16, '0');
      if (noContent.includes(id)) return {result: 0x2ee02, data: Buffer.alloc(32)};
      if (command === 6) {
        const key = Buffer.alloc(16);
        Buffer.from(id, 'hex').copy(key);
        return {result: 0, data: key};
      }
      if (command === 3) return {result: 0, data: Buffer.from('aa'.repeat(16), 'hex')};
      if (command === 24) {
        const data = Buffer.alloc(32);
        data[21] = 2;                       // attributes 2 & 15
        return {result: 0, data};
      }
      return {result: 0x2ee02, data: Buffer.alloc(32)};
    },
    async readOwned(address, size) {
      const bytes = Buffer.alloc(size);
      bytes.write('/content/00000000000000000000000000000000.cnmt.nca');
      return bytes;
    },
    async write() {},
    async close(handle) { state.closed.push(handle); },
  };
  const domain = {
    async send(session, label, handle, packet) {
      state.calls.push({kind: 'domain', label, handle});
      if (label.startsWith('Resolve')) return {result: 0, moves: []};
      if (label.startsWith('Open control filesystem')) {
        const id = packet.toString('hex');
        return noMount.some(title => packet.includes(Buffer.from(title, 'hex')))
          ? {result: 0x2ee02, moves: []} : {result: 0, moves: [state.handles++]};
      }
      return {result: 0, moves: []};
    },
  };
  // The packet builder only has to be recognisable here; the real one is the
  // engine's and is exercised on hardware.
  const packet = (command, input, options = {}) =>
    Buffer.concat([Buffer.from([command]), input, Buffer.from(JSON.stringify(
      {send: options.pointers?.send?.length ?? 0,
        receive: options.pointers?.receive?.length ?? 0}))]);
  const filesystem = {
    async openFile(session, handle, file) {
      state.calls.push({kind: 'file', file});
      return {result: 0, handle: state.handles++};
    },
    async fileSize() { return 0x4000; },
    async readFile(session, handle) { return nacp(titles.fileName || 'Control Name'); },
  };
  return {s, domain, packet, filesystem, state, root: 99};
}

(async () => {
  await test('a title is named through its control NCA', async () => {
    const fake = fakeConsole({titles: {}});
    const names = await contentNames.readTitles({...fake, ncm: 7,
      ids: ['0x01000000000000ab'], storages: {'0x01000000000000AB': 4}});
    assert.deepStrictEqual(names, {'01000000000000ab': 'Control Name'});
    const commands = fake.state.calls.filter(c => c.kind === 'ipc').map(c => c.command);
    assert.deepStrictEqual(commands, [5, 4, 6, 3, 24]);
    const domainCalls = fake.state.calls.filter(c => c.kind === 'domain').map(c => c.label);
    assert.deepStrictEqual(domainCalls, ['Resolve control NCA path', 'Open control filesystem']);
    assert.deepStrictEqual(fake.state.calls.filter(c => c.kind === 'file').map(c => c.file),
      ['/control.nacp']);
  });

  await test('the storage a title was listed from is used, with or without 0x', async () => {
    const fake = fakeConsole({titles: {}});
    await contentNames.readTitles({...fake, ncm: 7, ids: ['0x04000000000000cd'],
      storages: {'04000000000000cd': 2}});
    // The meta database and the content storage are opened on storage 2.
    const opens = fake.state.calls.filter(c => c.kind === 'ipc' &&
      (c.command === 5 || c.command === 4));
    assert.deepStrictEqual(opens.map(c => c.storage), [2, 2]);
  });

  await test('one database and one storage per storage, closed afterwards', async () => {
    const fake = fakeConsole({titles: {}});
    await contentNames.readTitles({...fake, ncm: 7,
      ids: ['0x0100000000000001', '0x0100000000000002'], storages: {}});
    const ipc = command => fake.state.calls.filter(c => c.kind === 'ipc' && c.command === command);
    assert.strictEqual(ipc(5).length, 1);
    assert.strictEqual(ipc(4).length, 1);
    // Database and storage handles, one filesystem and one file per title.
    assert.deepStrictEqual(fake.state.closed.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  });

  await test('a title with no control content keeps its id', async () => {
    const fake = fakeConsole({titles: {}, noContent: ['0100000000000002']});
    const names = await contentNames.readTitles({...fake, ncm: 7,
      ids: ['0x0100000000000001', '0x0100000000000002'], storages: {}});
    assert.deepStrictEqual(Object.keys(names), ['0100000000000001']);
  });

  await test('an empty or unreadable path is a missing name, not a throw', async () => {
    const fake = fakeConsole({titles: {}});
    fake.s.readOwned = async (address, size) => Buffer.alloc(size);
    const names = await contentNames.readTitles({...fake, ncm: 7,
      ids: ['0x0100000000000001'], storages: {}});
    assert.deepStrictEqual(names, {});
  });

  await test('an ipc failure for one title is noted and the rest continue', async () => {
    const fake = fakeConsole({titles: {}});
    const realIpc = fake.s.ipc;
    let failed = false;
    fake.s.ipc = async (label, handle, command, input) => {
      if (command === 6 && !failed) { failed = true; throw Error('transport 0xf601'); }
      return realIpc(label, handle, command, input);
    };
    const notes = [];
    const names = await contentNames.readTitles({...fake, ncm: 7,
      ids: ['0x0100000000000001', '0x0100000000000002'], storages: {},
      note: text => notes.push(text)});
    assert.deepStrictEqual(Object.keys(names), ['0100000000000002']);
    assert.ok(notes.some(text => /transport 0xf601/.test(text)));
  });

  await test('the control content ids are the documented fields', async () => {
    const fake = fakeConsole({titles: {}});
    const content = await contentNames.controlContent(fake.s, 3, '01000000000000ef');
    assert.strictEqual(content.attributes, 2);
    assert.strictEqual(content.contentId.toString('hex'), 'aa'.repeat(16));
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
