#!/usr/bin/env node
// Offline tests for tools/lib/save-tree.cjs. No console, no network, no deps.
//
//   node tests/test_save_tree.cjs
//
// The regression these pin: the pull classified an entry by whether openFile
// succeeded, so a real file whose read-only open failed was recursed into as a
// directory and dropped without a word (the "not catching all the file
// structure" report for Breath of the Wild). A file must stay a file, and a file
// that will not open must be reported rather than skipped.
const assert = require('node:assert');
const tree = require('../tools/lib/save-tree.cjs');

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

// A tiny save filesystem: directories to list, files to open.
//
// A `refuse` file answers a non-zero result from openFile, which is the case the
// old walker mistook for a directory. Listing a path that is a file throws: that
// is exactly the doomed call the old walker made, so a test fails loudly if the
// walker ever does it again.
function fakeSave(shape) {
  const calls = {list: [], open: [], close: 0};
  return {
    calls,
    async list(save, directory, limit) {
      calls.list.push({directory, limit});
      const entries = shape[directory];
      if (!entries) throw Error('listed a path that is a file: ' + directory);
      return entries;
    },
    async open(save, full) {
      calls.open.push(full);
      const file = shape.files[full];
      if (!file) throw Error('opened a path that is a directory: ' + full);
      return file.refuse ? {result: 0x2ee02, handle: null} : {result: 0, handle: full};
    },
    async size(opened) { return shape.files[opened.handle].data.length; },
    async read(opened, offset, size) {
      const data = shape.files[opened.handle].data;
      return data.subarray(offset, Math.min(offset + size, data.length));
    },
    async close() { calls.close += 1; },
  };
}

const bytes = text => Buffer.from(text);

// /tracker and /album are directories; option.sav, locked.bin and map.dat are
// files. locked.bin is the interesting one: its read-only open is refused.
function botwShape() {
  return {
    '/': [
      {name: 'option.sav', type: tree.FILE, size: '4'},
      {name: 'tracker', type: tree.DIRECTORY, size: '0'},
      {name: 'album', type: tree.DIRECTORY, size: '0'},
    ],
    '/tracker': [
      {name: 'locked.bin', type: tree.FILE, size: '999'},
      {name: 'map.dat', type: tree.FILE, size: '5'},
    ],
    '/album': [],
    files: {
      '/option.sav': {data: bytes('save')},
      '/tracker/locked.bin': {data: bytes('x'.repeat(999)), refuse: true},
      '/tracker/map.dat': {data: bytes('12345')},
    },
  };
}

(async () => {
  await test('Directory is 0 and File is 1', () => {
    assert.strictEqual(tree.DIRECTORY, 0);
    assert.strictEqual(tree.FILE, 1);
    assert.ok(tree.isDirectory({name: 'd', type: 0}));
    assert.ok(!tree.isDirectory({name: 'f', type: 1}));
    assert.ok(tree.isFile({name: 'f', type: 1}));
    assert.ok(!tree.isFile({name: 'd', type: 0}));
  });

  await test('a walk reaches every file, nested or not', async () => {
    const api = fakeSave(botwShape());
    const seen = [], dirs = [];
    await tree.walk('save', '/', api, {
      directory: async full => dirs.push(full),
      file: async full => seen.push(full),
    });
    assert.deepStrictEqual(seen.sort(), ['/option.sav', '/tracker/locked.bin', '/tracker/map.dat']);
    assert.deepStrictEqual(dirs, ['/tracker', '/album']);
    // Only directories are listed: the root and the two subdirectories.
    assert.deepStrictEqual(api.calls.list.map(call => call.directory), ['/', '/tracker', '/album']);
  });

  await test('a refused open stays a file and is reported, not skipped', async () => {
    const api = fakeSave(botwShape());
    const state = {files: 0, bytes: 0, entries: [], failed: []};
    await tree.walk('save', '/', api, {
      file: async (full, entry) => {
        const opened = await api.open('save', full);
        if (opened.result) {
          state.failed.push({path: full, size: Number(entry.size), result: opened.result});
          return;
        }
        const data = await api.read(opened, 0, 0x40000);
        await api.close(opened);
        state.files += 1;
        state.bytes += data.length;
        state.entries.push({path: full, size: data.length});
      },
    });
    assert.deepStrictEqual(state.failed.map(item => item.path), ['/tracker/locked.bin']);
    assert.deepStrictEqual(state.entries.map(item => item.path),
      ['/option.sav', '/tracker/map.dat']);
    assert.strictEqual(state.files, 2);
    assert.strictEqual(state.bytes, 9);
    assert.ok(!api.calls.list.some(call => call.directory === '/tracker/locked.bin'),
      'the refused file was recursed into');
  });

  await test('the limit handed to the engine is above the old 2048', async () => {
    const api = fakeSave(botwShape());
    await tree.walk('save', '/', api, {file: async () => {}});
    assert.ok(tree.ENTRY_LIMIT > 2048, 'ENTRY_LIMIT must be above the old probe limit');
    for (const call of api.calls.list) assert.strictEqual(call.limit, tree.ENTRY_LIMIT);
  });

  await test('a type that is neither value is walked as a file', async () => {
    const api = fakeSave({
      '/': [{name: 'odd.out', type: 7, size: '3'}],
      files: {'/odd.out': {data: bytes('odd')}},
    });
    const seen = [];
    await tree.walk('save', '/', api, {file: async full => seen.push(full)});
    assert.deepStrictEqual(seen, ['/odd.out']);
    assert.deepStrictEqual(api.calls.list.map(call => call.directory), ['/']);
  });

  await test('a subdirectory path is joined once', () => {
    assert.strictEqual(tree.join('/', 'a'), '/a');
    assert.strictEqual(tree.join('/a', 'b'), '/a/b');
    assert.strictEqual(tree.join('/a/', 'b'), '/a/b');
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
