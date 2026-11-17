const {loadTarget, nativeOffset} = require('../shared/target.cjs');

const REQUEST_BYTES = 0x8080;
const OUTPUT_BYTES = 0x8000;
const RESPONSE_BYTES = 16 + OUTPUT_BYTES;
const INPUT_OFFSET = 0x40000;
const DATA_OFFSET = 0x80;
const OUTPUT_OFFSET = 0x4040;
const PROGRESS_MAGIC = 0x47504353;
const COMPACT_MAGIC = 0x504d4347;
const COMPACT_HEADER_BYTES = 0x80;

function callRecord(sdk, offset, args, target = loadTarget()) {
  if (!Number.isSafeInteger(sdk) || sdk < 0x1000 || sdk >= 2 ** 39 || sdk % 4 ||
      !Number.isInteger(offset) || offset < 0 || offset >= target.sdkBytes || offset % 4 || args.length !== 4)
    throw Error('Invalid SDK function or argument count');
  // JSON carries BigInt arguments as decimal strings.
  if (args.some(value => typeof value !== 'bigint' && !Number.isSafeInteger(value) &&
      !(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value))))
    throw Error('Native arguments must be exact integers; use BigInt for values above 2^53');
  const words = [BigInt(sdk + offset), ...args.map(BigInt)];
  if (words.some(value => value < 0n || value > 0xffffffffffffffffn))
    throw Error('Native arguments must fit uint64');
  const bytes = Buffer.alloc(40);
  words.forEach((value, index) => bytes.writeBigUInt64LE(value, index * 8));
  return bytes;
}

class NativeClient {
  constructor(connection, addresses, target = loadTarget(addresses.target || undefined)) {
    this.connection = connection;
    this.addresses = addresses;
    this.target = target;
    this.offsets = Object.fromEntries(['memcpy', 'memmove', 'queryMemory'].map(name =>
      [name, nativeOffset(name, target)]));
    this.output = addresses.scratch + OUTPUT_OFFSET;
    this.queue = Promise.resolve();
    this.calls = 0;
    this.functions = new Set();
    this.compact = false;
    this.verifiedRegions = [];
  }

  async negotiateCompact() {
    if (this.target.name !== 'gravcirc') return false;
    const packet = Buffer.alloc(REQUEST_BYTES);
    packet.writeUInt32LE(COMPACT_MAGIC, 16);
    const task = this.queue.then(async () => {
      await this.connection.write(packet);
      const reply = await this.connection.read(RESPONSE_BYTES);
      const marker = reply.readBigUInt64LE();
      const version = reply.readBigUInt64LE(8);
      if (marker === BigInt(COMPACT_MAGIC) && version === 1n) this.compact = true;
      else if (marker !== 0n || version !== 0n)
        throw Error('Unexpected Gravity Circuit transport negotiation response');
      return this.compact;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  exchange(calls, data = Buffer.alloc(0), outputBytes = 0) {
    if (calls.length < 1 || calls.length > 2 || data.length > 0x8000 ||
        !Number.isInteger(outputBytes) || outputBytes < 0 || outputBytes > OUTPUT_BYTES)
      return Promise.reject(Error('Invalid native request'));
    const compact = this.compact;
    const packet = Buffer.alloc(compact ? COMPACT_HEADER_BYTES + data.length : REQUEST_BYTES);
    const operations = [...calls];
    if (operations.length === 1)
      operations.push({offset: this.offsets.memmove, args: [this.output, this.output, 0, 0]});
    operations.forEach(({offset, address, args, continuation}, index) => {
      if (continuation) {
        if (index !== 1 || args.length !== 2)
          throw Error('Invalid six-argument continuation');
        callRecord(this.addresses.sdk, 0, [...args, 0, 0], this.target).copy(packet, index * 40);
        packet.writeBigUInt64LE(2n, index * 40);
        return;
      }
      if (address !== undefined && !this.functions.has(address))
        throw Error('Native function has not been verified');
      callRecord(address ?? this.addresses.sdk, address === undefined ? offset : 0, args, this.target).copy(packet, index * 40);
    });
    if (compact) {
      packet.writeUInt32LE(COMPACT_MAGIC, 0x50);
      packet.writeBigUInt64LE(BigInt(data.length), 0x58);
      packet.writeBigUInt64LE(BigInt(outputBytes), 0x60);
    }
    data.copy(packet, DATA_OFFSET);
    const task = this.queue.then(async () => {
      const tag = calls.map(c => '0x' + (c.offset ?? c.address ?? 0).toString(16)).join(',');
      process.stderr.write(`[exchange] start ${tag}\n`);
      await this.connection.write(packet);
      const bytes = await this.connection.read(compact ? 16 + outputBytes : RESPONSE_BYTES);
      process.stderr.write(`[exchange] done ${tag}\n`);
      this.calls += calls.filter(call => !call.continuation).length;
      return {results: [bytes.readBigUInt64LE(8), bytes.readBigUInt64LE()],
        result: bytes.readBigUInt64LE(8), output: bytes.subarray(16)};
    });
    this.queue = task.catch(() => {});
    return task;
  }

  call(offset, ...args) {
    if (args.length > 4) return Promise.reject(Error('At most four native arguments are supported'));
    while (args.length < 4) args.push(0);
    return this.exchange([{offset, args}]);
  }

  progress(step) {
    if (this.target.name !== 'gravcirc' || !Number.isInteger(step) || step < 1 || step > 6)
      return Promise.reject(Error('Invalid Gravity Circuit progress step'));
    const compact = this.compact;
    const packet = Buffer.alloc(compact ? COMPACT_HEADER_BYTES : REQUEST_BYTES);
    packet.writeUInt32LE(PROGRESS_MAGIC, 16);
    if (compact) packet.writeUInt32LE(COMPACT_MAGIC, 0x50);
    packet.writeBigUInt64LE(BigInt(step), 24);
    const task = this.queue.then(async () => {
      await this.connection.write(packet);
      const bytes = await this.connection.read(compact ? 16 : RESPONSE_BYTES);
      if (bytes.readBigUInt64LE() !== BigInt(PROGRESS_MAGIC) ||
          bytes.readBigUInt64LE(8) !== BigInt(step))
        throw Error('Gravity Circuit console did not acknowledge FS progress');
      return {shown: true};
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async verifyFunction(address, expected) {
    if (!Number.isSafeInteger(address) || address < 0x1000 || address % 4 ||
        !Buffer.isBuffer(expected) || expected.length < 4 || expected.length > 256 || expected.length % 4)
      throw Error('Invalid native function signature');
    const region = await this.query(address);
    if (region.permissions !== 5 || region.attributes ||
        BigInt(address + expected.length) > region.address + region.size ||
        !(await this.read(address, expected.length)).equals(expected))
      throw Error('Native function mapping or instructions differ');
    this.functions.add(address);
  }

  callAddress(address, ...args) {
    if (args.length > 4) return Promise.reject(Error('At most four native arguments are supported'));
    while (args.length < 4) args.push(0);
    return this.exchange([{address, args}]);
  }

  callAddress6(address, ...args) {
    if (args.length !== 6) return Promise.reject(Error('Exactly six native arguments are required'));
    return this.exchange([{address, args: args.slice(0, 4)},
      {continuation: true, args: args.slice(4)}]);
  }

  async query(address) {
    const {result, output: bytes} = await this.exchange([{
      offset: this.offsets.queryMemory,
      args: [this.output, this.output + 0x40, address, 0]
    }], Buffer.alloc(0), 0x40);
    if (result) throw Error('QueryMemory failed: 0x' + result.toString(16));
    return {address: bytes.readBigUInt64LE(), size: bytes.readBigUInt64LE(8),
      type: bytes.readUInt32LE(16), attributes: bytes.readUInt32LE(20),
      permissions: bytes.readUInt32LE(24), ipcReferences: bytes.readUInt32LE(28),
      deviceReferences: bytes.readUInt32LE(32)};
  }

  async guard(address, length, permission) {
    if (!Number.isSafeInteger(address) || address < 0x1000 || !Number.isInteger(length) ||
        length < 1 || address + length >= 2 ** 39)
      throw Error('Invalid application memory span');
    const spanEnd = address + length;
    // Cache previously-verified mapped spans so the dominant per-read/write
    // svcQueryMemory re-validation is skipped. The scratch + app arena are
    // stable for the whole run, so a span proven once stays proven.
    for (const region of this.verifiedRegions) {
      if (region.start <= address && spanEnd <= region.end &&
          (region.permissions & permission) === permission) return;
    }
    for (let at = address; at < spanEnd;) {
      const region = await this.query(at);
      const end = Number(region.address + region.size);
      if (Number(region.address) > at || end <= at ||
          (region.permissions & permission) !== permission || region.ipcReferences ||
          [0, 1, 16].includes(region.type))
        throw Error('Application memory is inaccessible or reserved by IPC');
      this.verifiedRegions.push({start: Number(region.address), end, permissions: region.permissions});
      at = end;
    }
  }

  async read(address, length) {
    if (length === 0) return Buffer.alloc(0);
    await this.guard(address, length, 1);
    const parts = [];
    for (let at = 0; at < length; at += OUTPUT_BYTES) {
      const count = Math.min(OUTPUT_BYTES, length - at);
      const reply = await this.exchange([{
        offset: this.offsets.memcpy,
        args: [this.output, address + at, count, 0]
      }], Buffer.alloc(0), count);
      if (reply.result !== BigInt(this.output)) throw Error('Native memory read failed');
      parts.push(reply.output.subarray(0, count));
    }
    return Buffer.concat(parts);
  }

  async write(address, bytes) {
    if (!Buffer.isBuffer(bytes)) throw Error('Expected a byte buffer');
    if (bytes.length === 0) return;
    await this.guard(address, bytes.length, 2);
    for (let at = 0; at < bytes.length; at += 0x8000) {
      const part = bytes.subarray(at, at + 0x8000);
      const args = [address + at, this.addresses.scratch + INPUT_OFFSET + DATA_OFFSET, part.length, 0];
      const reply = await this.exchange([{offset: this.offsets.memmove, args}], part);
      if (reply.result !== BigInt(address + at)) throw Error('Native memory write failed');
    }
  }

  async stop() {
    try {
      await this.queue;
      if (!this.connection.error) await this.connection.write(Buffer.alloc(this.compact ? COMPACT_HEADER_BYTES : REQUEST_BYTES));
    } finally {this.connection.close();}
  }
}

module.exports = {NativeClient, callRecord, REQUEST_BYTES, RESPONSE_BYTES, OUTPUT_BYTES};
