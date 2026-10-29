'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {SourcePreferences} = require('./source-preferences.cjs');

test('the last playable source resumes only the same video across sessions', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-source-preferences-'));
  t.after(() => fs.rm(folder, {recursive: true, force: true}));
  const file = path.join(folder, 'last-sources.json');
  const sources = [
    {label: 'Direct', providerKey: 'a'.repeat(64), addonName: 'Provider', playable: true,
      url: 'https://media.invalid/first?token=SECRET', headers: {Authorization: 'Bearer SECRET'}},
    {label: 'Direct', providerKey: 'a'.repeat(64), addonName: 'Provider', playable: true,
      url: 'https://media.invalid/second?token=SECRET', headers: {Authorization: 'Bearer SECRET'}}
  ];
  const first = await SourcePreferences.load(file);
  await first.remember('series', 'series:1', 'episode:2', sources, 1);
  const saved = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(saved, /SECRET|media\.invalid|Provider|Direct|series:1|episode:2/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const second = await SourcePreferences.load(file);
  assert.equal(second.find('series', 'series:1', 'episode:2', [...sources].reverse()), 0);
  assert.equal(second.find('series', 'series:1', 'episode:3', sources), -1);
  assert.equal(second.find('movie', 'series:1', 'episode:2', sources), -1);
  assert.equal(second.find('series', 'series:1', 'episode:2', sources.slice(0, 1)), -1);
  assert.equal(second.find('series', 'series:1', 'episode:2', sources.map(source => ({...source, playable: false}))), -1);
  assert.equal(second.find('series', 'series:1', 'episode:2', sources.map(source => ({...source, url: 'https://media.invalid/renewed'}))), -1);
  await second.forget('series', 'series:1', 'episode:2', sources, 0);
  assert.equal(second.find('series', 'series:1', 'episode:2', sources), 1);
  await second.forget('series', 'series:1', 'episode:2', sources, 1);
  assert.equal((await SourcePreferences.load(file)).find('series', 'series:1', 'episode:2', sources), -1);
  await second.remember('movie', 'movie:1', 'movie:1', [sources[0]], 0);
  assert.equal(second.find('movie', 'movie:1', 'movie:1', [{...sources[0], url: 'https://media.invalid/renewed'}]), 0);
});
