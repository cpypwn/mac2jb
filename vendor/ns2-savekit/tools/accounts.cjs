#!/usr/bin/env node
// List account uids and their nicknames through acc:u0.
//
//   node accounts.cjs <run-directory>
//
// The ListAllUsers call is copied from the working puller path (CMIF pointer
// output, 0x80 bytes), because the same call with a map-alias receive descriptor
// fails with transport 0xf601. GetProfile candidate ids are probed per uid and
// the first that answers is decoded for its nickname.
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const code = value => '0x' + (Number(value) & 0x3fffff).toString(16);

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(60000, () => socket.destroy(new Error('timeout')));
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

function nicknames(bytes) {
  const text = bytes.toString('utf8');
  const found = [];
  for (const match of text.matchAll(/[\x20-\x7e]{1,32}/g)) found.push(match[0]);
  return found;
}

async function main() {
  const [runDirectory] = process.argv.slice(2);
  if (!runDirectory) {
    console.error('usage: node accounts.cjs <run-directory>');
    process.exit(2);
  }
  const engine = path.join(path.resolve(runDirectory), 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const {Session, u64} = require(path.join(engine, 'app/session.cjs'));
  await request(current.socketPath, {command: 'root-native-info'});
  const s = new Session('accounts-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  try {
    const acc = await s.openService('acc:u0');
    const init = await s.ipc('acc InitializeApplicationInfo', acc, 140, u64(0), {pid: true});
    console.log('InitializeApplicationInfo', code(init.result));
    const at = s.base + 0x3000;
    await s.write(at, Buffer.alloc(0x80));
    const listed = await s.ipc('ListAllUsers', acc, 2, Buffer.alloc(0),
      {pointers: {receive: [{address: at, size: 0x80}]}});
    console.log('ListAllUsers', code(listed.result));
    if (listed.result) return;
    const bytes = await s.read(at, 0x80);
    const uids = [];
    for (let i = 0; i < 0x80 / 16; i++) {
      const uid = bytes.subarray(i * 16, (i + 1) * 16);
      if (uid.some(byte => byte !== 0)) uids.push(uid);
    }
    console.log('uids:', uids.map(uid => uid.toString('hex')).join(' '));

    const base = s.base + 0x5000;
    for (const uid of uids) {
      console.log('uid ' + uid.toString('hex'));
      for (const command of [4, 100, 101]) {
        for (const size of [0x200, 0x800, 0x1000]) {
          await s.write(base, Buffer.alloc(size));
          const reply = await s.ipc('GetProfile ' + command + '/' + size, acc, command, uid,
            {pointers: {receive: [{address: base, size}]}});
          const result = Number(reply.canonicalResult ?? reply.result) & 0x3fffff;
          if (result) { console.log(`  cmd ${command} size ${size} -> ${code(result)}`); continue; }
          const data = await s.read(base, size);
          let written = 0;
          for (const byte of data) if (byte) written++;
          const names = nicknames(data).filter(text => text.trim().length > 1);
          console.log(`  cmd ${command} size ${size} -> OK, ${written} bytes written, names ${JSON.stringify(names.slice(0, 3))}`);
          if (names.length) return;
        }
      }
    }
  } finally {
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
