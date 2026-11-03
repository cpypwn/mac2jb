#!/usr/bin/env node
// Offline tests for tools/lib/app-storages.cjs. No console, no network, no deps.
//
//   node tests/test_app_storages.cjs
//
// These pin the two halves of issue #1 that are testable without the console:
// the list is built from every storage NCM has a database for (not just the
// internal NAND), and a console with no SD card or no game card still produces a
// list instead of an error.
const assert = require('node:assert');
const {collect, STORAGES} = require('../tools/lib/app-storages.cjs');

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

const app = id => ({id});
const reply = ids => ({total: ids.length, written: ids.length, complete: true,
  keys: ids.map(app)});

(async () => {
  await test('every storage with a database is asked', async () => {
    const asked = [];
    const result = await collect(async storage => {
      asked.push(storage);
      return reply(['0x' + String(storage).padStart(16, '0')]);
    });
    assert.deepStrictEqual(asked, STORAGES.map(storage => storage.id));
    assert.strictEqual(result.ids.length, STORAGES.length);
    assert.deepStrictEqual(result.storages.map(s => s.label),
      ['BuiltInUser', 'SdCard', 'GameCard']);
  });

  await test('an SD-card title is listed alongside an internal one', async () => {
    const result = await collect(async storage => {
      if (storage === 4) return reply(['0x0100000000000001']);
      if (storage === 5) return reply(['0x0100000000000002']);
      throw Error('NCM built-in-system database did not open');
    });
    assert.deepStrictEqual(result.ids, ['0x0100000000000001', '0x0100000000000002']);
  });

  await test('a missing SD card or game card is absent, not an error', async () => {
    const notes = [];
    const result = await collect(async storage => {
      if (storage === 4) return reply(['0x0100000000000001']);
      throw Error('NCM built-in-system database did not open');
    }, {note: text => notes.push(text)});
    assert.deepStrictEqual(result.ids, ['0x0100000000000001']);
    const sd = result.storages.find(s => s.label === 'SdCard');
    const gc = result.storages.find(s => s.label === 'GameCard');
    assert.match(sd.error, /did not open/);
    assert.match(gc.error, /did not open/);
    assert.strictEqual(notes.filter(text => /no database/.test(text)).length, 2);
  });

  await test('the same id in two databases is listed once', async () => {
    const result = await collect(async storage => storage === 4
      ? reply(['0x0100000000000001', '0x0100000000000002'])
      : reply(['0x0100000000000002', '0x0100000000000003']));
    assert.deepStrictEqual(result.ids,
      ['0x0100000000000001', '0x0100000000000002', '0x0100000000000003']);
    assert.strictEqual(result.storages.find(s => s.label === 'SdCard').ids.length, 1);
  });

  await test('ids are lowercased so consumers see one spelling', async () => {
    const result = await collect(async storage => storage === 4
      ? reply(['0x01000000000000AB'])
      : reply([]));
    assert.deepStrictEqual(result.ids, ['0x01000000000000ab']);
  });

  await test('a truncated database reply is reported', async () => {
    const notes = [];
    await collect(async storage => ({total: 2000, written: 1024, complete: false,
      keys: [app('0x0100000000000001')]}), {note: text => notes.push(text)});
    assert.ok(notes.some(text => /truncated/.test(text)));
  });

  await test('nothing anywhere gives an empty list, not a throw', async () => {
    const result = await collect(async () => { throw Error('did not open'); });
    assert.deepStrictEqual(result.ids, []);
    assert.strictEqual(result.storages.filter(s => s.error).length, STORAGES.length);
  });

  await test('a reply with no key list is skipped, not fatal', async () => {
    const result = await collect(async storage =>
      storage === 4 ? {} : reply(['0x0100000000000001']));
    assert.deepStrictEqual(result.ids, ['0x0100000000000001']);
    assert.match(result.storages.find(s => s.label === 'BuiltInUser').error, /no key list/);
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
