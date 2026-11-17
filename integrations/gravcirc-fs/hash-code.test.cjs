const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const qualified = require('./sdk-sha256.v1.2.1.json');
const runtime = require('../civswitch/fs-kit/port/gravcirc-app/hash-code.json');
const profileDir = process.env.GC_PROFILE_DIR;

test('Gravity Circuit runtime hash artifact contains the live-qualified SHA-256 function', () => {
  assert.equal(qualified.liveVerified, true);
  assert.equal(qualified.liveQualification.vectorsMatched, 2);
  assert.equal(qualified.liveQualification.outputGuardsIntact, true);
  assert.equal(qualified.liveQualification.inputsUnchanged, true);
  assert.equal(qualified.liveQualification.fsBridgeStageAfter, 'accept');
  assert.equal(runtime.offset, qualified.function.offset);
  assert.equal(runtime.bytes, qualified.function.bytes);
  assert.equal(runtime.size, qualified.function.size);
  assert.equal(runtime.sha256, qualified.function.sha256);
  assert.equal(runtime.dynamicSymbol, qualified.function.sourceSymbol);
  assert.equal(runtime.dumpSha256, qualified.sdkCode.sha256);
  assert.equal(runtime.qualification,
    'integrations/gravcirc-fs/sdk-sha256.v1.2.1.json');
});

test('Gravity Circuit runtime hash artifact matches the captured SDK bytes', t => {
  const file = profileDir ? path.join(profileDir, 'sdk-v1.2.1-code.bin') : null;
  if (!file || !fs.existsSync(file)) {
    t.skip('set GC_PROFILE_DIR to the captured Gravity Circuit SDK dump directory');
    return;
  }
  const sdk = fs.readFileSync(file);
  assert.equal(sdk.length, qualified.sdkCode.size);
  assert.equal(crypto.createHash('sha256').update(sdk).digest('hex'), runtime.dumpSha256);
  const functionBytes = sdk.subarray(runtime.offset, runtime.offset + runtime.size);
  assert.equal(functionBytes.toString('hex'), runtime.bytes);
  assert.equal(crypto.createHash('sha256').update(functionBytes).digest('hex'), runtime.sha256);
});
