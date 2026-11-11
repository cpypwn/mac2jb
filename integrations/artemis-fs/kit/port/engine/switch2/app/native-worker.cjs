// Variable-size original-SDK worker frames. All memory belongs to this Session.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {live, check} = require("./session.cjs");
const {nativeHash} = require("./filesystem.cjs");
const {code, directNnOs, rawSvc, managerListRecovery, SENTINEL} = require("./worker.cjs");
const {build} = require('../../shared/frames.cjs');
const {loadTarget, nativeOffset} = require('../../shared/target.cjs');
const target = loadTarget(), memcpyOffset = nativeOffset('memcpy', target);
const directMode = target.thread?.mode === 'direct-nnos';
const enumerateMode = target.thread?.mode === 'pthread-enumerate';
const rawMode = target.thread?.mode === 'raw-svc';
const directCode = directNnOs?.functions;
const rawCode = rawSvc?.functions;

const align = n => Math.ceil(n / 4096) * 4096;
function capacity(calls) {
  const count = calls.reduce((n, call) => n + 1 + call.args.filter(a => typeof a === 'object').length, 0);
  return align(0x20000 + count * 0x300);
}

async function writeSparse(s, address, bytes) {
  check(address % 8 === 0 && bytes.length % 8 === 0 && address >= s.base && address + bytes.length <= s.base + s.bytes,
    'Sparse write is outside the owned allocation');
  // start() has already cleared the whole allocation. Send only occupied
  // pages; the native hash below still checks every byte, including zeroes.
  let first = null;
  for (let offset = 0; offset <= bytes.length; offset += 4096) {
    const occupied = offset < bytes.length && bytes.subarray(offset, offset + 4096).some(Boolean);
    if (occupied && first === null) first = offset;
    if (!occupied && first !== null) {
      await s.write(address + first, bytes.subarray(first, offset));
      first = null;
    }
  }
}

async function start(s, base, limit, slot, calls, label, snapshot = 0, threadMemory = null) {
  check(base % 4096 === 0 && base >= s.base && base + limit <= s.base + s.bytes, 'Worker frame is outside allocation');
  check(slot % 8 === 0 && slot >= s.base && slot + 16 <= base, 'Worker output slot overlaps its frame');
  const plan = path.join(__dirname, label + '-plan.json'), filename = path.join(__dirname, label + '-frame.bin');
  await fs.writeFile(plan, JSON.stringify({base, sdk: live.sdk, calls}) + '\n');
  const {frame, proof} = build(base, live.sdk, calls, code, false, target);
  await fs.writeFile(filename, frame, {flag: 'wx', mode: 0o600});
  check(frame.length === proof.bytes && frame.length <= limit, 'Worker frame exceeds reserved space');
  if (directMode) {
    check(threadMemory && Number.isInteger(threadMemory.object) && Number.isInteger(threadMemory.stack) &&
      threadMemory.stackBytes === target.thread.stackBytes,
    'Direct worker requires an explicit thread object and stack');
    const {object, stack, stackBytes} = threadMemory;
    const regions = [[object, target.thread.objectBytes], [stack, stackBytes]];
    for (const [address, bytes] of regions) {
      check(address % 4096 === 0 && address >= s.base && address + bytes <= s.base + s.bytes,
        'Direct worker memory is outside allocation');
      check(address + bytes <= base || base + limit <= address, 'Direct worker memory overlaps its frame');
      if (snapshot) check(address + bytes <= snapshot || snapshot + frame.length <= address,
        'Direct worker memory overlaps its snapshot');
    }
    check(object + target.thread.objectBytes <= stack || stack + stackBytes <= object,
      'Direct thread object and stack overlap');
  }
  if (rawMode) {
    check(threadMemory && Number.isInteger(threadMemory.stack) &&
      threadMemory.stackBytes === target.thread.stackBytes,
    'Raw worker requires an explicit thread stack');
    const {stack, stackBytes} = threadMemory;
    check(stack % 4096 === 0 && stack >= s.base && stack + stackBytes <= s.base + s.bytes,
      'Raw worker stack is outside allocation');
    check(stack + stackBytes <= base || base + limit <= stack, 'Raw worker stack overlaps its frame');
    if (snapshot) check(stack + stackBytes <= snapshot || snapshot + frame.length <= stack,
      'Raw worker stack overlaps its snapshot');
  }
  await s.call('memset', base, 0, limit);
  await writeSparse(s, base, frame);
  const hash = crypto.createHash('sha256').update(frame).digest('hex');
  check(await nativeHash(s, base, frame.length) === hash, 'Full worker frame hash differs');
  if (snapshot) {
    check(snapshot >= base + limit && snapshot + frame.length <= s.base + s.bytes, 'Worker snapshot is outside allocation');
    await s.rpc.call3(live.sdk + memcpyOffset, snapshot, base, frame.length);
    check(await nativeHash(s, snapshot, frame.length) === hash, 'Worker snapshot differs');
  }
  await s.record({operation: 'workerPrepared', label, base, slot, ...proof, frameSha256: hash});
  return launch(s, {label, base, slot, calls, ...proof, snapshot, frameSha256: hash, threadMemory});
}

function validNodeAddress(value) {
  return Number.isSafeInteger(value) && value > 0 && value < 2 ** 39 && value % 8 === 0;
}

async function readQword(s, address, offset = 0) {
  return (await s.read(address + offset, 8)).readBigUInt64LE();
}

// Raw kernel threads have no ThreadType to carry scheduling parameters, so
// borrow a valid priority and the usable cores from live game threads through
// the nn::os manager list and the real handles stored at node+0x1B0.
async function borrowScheduling(s) {
  if (s.rawScheduling) return s.rawScheduling;
  const layout = rawSvc?.managerList;
  check(layout && rawCode?.getThreadPriority && rawCode?.getThreadCoreMask,
    'Missing raw-svc manager-list layout');
  const manager = Number(await readQword(s, live.sdk + layout.globalPointerOffset)) + layout.managerBias;
  check(validNodeAddress(manager), 'Invalid thread manager pointer');
  await s.read(manager, 0x1f0);
  const sentinel = manager + layout.listSentinelOffset;
  let node = Number(await readQword(s, sentinel));
  const seen = new Set();
  const out = s.base + 0x2800;
  const borrowed = new Set();
  let priority = 0;
  for (let count = 0; node !== sentinel && count < layout.maxNodes; count++) {
    check(validNodeAddress(node) && !seen.has(node), 'Invalid or cyclic manager-list node');
    seen.add(node);
    const bytes = await s.read(node, 0x1b8);
    const handle = bytes.readUInt32LE(layout.nodeHandleOffset);
    const next = Number(bytes.readBigUInt64LE(0));
    if (handle > 0 && handle < 0xffff8000) {
      check(await s.rpc.call3(live.sdk + rawCode.getThreadPriority.offset, out, handle, 0) === 0,
        'svcGetThreadPriority failed on a borrowed handle');
      const candidate = (await s.readOwned(out, 4)).readUInt32LE();
      check(await s.rpc.call3(live.sdk + rawCode.getThreadCoreMask.offset, out, out + 8, handle) === 0,
        'svcGetThreadCoreMask failed on a borrowed handle');
      const mask = (await s.readOwned(out + 8, 8)).readBigUInt64LE();
      if (candidate > 0 && candidate < 64 && mask > 0n) {
        if (!priority) priority = candidate;
        for (let bit = 0n; bit < 64n; bit++) if ((mask >> bit) & 1n) borrowed.add(Number(bit));
        if (priority && borrowed.size) break;
      }
    }
    node = next;
  }
  check(priority > 0, 'No valid borrowed thread priority');
  check(borrowed.size > 0, 'No valid borrowed thread cores');
  const cores = [...borrowed];
  for (const extra of rawSvc.fallbackCores || [])
    if (!cores.includes(extra)) cores.push(extra);
  s.rawScheduling = {priority, cores, borrowedCores: [...borrowed]};
  await s.record({operation: 'rawSchedulingBorrowed', priority, cores,
    borrowedCores: s.rawScheduling.borrowedCores, nodes: seen.size});
  return s.rawScheduling;
}

async function validateManagerLink(s, node) {
  const previous = Number(await readQword(s, node, 8));
  check(validNodeAddress(previous), 'Manager-list previous pointer is invalid');
  check(Number(await readQword(s, previous)) === node, 'Manager-list linkage changed');
}

async function recoverThread(s, frameBase) {
  check(managerListRecovery?.layout && managerListRecovery.guardedWalk, 'Missing manager-list recovery layout');
  const layout = managerListRecovery.layout;
  const manager = Number(await readQword(s, live.sdk + layout.globalManagerPointerOffset)) + layout.managerBias;
  check(validNodeAddress(manager), 'Invalid thread manager pointer');
  await s.read(manager, 0x1f0);
  const sentinel = manager + layout.listSentinelOffset;
  let node = Number(await readQword(s, sentinel));
  const seen = new Set();
  for (let count = 0; node !== sentinel && count < managerListRecovery.guardedWalk.maxNodes; count++) {
    check(validNodeAddress(node) && !seen.has(node), 'Invalid or cyclic manager-list node');
    seen.add(node);
    const bytes = await s.read(node, 0x610);
    const entry = bytes.readBigUInt64LE(layout.entryOffset);
    const argument = bytes.readBigUInt64LE(layout.argumentOffset);
    const next = Number(bytes.readBigUInt64LE(layout.nextOffset));
    if (count < 8) await s.record({operation: 'managerListNode', count, node,
      entry: entry.toString(), argument: argument.toString(), next});
    if (entry === BigInt(live.sdk + code.longjmp.offset) && argument === BigInt(frameBase)) {
      const pthreadBase = node + layout.pthreadBaseFromNode;
      check(validNodeAddress(pthreadBase), 'Invalid enclosing pthread pointer');
      const pthread = await s.read(pthreadBase, 0x1d0);
      check(pthread.readBigUInt64LE(layout.pthreadEntryOffset) === entry &&
        pthread.readBigUInt64LE(layout.pthreadArgumentOffset) === argument,
      'Enclosing pthread identity differs');
      await validateManagerLink(s, node);
      return {thread: node, pthreadBase};
    }
    node = next;
  }
  await s.record({operation: 'managerListNotFound', manager, sentinel, nodes: seen.size, next: node});
  throw Error('Created worker was not found in the manager list');
}

async function launch(s, prepared) {
  const {label, base, slot} = prepared;
  await s.write(slot, Buffer.alloc(16));
  const pending = label + ':creating';
  s.threads.add(pending);
  let thread, result;
  if (directMode) {
    const {object, stack, stackBytes} = prepared.threadMemory;
    await s.call('memset', object, 0, target.thread.objectBytes);
    await s.call('memset', stack, 0, stackBytes);
    await s.rpc.verifyFunction(live.sdk + directCode.create.offset, directCode.create.bytes);
    result = await s.rpc.call6(live.sdk + directCode.create.offset, object, live.sdk + code.longjmp.offset,
      base, stack, stackBytes, target.thread.priority);
    if (result) s.threads.delete(pending);
    check(!result, 'nn::os::CreateThread failed: ' + result);
    thread = object;
    const started = await s.rpc.call3(live.sdk + directCode.start.offset, thread, 0, 0);
    if (started) {
      await s.rpc.call3(live.sdk + directCode.destroy.offset, thread, 0, 0);
      s.threads.delete(pending);
    }
    check(!started, 'nn::os::StartThread failed: ' + started);
    await s.record({operation: 'workerCreateReturned', label, result, started, thread: thread.toString()});
  } else if (rawMode) {
    const {stack, stackBytes} = prepared.threadMemory;
    await s.call('memset', stack, 0, stackBytes);
    await s.rpc.verifyFunction(live.sdk + rawCode.createThread.offset, rawCode.createThread.bytes);
    const scheduling = await borrowScheduling(s);
    let usedCore = null;
    for (const core of scheduling.cores) {
      await s.record({operation: 'rawThreadCreateAttempt', label, core, priority: scheduling.priority});
      result = await s.rpc.call6(live.sdk + rawCode.createThread.offset, slot,
        live.sdk + code.longjmp.offset, base, stack + stackBytes, scheduling.priority, core);
      if (result === 0) {usedCore = core; break;}
      check(result === 0xe001, 'Unexpected svcCreateThread error: ' + result);
    }
    if (result !== 0) s.threads.delete(pending);
    check(result === 0, 'svcCreateThread rejected every candidate core');
    thread = (await s.readOwned(slot, 4)).readUInt32LE();
    check(thread > 0 && thread < 0xffff8000, 'Invalid raw thread handle');
    const started = await s.rpc.call3(live.sdk + rawCode.startThread.offset, thread, 0, 0);
    if (started) {
      await s.rpc.call3(live.sdk + rawCode.closeHandle.offset, thread, 0, 0);
      s.threads.delete(pending);
    }
    check(!started, 'svcStartThread failed: ' + started);
    await s.record({operation: 'workerCreateReturned', label, result, started, thread, core: usedCore});
  } else {
    result = await s.rpc.call4(live.sdk + code.create.offset, slot, 0, live.sdk + code.longjmp.offset, base);
    if (result) s.threads.delete(pending);
    check(!result, 'pthread_create failed: ' + result);
    if (enumerateMode) {
      const gateResult = (await s.readOwned(base + prepared.resultOffset, 8)).readBigUInt64LE();
      await s.record({operation: 'workerGateAfterCreate', label, result: gateResult.toString()});
      check(gateResult === SENTINEL, 'Worker passed its start gate before recovery');
      const recovered = await recoverThread(s, base);
      thread = recovered.thread;
      await s.record({operation: 'workerRecovered', label, result, thread: thread.toString(),
        pthreadBase: recovered.pthreadBase.toString()});
    } else {
      const threadWord = (await s.readOwned(slot, 8)).readBigUInt64LE();
      thread = Number(threadWord);
      await s.record({operation: 'workerCreateReturned', label, result, thread: threadWord.toString()});
    }
  }
  if (rawMode) check(Number.isSafeInteger(thread) && thread > 0 && thread < 0xffff8000,
    'Invalid raw thread handle');
  else check(Number.isSafeInteger(thread) && thread > 0 && thread < 2 ** 39 && thread % 8 === 0,
    'Invalid worker pointer');
  s.threads.delete(pending); s.threads.add(thread);
  const worker = {...prepared, thread, joined: false};
  check((await s.readOwned(base + worker.resultOffset, 8)).readBigUInt64LE() === SENTINEL, 'Worker passed its start gate');
  await s.record({operation: 'workerStarted', label, thread, base});
  return worker;
}

async function restart(s, worker) {
  // A joined thread's address can already belong to another worker.
  check(worker.snapshot && worker.joined, 'Cannot restore an active worker');
  await s.rpc.call3(live.sdk + memcpyOffset, worker.base, worker.snapshot, worker.bytes);
  delete worker.results;
  return launch(s, worker);
}

async function join(s, worker, timeoutMs = target.worker.joinTimeoutMs) {
  check(!worker.joined && s.threads.has(worker.thread), 'Worker is not owned');
  const until = Date.now() + timeoutMs;
  let finished;
  if (rawMode) {
    const wait = s.base + 0x2800;
    const timeoutResult = rawSvc.waitTimeoutResult;
    let result;
    do {
      await s.write(wait, Buffer.alloc(16));
      const handles = Buffer.alloc(8);
      handles.writeUInt32LE(worker.thread);
      await s.write(wait + 8, handles);
      result = await s.rpc.call4(live.sdk + rawCode.waitSynchronization.offset, wait, wait + 8, 1,
        rawSvc.pollTimeoutNs ?? 0);
      check(result === 0 || result === timeoutResult, 'Unexpected wait-synchronization result: ' + result);
      if (result === 0) {
        check((await s.readOwned(wait, 4)).readUInt32LE() === 0, 'Wait signaled a different handle');
        finished = 1;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, target.worker.joinPollMs));
    } while (Date.now() < until);
  } else do {
    finished = await s.rpc.call3(live.sdk + code.tryWait.offset, worker.thread, 0, 0);
    check(finished === 0 || finished === 1, 'Unexpected thread state');
    if (finished) break;
    await new Promise(resolve => setTimeout(resolve, target.worker.joinPollMs));
  } while (Date.now() < until);
  check(finished, 'Native batch did not terminate; resources retained');
  const raw = await s.readOwned(worker.base + worker.resultOffsets[0], worker.resultOffsets.length * 8);
  const values = worker.resultOffsets.map((_, i) => raw.readBigUInt64LE(i * 8));
  check(values.every(value => value !== SENTINEL), 'Native batch did not store every result');
  if (rawMode) {
    check(!await s.rpc.call3(live.sdk + rawCode.closeHandle.offset, worker.thread, 0, 0),
      'svcCloseHandle failed');
  } else if (directMode || enumerateMode) {
    if (enumerateMode) await validateManagerLink(s, worker.thread);
    check(!await s.rpc.call3(live.sdk + directCode.destroy.offset, worker.thread, 0, 0),
      'nn::os::DestroyThread failed');
  } else {
    check(!await s.rpc.call3(live.sdk + code.join.offset, worker.thread, worker.slot + 8, 0), 'pthread_join failed');
    check((await s.readOwned(worker.slot + 8, 8)).readBigUInt64LE() === values.at(-1), 'Thread exit result differs');
  }
  s.threads.delete(worker.thread);
  worker.joined = true;
  worker.results = worker.logicalResultIndices.map(i => values[i]);
  await s.record({operation: 'workerJoined', label: worker.label, thread: worker.thread,
    values: worker.results.map(String), nativeCalls: values.length});
  return worker.results;
}

async function restartAll(s, workers) {
  for (const worker of workers) Object.assign(worker, await restart(s, worker));
  return workers;
}

async function joinAll(s, workers, timeoutMs = target.worker.joinTimeoutMs) {
  for (const worker of workers) await join(s, worker, timeoutMs);
}

module.exports = {capacity, writeSparse, start, restart, join, restartAll, joinAll, borrowScheduling};
