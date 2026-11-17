const assert = require('node:assert/strict');
const {test} = require('node:test');
const {MARKER, makeSource, parseReply,
  inspectRootState} = require('./fs-root-state-live.cjs');

const context = {nonce: 'a13a825d95523b77', mainBase: '0x5916c04000',
  sdkBase: '0x59298b4000', arenaBase: '0x31f94f8000'};

test('owner-bound inspection reads state and guards without changing it', () => {
  const source = makeSource(context);
  assert.match(source, /h\.owner~='a13a825d95523b77'/);
  assert.match(source, /arena-guard/);
  assert.doesNotMatch(source, /b\.fs_bridge=nil|t:close\(\)|ffi\.fill/);
  const reply = `-> ${MARKER}\tok\t${context.nonce}\t${context.arenaBase}` +
    '\tready\tnone\tlistener-absent\tclient-absent\tworker-absent\n';
  assert.deepEqual(parseReply(reply, context), {
    owner: context.nonce, arenaBase: context.arenaBase, arenaStage: 'ready',
    transportStage: 'none', listener: 'listener-absent',
    client: 'client-absent', worker: 'worker-absent'});
});

test('state query rejects changed owner, changed image, and ambiguous reply', async () => {
  await assert.rejects(inspectRootState({...context, host: '10.0.0.189',
    execute: async () => `-> ${MARKER}\tfail\timage-changed\n`}), /image-changed/);
  assert.throws(() => parseReply(`-> ${MARKER}\tok\tdeadbeefdeadbeef\t` +
    `${context.arenaBase}\tready\tnone\tlistener-absent\tclient-absent\tworker-absent\n`,
  context), /incomplete or changed/);
  assert.throws(() => parseReply('', context), /missing or duplicated/);
});
