const assert = require('node:assert/strict');
const {test} = require('node:test');
const {runFreshAbsentPath} = require('./borrowed-absent-live.cjs');
const {runBorrowedDomainDiscriminator} = require('./borrowed-domain-discriminator.cjs');

function success() {
  return {sendCount: 1, result: 0x202, arena: 'detached',
    listener: 'closed', nativeBridge: 'closed', domainClones: 0,
    markerWrites: 0, explicitSaveWrites: 0};
}

test('absent-path wrapper injects exactly the owned-path-free one-send diagnostic', async () => {
  let calls = 0;
  const result = await runFreshAbsentPath({host: '10.0.0.189', macIp: '10.0.0.205',
    async runFresh(options) {
      calls++;
      assert.equal(options.runOne, runBorrowedDomainDiscriminator);
      assert.equal(options.host, '10.0.0.189');
      assert.equal(options.macIp, '10.0.0.205');
      return success();
    }});
  assert.equal(calls, 1);
  assert.equal(result.result, 0x202);
});

test('absent-path wrapper fails closed if result or cleanup differs', async () => {
  for (const changed of [{result: 0}, {sendCount: 2}, {arena: 'retained'},
    {listener: 'open'}, {domainClones: 1}, {markerWrites: 1},
    {explicitSaveWrites: 1}]) {
    await assert.rejects(runFreshAbsentPath({host: '10.0.0.189', macIp: '10.0.0.205',
      async runFresh() {return {...success(), ...changed};}}), /did not verify/);
  }
});

test('absent-path wrapper rejects invalid addresses before invoking the runner', async () => {
  let calls = 0;
  await assert.rejects(runFreshAbsentPath({host: 'localhost', macIp: '10.0.0.205',
    async runFresh() {calls++; return success();}}), /IPv4/);
  assert.equal(calls, 0);
});
