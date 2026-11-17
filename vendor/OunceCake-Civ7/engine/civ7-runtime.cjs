const fs = require('node:fs/promises');
const path = require('node:path');

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
};

function checkSdk(value, message) {
  if (!value) throw new Error('SDK symbol lookup: ' + message);
}

function integer(value) {
  checkSdk(value <= BigInt(Number.MAX_SAFE_INTEGER), 'imprecise address');
  return Number(value);
}

async function resolveSdkFunctions({ read, query, base, sdkBytes }) {
  const exact = async (at, size) => {
    const bytes = await read(at, size);
    checkSdk(Buffer.isBuffer(bytes) && bytes.length === size, 'short metadata read');
    return bytes;
  };
  const header = await exact(base, 16);
  const moduleOffset = header.readInt32LE(4);
  checkSdk(moduleOffset >= 0 && moduleOffset < 0x2000000, 'module-header offset');

  const module = await exact(base + moduleOffset, 28);
  checkSdk(module.toString('ascii', 0, 4) === 'MOD0', 'missing MOD0 header');

  const dynamic = base + moduleOffset + module.readInt32LE(4);
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
  checkSdk(count > 0 && count <= 200000 && stringBytes > 0 && stringBytes <= 0x1000000,
    'symbol table geometry');

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
        offset + size <= sdkBytes &&
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

const align = (value) => Math.ceil(value / 4096) * 4096;

async function readCiv7Image() {
  return fs.readFile(path.join(__dirname, 'oz-code', 'native-civ7.bin'));
}

function encodeConfiguration({
  functions,
  index,
  indexBytes,
  sourceAddress,
  sources,
  data,
  dataBytes,
  outputBytes,
  ipcBuffer,
  slots,
  slotBytes,
  maxClients,
  port,
}) {
  const config = Buffer.alloc(256);
  config.write('NS2FTP01');
  config.writeUInt32LE(2, 8);
  config.writeUInt32LE(port, 24);
  config.writeUInt32LE(maxClients, 28);

  const pointer = (at, value) => config.writeBigUInt64LE(BigInt(value), at);
  pointer(64, functions);
  pointer(72, index);
  config.writeBigUInt64LE(BigInt(indexBytes), 80);
  pointer(88, sourceAddress);
  config.writeBigUInt64LE(BigInt(sources.length), 96);
  pointer(104, data);
  config.writeBigUInt64LE(BigInt(dataBytes), 112);
  pointer(120, ipcBuffer);
  config.writeBigUInt64LE(BigInt(outputBytes), 128);
  pointer(232, slots);
  config.writeBigUInt64LE(BigInt(slotBytes), 240);

  const table = Buffer.alloc(sources.length * 24);
  sources.forEach((source, i) => {
    const at = i * 24;
    table.writeUInt32LE(source.handle, at);
    table.writeUInt32LE(source.kind, at + 4);
    if (source.kind === 2 || source.kind === 3) {
      table[at + 5] = source.attributes;
      table[at + 6] = source.proxyType;
    }
    table.writeBigUInt64LE(
      source.kind === 3 ? BigInt('0x' + source.programId) : BigInt(source.size),
      at + 8,
    );
    table.writeUInt32LE(source.objectId || 0, at + 16);
  });

  return { config, sources: table };
}

module.exports = {
  align,
  encodeConfiguration,
  readCiv7Image,
  resolveSdkFunctions,
  wanted,
};
