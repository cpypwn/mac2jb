const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {CHUNK_BYTES, MAX_DUMP_BYTES, parseLength, parseInfoReply, parseChunkReply,
  dumpModule} = require('./dump-module.cjs');

const PROFILE = 'gravity-circuit-v1.2.1';
const BASE = '0x700000';

function mockRepl(bytes, options = {}) {
  const requests = [];
  const execute = async ({source}) => {
    requests.push(source);
    if (source.includes('GC_DUMP_INFO_V1')) {
      return `-> GC_DUMP_INFO_V1\t${PROFILE}\t${BASE}\n`;
    }
    const offset = Number(source.match(/local offset = ([0-9]+)/)?.[1]);
    const count = Number(source.match(/local count = ([0-9]+)/)?.[1]);
    assert.ok(Number.isInteger(offset));
    assert.ok(Number.isInteger(count) && count > 0 && count <= CHUNK_BYTES);
    assert.match(source, /info\.sdk_base/);
    assert.match(source, /Gravity Circuit module changed during dump/);
    if (options.failAt === offset) return 'error: mock failure\n';
    const returnedOffset = options.wrongOffsetAt === offset ? offset + 1 : offset;
    return `-> GC_DUMP_CHUNK_V1\t${PROFILE}\tsdk\t${returnedOffset}\t${count}\t${BASE}\t` +
      `${bytes.subarray(offset, offset + count).toString('hex')}\n`;
  };
  return {execute, requests};
}

test('byte lengths must be explicit and capped', () => {
  assert.equal(parseLength('16384'), 16384);
  assert.equal(parseLength('0x4000'), 16384);
  for (const value of ['0', '-1', '1.5', '16kb', '', 'Infinity', ' 10']) {
    assert.throws(() => parseLength(value));
  }
  assert.throws(() => parseLength(String(MAX_DUMP_BYTES + 1)), /between 1/);
});

test('module metadata rejects unknown profiles and malformed replies', () => {
  assert.deepEqual(parseInfoReply(`-> GC_DUMP_INFO_V1\t${PROFILE}\t${BASE}\n`),
    {profile: PROFILE, base: 0x700000, baseHex: BASE});
  assert.throws(() => parseInfoReply('-> GC_DUMP_INFO_V1\tunknown\t0x700000\n'), /Unsupported/);
  assert.throws(() => parseInfoReply(`-> GC_DUMP_INFO_V1\t${PROFILE}\t0x123\n`), /base/);
  assert.throws(() => parseInfoReply('error: bad state\n'), /bad state/);
});

test('chunk parser requires matching offset, size, base, and complete hex', () => {
  const expected = {module: 'sdk', profile: PROFILE, baseHex: BASE, offset: 0, count: 2};
  assert.deepEqual(parseChunkReply(`-> GC_DUMP_CHUNK_V1\t${PROFILE}\tsdk\t0\t2\t${BASE}\t00ff\n`, expected),
    Buffer.from([0, 255]));
  assert.throws(() => parseChunkReply(`-> GC_DUMP_CHUNK_V1\t${PROFILE}\tsdk\t1\t2\t${BASE}\t00ff\n`, expected),
    /metadata changed/);
  assert.throws(() => parseChunkReply(`-> GC_DUMP_CHUNK_V1\t${PROFILE}\tsdk\t0\t2\t${BASE}\t00\n`, expected),
    /invalid hex/);
});

test('dump uses bounded read chunks and writes an exact binary image', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gravcirc-dump-'));
  try {
    const bytes = Buffer.alloc(CHUNK_BYTES * 2 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const output = path.join(directory, 'sdk.bin');
    const {execute, requests} = mockRepl(bytes);
    const progress = [];
    const result = await dumpModule({host: '127.0.0.1', module: 'sdk', length: bytes.length,
      output, execute, onProgress: (event) => progress.push(event)});
    assert.deepEqual(await fs.readFile(output), bytes);
    assert.equal(result.base, BASE);
    assert.equal(result.profile, PROFILE);
    assert.equal(result.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(requests.length, 4);
    assert.deepEqual(progress.map((event) => event.bytes),
      [CHUNK_BYTES, CHUNK_BYTES * 2, bytes.length]);
    assert.deepEqual(await fs.readdir(directory), ['sdk.bin']);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('a failed or mismatched reply leaves no dump file or partial image', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gravcirc-dump-'));
  try {
    const bytes = Buffer.alloc(CHUNK_BYTES + 1, 77);
    for (const options of [{failAt: CHUNK_BYTES}, {wrongOffsetAt: CHUNK_BYTES}]) {
      const output = path.join(directory, 'sdk.bin');
      const {execute} = mockRepl(bytes, options);
      await assert.rejects(dumpModule({host: '127.0.0.1', module: 'sdk', length: bytes.length,
        output, execute}));
      assert.deepEqual(await fs.readdir(directory), []);
    }
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('an existing output cannot be replaced', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gravcirc-dump-'));
  try {
    const output = path.join(directory, 'sdk.bin');
    await fs.writeFile(output, 'existing');
    const {execute} = mockRepl(Buffer.from('new'));
    await assert.rejects(dumpModule({host: '127.0.0.1', module: 'sdk', length: 3,
      output, execute}), {code: 'EEXIST'});
    assert.equal(await fs.readFile(output, 'utf8'), 'existing');
    assert.deepEqual(await fs.readdir(directory), ['sdk.bin']);
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
});

test('invalid options are rejected before contacting the REPL', async () => {
  let called = false;
  const execute = async () => { called = true; return ''; };
  await assert.rejects(dumpModule({host: '127.0.0.1', module: 'sdk', length: MAX_DUMP_BYTES + 1,
    output: '/tmp/unused', execute}), /between 1/);
  await assert.rejects(dumpModule({host: '127.0.0.1', module: 'other', length: 1,
    output: '/tmp/unused', execute}), /module/);
  assert.equal(called, false);
});
