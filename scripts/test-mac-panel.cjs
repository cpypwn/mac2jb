'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {openPanel} = require('../integrations/blitbun/mac-panel.cjs');

test('BlitBun opens its local panel with the Mac default browser', () => {
  const url = 'http://127.0.0.1:53674/#' + 'a'.repeat(48);
  const calls = [];
  const launch = (...args) => {calls.push(args); const child = new EventEmitter(); child.unref = () => {}; return child;};
  assert.equal(openPanel(url, {launch}), true);
  assert.deepEqual(calls, [['/usr/bin/open', [url], {detached: true, stdio: 'ignore'}]]);
});

test('BlitBun rejects nonlocal, altered or out-of-range panel URLs', () => {
  const token = 'a'.repeat(48);
  for (const url of [
    `https://127.0.0.1:53674/#${token}`,
    `http://localhost:53674/#${token}`,
    `http://127.0.0.1:53674/?x=1#${token}`,
    `http://127.0.0.1:65536/#${token}`,
    `http://127.0.0.1:53674/#${token}extra`
  ]) assert.throws(() => openPanel(url), /Invalid local capture panel URL/);
});
