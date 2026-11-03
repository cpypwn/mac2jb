const fs = require('node:fs/promises');
const path = require('node:path');
const { resultError } = require('./protocol.cjs');

const threadCode = {
  "create": {
    "offset": 1255648,
    "bytes": "ff8303d1fd7b08a9fd030291fc6f09a9fa670aa9f85f0ba9f6570ca9f44f0da9f40303aaf50302aaf30300aae10300b4370040f9f71f00f9280440f9e81b00f93b0840f9fb1700f9281840b9e82300b9291c40b9e91f00b92a2040b9ea1b00b9282440b9e81700b92b1440f92c1840f9ec0700f9eb0300f989040034c00280523f050071410b00545f050071080b0054091500513f7d0071a80a0054890480523601084b1c000014bf7f3fa9bf831ef8bfc31df8bf431df8ff7f04a9b7835ff8f71f00f9a8035ff8e81b00f9bb835ef8fb1700f9a8035eb8e82300b9a9c35db8e91f00b9aa835db8ea1b00b9a8435db8e81700b9eb2340f9ec2740f9ec0700f9eb0300f9c9fbff35f2371294e5461294f603002aff0200f1080088522800a0721701979a7f0300f1e8fe3f9118019f9ae86983520803088b19cd7492e00319aac02f1294200500b4e1031f2ae20319aafa0300aaeb2a129448ff3f911f0300f16001805208cd7492e902088b7b03889a291d009129f17d925803899a08031acb08412d913f0308eb23030054080b4092e80200b5081f0d912920805209010079088e8a5200030d91088b06791c0307911a671ca91b5f1da914d71ea9c93512940100009021002d9118f300f9e00318aae2031caae3031baae40317aae503162a1c3612944001003460018052f44f4da9f6574ca9f85f4ba9fa674aa9fc6f49a9fd7b48a9ff830391c0035fd6e0031caa14060094295f009008f340f9294546f9089f01f9290140b9080d098b1c4100f900f340f9600200f90a361294e82340b96800003400f340f9f6050094e0031f2ae7ffff17"
  },
  "join": {
    "offset": 1256736,
    "bytes": "fd7bbda9f50b00f9fd030091f44f02a908184d3928040037081c4d39f30300aa6804003468224d392804003468124d391fc10171c103005468164d391f51017161030054e00313aaf40301aa7502079180351294740000b468fe40f9880200f9e00313aa5735129473e240f902328152e00315aae1031f2a122a1294e00313aa542e1294e0031f2af44f42a9f50b40f9fd7bc3a8c0035fd6c0028052f44f42a9f50b40f9fd7bc3a8c0035fd6a9ffff97"
  },
  "tryWait": {
    "offset": 1217808,
    "bytes": "685f00b0e10300aa08dd45f900810391e46b1214"
  }
};
const sdk = {
  "send": {
    "offset": 1410140,
    "bytes": "410400d4c0035fd6"
  },
  "close": {
    "offset": 1410028,
    "bytes": "c10200d4c0035fd6"
  }
};

// find the sdk function we need

const checkSdk = (ok, why) => {
  if (!ok) throw new Error('SDK symbol lookup: ' + why);
};
const wanted = {
  socket: '_ZN2nn6socket6SocketEiii',
  bind: '_ZN2nn6socket4BindEiPKNS0_8SockAddrEj',
  listen: '_ZN2nn6socket6ListenEii',
  accept: '_ZN2nn6socket6AcceptEiPNS0_8SockAddrEPj',
  recv: '_ZN2nn6socket4RecvEiPvmi',
  send: '_ZN2nn6socket4SendEiPKvmi',
  close: '_ZN2nn6socket5CloseEi',
  poll: '_ZN2nn6socket4PollEPNS0_6PollFdEmi',
  sockname: '_ZN2nn6socket11GetSockNameEiPNS0_8SockAddrEPj',
  fcntl: '_ZN2nn6socket5FcntlEiiz',
  get_errno: '_ZN2nn6socket12GetLastErrnoEv',
  setsockopt: '_ZN2nn6socket10SetSockOptEiiiPKvj',
  connect: '_ZN2nn6socket7ConnectEiPKNS0_8SockAddrEj',
};

// Slot order of ServerFunctions in native.h. Entries not in `wanted` are filled from patched code below.
const FUNCTION_TABLE = [
  'socket', 'bind', 'listen', 'accept', 'recv', 'send', 'close', 'poll', 'sockname', 'fcntl', 'get_errno',
  'ipc', 'close_handle', 'thread_create', 'thread_join', 'setsockopt', 'connect',
];

// StartupPhase in native.h, for readable startup errors.
const STARTUP_PHASES = { 1: 'configuration check', 2: 'file index check', 3: 'socket()', 4: 'bind()', 5: 'listen()' };
// nn::socket errno values are BSD's.
const ERRNO_NAMES = { 13: 'EACCES', 22: 'EINVAL', 23: 'ENFILE', 24: 'EMFILE', 48: 'EADDRINUSE', 49: 'EADDRNOTAVAIL', 50: 'ENETDOWN', 55: 'ENOBUFS' };

/** Explain a failed native startup from the phase and errno the payload recorded. */
function startupError({ phase, errno }, port) {
  const step = STARTUP_PHASES[phase] || 'unknown step ' + phase;
  if (phase === 4 && errno === 48) {
    return new Error(`Port ${port} is already in use on the console (is another server still running?). Try another --port.`);
  }
  const detail = phase >= 3 ? ` (errno ${errno}${ERRNO_NAMES[errno] ? ' ' + ERRNO_NAMES[errno] : ''})` : '';
  return new Error(`Native server startup failed at ${step}${detail}`);
}

function integer(value) {
  checkSdk(value <= BigInt(Number.MAX_SAFE_INTEGER), 'imprecise address');
  return Number(value);
}

async function resolveSdkFunctions({ read, query, base }) {
  const exact = async (at, size) => {
    const b = await read(at, size);
    checkSdk(Buffer.isBuffer(b) && b.length === size, 'short metadata read');
    return b;
  };
  const header = await exact(base, 16);
  const moduleOffset = header.readInt32LE(4);
  checkSdk(moduleOffset >= 0 && moduleOffset < 0x2000000, 'module-header offset');

  const mod = await exact(base + moduleOffset, 28);
  checkSdk(mod.toString('ascii', 0, 4) === 'MOD0', 'missing MOD0 header');

  const dynamic = base + moduleOffset + mod.readInt32LE(4);
  const table = await exact(dynamic, 4096);
  const tags = new Map();
  let terminated = false;

  for (let at = 0; at < table.length; at += 16) {
    const tag = table.readBigInt64LE(at);

    if (!tag) {
      terminated = true;
      break;
    }

    tags.set(Number(tag), integer(table.readBigUInt64LE(at + 8)));
  }

  checkSdk(
    terminated && tags.get(11) === 24 && [4, 5, 6, 10].every((tag) => tags.has(tag)),
    'unsupported dynamic table',
  );

  const address = (value) => (value < base ? base + value : value);
  const hash = await exact(address(tags.get(4)), 8);
  const count = hash.readUInt32LE(4);
  const stringBytes = tags.get(10);
  checkSdk(count > 0 && count <= 200000 && stringBytes > 0 && stringBytes <= 0x1000000, 'symbol table geometry');

  const strings = await exact(address(tags.get(5)), stringBytes);
  const symbols = await exact(address(tags.get(6)), count * 24);
  const names = new Map(Object.entries(wanted).map(([key, name]) => [name, key]));
  const result = {};

  for (let i = 0; i < count; i++) {
    const at = i * 24;
    const start = symbols.readUInt32LE(at);
    checkSdk(start < strings.length, 'symbol string offset');

    const end = strings.indexOf(0, start);
    checkSdk(end >= start, 'unterminated symbol');

    const name = strings.toString('utf8', start, end);
    const key = names.get(name);

    if (!key || !symbols.readUInt16LE(at + 6)) continue;

    const offset = integer(symbols.readBigUInt64LE(at + 8));
    const size = integer(symbols.readBigUInt64LE(at + 16));
    checkSdk(
      (symbols[at + 4] & 15) === 2 &&
        offset % 4 === 0 &&
        size >= 4 &&
        offset + size <= 0x5e1000 &&
        !result[key],
      'invalid or duplicate function: ' + name,
    );

    const location = base + offset;
    const region = await query(location);
    checkSdk(
      !region.result &&
        region.permissions === 5 &&
        !region.attributes &&
        region.address <= location &&
        Number(region.address) + Number(region.size) >= location + Math.min(size, 32),
      'function is not executable: ' + name,
    );

    result[key] = location;
  }

  checkSdk(Object.keys(result).length === names.size, 'required socket exports are missing');
  return result;
}

// These mirror SERVER_MAX_CLIENTS (native.h) and IPC_BUFFER_BYTES / SCRATCH_BYTES (native.c).
const MAX_CLIENTS = 12;
const IPC_BUFFER_BYTES = 8192;
const SCRATCH_BYTES = 8192;

const align = (n) => Math.ceil(n / 4096) * 4096;

async function readImage() {
  return fs.readFile(path.join(__dirname, 'oz-code/native.bin'));
}

function encodeConfiguration({
  base,
  functions,
  index,
  indexBytes,
  sourceAddress,
  sources,
  data,
  dataBytes,
  slots,
  slotBytes,
  port,
  zipPort = 0,
}) {
  const config = Buffer.alloc(256);
  config.write('NS2FTP01'); // Historical magic, shared with native.c CFG_MAGIC; not renamed to keep the ABI stable.
  config.writeUInt32LE(1, 8);
  config.writeUInt32LE(port, 24);
  config.writeUInt32LE(MAX_CLIENTS, 28);
  config.writeUInt32LE(zipPort, 132);

  const pointer = (at, value) => {
    config.writeBigUInt64LE(BigInt(value), at);
  };

  pointer(64, functions);
  pointer(72, index);
  config.writeBigUInt64LE(BigInt(indexBytes), 80);
  pointer(88, sourceAddress);
  config.writeBigUInt64LE(BigInt(sources.length), 96);
  pointer(104, data);
  config.writeBigUInt64LE(BigInt(dataBytes), 112);
  pointer(120, base + 0x8000);
  pointer(232, slots);
  config.writeBigUInt64LE(BigInt(slotBytes), 240);

  const table = Buffer.alloc(sources.length * 16);
  sources.forEach((source, i) => {
    table.writeUInt32LE(source.handle, i * 16);
    table.writeUInt32LE(source.kind, i * 16 + 4);

    if (source.kind === 2) table[i * 16 + 5] = source.attributes;

    table.writeBigUInt64LE(BigInt(source.size), i * 16 + 8);
  });

  return { config, sources: table };
}

async function deployServer({ attachment: a, image, index, sources, port, zipPort = 0, timing = {} }) {
  if (!Number.isInteger(zipPort) || zipPort < 0 || zipPort > 65535)
    throw new Error('Invalid OunceCake ZIP port');
  const now = timing.now || Date.now;
  const pause = timing.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startupMs = timing.startupMs ?? 10000;
  const stopMs = timing.stopMs ?? 10000;
  const codeBytes = align(image.length);

  const indexOffset = 0x20000;
  const sourceOffset = align(indexOffset + index.length);
  const dataOffset = align(sourceOffset + sources.length * 16);
  const dataBytes = 0x400000;
  const slotsOffset = dataOffset + dataBytes;
  // Per client: slot header, read cache, IPC buffer, then HTTP request scratch (SCRATCH_BYTES in native.c).
  const slotBytes = align(4096 + dataBytes + IPC_BUFFER_BYTES + SCRATCH_BYTES);

  const work = new a.Session('server-native-' + Date.now(), align(slotsOffset + MAX_CLIENTS * slotBytes));
  work.record = async () => {};

  let worker;
  let workerMayRun = false;
  let ro;
  let pid;
  let mappings = [];
  let mappingPending = false;
  let closing;

  async function roRequest(command, values) {
    const input = Buffer.alloc(32);
    values.forEach((value, i) => input.writeBigUInt64LE(BigInt(value), i * 8));

    const reply = await work.ipc('Server owned code mapping', ro, command, input, {
      pid: true,
      copies: [0xffff8001],
    });

    if (reply.result) throw resultError('Server owned code mapping', reply.result);

    return reply.data;
  }

  async function status() {
    const data = await work.readOwned(work.base + 0x4000, 64);
    // Offsets follow ServerConfig in native.h.
    return {
      state: data.readUInt32LE(16),
      result: data.readUInt32LE(20),
      errno: Number(data.readBigUInt64LE(48)),
      ip: [...data.subarray(56, 60)].join('.'),
      phase: data.readUInt32LE(60),
    };
  }

  function blocked(error) {
    error.cleanupBlocked = true;
    return error;
  }

  function close() {
    if (closing) return closing;
    closing = (async () => {
      if (mappingPending)
        throw blocked(new Error('Server executable mapping ownership is uncertain; restart the console.'));
      if (workerMayRun && !worker)
        throw blocked(new Error('Server thread ownership is uncertain; restart the console.'));

      if (worker) {
        try {
          await work.write(work.base + 0x400c, Buffer.from([1, 0, 0, 0]));
          const until = now() + stopMs;
          let stopped = false;
          while (now() < until) {
            const result = await work.rpc.call3(a.live.sdk + threadCode.tryWait.offset, worker, 0, 0);
            if (result === 1) { stopped = true; break; }
            if (result !== 0) throw new Error('Server thread stop status was invalid: ' + result);
            await pause(50);
          }
          if (!stopped) throw new Error('Server thread did not confirm stop before its deadline.');
          const joined = await work.rpc.call3(a.live.sdk + threadCode.join.offset, worker, work.base + 0xa008, 0);
          if (joined !== 0) throw new Error('Server thread did not join successfully: ' + joined);
        } catch (error) { throw blocked(error); }
        work.threads.delete(worker);
        a.s.threads.delete('standalone-server');
        worker = undefined;
        workerMayRun = false;
      }

      try {
        for (const mapping of mappings.slice().reverse())
          await roRequest(0x524f0013, [pid, mapping.source, mapping.destination, 4096]);
        await work.cleanup();
        if (work.base !== 0 || work.handles.size !== 0 || work.threads.size !== 0)
          throw new Error('Server owned allocation cleanup was deferred.');
      } catch (error) { throw blocked(error); }
      mappings = [];
      return { nativeStopped: true, joined: true, mappingsCleared: true };
    })();
    return closing;
  }

  try {
    await work.initialize();
    for (const [name, expected] of Object.entries({ ...sdk, ...threadCode }))
      await work.verifyCode(expected, 'OunceCake ' + name);

    const symbols = await resolveSdkFunctions({
      read: work.read.bind(work),
      query: work.rpc.query,
      base: a.live.sdk,
    });

    const addresses = {
      ...symbols,
      ipc: a.live.sdk + sdk.send.offset,
      close_handle: a.live.sdk + sdk.close.offset,
      thread_create: a.live.sdk + threadCode.create.offset,
      thread_join: a.live.sdk + threadCode.join.offset,
    };
    const functions = Buffer.alloc(FUNCTION_TABLE.length * 8);
    FUNCTION_TABLE.forEach((name, i) => {
      functions.writeBigUInt64LE(BigInt(addresses[name]), i * 8);
    });

    const configuration = encodeConfiguration({
      base: work.base,
      functions: work.base + 0x5000,
      index: work.base + indexOffset,
      indexBytes: index.length,
      sourceAddress: work.base + sourceOffset,
      sources,
      data: work.base + dataOffset,
      dataBytes,
      slots: work.base + slotsOffset,
      slotBytes,
      port,
      zipPort,
    });

    await work.write(work.base + 0x4000, configuration.config);
    await work.write(work.base + 0x5000, functions);
    await work.write(work.base + sourceOffset, configuration.sources);
    await work.write(work.base + indexOffset, index);
    await work.write(work.base + 0x10000, image);

    ro = await a.service('ro:dmnt');

    const reply = await work.ipc('Server verify application process', ro, 0x524f0010, Buffer.alloc(32), {
      pid: true,
      copies: [0xffff8001],
    });
    if (reply.result) throw resultError('Server verify application process', reply.result);
    if (!Buffer.isBuffer(reply.data) || reply.data.length < 96)
      throw new Error('Server application process reply was truncated.');

    pid = reply.data.readBigUInt64LE().toString();

    const destination = Number(reply.data.readBigUInt64LE(88));
    if (BigInt(pid) <= 0n || !Number.isSafeInteger(destination) || destination < 4096 ||
        destination >= 2 ** 39 || destination % 4096 !== 0)
      throw new Error('Server application process identity or executable destination is invalid.');

    for (let offset = 0; offset < codeBytes; offset += 4096) {
      const source = work.base + 0x10000 + offset;
      const target = destination + offset;
      mappingPending = true;
      await roRequest(0x524f0012, [pid, source, target, 4096]);
      mappings.push({ source, destination: target });
      mappingPending = false;
    }

    a.s.threads.add('standalone-server');

    workerMayRun = true;
    const started = await work.rpc.call4(
      a.live.sdk + threadCode.create.offset,
      work.base + 0xa000,
      0,
      destination,
      work.base + 0x4000,
    );

    if (started) {
      workerMayRun = false;
      a.s.threads.delete('standalone-server');
      throw new Error('Could not start server thread: ' + started);
    }

    worker = Number((await work.readOwned(work.base + 0xa000, 8)).readBigUInt64LE());
    if (!Number.isSafeInteger(worker) || worker <= 0 || worker >= 2 ** 39) {
      worker = undefined;
      throw blocked(new Error('Native server did not return a valid owned thread.'));
    }
    work.threads.add(worker);

    const until = now() + startupMs;
    let current = { state: 0 };

    while (now() < until) {
      current = await status();

      if (current.state === 1 && current.result === 0) break;

      if (current.state === 3) throw startupError(current, port);

      await pause(50);
    }
    if (current.state !== 1 || current.result !== 0)
      throw new Error('Native server did not confirm listening before its deadline.');

    // 0.0.0.0 means the console found no route; the caller falls back to a placeholder.
    return { close, address: current.ip === '0.0.0.0' ? undefined : current.ip };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) {
      const combined = new AggregateError([error, cleanupError], error.message + '\n' + cleanupError.message);
      combined.cleanupBlocked = Boolean(cleanupError.cleanupBlocked);
      throw combined;
    }
    throw error;
  }
}

module.exports = { deployServer, readImage };
