'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {probe} = require('./probe.cjs');

async function server(answer) {
  const listener = net.createServer(socket => {
    let code = '';
    socket.on('data', bytes => { code += bytes.toString('utf8'); });
    socket.on('end', () => {
      const match = /^log\("(mac2jb-civswitch-[a-f0-9]{32})"\);$/.exec(code);
      socket.end(answer(match?.[1]));
    });
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  return listener;
}

test('CivSwitch probe accepts only its nonce and the loader completion line', async t => {
  const listener = await server(marker => 'Executing payload...\n' + marker + '\nExecuted successfully\n');
  t.after(() => listener.close());
  const events = [];
  const result = await probe('127.0.0.1', {port: listener.address().port, waitMs: 500,
    emit: (type, fields) => events.push({type, ...fields})});
  assert.match(result.marker, /^mac2jb-civswitch-[a-f0-9]{32}$/);
  assert.equal(events.at(-1).type, 'loader-ready');
});

test('CivSwitch probe rejects a different service even when it says success', async t => {
  const listener = await server(() => 'Executed successfully\n');
  t.after(() => listener.close());
  await assert.rejects(probe('127.0.0.1', {port: listener.address().port, waitMs: 500}),
    /did not confirm/);
  await assert.rejects(probe('localhost'), /IPv4/);
});
