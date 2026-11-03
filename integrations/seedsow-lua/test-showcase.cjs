const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const script = fs.readFileSync(path.join(__dirname, 'cpypwn.lua'));
const source = script.toString('utf8');

test('bundled showcase matches the user-visible Seedsow script', () => {
  assert.equal(crypto.createHash('sha256').update(script).digest('hex'),
    '16c364686631521aa23e2d2e43302cd2713ac5e49cab24716727fbd1cc000c43');
  const screen = source.indexOf("p.screen('0xff000000')");
  const name = source.indexOf("p.label('cpypwn', 509, 315, 80, 'cpypwn')");
  const shapes = source.indexOf('for i = 1, 16 do outer(p,');
  assert.ok(screen >= 0 && screen < name && name < shapes,
    'the centered name must be drawn on black before decorative layers');
  assert.equal([...source.matchAll(/\bp\.label\(/g)].length, 1,
    'the showcase should display only the cpypwn text');
});

test('animation reuses the 32 decorative layers created at startup', () => {
  const initial = [...source.matchAll(/^for i = 1, (\d+) do (?:outer|inner|wave)\(p,/gm)]
    .map(([, count]) => Number(count));
  const animated = [...source.matchAll(/^    for i = 1, (\d+) do (?:outer|inner|wave)\(api,/gm)]
    .map(([, count]) => Number(count));
  assert.deepEqual(initial, [16, 8, 8]);
  assert.deepEqual(animated, initial);
});
