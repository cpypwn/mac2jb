const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const profile = require('./sdk-profile.v1.0.1f.json');
const probe = require('./scratch-probe.cjs');

const nonce = '0123456789abcdef';
const absentResult = '0x00000202';

function context(phase, size = probe.SIZES['8m'], index) {
  return {phase, size, index, nonce, absentResult};
}

function preflight(result = absentResult) {
  return {readonly: {absentPathResult: result, gameProfile: profile.gameProfile},
    service: {cleanup: 'closed'}};
}

function reply(context, detail = 'created', status = 'ok') {
  return '-> BAL_SCRATCH_V1|' + context.phase + '|' + status + '|' + context.nonce +
    '|' + detail + '\n';
}

test('all size choices generate bounded Lua chunks with pinned calls', () => {
  for (const size of Object.values(probe.SIZES)) {
    for (const phase of ['create', 'write', 'commit', 'read', 'delete', 'inspect', 'cleanup']) {
      const source = probe.makeSource(context(phase, size,
        ['write', 'read'].includes(phase) ? 0 : undefined));
      assert.ok(Buffer.byteLength(source) < 32768);
      assert.match(source, /1\.0\.1f-FULL/);
      assert.match(source, /save:\/bal-fs-0123456789abcdef\.bin/);
      assert.match(source, /local expected=514/);
      assert.match(source, /code:.*item\[3\]/);
      assert.match(source, /sdk-base-range/);
      if (phase === 'inspect' || phase === 'cleanup') {
        assert.match(source, /kind~=1/);
      }
      assert.doesNotMatch(source, /sdk-base'\)/);
      const compile = spawnSync('/opt/homebrew/bin/luajit', ['-b', '-', '/dev/null'],
        {input: source, encoding: 'utf8'});
      if (!compile.error || compile.error.code !== 'ENOENT') {
        assert.equal(compile.status, 0, compile.stderr);
      }
    }
  }
});

test('8 MiB runs 8 bounded writes, commit, 8 readbacks and verified deletion', async () => {
  const calls = [];
  const result = await probe.probeScratch({host: '10.0.0.189', size: probe.SIZES['8m'],
    absentResult, nonceBytes: () => Buffer.from(nonce, 'hex'),
    qualify: async () => preflight(),
    execute: async ({source, port, timeoutMs}) => {
      assert.equal(port, 9026);
      assert.equal(timeoutMs, 30000);
      const phase = source.match(/local phase="([^"]+)"/)[1];
      const indexMatch = source.match(/s\.step~=(\d+)/);
      const index = indexMatch ? Number(indexMatch[1]) : undefined;
      const item = {phase, index};
      calls.push(item);
      const detail = phase === 'create' ? 'created' : phase === 'commit' ? 'committed' :
        phase === 'delete' ? 'clean:16121856' : phase === 'write' ?
          'written:' + Math.min(probe.SIZES['8m'], (index + 1) * probe.STEP) :
          'verified:' + Math.min(probe.SIZES['8m'], (index + 1) * probe.STEP);
      return reply(context(phase, probe.SIZES['8m'], index), detail);
    }});
  assert.equal(result.cleanup, 'verified');
  assert.equal(result.results.length, 19);
  assert.deepEqual(calls.map(item => item.phase),
    ['create', ...Array(8).fill('write'), 'commit', ...Array(8).fill('read'), 'delete']);
  assert.deepEqual(calls.filter(item => item.phase === 'write').map(item => item.index),
    [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('mismatched read-only result stops before any write request', async () => {
  let calls = 0;
  await assert.rejects(probe.probeScratch({host: '10.0.0.189', size: probe.SIZES['8m'],
    absentResult, nonceBytes: () => Buffer.from(nonce, 'hex'),
    qualify: async () => preflight('0x00000402'),
    execute: async () => { calls++; }}), /preflight did not match/);
  assert.equal(calls, 0);
});

test('a native failure stops without cleanup or fallback', async () => {
  const calls = [];
  await assert.rejects(probe.probeScratch({host: '10.0.0.189', size: probe.SIZES['8m'],
    absentResult, nonceBytes: () => Buffer.from(nonce, 'hex'),
    qualify: async () => preflight(),
    execute: async ({source}) => {
      const phase = source.match(/local phase="([^"]+)"/)[1];
      calls.push(phase);
      return reply(context(phase), phase === 'write' ? 'write:402' : 'created',
        phase === 'write' ? 'fail' : 'ok');
    }}), /scratch write failed: write:402/);
  assert.deepEqual(calls, ['create', 'write']);
});

test('invalid size, result and nonce fail before generation', () => {
  assert.throws(() => probe.makeSource(context('create', 16777216)), /invalid size/);
  assert.throws(() => probe.makeSource({...context('create'), absentResult: '0x00000000'}),
    /missing-path Result/);
  assert.throws(() => probe.makeSource({...context('create'), nonce: 'bad'}), /invalid nonce/);
  assert.throws(() => probe.parseReply(reply(context('create')).replace(nonce, 'aaaaaaaaaaaaaaaa'),
    context('create')), /does not match/);
});

test('explicit cleanup follows read-only inspection of a failed owned transaction', async () => {
  const phases = [];
  const result = await probe.inspectScratch({host: '10.0.0.189', nonce,
    size: probe.SIZES['8m'], absentResult, cleanup: true,
    qualify: async () => preflight(),
    execute: async ({source}) => {
      const phase = source.match(/local phase="([^"]+)"/)[1];
      phases.push(phase);
      if (phase === 'cleanup') {
        assert.match(source, /cleanup-size-mismatch/);
        assert.match(source, /delete-commit/);
        return reply(context(phase), 'clean:16105472');
      }
      return reply(context(phase), 'failed:00000000:1:8000000');
    }});
  assert.deepEqual(phases, ['inspect', 'cleanup']);
  assert.equal(result.cleanup.detail, 'clean:16105472');
});

test('explicit cleanup refuses an in-flight transaction and unexpected file result', async () => {
  for (const detail of ['write:00000000:1:8000000', 'failed:00000402:0:8000000']) {
    const phases = [];
    await assert.rejects(probe.inspectScratch({host: '10.0.0.189', nonce,
      size: probe.SIZES['8m'], absentResult, cleanup: true,
      qualify: async () => preflight(),
      execute: async ({source}) => {
        const phase = source.match(/local phase="([^"]+)"/)[1];
        phases.push(phase);
        return reply(context(phase), detail);
      }}), /state is not failed/);
    assert.deepEqual(phases, ['inspect']);
  }
});
