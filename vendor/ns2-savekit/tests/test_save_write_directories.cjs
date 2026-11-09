const test = require('node:test');
const assert = require('node:assert/strict');
const {ensureParentDirectories} = require('../tools/save-write-stage.cjs');

const directory = () => ({result: 0, data: Buffer.alloc(4)});
const missing = () => ({result: 0x202, canonicalResult: 0x202});

test('nested save files create each missing parent once using CreateDirectory', async () => {
  const present = new Set(['/.lovegame']);
  const created = [];
  await ensureParentDirectories([
    '/.lovegame/bl/app.lua',
    '/.lovegame/bl/assets/mono.ttf',
    '/.lovegame/conf.lua',
    '/.lovegame/bl/console.lua'
  ], prefix => present.has(prefix) ? directory() : missing(),
  async (command, prefix, input) => {
    assert.equal(command, 2);
    assert.equal(input.length, 0);
    assert.ok(present.has(prefix.substring(0, prefix.lastIndexOf('/'))));
    present.add(prefix);
    return {result: 0};
  }, prefix => created.push(prefix));
  assert.deepEqual(created, ['/.lovegame/bl', '/.lovegame/bl/assets']);
});

test('a file where a parent directory belongs stops before mutation', async () => {
  const file = Buffer.alloc(4);
  file.writeUInt32LE(1);
  let created = false;
  await assert.rejects(ensureParentDirectories(['/.lovegame/bl/app.lua'],
    prefix => prefix === '/.lovegame' ? {result: 0, data: file} : missing(),
    () => {created = true; return {result: 0};}),
  /not a directory/);
  assert.equal(created, false);
});

test('a failed CreateDirectory stops before any file write', async () => {
  await assert.rejects(ensureParentDirectories(['/.lovegame/bl/app.lua'],
    prefix => prefix === '/.lovegame' ? directory() : missing(),
    () => ({result: 0x202})),
  /CreateDirectory failed for \/.lovegame\/bl: 0x202/);
});
