const assert = require('node:assert/strict');
const test = require('node:test');
const {qualifyTimingProof} = require('./timing-proof.cjs');

test('timing proof retains the one-call measurement and its issue time', async () => {
  const measured = {gameProfile: 'gravity-circuit-v1.2.1', nonce: '0123456789abcdef'};
  const before = Date.now();
  const proof = await qualifyTimingProof({switchIp: '10.0.0.199'}, {
    qualifyTiming: async args => {
      assert.deepEqual(args, {host: '10.0.0.199'});
      return measured;
    }
  });
  assert.deepEqual({...proof, issuedAt: undefined}, {...measured, issuedAt: undefined});
  assert.ok(proof.issuedAt >= before && proof.issuedAt <= Date.now());
});
