#!/usr/bin/env node
// List save-data entries known to FS, through a held run.cjs --rpc session.
//   node save-list.cjs <run-directory> [space]
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');

const SPACES = {0: 'System', 1: 'User', 2: 'SdSystem', 3: 'Temporary', 4: 'ProperSystem'};
const TYPES = {0: 'System', 1: 'Account', 2: 'Bcat', 3: 'Device', 4: 'Temporary', 5: 'Cache', 6: 'SystemBcat'};

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(120000, () => socket.destroy(new Error('timeout')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', part => { input += part; });
    socket.on('end', () => {
      try {
        const result = JSON.parse(input);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

async function main() {
  const [runDirectory, spaceText] = process.argv.slice(2);
  const space = Number(spaceText ?? 1);
  const engine = path.resolve(runDirectory, 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const {Session, u64} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));

  await request(current.socketPath, {command: 'root-native-info'});
  const s = new Session('save-list-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  try {
    const fsp = await s.openService('fsp-srv');
    const opened = await s.ipc('open save info reader', fsp, 61, Buffer.from([space]));
    console.log('reader result 0x' + (Number(opened.canonicalResult ?? opened.result) & 0x3fffff).toString(16),
      'moves', opened.moves.length);
    if (opened.result || !opened.moves.length) return;
    const reader = domain.oneHandle(opened);
    const buffer = s.base + 0x7000;
    const stride = 0x60;
    const slots = 16;
    await s.write(buffer, Buffer.alloc(stride * slots));
    const reply = await s.ipc('read save info', reader, 0, u64(0),
      {receive: [{address: buffer, size: stride * slots, mode: 0}]});
    console.log('read result 0x' + (Number(reply.canonicalResult ?? reply.result) & 0x3fffff).toString(16));
    const bytes = await s.read(buffer, stride * slots);
    for (let i = 0; i < slots; i++) {
      const e = bytes.subarray(i * stride, (i + 1) * stride);
      const id = e.readBigUInt64LE(0);
      const spaceId = e[8], type = e[9];
      const uid = e.subarray(0x10, 0x20).toString('hex');
      const appId = e.readBigUInt64LE(0x28);
      const size = e.readBigUInt64LE(0x30);
      if (!id && !appId) continue;
      console.log(`slot ${i}: id=${id} space=${SPACES[spaceId] ?? spaceId} type=${TYPES[type] ?? type} ` +
        `uid=${uid} app=0x${appId.toString(16)} size=${size}`);
    }
    await s.close(reader);
  } finally {
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => { console.error(error.message); process.exit(1); });
