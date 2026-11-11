const fs = require('node:fs/promises');
const path = require('node:path');
const {live, check} = require("./session.cjs");
const {loadTarget, required} = require('../../shared/target.cjs');
const target = loadTarget();
const code = require("./timing-code.json").functions;
const nativeFrequencyCode = target.timing.nativeFrequencyCode || null;

async function verify(s) {
  for (const [name, expected] of Object.entries(code))
    await s.verifyCode(expected, 'Timing ' + name);
  if (target.timing.mode === 'measured') {
    const legacyFrequency = await s.rpc.call3(live.sdk + code.frequency.offset, 0, 0, 0);
    check(legacyFrequency === target.timing.sdkFrequency, 'Unexpected legacy SDK counter frequency');
    const sleep = require('./thread-code.json').functions.sleep;
    await s.verifyCode(sleep, 'Timing sleep');
    const measurementNs = target.timing.measurementNs;
    check(Number.isSafeInteger(measurementNs) && measurementNs >= 100000000,
      'Invalid counter measurement interval');
    const start = await s.rpc.call3(live.sdk + code.tick.offset, 0, 0, 0);
    await s.rpc.call3(live.sdk + sleep.offset, measurementNs, 0, 0);
    const end = await s.rpc.call3(live.sdk + code.tick.offset, 0, 0, 0);
    const elapsedTicks = Number(BigInt.asUintN(32, BigInt(end) - BigInt(start)));
    const measuredFrequency = elapsedTicks * 1e9 / measurementNs;
    const tolerance = target.timing.nativeFrequency * target.timing.tolerancePpm / 1e6;
    check(Number.isFinite(measuredFrequency) &&
      Math.abs(measuredFrequency - target.timing.nativeFrequency) <= tolerance,
    `Measured counter frequency ${measuredFrequency} differs from ${target.timing.nativeFrequency}`);
    await s.record({operation: 'counterFrequency', mode: 'measured', frequency: target.timing.nativeFrequency,
      measuredFrequency, legacyFrequency, measurementNs, elapsedTicks, tolerancePpm: target.timing.tolerancePpm});
    return target.timing.nativeFrequency;
  }
  if (target.timing.mode === 'sdk') {
    const frequency = await s.rpc.call3(live.sdk + code.frequency.offset, 0, 0, 0);
    check(frequency === target.timing.sdkFrequency && frequency === target.timing.nativeFrequency,
      'Unexpected SDK counter frequency');
    await s.record({operation: 'counterFrequency', mode: 'sdk', frequency});
    return frequency;
  }
  check(target.timing.mode === 'native-module', `Unsupported timing verification mode: ${target.timing.mode}`);
  const moduleBytes = BigInt(required(target.timing.nativeModuleBytes, `${target.name} timing module size`));
  const frequencyCode = required(nativeFrequencyCode, `${target.name} native frequency function`);
  const map = JSON.parse(await fs.readFile(path.join(__dirname, 'memory-map.json'), 'utf8'));
  check(map.session === live.session && map.complete, 'Fresh memory map is missing');
  const candidates = map.regions.filter(region => region.permissions === 5 && BigInt(region.size) === moduleBytes);
  check(candidates.length === 1, 'Native compatibility module is not uniquely identified');
  const base = Number(BigInt(candidates[0].address));
  const region = await s.rpc.query(base);
  check(!region.result && region.permissions === 5 && Number(BigInt(region.address)) === base &&
    BigInt(region.size) === moduleBytes, 'Native module mapping changed');
  const address = base + frequencyCode.offset;
  const expected = Buffer.from(frequencyCode.bytes, 'hex');
  check((await s.read(address, expected.length)).equals(expected),
    'Native frequency instructions differ from the captured module');
  await s.rpc.verifyFunction(address, frequencyCode.bytes);
  const frequency = await s.rpc.call3(address, 0, 0, 0);
  const legacyFrequency = await s.rpc.call3(live.sdk + code.frequency.offset, 0, 0, 0);
  check(frequency === target.timing.nativeFrequency && legacyFrequency === target.timing.sdkFrequency,
    'Unexpected counter frequencies');
  await s.record({operation: 'counterFrequency', nativeModule: base, address, frequency, legacyFrequency,
    instructionBytes: frequencyCode.bytes});
  return frequency;
}

module.exports = {verify, code, nativeFrequencyCode};
