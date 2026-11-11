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
  async function civRun(index, state = 'listening', target = 'civ7') {
    const session = `A0000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
    const stage = 'civswitch-fs-' + String(index).padStart(16, '0');
    const directory = path.join(sessions, session, 'runs', stage, 'port', 'engine', 'runs',
      `switch2-${String(index).padStart(6, '0')}`);
    await fs.mkdir(directory, {recursive:true, mode:0o700});
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({platform:2, target, verified:true,
      sourceSha256:'b'.repeat(64), rpc:{mode:'held', state}}), {mode:0o600});
    return directory;
  }
  async function artemisRun(index, state = 'listening') {
    const session = `A0000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
    const stage = 'artemis-fs-' + String(index).padStart(16, '0');
    const directory = path.join(sessions, session, 'runs', stage, 'port', 'engine', 'runs',
      `switch2-${String(index).padStart(6, '0')}`);
    await fs.mkdir(directory, {recursive:true, mode:0o700});
    await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({platform:2,
      target:'artemis-seedsow', verified:true, sourceSha256:'b'.repeat(64),
      rpc:{mode:'held', state}}), {mode:0o600});
    return directory;
  }
  return {root, sessions, run, civRun, artemisRun};
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

test('discovery includes live CivSwitch FS runs from the private staged host tree', async t => {
  const f = await fixture(t);
  const ns2jb = await f.run(1);
  const civ = await f.civRun(2);
  await f.civRun(3, 'closed');
  await f.civRun(4, 'listening', 'switch2');
  const seen = [];
  const result = await discover(f.root, f.sessions, {inspect:async (_, directory) => {
    seen.push(directory);
    return {directory, session:path.basename(directory),
      profileId:directory === civ ? 'civswitch-fs' : 'kurumuz', description:'Held · '+path.basename(directory)};
  }});
  assert.deepEqual(new Set(seen), new Set([ns2jb, civ]));
  assert.deepEqual(new Set(result.candidates.map(item => item.path)), new Set([ns2jb, civ]));
  assert.equal(result.candidates.find(item => item.path === civ).profileId, 'civswitch-fs');
});

test('a CivSwitch result file alone does not establish a live RPC session', async t => {
  const f = await fixture(t);
  await f.civRun(1);
  let probes = 0;
  const result = await discover(f.root, f.sessions, {inspect:async () => {
    probes++;
    throw Error('native RPC bridge is no longer ready');
  }});
  assert.equal(probes, 1);
  assert.deepEqual(result.candidates, []);
});

test('discovery lists a live Artemis run only after inspection', async t => {
  const f = await fixture(t);
  const artemis = await f.artemisRun(1);
  await f.artemisRun(2, 'closed');
  const result = await discover(f.root, f.sessions, {inspect:async (_, directory) => {
    assert.equal(directory, artemis);
    return {directory, session:path.basename(directory), profileId:'artemis-seedsow',
      description:'Seedsow Lullaby'};
  }});
  assert.deepEqual(result.candidates.map(item => item.path), [artemis]);
  assert.equal(result.candidates[0].profileId, 'artemis-seedsow');
});

test('discovery rejects untrusted CivSwitch stages and claimed runs', async t => {
  const f = await fixture(t);
  const claimed = await f.civRun(1);
  await fs.writeFile(path.join(claimed, ATTEMPT), '{}', {mode:0o600});
  const linked = await f.civRun(2);
  const port = path.resolve(linked, '../../../../port');
  await fs.rename(port, port+'-real');
  await fs.symlink(port+'-real', port);
  const publicStage = await f.civRun(3);
  await fs.chmod(path.resolve(publicStage, '../../../../'), 0o755);
  let probes = 0;
  const result = await discover(f.root, f.sessions, {inspect:async () => {
    probes++;
    throw Error('untrusted run was probed');
  }});
  assert.deepEqual(result.candidates, []);
  assert.equal(probes, 0);
  assert.deepEqual(await findPossibleRuns(f.sessions), []);
});

test('canonical private Sessions paths are required', async t => {
  const f = await fixture(t);
  await assert.rejects(discover(f.root, f.sessions+'/../Sessions'), /canonical local Sessions/);
  await fs.chmod(f.sessions, 0o755);
  await assert.rejects(discover(f.root, f.sessions), /owned private Sessions/);
  await fs.chmod(f.sessions, 0o700);
  await assert.rejects(discover(f.root, 'relative'), /canonical local Sessions/);
});
