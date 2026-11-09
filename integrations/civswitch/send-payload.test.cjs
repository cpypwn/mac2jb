'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {sendPayload} = require('./send-payload.cjs');

async function fixture(t, reply) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-civ-js-'));
  t.after(() => fs.rmSync(folder, {recursive: true, force: true}));
  const file = path.join(folder, 'sample.js');
  fs.writeFileSync(file, 'log("hello");');
  const listener = net.createServer({allowHalfOpen: true}, socket => {
    let source = '';
    socket.setEncoding('utf8');
    socket.on('data', part => { source += part; });
    socket.once('end', () => socket.end(reply(source)));
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  return {file, port: listener.address().port};
}

test('sends a selected JavaScript file to an open loader', async t => {
  const {file, port} = await fixture(t, source => {
    assert.equal(source, 'log("hello");');
    return 'hello\nExecuted successfully\n';
  });
  assert.match(await sendPayload('127.0.0.1', file, {port, timeoutMs: 1000}), /hello/);
});

test('rejects a loader payload error', async t => {
  const {file, port} = await fixture(t, () => 'Error in payload: rejected\nExecuted successfully\n');
  await assert.rejects(sendPayload('127.0.0.1', file, {port, timeoutMs: 1000}), /rejected/);
});

test('rejects an unrelated service and an oversized file', async t => {
  const {file, port} = await fixture(t, () => 'ok\n');
  await assert.rejects(sendPayload('127.0.0.1', file, {port, timeoutMs: 1000}), /did not confirm/);
  fs.writeFileSync(file, 'x'.repeat(480001));
  await assert.rejects(sendPayload('127.0.0.1', file, {port, timeoutMs: 1000}), /smaller than 480 KB/);
});
