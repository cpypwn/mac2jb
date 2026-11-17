const {packet: cmifPacket, response: cmifResponse} = require('../civswitch/fs-kit/port/engine/shared/ipc.cjs');
const profile = require('./sdk-profile.v1.0.1f.json');

const REQUEST_BYTES = 0x8080;
const RESPONSE_BYTES = 0x8010;
const SERVICE_NAME_OFFSET = 0x40080n;
const IPC_BUFFER_OFFSET = 0x41000n;
const IPC_PACKET_OFFSET = 0x1000;
const OUTPUT_OFFSET = 0x4040n;
const COUNTER_COUNT = 16;
const GENERAL_HEAP_INDEX = 5;
const SDK_TICK_HZ = 19200000;
const REQUIRED_STREAK = 3;
const MAX_READS = 16;
const OWNED = Symbol('Balatro owned fsp-srv handle');
const SDK_CRC32 = Number.parseInt(profile.sdkCode.offlineCrc32, 16);
const qualifiedContexts = new WeakSet();

function address(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/.test(value)) {
    throw new TypeError(`${label} must be a hexadecimal address`);
  }
  return BigInt(value);
}

function createQualifiedContext({arenaBase, hello, crc, nonce, port = 39381}) {
  if (!/^[0-9a-f]{16}$/.test(nonce || '') ||
      !Number.isInteger(port) || port < 1024 || port > 65535 || port === 39380) {
    throw new TypeError('Balatro counter context needs its retained owner and transport port');
  }
  const arena = address(arenaBase, 'arena base');
  const scratch = address(hello?.scratch, 'transport scratch');
  const sdk = address(hello?.sdkBase, 'transport SDK base');
  if (hello.status !== 'read-only transport handshake verified' ||
      hello.scratchBytes !== 0x80000 || hello.sdkCrc32 !== SDK_CRC32 ||
      scratch !== arena + 0x10000n || arena % 4096n !== 0n ||
      scratch + 0x80000n > arena + 0x200000n ||
      arena < 4096n || arena + 0x200000n >= 1n << 39n ||
      sdk < 4096n || sdk % 4096n !== 0n ||
      sdk + BigInt(profile.sdkCode.size) >= 1n << 39n) {
    throw Error('Balatro counter context does not match its verified arena and SDK map');
  }
  if (crc?.gameProfile !== profile.gameProfile || crc.nonce !== nonce ||
      crc.port !== port || crc.sdkBase !== hello.sdkBase ||
      crc.sdkCrc32 !== profile.sdkCode.offlineCrc32) {
    throw Error('Balatro counter context needs matching live SDK CRC qualification');
  }
  const context = Object.freeze({arena, scratch, sdk, nonce, port,
    owner: Symbol('counter context')});
  qualifiedContexts.add(context);
  return context;
}

function nativePacket(context, first, second, data = Buffer.alloc(0), dataOffset = 0x80) {
  if (!qualifiedContexts.has(context) || !Array.isArray(first) || first.length !== 5 ||
      !Array.isArray(second) || second.length !== 5 ||
      !Buffer.isBuffer(data) || !Number.isInteger(dataOffset) || dataOffset < 0x80 ||
      dataOffset + data.length > REQUEST_BYTES) {
    throw new TypeError('invalid Balatro native packet');
  }
  const bytes = Buffer.alloc(REQUEST_BYTES);
  first.forEach((value, index) => bytes.writeBigUInt64LE(BigInt(value), index * 8));
  second.forEach((value, index) => bytes.writeBigUInt64LE(BigInt(value), 0x28 + index * 8));
  data.copy(bytes, dataOffset);
  return bytes;
}

function makeOpenServicePacket(context) {
  const entry = context.sdk + BigInt(profile.symbols['nn::sm::GetServiceHandle'].offset);
  return nativePacket(context,
    [entry, context.scratch + OUTPUT_OFFSET, context.scratch + SERVICE_NAME_OFFSET, 7n, 0n],
    [0n, 0n, 0n, 0n, 0n], Buffer.from('fsp-srv\0', 'ascii'));
}

function makeTickPacket(context) {
  return nativePacket(context,
    [context.sdk + BigInt(profile.symbols['nn::os::GetSystemTick'].offset), 0n, 0n, 0n, 0n],
    [context.sdk + BigInt(profile.symbols['nn::os::GetSystemTickFrequency'].offset),
      0n, 0n, 0n, 0n]);
}

function parseTickReply(bytes) {
  const reply = readNativeReply(bytes);
  if (reply.first === 0n || reply.second !== BigInt(SDK_TICK_HZ)) {
    throw Error('Balatro native tick or frequency did not match the pinned SDK');
  }
  return reply.first;
}

function readNativeReply(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== RESPONSE_BYTES) {
    throw Error('Balatro native reply has the wrong size');
  }
  return {second: bytes.readBigUInt64LE(0), first: bytes.readBigUInt64LE(8),
    output: bytes.subarray(16)};
}

function parseOpenServiceReply(bytes, context) {
  const reply = readNativeReply(bytes);
  const handle = reply.output.readUInt32LE();
  if (reply.first !== 0n || reply.second !== 0n || handle === 0 ||
      handle >= 0xffff8000) {
    throw Error('Balatro fsp-srv handle was not verified');
  }
  return ownedHandle(context, handle, 'root');
}

function claimOpenedService(context, result, handle) {
  if (!qualifiedContexts.has(context) || result !== 0n ||
      !Number.isInteger(handle) || handle <= 0 || handle >= 0xffff8000) {
    throw Error('Balatro fsp-srv handle was not verified');
  }
  return ownedHandle(context, handle, 'root');
}

function ownedHandle(context, handle, role) {
  const service = {};
  Object.defineProperties(service, {
    [OWNED]: {value: context.owner},
    handle: {value: handle, enumerable: true},
    role: {value: role, enumerable: true},
    closed: {value: false, writable: true, enumerable: true},
  });
  return Object.seal(service);
}

function requireOwned(context, service) {
  if (!qualifiedContexts.has(context) || !service ||
      service[OWNED] !== context.owner || service.closed ||
      !Number.isInteger(service.handle) || service.handle <= 0 ||
      service.handle >= 0xffff8000) {
    throw Error('Balatro FS request requires an owned, open fsp-srv handle');
  }
  return service.handle;
}

function makeIpcPacket(context, service, command) {
  const handle = requireOwned(context, service);
  if (service.role !== 'root') {
    throw Error('Balatro FS root command requires an owned fsp-srv root handle');
  }
  if (command !== 'initialize' && command !== 'counters' &&
      command !== 'open-storage') {
    throw new TypeError('Balatro FS probe only supports initialization, counters and owned storage');
  }
  const request = command === 'initialize' ? cmifPacket(1, Buffer.alloc(8), {pid: true}) :
    cmifPacket(command === 'counters' ? 1009 : 200);
  const first = [context.sdk + BigInt(profile.symbols.svcSend.offset),
    context.scratch + IPC_BUFFER_OFFSET, 4096n, BigInt(handle), 0n];
  const second = [context.sdk + BigInt(profile.symbols.memmove.offset),
    context.scratch + OUTPUT_OFFSET, context.scratch + IPC_BUFFER_OFFSET,
    BigInt(request.length), 0n];
  return nativePacket(context, first, second, request, IPC_PACKET_OFFSET);
}

function parseOpenStorageReply(bytes, context, root) {
  requireOwned(context, root);
  if (root.role !== 'root') throw Error('Balatro storage open requires its fsp-srv root');
  const native = readNativeReply(bytes);
  if (native.first !== 0n || native.second !== context.scratch + OUTPUT_OFFSET ||
      (native.output.readUInt32LE(4) & 0x3ff) < 4) {
    throw Error('Balatro content storage IPC did not complete');
  }
  const reply = cmifResponse(native.output.subarray(0, 256));
  if (reply.result !== 0 || reply.copies.length !== 0 || reply.moves.length !== 1 ||
      reply.moves[0] === root.handle || reply.moves[0] <= 0 ||
      reply.moves[0] >= 0xffff8000) {
    throw Error('Balatro content storage did not return one owned handle');
  }
  return ownedHandle(context, reply.moves[0], 'storage');
}

function parseIpcReply(bytes, context, command) {
  if (command !== 'initialize' && command !== 'counters') {
    throw new TypeError('invalid Balatro counter command');
  }
  const native = readNativeReply(bytes);
  if (native.first !== 0n || native.second !== context.scratch + OUTPUT_OFFSET) {
    throw Error('Balatro FS native call did not complete and copy its IPC reply');
  }
  const reportedWords = native.output.readUInt32LE(4) & 0x3ff;
  if (reportedWords < (command === 'counters' ? 36 : 4)) {
    throw Error('Balatro FS IPC reply did not report enough data words');
  }
  const reply = cmifResponse(native.output.subarray(0, 256));
  if (reply.result !== 0 || reply.copies.length !== 0 || reply.moves.length !== 0) {
    throw Error('Balatro FS counter IPC response was unsuccessful or returned handles');
  }
  if (command === 'initialize') return {initialized: true};
  if (reply.data.length < COUNTER_COUNT * 8) {
    throw Error('Balatro FS allocation counter reply is too short');
  }
  const counters = [];
  for (let index = 0; index < COUNTER_COUNT; index++) {
    const value = reply.data.readBigUInt64LE(index * 8);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw Error('Balatro FS allocation counter exceeds the safe integer range');
    }
    counters.push(Number(value));
  }
  return counters;
}

function makeCloseServicePacket(context, service) {
  const handle = requireOwned(context, service);
  const first = [context.sdk + BigInt(profile.symbols.svcCloseHandle.offset),
    BigInt(handle), 0n, 0n, 0n];
  return nativePacket(context, first, [0n, 0n, 0n, 0n, 0n]);
}

function parseCloseServiceReply(bytes, context, service) {
  requireOwned(context, service);
  const reply = readNativeReply(bytes);
  if (reply.first !== 0n || reply.second !== 0n) {
    throw Error('Balatro fsp-srv handle close was not verified');
  }
  service.closed = true;
  return {closed: true};
}

function validateCounters(counters) {
  if (!Array.isArray(counters) || counters.length !== COUNTER_COUNT ||
      counters.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('Balatro FS allocation counters are incomplete');
  }
  return counters;
}

async function sampleStableCounters(readOne, maxReads = MAX_READS) {
  if (typeof readOne !== 'function' || !Number.isInteger(maxReads) ||
      maxReads < REQUIRED_STREAK || maxReads > MAX_READS) {
    throw new TypeError('invalid Balatro counter sampler');
  }
  let previous, streak = 0;
  const observedGeneralHeap = [];
  for (let index = 0; index < maxReads; index++) {
    const current = validateCounters(await readOne(index + 1));
    const value = current[GENERAL_HEAP_INDEX];
    observedGeneralHeap.push(value);
    streak = previous && previous[GENERAL_HEAP_INDEX] === value ? streak + 1 : 1;
    if (streak >= REQUIRED_STREAK) {
      return {samples: [previous, current], reads: index + 1, observedGeneralHeap};
    }
    previous = current;
  }
  const error = Error(`Balatro FS general heap did not stabilize after ${maxReads} reads`);
  error.code = 'UNSTABLE_COUNTERS';
  error.observedGeneralHeap = observedGeneralHeap;
  throw error;
}

function assessPinning(before, held, after) {
  const pair = phase => Array.isArray(phase) && phase.length === 2 &&
    phase.every(sample => {try {validateCounters(sample); return true;} catch {return false;}});
  if (!pair(before) || !pair(held) || !pair(after)) {
    throw new TypeError('Balatro pinning comparison needs complete counter pairs');
  }
  const value = pair => pair[1][GENERAL_HEAP_INDEX];
  const stability = Object.fromEntries([['before', before], ['held', held],
    ['after', after]].map(([name, samples]) => [name,
    samples[1][GENERAL_HEAP_INDEX] - samples[0][GENERAL_HEAP_INDEX]]));
  const bytes = value(before) - value(held);
  const restoration = value(after) - value(before);
  return {bytes, restoration, stability,
    verified: Object.values(stability).every(delta => delta === 0) &&
      Number.isInteger(bytes) && bytes > 0 && bytes <= 0x10000 && restoration === 0};
}

async function runCounterPreflight({context, exchange, maxReads = MAX_READS}) {
  if (!qualifiedContexts.has(context) || typeof exchange !== 'function') {
    throw new TypeError('Balatro counter preflight needs a qualified context and exchange');
  }
  let service;
  let sample;
  let failure;
  try {
    service = parseOpenServiceReply(
      await exchange(makeOpenServicePacket(context), 'open-fsp-srv'), context);
    parseIpcReply(await exchange(makeIpcPacket(context, service, 'initialize'),
      'initialize-fsp-srv'), context, 'initialize');
    sample = await sampleStableCounters(async index =>
      parseIpcReply(await exchange(makeIpcPacket(context, service, 'counters'),
        `allocation-counters-${index}`), context, 'counters'), maxReads);
  } catch (error) {
    failure = error;
  }
  if (service && !service.closed) {
    try {
      parseCloseServiceReply(await exchange(makeCloseServicePacket(context, service),
        'close-fsp-srv'), context, service);
    } catch (closeError) {
      if (failure) throw new AggregateError([failure, closeError],
        'Balatro counter preflight failed and service cleanup was not verified');
      throw closeError;
    }
  }
  if (failure) throw failure;
  return {...sample, cleanup: 'released',
    status: 'stable FS allocation counters sampled; pinning and canary unverified'};
}

module.exports = {REQUEST_BYTES, RESPONSE_BYTES, COUNTER_COUNT, GENERAL_HEAP_INDEX,
  SDK_TICK_HZ, makeTickPacket, parseTickReply,
  REQUIRED_STREAK, MAX_READS, createQualifiedContext, makeOpenServicePacket,
  parseOpenServiceReply, claimOpenedService, makeIpcPacket, parseIpcReply, makeCloseServicePacket,
  parseCloseServiceReply, parseOpenStorageReply, sampleStableCounters,
  assessPinning, runCounterPreflight};
