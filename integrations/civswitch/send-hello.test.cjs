'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const vm = require('node:vm');
const {payload, sendHello} = require('./send-hello.cjs');

async function server(t, reply) {
  const listener = net.createServer({allowHalfOpen: true}, socket => {
    let code = '';
    socket.setEncoding('utf8');
    socket.on('data', part => { code += part; });
    socket.once('end', () => {
      try { socket.end(reply(code)); }
      catch (error) { socket.destroy(error); }
    });
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  return listener.address().port;
}

test('CivSwitch demo builds a single nonce-bearing display payload', () => {
  const script = payload('mac2jb-civ-hello-' + 'a'.repeat(32));
  assert.match(script, /hellow from cpypwn!/);
  assert.equal(script.includes('__MAC2JB_CIV_HELLO_NONCE__'), false);
  assert.equal(script.split('mac2jb-civ-hello-' + 'a'.repeat(32)).length, 2);
  assert.ok(Buffer.byteLength(script) < 500 * 1024);
});

test('CivSwitch demo covers but preserves the game page', async () => {
  function element(tagName = 'div') {
    const children = [];
    return {
      tagName,
      children,
      style: {},
      textContent: '',
      appendChild(child) { child.parent = this; children.push(child); return child; },
      removeChild(child) { children.splice(children.indexOf(child), 1); },
      get firstChild() { return children[0]; },
      remove() { if (this.parent) this.parent.removeChild(this); },
    };
  }
  const body = element();
  const game = element();
  game.textContent = 'Existing game content';
  body.appendChild(game);
  const findById = (node, id) => node.id === id ? node :
    node.children.map(child => findById(child, id)).find(Boolean);
  const messages = [];
  await vm.runInNewContext(payload('demo-marker'), {
    document: {body, getElementById: id => findById(body, id), createElement: element},
    log: message => { messages.push(message); return Promise.resolve(); },
    Math,
  });
  const visibleText = node => [node.textContent, ...node.children.flatMap(visibleText)].filter(Boolean);
  assert.ok(body.children.includes(game));
  const overlay = findById(body, 'mac2jb-civ-hello');
  assert.ok(overlay);
  assert.deepEqual(visibleText(overlay), ['hellow from cpypwn!']);
  assert.deepEqual(messages, ['demo-marker']);
});

test('CivSwitch demo accepts only its own nonce and loader completion', async t => {
  const port = await server(t, code => {
    const marker = /mac2jb-civ-hello-[a-f0-9]{32}/.exec(code)?.[0];
    assert.ok(marker);
    assert.match(code, /hellow from cpypwn!/);
    return 'Executing payload...\n' + marker + '\nExecuted successfully\n';
  });
  const result = await sendHello('127.0.0.1', {port, timeoutMs: 1000});
  assert.equal(result.port, port);
});

test('CivSwitch demo rejects an unrelated service claiming success', async t => {
  const port = await server(t, () => 'other-marker\nExecuted successfully\n');
  await assert.rejects(sendHello('127.0.0.1', {port, timeoutMs: 1000}), /did not confirm/);
});

test('CivSwitch demo rejects a payload error from the loader', async t => {
  const port = await server(t, code => {
    const marker = /mac2jb-civ-hello-[a-f0-9]{32}/.exec(code)?.[0];
    return marker + '\nError in payload: display failed\n';
  });
  await assert.rejects(sendHello('127.0.0.1', {port, timeoutMs: 1000}), /display failed/);
});

test('CivSwitch demo rejects an error even if a service also claims success', async t => {
  const port = await server(t, code => {
    const marker = /mac2jb-civ-hello-[a-f0-9]{32}/.exec(code)?.[0];
    return marker + '\nError in payload: display failed\nExecuted successfully\n';
  });
  await assert.rejects(sendHello('127.0.0.1', {port, timeoutMs: 1000}), /display failed/);
});

test('CivSwitch demo has an absolute response deadline', async t => {
  const listener = net.createServer({allowHalfOpen: true}, socket => {
    socket.on('error', () => {});
    socket.resume();
    socket.once('end', () => {
      const drip = setInterval(() => socket.write('.'), 20);
      socket.once('close', () => clearInterval(drip));
    });
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  await assert.rejects(sendHello('127.0.0.1', {port: listener.address().port, timeoutMs: 120}),
    /timed out/);
});
