const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {makeSource, parseReply, takeSnapshot} = require('./rpc-log-snapshot.cjs');

const nonce = '0123456789abcdef';
const logger = Buffer.alloc(100, 97);
const expectedLoggerHash = crypto.createHash('sha256').update(logger).digest('hex');
const reply = ({free = 16367616, logSize = 4096, phaseSize = 11,
  sourceHex = logger.toString('hex')} = {}) =>
  `-> BAL_FS_LOG_SNAPSHOT_V1\tok\t${nonce}\t${free}\t00000202\t${logSize}\t${phaseSize}\t${sourceHex}\n`;

test('snapshot source preserves pinned FS/path checks without explicit console logging', () => {
  const source = makeSource({nonce});
  assert.match(source, /freeCall/);
  assert.match(source, /entryCall/);
  assert.match(source, /getInfo\('bl_log\.txt','file'\)/);
  assert.match(source, /fs\.read\('bl\/log\.lua'\)/);
  assert.doesNotMatch(source, /log\.log\(/);
  assert.doesNotMatch(source, /showcase\.fs_log/);
  assert.ok(Buffer.byteLength(source) <= 32768);
});

test('snapshot parses exact log size and pinned source', () => {
  const result = parseReply(reply(), {nonce, expectedLoggerHash});
  assert.equal(result.readonly.freeBytes, 16367616);
  assert.equal(result.readonly.absentPathResult, '0x00000202');
  assert.equal(result.log.sizeBytes, 4096);
  assert.equal(result.log.phaseSizeBytes, 11);
  assert.equal(result.log.sourcePinned, true);
});

test('snapshot refuses changed logger source and malformed measurements', () => {
  assert.throws(() => parseReply(reply(), {nonce,
    expectedLoggerHash: '0'.repeat(64)}), /logger source differs/);
  assert.throws(() => parseReply(reply({logSize: -1}),
    {nonce, expectedLoggerHash}), /incomplete/);
  assert.throws(() => parseReply(reply({free: 1}),
    {nonce, expectedLoggerHash}), /invalid sizes/);
  assert.throws(() => parseReply(reply({sourceHex: 'aa'}),
    {nonce, expectedLoggerHash}), /incomplete/);
});

test('snapshot stops on a pre-source pinned FS failure', () => {
  assert.throws(() => parseReply(`-> BAL_FS_READONLY_V1\tfail\t${nonce}\tidentity\n`,
    {nonce, expectedLoggerHash}), /read-only probe failed: identity/);
});

test('snapshot validates IPv4 and nonce generator before RPC', async () => {
  await assert.rejects(takeSnapshot({host: 'not-an-ip'}), /IPv4/);
  await assert.rejects(takeSnapshot({host: '10.0.0.189',
    nonceBytes: () => Buffer.alloc(7), execute: async () => 'unexpected'}),
  /nonce source/);
});
