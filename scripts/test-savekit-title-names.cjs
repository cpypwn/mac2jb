'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {main, lookup, namesFromGames} = require('./savekit-title-names.cjs');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-title-names-'));
  const run = path.join(root, 'runs', 'switch2-fixture');
  fs.mkdirSync(run, {recursive: true});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const calls = [];
  const attachment = {live: {session: 'switch2-fixture'}, async close() {
    calls.push('close');
    if (options.closeError) throw options.closeError;
  }};
  const dependencies = {
    root,
    ouncecake: {
      async verifySnapshot() { calls.push('snapshot'); },
      async validateAttachment() { calls.push('validate-attachment'); }
    },
    async validateRun() {
      calls.push('validate-run');
      if (options.validateError) throw options.validateError;
      return {directory: run, proof: {session: 'switch2-fixture'}};
    },
    verifiedSession() {},
    session: {async attachGame() {
      calls.push('attach');
      if (options.attachError) throw options.attachError;
      return attachment;
    }},
    content: {async discoverGames() {
      calls.push('discover');
      if (options.discoverError) throw options.discoverError;
      return options.games || [];
    }}
  };
  return {root, run, calls, dependencies};
}

test('read-only discovery emits bounded title names only after native cleanup', async t => {
  const state = fixture(t, {games: [
    {title: '010012900D38A000', name: 'Nora Princess 2'},
    {title: '010042D022AEA000', name: 'Seedsow\u202e Lullaby'},
    {title: '0100b4b00f9f6000', name: null}
  ]});
  const output = [];
  const names = await main([state.run], {...state.dependencies, write: line => output.push(line)});
  assert.deepEqual(names, [
    {titleId: '010012900d38a000', name: 'Nora Princess 2'},
    {titleId: '010042d022aea000', name: 'Seedsow Lullaby'}
  ]);
  assert.deepEqual(state.calls,
    ['snapshot', 'validate-run', 'validate-attachment', 'attach', 'discover', 'close']);
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0].slice('MAC2JB_TITLE_NAMES '.length)),
    {cleanupConfirmed: true, titles: names});
  assert.equal(fs.readdirSync(state.run).length, 0);
});

test('unavailable name service safely returns ids-only fallback after cleanup', async t => {
  const state = fixture(t, {discoverError: Error('Service unavailable: ns:am2')});
  const output = [];
  assert.deepEqual(await main([state.run], {...state.dependencies, write: line => output.push(line)}), []);
  assert.deepEqual(JSON.parse(output[0].slice('MAC2JB_TITLE_NAMES '.length)),
    {cleanupConfirmed: true, titles: []});
  assert.equal(state.calls.at(-1), 'close');
});

test('timeout or uncertain discovery never emits a safe result', async t => {
  const state = fixture(t, {discoverError: Error('Memory request timed out')});
  const output = [];
  await assert.rejects(main([state.run], {...state.dependencies, write: line => output.push(line)}),
    /timed out/);
  assert.deepEqual(output, []);
  assert.equal(state.calls.at(-1), 'close');
});

test('failed cleanup blocks title listing even when names were read', async t => {
  const state = fixture(t, {
    games: [{title: '010012900d38a000', name: 'Nora Princess 2'}],
    closeError: Error('Owned handle did not close')
  });
  const output = [];
  await assert.rejects(main([state.run], {...state.dependencies, write: line => output.push(line)}),
    /Owned handle did not close/);
  assert.deepEqual(output, []);
});

test('a failed source check cannot attach to the console', async t => {
  const state = fixture(t, {validateError: Error('Changed host code')});
  await assert.rejects(lookup(state.run, state.dependencies), /Changed host code/);
  assert.deepEqual(state.calls, ['snapshot', 'validate-run']);
});

test('untrusted names and duplicate ids are rejected before output', () => {
  assert.throws(() => namesFromGames([
    {title: '010012900d38a000', name: 'A'},
    {title: '010012900D38A000', name: 'B'}
  ]), /invalid title ID/);
  assert.throws(() => namesFromGames([{title: '../bad', name: 'Bad'}]), /invalid title ID/);
});
