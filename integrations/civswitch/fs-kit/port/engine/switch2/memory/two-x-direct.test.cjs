'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {dataStart} = require('../../shared/domain.cjs');
const diagnostic = require('./two-x-direct.cjs');

const scratch = '/NS2_GAP_1234567890123';
const segments = ['S0_1234567890123', 'S1_1234567890123', 'S2_1234567890123'];

test('matched sources share exactly one owned directory prefix', () => {
  const source = diagnostic.sources(scratch, segments);
  assert.equal(source.prefix.length, 0x800);
  assert.equal(source.prefix.at(-1), '/'.charCodeAt());
  assert.equal(source.prefix.indexOf(0), -1);
  assert.equal(source.prefixControl.length, 0x800);
  assert.equal(source.prefixControl.at(-1), 0);
  assert.ok(source.prefixControl.subarray(0, 0x7ff)
    .equals(source.prefix.subarray(0, 0x7ff)));
  assert.equal(source.prefixPath, scratch + '/' + segments.join('/'));
  assert.equal(source.tails.marker.toString(), 'SPAN_MARKER\0');
  assert.equal(source.tails.absent.toString(), 'SPAN_ABSENT\0');
  assert.deepEqual(source.tails.terminator, Buffer.from([0]));
  assert.equal(source.tails.marker.length, source.tails.absent.length);
  assert.equal(source.markerPath, source.prefixPath + '/SPAN_MARKER');
  assert.equal(source.absentPath, source.prefixPath + '/SPAN_ABSENT');
});

test('prefix-only and two-X command 7 packets retain legal descriptors', () => {
  const prefix = diagnostic.request(0x123456789n);
  const pair = diagnostic.request(0x123456789n, 0x123457000n);
  const terminated = diagnostic.request(0x123456789n, 0x123457000n, 1);
  assert.equal(prefix.length, 256);
  assert.equal(pair.length, 256);
  assert.equal(prefix.readUInt32LE(0), 0x10004);
  assert.equal(pair.readUInt32LE(0), 0x20004);
  assert.equal(prefix.readUInt32LE(8) >>> 16, 0x800);
  assert.equal(pair.readUInt32LE(8) >>> 16, 0x800);
  assert.equal(pair.readUInt32LE(16) >>> 16, diagnostic.TAIL_BYTES);
  assert.equal(terminated.readUInt32LE(16) >>> 16, 1);
  assert.equal(pair.readUInt32LE(12), 0x23456789);
  assert.equal(pair.readUInt32LE(20), 0x23457000);
  assert.equal(dataStart(prefix), 16);
  assert.equal(dataStart(pair), 32);
  assert.equal(prefix.toString('ascii', 16, 20), 'SFCI');
  assert.equal(pair.toString('ascii', 32, 36), 'SFCI');
  assert.equal(prefix.readUInt32LE(24), 7);
  assert.equal(pair.readUInt32LE(40), 7);
});

test('no-race query records transport separately from CMIF response', async () => {
  const source = diagnostic.sources(scratch, segments);
  const writes = [], records = [];
  let transport = 0, result = 0, type = 0;
  const session = {
    base: 0x100000,
    async write(address, bytes) {writes.push({address, bytes: Buffer.from(bytes)});},
    async call(name, address, size, handle) {
      assert.deepEqual([name, address, size, handle], ['send', session.base, 4096, 42]);
      return transport;
    },
    async record(row) {records.push(row);},
    async readOwned(address, size) {
      assert.deepEqual([address, size], [session.base, 256]);
      const reply = Buffer.alloc(256);
      reply.writeUInt32LE(4);
      reply.write('SFCO', 16);
      reply.writeUInt32LE(result, 24);
      reply.writeUInt32LE(type, 32);
      return reply;
    },
  };
  const prefix = await diagnostic.query(session, 42, 0x104000, 0x105000, source, 'prefix');
  assert.deepEqual(prefix, {kind: 'prefix', transport: 0, result: 0, type: 0});
  assert.equal(writes.length, 2);
  assert.equal(writes[0].bytes.length, 0x800);
  assert.ok(writes[0].bytes.equals(source.prefixControl));
  assert.equal(writes[1].bytes.readUInt32LE(0), 0x10004);
  const terminated = await diagnostic.query(session, 42, 0x104000, 0x105000,
    source, 'terminator');
  assert.deepEqual(terminated, {kind: 'terminator', transport: 0, result: 0, type: 0});
  assert.equal(writes.length, 5);
  assert.ok(writes[2].bytes.equals(source.prefix));
  assert.deepEqual(writes[3].bytes, Buffer.from([0]));
  assert.equal(writes[4].bytes.readUInt32LE(16) >>> 16, 1);
  result = 0x202;
  const absent = await diagnostic.query(session, 42, 0x104000, 0x105000, source, 'absent');
  assert.deepEqual(absent, {kind: 'absent', transport: 0, result: 0x202, type: null});
  assert.equal(writes.length, 8);
  assert.ok(writes[5].bytes.equals(source.prefix));
  assert.equal(writes[6].bytes.toString(), 'SPAN_ABSENT\0');
  assert.equal(writes[7].bytes.readUInt32LE(0), 0x20004);
  transport = 0xce01;
  const marker = await diagnostic.query(session, 42, 0x104000, 0x105000, source, 'marker');
  assert.deepEqual(marker, {kind: 'marker', transport, result: null, type: null});
  assert.deepEqual(records.filter(row => row.transport !== undefined)
    .map(row => row.transport), [0, 0, 0, 0xce01]);
  assert.deepEqual(records.filter(row => row.operation.endsWith('CMIF'))
    .map(row => [row.result, row.type]), [[0, 0], [0, 0], [0x202, null]]);
});

test('report requires exact direct controls and clean released resources', () => {
  const controls = {marker: {result: 0, type: 1},
    absent: {result: 0x202, type: null}, prefix: {result: 0, type: 0}};
  const observations = [
    {kind: 'prefix', transport: 0, result: 0, type: 0},
    {kind: 'terminator', transport: 0, result: 0, type: 0},
    {kind: 'marker', transport: 0, result: 0, type: 0},
    {kind: 'absent', transport: 0, result: 0, type: 0},
  ];
  const report = {session: 'boot', target: 'gravcirc', twoXDirectEnabled: true,
    completed: true, cleanedUp: true, cases: [],
    twoXDirect: {mode: 'owned-prefix-two-x', status: 'path-comparison-completed',
      completed: true,
      before: controls, after: controls, observations},
    retained: {base: 0, handles: [], threads: [], created: [], group: null,
      cacheNeedsRestore: false, released: true}};
  assert.deepEqual(diagnostic.verifyReport(report, 'boot'),
    {diagnostic: 'two-x-direct', session: 'boot',
      status: 'path-comparison-completed', transportResult: null,
      parserOutcome: 'observed', observations, cleanedUp: true});
  const rejected = {...report, twoXDirect: {...report.twoXDirect,
    status: 'transport-rejected-two-x',
    transportResult: diagnostic.TWO_X_TRANSPORT_REJECTION,
    observations: [observations[0], {kind: 'terminator',
      transport: diagnostic.TWO_X_TRANSPORT_REJECTION, result: null, type: null}]}};
  assert.deepEqual(diagnostic.verifyReport(rejected, 'boot'),
    {diagnostic: 'two-x-direct', session: 'boot',
      status: 'transport-rejected-two-x',
      transportResult: diagnostic.TWO_X_TRANSPORT_REJECTION,
      parserOutcome: 'unmeasured',
      observations: rejected.twoXDirect.observations, cleanedUp: true});
  assert.throws(() => diagnostic.verifyReport({...rejected,
    twoXDirect: {...rejected.twoXDirect, observations: [...rejected.twoXDirect.observations,
      observations[2]]}}, 'boot'), /transport or path-comparison/);
  assert.throws(() => diagnostic.verifyReport({...rejected,
    twoXDirect: {...rejected.twoXDirect, transportResult: 0}}, 'boot'),
  /transport or path-comparison/);
  assert.throws(() => diagnostic.verifyReport({...report, cleanedUp: false}, 'boot'),
    /did not finish cleanly/);
  assert.throws(() => diagnostic.verifyReport({...report, retained: {...report.retained,
    created: [{path: scratch}]}}, 'boot'), /retained resources/);
  assert.throws(() => diagnostic.verifyReport({...report, retained: {...report.retained,
    released: false}}, 'boot'), /retained resources/);
  assert.throws(() => diagnostic.verifyReport({...report, twoXDirect: {...report.twoXDirect,
    before: {...controls, prefix: {result: 0x202, type: null}}}}, 'boot'),
  /owned-path controls/);
});
