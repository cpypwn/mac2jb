const assert = require('node:assert/strict');
const test = require('node:test');
const {makeSource, parseReply} = require('./qualify-timing.cjs');
const profile = require('./profile.v1.2.1.json');

const nonce = '0123456789abcdef';
const valid = `-> GC_TIMING_V2\tok\t19200000\t31264192\taccept\t305418240\t591749120\t${profile.sdkCrc32}\t${nonce}\n`;

test('Gravity Circuit timing qualification bounds its sleep and pins the captured calls', () => {
  assert.throws(() => makeSource(1000000001), /between 100 ms and 1 s/);
  assert.throws(() => makeSource(99999999), /between 100 ms and 1 s/);
  const source = makeSource(1000000000, nonce);
  assert.match(source, /LS\.fs_bridge\.stage=='accept'/);
  assert.match(source, /\{1214048,\{32,224,59,213,192,3,95,214\}\}/);
  assert.match(source, /\{1213728,\{60,98,18,20\}\}/);
  assert.match(source, /call\(1213728,\{1000000000\}\)/);
  assert.match(source, new RegExp(nonce));
  assert.match(source, /LS\.fs_bridge\.profile\.sdkCrc32/);
});

test('Gravity Circuit timing qualification rejects a wrong frequency or failed call', () => {
  const proof = parseReply(valid, 1000000000, nonce);
  assert.equal(proof.nativeFrequency, 31250000);
  assert.equal(proof.sdkBase, 305418240);
  assert.equal(proof.scratch, 591749120);
  assert.equal(proof.nonce, nonce);
  assert.throws(() => parseReply(valid.replace('31264192', '19200000')), /counter frequency differs/);
  assert.throws(() => parseReply('-> GC_TIMING_V2\tfail\tfunction-bytes\n'), /failed/);
  assert.throws(() => parseReply(valid, 1000000000, 'ffffffffffffffff'), /counter frequency differs/);
  assert.throws(() => parseReply(valid.replace(String(profile.sdkCrc32), '1')), /counter frequency differs/);
});
