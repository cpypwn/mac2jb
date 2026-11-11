const crypto = require('node:crypto');
const {assertAppSupported, nativeEntry, required} = require('../shared/target.cjs');

async function qualify(native) {
  const a = native.addresses, target = native.target;
  assertAppSupported(target);
  const check = (ok, message) => {if (!ok) throw Error(message);};
  const proof = {started: new Date().toISOString(), platform: a.platform, target: target.name};
  const mapping = target.sdkMapping;
  const code = await native.query(a.sdk);
  check(code.address === BigInt(a.sdk) && code.size === BigInt(target.sdkBytes) && code.type === mapping.type &&
    code.permissions === mapping.permissions && code.attributes === mapping.attributes, 'The SDK mapping differs');
  const transportEntries = ['memcpy', 'memmove', 'queryMemory'].map(name => nativeEntry(name, target));
  const crcEntry = target.crc32.function ? nativeEntry('crc32', {...target,
    nativeFunctions: {...target.nativeFunctions, crc32: target.crc32.function}}) : {offset: target.crc32.offset};
  for (const entry of [...transportEntries, crcEntry]) {
    if (entry.bytes) await native.verifyFunction(a.sdk + entry.offset, Buffer.from(entry.bytes, 'hex'));
  }
  const crc = await native.call(crcEntry.offset, 0, a.sdk, target.sdkBytes);
  check(crc.result === BigInt(required(target.crc32.expected, `${target.name} SDK CRC-32`)),
    `${target.displayName} SDK checksum differs`);
  const slot = a.scratch + 0x10000;
  const saved = await native.read(slot, 64);
  const marker = crypto.randomBytes(64);
  let written = false;
  try {
    await native.write(slot, marker);
    written = true;
    check((await native.read(slot, marker.length)).equals(marker), 'Fresh memory challenge failed');
    proof.memoryChallenge = marker.toString('hex');
  } finally {
    if (written && !native.connection.error) {
      await native.write(slot, saved);
      check((await native.read(slot, saved.length)).equals(saved), 'Scratch restoration failed');
      proof.scratchRestored = true;
    }
  }
  if (target.importRestoration) {
    required(target.hello.gotOffsetFromMain, `${target.name} GOT offset`);
    check(a.got === a.main + target.hello.gotOffsetFromMain &&
      (await native.read(a.got, 8)).readBigUInt64LE() === BigInt(a.memmove),
    'The native call did not restore its import');
    proof.importRestored = true;
  }
  if (target.keepAwake.enabled) {
    const keepAwake = target.keepAwake, offset = keepAwake.activityReportOffset;
    const expected = Buffer.from(keepAwake.activityReportBytes, 'hex');
    check((await native.read(a.sdk + offset, expected.length)).equals(expected),
      'Activity-report instructions differ');
    const controller = Number((await native.call(keepAwake.controllerGetterOffset)).result);
    check(Number.isSafeInteger(controller) && controller > 0 && controller < 2 ** 39 && controller % 8 === 0,
      'Invalid application controller');
    const table = Number((await native.read(controller, 8)).readBigUInt64LE());
    check(table === a.sdk + keepAwake.controllerVtableOffset &&
      (await native.read(table + keepAwake.activityVtableEntryOffset, 8)).readBigUInt64LE() === BigInt(a.sdk + offset),
      'Activity-report interface differs');
    check((await native.call(offset, controller)).result === 0n, 'Activity report failed');
    proof.activity = {offset, controller};
  } else {
    proof.activity = null;
    proof.keepAwake = 'disabled by target configuration; memmove heartbeat remains enabled';
  }
  proof.verified = true;
  proof.completed = new Date().toISOString();
  return proof;
}

module.exports = {qualify};
