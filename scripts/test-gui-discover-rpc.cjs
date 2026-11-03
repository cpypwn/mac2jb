'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {discover, findPossibleRuns} = require('./gui-discover-rpc.cjs');
const {ATTEMPT} = require('./rpc-attachment.cjs');

async function fixture(t) {
  const base = await fs.mkdtemp('/private/tmp/m2d-');
  t.after(() => fs.rm(base, {recursive:true, force:true}));
  const root = path.join(base, 'Runtime'), sessions = path.join(base, 'Sessions');
  await fs.mkdir(root, {mode:0o700});
  await fs.mkdir(sessions, {mode:0o700});
  async function run(index, host = 'ns2jb', state = 'listening') {
    const session = `A0000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
    const directory = path.join(sessions, session, 'vendor', host, 'runs', `switch2-${String(index).padStart(6, '0')}`);
    await fs.mkdir(directory, {recursive:true, mode:0o700});
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({platform:2, verified:true,
      sourceSha256:'a'.repeat(64), rpc:{mode:'held', state}}), {mode:0o600});
    return directory;
  }
  return {root, sessions, run};
}

test('discovery reports only live, verified local runs and does not claim them', async t => {
  const f = await fixture(t);
  const active = await f.run(1, 'ns2-savekit-host-AbC123');
  await f.run(2, 'ns2jb', 'closed');
  const claimed = await f.run(3);
  await fs.writeFile(path.join(claimed, ATTEMPT), '{}', {mode:0o600});
  await f.run(4, 'other-host');
  const seen = [];
  const result = await discover(f.root, f.sessions, {inspect:async (_, directory, options) => {
    seen.push(directory);
    assert.equal(options.allowRetainedBusy, true);
    return {directory, session:path.basename(directory), profileId:'cellenseres', description:'Cellenseres · '+path.basename(directory)};
  }});
  assert.deepEqual(seen, [active]);
  assert.deepEqual(result.candidates.map(item => item.path), [active]);
  assert.equal(typeof result.candidates[0].modified, 'string');
  assert.match(result.candidates[0].modified, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.candidates[0].profileId, 'cellenseres');
  assert.equal((await findPossibleRuns(f.sessions)).length, 1);
});

test('unverified or unresponsive candidates do not appear and search is bounded', async t => {
  const f = await fixture(t);
  await f.run(1);
  let probes = 0;
  assert.deepEqual((await discover(f.root, f.sessions, {inspect:async () => {
    probes++; throw Error('not a live held session');
  }})).candidates, []);
  assert.equal(probes, 1);
  const started = Date.now();
  const slow = await discover(f.root, f.sessions, {maxDurationMs:40, inspect:() => new Promise(() => {})});
  assert.deepEqual(slow.candidates, []);
  assert.ok(Date.now() - started < 1000);
});

test('canonical private Sessions paths are required', async t => {
  const f = await fixture(t);
  await assert.rejects(discover(f.root, f.sessions+'/../Sessions'), /canonical local Sessions/);
  await fs.chmod(f.sessions, 0o755);
  await assert.rejects(discover(f.root, f.sessions), /owned private Sessions/);
  await fs.chmod(f.sessions, 0o700);
  await assert.rejects(discover(f.root, 'relative'), /canonical local Sessions/);
});
