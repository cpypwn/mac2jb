const assert = require('node:assert/strict');
const test = require('node:test');
const {artifact, makeSource, parseReply} = require('./qualify-crc.cjs');

test('Gravity Circuit CRC qualification pins the live SDK bytes and both expected checksums', () => {
  const source = makeSource();
  assert.match(source, /info\.profile=="gravity-circuit-v1\.2\.1"/);
  assert.match(source, /info\.sdk_base\+458576/);
  assert.match(source, /6148096/);
  assert.match(source, /3421780262/);
  assert.match(source, /4209895763/);
  assert.equal(artifact.function.bytes, 'e203022a5f301514');
});

test('Gravity Circuit CRC qualification rejects failed or inconsistent native results', () => {
  const valid = '-> GC_CRC_V1\tok\t0x7893381000\tcbf43926\tfaede953\taccept\n';
  assert.equal(parseReply(valid).sdkCrc32, 'faede953');
  assert.throws(() => parseReply(valid.replace('faede953', 'faede952')), /wrong checksum/);
  assert.throws(() => parseReply('-> GC_CRC_V1\tfail\tvector-result:0\n'), /failed/);
  assert.throws(() => parseReply('-> GC_CRC_V1\tok\t0x0\tcbf43926\n'), /incomplete/);
});
