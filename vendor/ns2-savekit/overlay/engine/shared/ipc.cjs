// Non-domain CMIF packets. Addresses and handles are supplied by the live session.
function descriptor({address, size, mode = 0}) {
  const a = BigInt(address), n = BigInt(size);
  if (a < 0n || a >= 1n << 39n || n < 0n || n >= 1n << 36n || ![0, 1, 3].includes(mode)) {
    throw Error('Invalid map-alias descriptor');
  }
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32LE(Number(n & 0xffffffffn));
  bytes.writeUInt32LE(Number(a & 0xffffffffn), 4);
  bytes.writeUInt32LE(Number(BigInt(mode) | (a >> 36n) << 2n |
    (n >> 32n) << 24n | ((a >> 32n) & 15n) << 28n), 8);
  return bytes;
}

// HIPC static descriptor (word pair): a CMIF "pointer" input buffer.
//   word 0: index:6 address_high:6 address_mid:4 size:16
//   word 1: address_low:32
function pointerDescriptor({address, size, index = 0}) {
  const a = BigInt(address), n = BigInt(size), id = BigInt(index);
  if (a < 0n || a >= 1n << 42n || n < 0n || n > 0xffffn || id < 0n || id > 0x3fn) {
    throw Error('Invalid pointer descriptor');
  }
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32LE(Number(id | (a >> 36n) << 6n | ((a >> 32n) & 15n) << 12n | n << 16n));
  bytes.writeUInt32LE(Number(a & 0xffffffffn), 4);
  return bytes;
}

// HIPC recv-list entry: a CMIF "pointer" output buffer.
//   word 0: address_low:32
//   word 1: address_high:16 size:16
function receiveDescriptor({address, size}) {
  const a = BigInt(address), n = BigInt(size);
  if (a < 0n || a >= 1n << 48n || n < 0n || n > 0xffffn) {
    throw Error('Invalid receive pointer descriptor');
  }
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32LE(Number(a & 0xffffffffn));
  bytes.writeUInt32LE(Number(((a >> 32n) & 0xffffn) | n << 16n), 4);
  return bytes;
}

function packet(command, input = Buffer.alloc(0), {pid = false, copies = [], send = [], receive = [],
  pointers = {}} = {}) {
  const sendPointers = pointers.send ?? [];
  const receivePointers = pointers.receive ?? [];
  const unfixed = receivePointers.filter(buffer => !buffer.fixed);
  if ([copies.length, send.length, receive.length, sendPointers.length].some(n => n > 15) ||
      receivePointers.length > 13) throw Error('Too many descriptors');
  const special = pid || copies.length > 0;
  const numDataWords = Math.ceil((32 + input.length + 2 * unfixed.length) / 4);
  const recvMode = receivePointers.length ? 2 + receivePointers.length : 0;
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE((4 | sendPointers.length << 16 | send.length << 20 |
    receive.length << 24) >>> 0);
  bytes.writeUInt32LE((numDataWords | recvMode << 10 |
    (special ? 0x80000000 : 0)) >>> 0, 4);
  let at = 8;
  if (special) {
    bytes.writeUInt32LE((pid ? 1 : 0) | copies.length << 1, at);
    at += 4;
    if (pid) at += 8;
    for (const handle of copies) {bytes.writeUInt32LE(handle >>> 0, at); at += 4;}
  }
  sendPointers.forEach((buffer, index) => {
    pointerDescriptor({...buffer, index}).copy(bytes, at); at += 8;
  });
  const dataWords = at;
  for (const buffer of [...send, ...receive]) {descriptor(buffer).copy(bytes, at); at += 12;}
  const header = (at + 15) & ~15;
  if (header + 16 + input.length > bytes.length) throw Error('CMIF input exceeds packet capacity');
  const recvList = dataWords + numDataWords * 4;
  if (recvList + 8 * receivePointers.length > bytes.length) throw Error('Descriptor list exceeds packet capacity');
  // CMIF appends one u16 size per unfixed out pointer at
  // data_words + 0x10 (message padding) + 0x10 (CmifInHeader) + input size.
  const table = dataWords + 32 + input.length;
  unfixed.forEach((buffer, index) => {
    bytes.writeUInt16LE(Number(BigInt(buffer.size) & 0xffffn), table + 2 * index);
  });
  bytes.write('SFCI', header);
  bytes.writeUInt32LE(command, header + 8);
  input.copy(bytes, header + 16);
  receivePointers.forEach((buffer, index) => {
    receiveDescriptor(buffer).copy(bytes, recvList + 8 * index);
  });
  return bytes;
}

function response(bytes) {
  const first = bytes.readUInt32LE(), second = bytes.readUInt32LE(4);
  let at = 8;
  const copies = [], moves = [];
  if (second >>> 31) {
    const special = bytes.readUInt32LE(at); at += 4;
    if (special & 1) at += 8;
    for (let i = 0; i < (special >>> 1 & 15); i++, at += 4) copies.push(bytes.readUInt32LE(at));
    for (let i = 0; i < (special >>> 5 & 15); i++, at += 4) moves.push(bytes.readUInt32LE(at));
  }
  at += (first >>> 16 & 15) * 8;
  at += ((first >>> 20 & 15) + (first >>> 24 & 15) + (first >>> 28 & 15)) * 12;
  at = (at + 15) & ~15;
  if (bytes.toString('ascii', at, at + 4) !== 'SFCO') throw Error('Missing SFCO reply');
  const result = bytes.readUInt32LE(at + 8);
  return {result, canonicalResult: result & 0x3fffff, copies, moves, data: bytes.subarray(at + 16)};
}

module.exports = {descriptor, pointerDescriptor, receiveDescriptor, packet, response};
