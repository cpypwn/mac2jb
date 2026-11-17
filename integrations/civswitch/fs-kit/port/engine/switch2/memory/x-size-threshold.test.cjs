'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {pathPacket} = require('./paths.cjs');
const threshold = require('./x-size-threshold.cjs');

test('same early-NUL source is used for each bounded X size', () => {
  const bytes = threshold.requestBytes('/NS2_GAP_123/SPAN_MARKER');
  assert.equal(bytes.length, threshold.SOURCE_BYTES);
  assert.equal(bytes.indexOf(0), '/NS2_GAP_123/SPAN_MARKER'.length);
  for (const size of [...threshold.SIZES, threshold.MIDPOINT]) {
    const packet = threshold.diagnosticPacket(0x123456789n, size);
    assert.equal(packet.readUInt32LE(8) >>> 16, size);
    assert.equal(packet.readUInt32LE(12), 0x23456789);
  }
  assert.throws(() => pathPacket(7, Buffer.alloc(0), 0x123456789n, 0x801),
    /Invalid path descriptor size/);
  assert.throws(() => threshold.diagnosticPacket(0x123456789n, 0x1000),
    /threshold size/);
});

test('short-path queries distinguish IPC transport failure from a file lookup', async () => {
  const sent = [], recorded = [];
  const reply = Buffer.alloc(256);
  reply.writeUInt32LE(4, 0);
  reply.write('SFCO', 16);
  reply.writeUInt32LE(1, 32);
  let transport = 0;
  const session = {
    base: 0x1000,
    async write(address, bytes) {
      assert.equal(address, 0x1000);
      sent.push(Buffer.from(bytes));
    },
    async call(name, address, capacity, handle) {
      assert.deepEqual([name, address, capacity, handle], ['send', 0x1000, 4096, 42]);
      return transport;
    },
    async record(entry) {recorded.push(entry);},
    async readOwned(address, size) {
      assert.deepEqual([address, size], [0x1000, 256]);
      return reply;
    },
  };
  assert.deepEqual(await threshold.query(session, 42, 0x23456789n, 0x800),
    {size: 0x800, transport: 0, result: 0, type: 1});
  transport = 0xce01;
  assert.deepEqual(await threshold.query(session, 42, 0x23456789n, 0x801),
    {size: 0x801, transport, result: null, type: null});
  assert.equal(sent.length, 2);
  assert.equal(sent[0].length, 256);
  assert.equal(sent[0].readUInt32LE(8) >>> 16, 0x800);
  assert.equal(sent[1].readUInt32LE(8) >>> 16, 0x801);
  sent[0].writeUInt32LE(sent[1].readUInt32LE(8), 8);
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(recorded.map(item => item.transport), [0, 0xce01]);
});

test('report requires the ordinary 0x800 control and clean shutdown', () => {
  const observations = [
    {size: 0x800, transport: 0, result: 0, type: 1},
    {size: 0x801, transport: 0xce01, result: null, type: null},
  ];
  const report = {session: 'boot', target: 'gravcirc',
    xSizeThresholdEnabled: true, completed: true, cleanedUp: true, cases: [],
    xSizeThreshold: {mode: 'owned-short-path', completed: true,
      before: {result: 0, type: 1}, after: {result: 0, type: 1}, observations},
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false}};
  assert.deepEqual(threshold.verifyReport(report, 'boot'),
    {diagnostic: 'x-descriptor-threshold', session: 'boot', observations,
      cleanedUp: true});
  assert.throws(() => threshold.verifyReport({...report, cleanedUp: false}, 'boot'),
    /finish cleanly/);
  assert.throws(() => threshold.verifyReport({...report, retained: {...report.retained,
    handles: [1]}}, 'boot'), /retained resources/);
  assert.throws(() => threshold.verifyReport({...report, xSizeThreshold: {
    ...report.xSizeThreshold, observations: [{...observations[0], type: 2}, observations[1]]}},
  'boot'), /controls did not verify/);
  assert.throws(() => threshold.verifyReport({...report, xSizeThreshold: {
    ...report.xSizeThreshold, observations: [...observations,
      {size: 0xc00, transport: 0, result: 0, type: 1}]}}, 'boot'),
  /controls did not verify/);
});
