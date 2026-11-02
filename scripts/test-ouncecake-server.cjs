'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deployServer } = require('../vendor/OunceCake/engine/server.cjs');

function fixture(failure) {
  const sdk = 2 ** 32;
  const base = 2 ** 33;
  const thread = 2 ** 34;
  const destination = 2 ** 35;
  const trace = [];
  let clock = 0;
  let stopping = false;
  const names = [
    '_ZN2nn6socket6SocketEiii', '_ZN2nn6socket4BindEiPKNS0_8SockAddrEj',
    '_ZN2nn6socket6ListenEii', '_ZN2nn6socket6AcceptEiPNS0_8SockAddrEPj',
    '_ZN2nn6socket4RecvEiPvmi', '_ZN2nn6socket4SendEiPKvmi',
    '_ZN2nn6socket5CloseEi', '_ZN2nn6socket4PollEPNS0_6PollFdEmi',
    '_ZN2nn6socket11GetSockNameEiPNS0_8SockAddrEPj', '_ZN2nn6socket5FcntlEiiz',
    '_ZN2nn6socket12GetLastErrnoEv', '_ZN2nn6socket10SetSockOptEiiiPKvj',
    '_ZN2nn6socket7ConnectEiPKNS0_8SockAddrEj',
  ];
  const strings = Buffer.from('\0' + names.join('\0') + '\0');
  const symbols = Buffer.alloc(names.length * 24);
  let stringAt = 1;
  names.forEach((name, index) => {
    const at = index * 24;
    symbols.writeUInt32LE(stringAt, at);
    symbols[at + 4] = 2;
    symbols.writeUInt16LE(1, at + 6);
    symbols.writeBigUInt64LE(BigInt(0x4000 + index * 64), at + 8);
    symbols.writeBigUInt64LE(32n, at + 16);
    stringAt += Buffer.byteLength(name) + 1;
  });

  class Session {
    constructor() {
      this.base = 0;
      this.handles = new Set();
      this.threads = new Set();
    }
    async initialize() { trace.push('initialize'); this.base = base; }
    async verifyCode() {
      trace.push('verify');
      if (failure === 'signature') throw Error('instructions differ');
    }
    async read(address, size) {
      const output = Buffer.alloc(size);
      if (address === sdk) { output.writeInt32LE(0x100, 4); return output; }
      if (address === sdk + 0x100) { output.write('MOD0'); output.writeInt32LE(0x100, 4); return output; }
      if (address === sdk + 0x200) {
        [[4, 0x1000], [5, 0x2000], [6, 0x3000], [10, strings.length], [11, 24]]
          .forEach(([tag, value], index) => {
            output.writeBigInt64LE(BigInt(tag), index * 16);
            output.writeBigUInt64LE(BigInt(value), index * 16 + 8);
          });
        return output;
      }
      if (address === sdk + 0x1000) { output.writeUInt32LE(names.length, 4); return output; }
      if (address === sdk + 0x2000) return strings;
      if (address === sdk + 0x3000) return symbols;
      throw Error('Unexpected metadata read');
    }
    async readOwned(address, size) {
      const output = Buffer.alloc(size);
      if (address === base + 0xa000) {
        output.writeBigUInt64LE(BigInt(thread));
        return output;
      }
      if (address === base + 0x4000) {
        output.writeUInt32LE(stopping ? 2 : failure === 'startup' ? 0 : 1, 16);
        output[56] = 192; output[57] = 0; output[58] = 2; output[59] = 44;
        return output;
      }
      throw Error('Unexpected owned read');
    }
    async write(address) {
      if (address === base + 0x400c) { trace.push('stop'); stopping = true; }
      else trace.push('write');
    }
    async ipc(label, handle, command) {
      if (command === 0x524f0012) {
        trace.push('map');
        if (failure === 'map') throw Error('mapping uncertain');
      }
      if (command === 0x524f0013) {
        trace.push('unmap');
        if (failure === 'unmap') throw Error('unmap failed');
      }
      const process = label === 'Server verify application process';
      const data = Buffer.alloc(process && failure === 'short-reply' ? 32 : 104);
      data.writeBigUInt64LE(process && failure === 'bad-pid' ? 0n : 77n);
      if (data.length >= 96)
        data.writeBigUInt64LE(BigInt(process && failure === 'bad-address' ? destination + 1 : destination), 88);
      return { result: process && failure === 'process-error' ? 5 : 0, data };
    }
    async cleanup() {
      trace.push('free');
      if (failure !== 'cleanup-deferred') this.base = 0;
    }
    rpc = {
      query: async () => ({ result: 0, permissions: 5, attributes: 0, address: sdk, size: 0x5e1000 }),
      call4: async () => {
        trace.push('create');
        if (failure === 'create') throw Error('native create uncertain');
        return 0;
      },
      call3: async (address) => {
        if (address === sdk + 1217808) {
          trace.push('tryWait');
          return failure === 'stop-timeout' ? 0 : 1;
        }
        trace.push('join');
        return failure === 'join' ? 5 : 0;
      },
    };
  }

  const attachment = {
    Session,
    live: { sdk },
    s: { threads: new Set() },
    async service() { return 7; },
  };
  const options = {
    attachment,
    image: Buffer.alloc(16180),
    index: Buffer.alloc(64),
    sources: [{ handle: 7, kind: 0, size: 0 }],
    port: 2121,
    timing: { now: () => clock, pause: async (ms) => { clock += ms; }, startupMs: 100, stopMs: 100 },
  };
  return { options, trace };
}

test('native server proves stop and join before unmapping and freeing', async () => {
  const { options, trace } = fixture();
  const server = await deployServer(options);
  assert.equal(server.address, '192.0.2.44');
  const proof = await server.close();
  assert.deepEqual(proof, { nativeStopped: true, joined: true, mappingsCleared: true });
  assert.equal(trace.filter((step) => step === 'verify').length, 5);
  assert.ok(trace.indexOf('join') < trace.indexOf('unmap'));
  assert.ok(trace.lastIndexOf('unmap') < trace.indexOf('free'));
  const count = trace.length;
  assert.deepEqual(await server.close(), proof);
  assert.equal(trace.length, count);
});

for (const failure of ['map', 'create', 'stop-timeout', 'join']) {
  test(`${failure} cannot release uncertain native resources`, async () => {
    const { options, trace } = fixture(failure);
    const task = ['stop-timeout', 'join'].includes(failure)
      ? (await deployServer(options)).close() : deployServer(options);
    await assert.rejects(task, (error) => error.cleanupBlocked === true);
    assert.equal(trace.includes('unmap'), false);
    assert.equal(trace.includes('free'), false);
    if (failure === 'stop-timeout') assert.equal(trace.includes('join'), false);
  });
}

test('failed unmap and deferred allocation cleanup cannot claim shutdown', async () => {
  for (const failure of ['unmap', 'cleanup-deferred']) {
    const { options, trace } = fixture(failure);
    const server = await deployServer(options);
    await assert.rejects(server.close(), (error) => error.cleanupBlocked === true);
    if (failure === 'unmap') assert.equal(trace.includes('free'), false);
  }
});

test('startup timeout stops and joins before freeing', async () => {
  const { options, trace } = fixture('startup');
  await assert.rejects(deployServer(options), /did not confirm listening/);
  assert.ok(trace.indexOf('join') < trace.indexOf('unmap'));
  assert.equal(trace.includes('free'), true);
});

for (const failure of ['signature', 'short-reply', 'bad-pid', 'bad-address', 'process-error']) {
  test(`${failure} refuses executable mapping`, async () => {
    const { options, trace } = fixture(failure);
    await assert.rejects(deployServer(options));
    assert.equal(trace.includes('map'), false);
    assert.equal(trace.includes('create'), false);
  });
}
