const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const timing = require('./sdk-timing.v1.2.1.json');
const profileDir = process.env.GC_PROFILE_DIR;

function symbolOffsets(dynsym, dynstr) {
  const found = new Map();
  for (let at = 0; at + 24 <= dynsym.length; at += 24) {
    const nameOffset = dynsym.readUInt32LE(at);
    if (nameOffset >= dynstr.length) continue;
    const end = dynstr.indexOf(0, nameOffset);
    if (end < 0) continue;
    const name = dynstr.toString('utf8', nameOffset, end);
    const offset = Number(dynsym.readBigUInt64LE(at + 8));
    if (offset) found.set(name, offset);
  }
  return found;
}

test('Gravity Circuit timing entries match the captured SDK symbols and bytes', (t) => {
  const files = profileDir ?
    ['sdk-v1.2.1-code.bin', 'sdk-v1.2.1-dynsym.bin', 'sdk-v1.2.1-dynstr.bin']
      .map(name => path.join(profileDir, name)) : [];
  if (files.length !== 3 || files.some(file => !fs.existsSync(file))) {
    t.skip('set GC_PROFILE_DIR to the captured Gravity Circuit SDK dump directory');
    return;
  }
  const [code, dynsym, dynstr] = files.map(file => fs.readFileSync(file));
  assert.equal(code.length, timing.sdkCode.size);
  assert.equal(crypto.createHash('sha256').update(code).digest('hex'), timing.sdkCode.sha256);
  const symbols = symbolOffsets(dynsym, dynstr);
  for (const entry of Object.values(timing.functions)) {
    assert.equal(symbols.get(entry.sourceSymbol), entry.offset, entry.sourceSymbol);
    assert.equal(code.subarray(entry.offset, entry.offset + entry.bytes.length / 2).toString('hex'), entry.bytes);
  }
  const frequency = timing.functions.frequency;
  const first = code.readUInt32LE(frequency.offset);
  const second = code.readUInt32LE(frequency.offset + 4);
  assert.equal(first & 0xff800000, 0x52800000);
  assert.equal(second & 0xff800000, 0x72800000);
  assert.equal(((second >>> 5) & 0xffff) * 0x10000 + ((first >>> 5) & 0xffff), frequency.returnedHz);
  assert.equal(timing.nativeCounterHz, 31250000);
  for (const sample of timing.liveMeasurements) {
    assert.ok(Math.abs(sample.measuredHz - timing.nativeCounterHz) <
      timing.nativeCounterHz * 0.01);
  }
});
