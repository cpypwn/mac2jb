'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {renderMenu} = require('./menu.cjs');
const {buildNavigation} = require('./navigation.cjs');

const python = process.env.STREMIO_TEST_PYTHON || path.resolve(__dirname, '../homebrew/python/bin/python3');
const fontPath = process.env.STREMIO_TEST_FONT || path.resolve(__dirname, '../homebrew/fonts/DejaVuSans.ttf');
const options = {python, fontPath, width: 640, height: 360};
const at = (frame, x, y) => (y * 640 + x) * 4;

function model(title, focusArea = 'content', selectedIndex = 0, titleMarqueeMs = 0) {
  const value = {view: 'catalog', title: 'Stremio', catalog: {name: 'Continue watching'},
    hero: {title: 'Discover movies and shows'}, count: 2, selectedIndex,
    cards: [{index: 0, title}, {index: 1, title: 'Short'}], titleMarqueeMs};
  value.navigation = buildNavigation(value, {focusArea});
  return value;
}

test('catalog labels sit below poster outlines, center short names, and sweep long focused names', async t => {
  if (!fs.existsSync(python) || !fs.existsSync(fontPath)) {t.skip('The menu renderer is unavailable'); return;}
  const long = 'THE VERY LONG TITLE THAT CONTINUES PAST THE POSTER WIDTH';
  const start = await renderMenu(model(long), options);
  const sweep = await renderMenu(model(long, 'content', 0, 4000), options);
  const idle = await renderMenu(model(long, 'tabs', 0, 0), options);
  const idleLater = await renderMenu(model(long, 'tabs', 0, 4000), options);
  assert.deepEqual(idle, idleLater, 'unfocused long titles remain static');
  let moved = 0;
  for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
    const pixel = at(start, x, y);
    if (!start.subarray(pixel, pixel + 4).equals(sweep.subarray(pixel, pixel + 4))) {
      assert.ok(x >= 73 && x < 191 && y >= 328 && y < 340, 'marquee stays inside its caption');
      moved++;
    }
  }
  assert.ok(moved > 50, 'focused long title visibly scrolls');
  for (let y = 325; y < 341; y++) for (let x = 68; x < 196; x++) {
    const pixel = at(start, x, y), r = start[pixel], g = start[pixel + 1], b = start[pixel + 2];
    assert.ok(!(r === 155 && g === 112 && b === 255) && !(r === 180 && g === 144 && b === 255),
      'poster focus outline stays above caption');
  }
  const short = await renderMenu(model(long, 'content', 1), options);
  const glyphs = [];
  for (let y = 328; y < 340; y++) for (let x = 208; x < 336; x++) {
    const pixel = at(short, x, y);
    if (short[pixel] > 200 && short[pixel + 1] > 200 && short[pixel + 2] > 200) glyphs.push(x);
  }
  assert.ok(glyphs.length > 10, 'short caption is visible');
  assert.ok(Math.abs((Math.min(...glyphs) + Math.max(...glyphs)) / 2 - 272) < 4,
    'short caption is centered below its poster');
});
