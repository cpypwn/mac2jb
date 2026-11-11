// Set only owned parked workers to a CPU allowed for this process.
const {live, check, u64} = require("./session.cjs");
const {loadTarget} = require('../../shared/target.cjs');
const {rawSvc} = require("./worker.cjs");
const target = loadTarget();
const rawMode = target.thread?.mode === 'raw-svc';
const reference = require("./thread-scheduling-reference.json").functions;
const compat = require("./compat-affinity-reference.json");
const availableName = 'nn::os::GetThreadAvailableCoreMask()';
const currentName = 'nn::os::GetCurrentCoreNumber()';
const setMaskName = 'nn::os::SetThreadCoreMask(nn::os::ThreadType*, int, unsigned long)';
const getMaskName = 'nn::os::GetThreadCoreMask(int*, unsigned long*, nn::os::ThreadType const*)';

async function verify(s) {
  if (s.affinityCodeVerified) return;
  if (rawMode) {
    // Raw threads have no ThreadType; the nn::os affinity wrappers and the
    // pseudo-handle based available-mask query do not apply. The raw svc
    // wrappers are verified with the worker code.
    check(rawSvc?.functions?.setThreadCoreMask && rawSvc?.functions?.getThreadCoreMask &&
      rawSvc?.functions?.getCurrentProcessorNumber, 'Missing raw-svc affinity signatures');
    for (const name of ['setThreadCoreMask', 'getThreadCoreMask', 'getCurrentProcessorNumber'])
      await s.verifyCode(rawSvc.functions[name], 'Raw svc affinity ' + name);
    s.affinityCodeVerified = true;
    return;
  }
  const workerNames = target.affinity.mode === 'direct' ? [setMaskName, getMaskName] :
    ['pthread_getaffinity_np', 'pthread_setaffinity_np'];
  for (const name of [...workerNames, availableName, currentName,
    'nn::os::detail::ThreadManagerImplByHorizon::GetThreadAvailableCoreMask() const',
    'nn::os::detail::ThreadManagerImplByHorizon::GetCurrentCoreNumber() const']) {
    const expected = reference[name];
    check(expected, `Missing affinity function ${name}`);
    await s.verifyCode(expected, 'Thread affinity ' + name);
  }
  if (target.affinity.mode === 'compat') {
    await s.verifyCode(compat.import, 'SDK affinity import');
    const wrapperTarget = Number((await s.read(live.sdk + compat.gotOffset, 8)).readBigUInt64LE());
    check(Number.isSafeInteger(wrapperTarget) && wrapperTarget > 0 &&
      (await s.read(wrapperTarget, compat.target.size)).toString('hex') === compat.target.bytes,
      'The compatibility affinity wrapper differs');
    check((await s.read(wrapperTarget + compat.symbolOffsetFromTarget, compat.symbol.length + 1)).toString() === compat.symbol + '\0',
      'The compatibility wrapper resolves a different function');
  } else check(target.affinity.mode === 'direct', `Unsupported affinity mode: ${target.affinity.mode}`);
  s.affinityCodeVerified = true;
}

async function available(s) {
  await verify(s);
  if (rawMode) {
    if (!s.affinityMasks) {
      const scheduling = await require("./native-worker.cjs").borrowScheduling(s);
      const mask = scheduling.borrowedCores.reduce((value, core) => value | (1n << BigInt(core)), 0n);
      check(mask > 0n, 'Raw threads have no borrowed CPU cores');
      s.affinityMasks = {mode: 'raw-svc', processMask: mask.toString(), sdkMask: mask.toString()};
      await s.record({operation: 'availableCoreMasks', ...s.affinityMasks});
    }
    return BigInt(s.affinityMasks.sdkMask);
  }
  if (!s.affinityMasks) {
    const processMask = await s.rpc.call3(live.sdk + reference[availableName].offset, 0, 0, 0);
    const sdkMask = target.affinity.mode === 'direct' ? processMask :
      await s.rpc.call3(live.sdk + compat.import.offset, 0, 0, 0);
    check([processMask, sdkMask].every(mask => Number.isSafeInteger(mask) && mask > 0 && mask < 2 ** 32) &&
      (BigInt(sdkMask) & BigInt(processMask)) === BigInt(sdkMask), 'Unexpected available CPU masks');
    s.affinityMasks = {mode: target.affinity.mode, processMask: String(processMask), sdkMask: String(sdkMask)};
    await s.record({operation: 'availableCoreMasks', ...s.affinityMasks});
  }
  return BigInt(s.affinityMasks.sdkMask);
}

function currentCoreCall() {
  const offset = rawMode ? rawSvc.functions.getCurrentProcessorNumber.offset : reference[currentName].offset;
  return {kind: 'core', function: live.sdk + offset, args: [0, 0, 0, 0]};
}

async function get(s, worker) {
  check(s.threads.has(worker.thread), 'Affinity query requires an owned worker');
  await verify(s);
  const output = s.base + 0x2800;
  if (rawMode) {
    await s.write(output, Buffer.alloc(16));
    check(await s.rpc.call3(live.sdk + rawSvc.functions.getThreadCoreMask.offset,
      output, output + 8, worker.thread) === 0, 'Worker affinity query failed');
    const mask = (await s.readOwned(output + 8, 8)).readBigUInt64LE();
    check(mask > 0n, 'Worker has no allowed CPU cores');
    return mask;
  }
  if (target.affinity.mode === 'direct') {
    await s.write(output, Buffer.alloc(16));
    check(!await s.rpc.call3(live.sdk + reference[getMaskName].offset,
      output, output + 8, worker.thread), 'Worker affinity query failed');
    const mask = (await s.readOwned(output + 8, 8)).readBigUInt64LE();
    check(mask > 0n, 'Worker has no allowed CPU cores');
    return mask;
  }
  await s.write(output, Buffer.alloc(8));
  check(!await s.rpc.call3(live.sdk + reference.pthread_getaffinity_np.offset,
    worker.thread, 8, output), 'Worker affinity query failed');
  const mask = (await s.readOwned(output, 8)).readBigUInt64LE();
  check(mask > 0n, 'Worker has no allowed CPU cores');
  return mask;
}

async function pin(s, worker, mask) {
  const before = await get(s, worker);
  const allowed = await available(s);
  check(mask > 0n && (mask & (mask - 1n)) === 0n && (mask & allowed) === mask,
    'Choose one CPU allowed for this process');
  let result;
  if (rawMode) {
    result = await s.rpc.call3(live.sdk + rawSvc.functions.setThreadCoreMask.offset,
      worker.thread, 0xffffffff, mask);
  } else if (target.affinity.mode === 'direct') {
    result = await s.rpc.call3(live.sdk + reference[setMaskName].offset, worker.thread, 0xffffffff, mask);
  } else {
    const input = s.base + 0x2800;
    await s.write(input, u64(mask));
    result = await s.rpc.call3(live.sdk + reference.pthread_setaffinity_np.offset, worker.thread, 8, input);
  }
  await s.record({operation: 'workerAffinitySet', label: worker.label, thread: worker.thread,
    mode: rawMode ? 'raw-svc' : target.affinity.mode, before: before.toString(), requested: mask.toString(), result});
  check(!result, 'Worker affinity update failed: ' + result);
  check(await get(s, worker) === mask, 'Worker affinity readback differs');
  await s.record({operation: 'workerAffinity', label: worker.label, thread: worker.thread,
    before: before.toString(), after: mask.toString()});
  return {before: before.toString(), after: mask.toString()};
}

async function pinAll(s, workers, masks) {
  check(workers.length === masks.length && workers.length <= 32, 'Invalid worker affinity list');
  for (let i = 0; i < workers.length; i++) await pin(s, workers[i], masks[i]);
}

module.exports = {verify, available, currentCoreCall, get, pin, pinAll};
