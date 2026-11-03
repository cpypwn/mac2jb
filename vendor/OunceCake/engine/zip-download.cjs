'use strict';

const http = require('node:http');
const net = require('node:net');

const MAX_FILES = 100000;
const MAX_NODES = 200000;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_CENTRAL_BYTES = 16 * 1024 * 1024;
const MAX_U64 = (1n << 64n) - 1n;
const NONE = 0xffffffff;

function check(ok, message) {
  if (!ok) throw Error(message);
}

function safeNumber(value, message) {
  check(value <= BigInt(Number.MAX_SAFE_INTEGER), message);
  return Number(value);
}

function catalog(index) {
  check(Buffer.isBuffer(index) && index.length >= 64 && index.length <= MAX_INDEX_BYTES,
    'Invalid OunceCake file index size');
  check(index.toString('ascii', 0, 8) === 'NS2FTPIX' &&
    index.readUInt32LE(8) === 1 && index.readUInt32LE(12) === 48,
  'Invalid OunceCake file index header');
  const count = safeNumber(index.readBigUInt64LE(16), 'Imprecise file count');
  const nodeStart = safeNumber(index.readBigUInt64LE(24), 'Imprecise node offset');
  const stringStart = safeNumber(index.readBigUInt64LE(32), 'Imprecise string offset');
  const stringBytes = safeNumber(index.readBigUInt64LE(40), 'Imprecise string size');
  const end = safeNumber(index.readBigUInt64LE(48), 'Imprecise index size');
  check(count > 0 && count <= MAX_NODES && nodeStart === 64 &&
    stringStart === 64 + count * 48 && stringStart + stringBytes === end && end === index.length,
  'Invalid OunceCake file index layout');
  const nodes = [];
  const paths = [];
  const files = [];
  let centralBytes = 0;
  for (let id = 0; id < count; id++) {
    const at = 64 + id * 48;
    const parent = index.readUInt32LE(at);
    const type = index.readUInt32LE(at + 12);
    const nameOffset = index.readUInt32LE(at + 16);
    const nameLength = index.readUInt32LE(at + 20);
    const size = index.readBigUInt64LE(at + 40);
    check((id === 0 ? parent === 0 && type === 0 && nameLength === 0 : parent < id) &&
      (type === 0 || type === 1) && nameLength <= 1023 &&
      nameOffset + nameLength < stringBytes && index[stringStart + nameOffset + nameLength] === 0,
    'Invalid OunceCake file index node');
    const name = index.toString('utf8', stringStart + nameOffset, stringStart + nameOffset + nameLength);
    check((id === 0 || nodes[parent].type === 0) && (id === 0 || name.length > 0 && name !== '.' && name !== '..' &&
      !/[\\/\x00-\x1f\x7f]/.test(name) && Buffer.byteLength(name) === nameLength),
    'Unsafe OunceCake file path');
    const full = id === 0 ? '' : paths[parent] ? paths[parent] + '/' + name : name;
    check(Buffer.byteLength(full) <= 1023, 'OunceCake file path exceeds ZIP limit');
    nodes.push({parent, type});
    paths.push(full);
    if (type === 1) {
      check(nodes[parent].type === 0, 'File has a file parent');
      const nameBytes = Buffer.from(full);
      centralBytes += 74 + nameBytes.length;
      check(centralBytes <= MAX_CENTRAL_BYTES, 'Game has too many files for ZIP metadata');
      files.push({name: full, nameBytes, size});
    }
  }
  check(files.length <= MAX_FILES, 'Game has too many downloadable files');
  let bytes = 98n + BigInt(centralBytes);
  for (const file of files) bytes += 74n + BigInt(file.nameBytes.length) + file.size;
  check(bytes <= MAX_U64, 'Game files exceed ZIP64 size');
  return {files, bytes};
}

const CRC_TABLE = Uint32Array.from({length: 256}, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

function crcUpdate(crc, bytes) {
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

function localHeader(file) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(45, 4);
  header.writeUInt16LE(0x0808, 6);
  header.writeUInt32LE(0xffffffff, 18);
  header.writeUInt32LE(0xffffffff, 22);
  header.writeUInt16LE(file.nameBytes.length, 26);
  header.writeUInt16LE(20, 28);
  return header;
}

function localExtra(file) {
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(file.size, 4);
  extra.writeBigUInt64LE(file.size, 12);
  return extra;
}

function descriptor(file) {
  const data = Buffer.alloc(24);
  data.writeUInt32LE(0x08074b50, 0);
  data.writeUInt32LE(file.crc, 4);
  data.writeBigUInt64LE(file.size, 8);
  data.writeBigUInt64LE(file.size, 16);
  return data;
}

function centralHeader(file) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(45, 4);
  header.writeUInt16LE(45, 6);
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt32LE(file.crc, 16);
  header.writeUInt32LE(0xffffffff, 20);
  header.writeUInt32LE(0xffffffff, 24);
  header.writeUInt16LE(file.nameBytes.length, 28);
  header.writeUInt16LE(28, 30);
  header.writeUInt32LE(0xffffffff, 42);
  return header;
}

function centralExtra(file) {
  const extra = Buffer.alloc(28);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(24, 2);
  extra.writeBigUInt64LE(file.size, 4);
  extra.writeBigUInt64LE(file.size, 12);
  extra.writeBigUInt64LE(file.offset, 20);
  return extra;
}

function trailer(count, centralOffset, centralSize) {
  const data = Buffer.alloc(98);
  data.writeUInt32LE(0x06064b50, 0);
  data.writeBigUInt64LE(44n, 4);
  data.writeUInt16LE(45, 12);
  data.writeUInt16LE(45, 14);
  data.writeBigUInt64LE(BigInt(count), 24);
  data.writeBigUInt64LE(BigInt(count), 32);
  data.writeBigUInt64LE(centralSize, 40);
  data.writeBigUInt64LE(centralOffset, 48);
  data.writeUInt32LE(0x07064b50, 56);
  data.writeBigUInt64LE(centralOffset + centralSize, 64);
  data.writeUInt32LE(1, 72);
  data.writeUInt32LE(0x06054b50, 76);
  data.writeUInt16LE(0xffff, 84);
  data.writeUInt16LE(0xffff, 86);
  data.writeUInt32LE(0xffffffff, 88);
  data.writeUInt32LE(0xffffffff, 92);
  return data;
}

function waitDrain(output) {
  return new Promise((resolve, reject) => {
    const clean = () => {
      output.removeListener('drain', drained);
      output.removeListener('close', closed);
      output.removeListener('error', errored);
    };
    const drained = () => { clean(); resolve(); };
    const closed = () => { clean(); reject(Error('ZIP download closed')); };
    const errored = error => { clean(); reject(error); };
    output.once('drain', drained);
    output.once('close', closed);
    output.once('error', errored);
  });
}

async function streamZip(files, open, output) {
  let offset = 0n;
  const write = async bytes => {
    check(!output.destroyed, 'ZIP download closed');
    offset += BigInt(bytes.length);
    if (!output.write(bytes)) await waitDrain(output);
  };
  for (const file of files) {
    const entry = {...file, offset, crc: 0};
    await write(localHeader(entry));
    await write(entry.nameBytes);
    await write(localExtra(entry));
    const source = await open(entry);
    let received = 0n;
    let crc = 0xffffffff;
    for await (const chunk of source) {
      received += BigInt(chunk.length);
      check(received <= entry.size, 'Game file exceeded its indexed size: ' + entry.name);
      crc = crcUpdate(crc, chunk);
      await write(chunk);
    }
    check(received === entry.size, 'Game file ended before its indexed size: ' + entry.name);
    entry.crc = (crc ^ 0xffffffff) >>> 0;
    await write(descriptor(entry));
    file.offset = entry.offset;
    file.crc = entry.crc;
  }
  const centralOffset = offset;
  for (const file of files) {
    await write(centralHeader(file));
    await write(file.nameBytes);
    await write(centralExtra(file));
  }
  const centralSize = offset - centralOffset;
  await write(trailer(files.length, centralOffset, centralSize));
  return offset;
}

function sourcePath(name) {
  return '/' + name.split('/').map(encodeURIComponent).join('/');
}

async function startZipServer({index, sourcePort = 2121, title = 'OunceCake game files'}) {
  const {files, bytes} = catalog(index);
  check(Number.isInteger(sourcePort) && sourcePort >= 1 && sourcePort <= 65535,
    'Invalid OunceCake source port');
  let sourceAddress;
  const clients = new Set();
  const agent = new http.Agent({keepAlive: true, maxSockets: 1});
  const filename = title.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 64) || 'OunceCake';
  const server = http.createServer(async (request, response) => {
    if (request.url !== '/download-all.zip' || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404, {'Content-Length': '0'}).end();
      return;
    }
    if (!sourceAddress) {
      response.writeHead(503, {'Content-Length': '0'}).end();
      return;
    }
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="${filename}.zip"`);
    response.setHeader('Content-Length', bytes.toString());
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'HEAD') {
      response.writeHead(200).end();
      return;
    }
    clients.add(response);
    response.once('close', () => clients.delete(response));
    let currentUpstream;
    response.once('close', () => currentUpstream?.destroy());
    const open = file => new Promise((resolve, reject) => {
      const upstream = http.get({host: sourceAddress, port: sourcePort,
        path: sourcePath(file.name), agent, timeout: 30000}, incoming => {
        if (incoming.statusCode !== 200 || incoming.headers['content-length'] !== file.size.toString()) {
          incoming.destroy();
          reject(Error('OunceCake file response differed from its index: ' + file.name));
          return;
        }
        incoming.once('end', () => { if (currentUpstream === upstream) currentUpstream = undefined; });
        resolve(incoming);
      });
      currentUpstream = upstream;
      upstream.once('timeout', () => upstream.destroy(Error('OunceCake file download timed out')));
      upstream.once('error', reject);
    });
    try {
      response.writeHead(200);
      const written = await streamZip(files.map(file => ({...file})), open, response);
      check(written === bytes, 'ZIP length differed from the file index');
      response.end();
    } catch (error) {
      response.destroy(error);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    port: server.address().port,
    setSourceAddress(address) {
      check(net.isIPv4(address), 'Invalid OunceCake console address');
      sourceAddress = address;
    },
    async close() {
      sourceAddress = undefined;
      for (const response of clients) response.destroy();
      agent.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = {catalog, streamZip, startZipServer};
