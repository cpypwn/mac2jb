#!/usr/bin/env node
// Find the fsp-srv command that enumerates save-data archives on this build.
//
// The save-info reader is the missing piece for a whole-space dump: once it
// opens, ReadSaveDataInfo returns one entry per archive (program id, space, type,
// uid, size) and each can be pulled like any other save.
//
//   node probe-info-reader.cjs <run-directory>
//
// Read-only: it opens candidate readers and closes them. No save filesystem is
// opened, nothing is written, no commit is issued.
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const SPACES = {0: 'System', 1: 'User', 2: 'SdSystem', 3: 'Temporary', 4: 'SdUser'};
const TYPES = {0: 'System', 1: 'Account', 2: 'Bcat', 3: 'Device', 4: 'Temporary', 5: 'Cache'};

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

const code = value => '0x' + (Number(value) & 0x3fffff).toString(16);

async function main() {
  const [runDirectory] = process.argv.slice(2);
  if (!runDirectory) {
    console.error('usage: node probe-info-reader.cjs <run-directory>');
    process.exit(2);
  }
  const engine = path.join(path.resolve(runDirectory), 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const rootProof = JSON.parse(await fs.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  if (rootProof.session !== current.session || rootProof.pid !== 1 || !rootProof.rootHandle) {
    throw new Error('The run has no promoted fsp-srv root (expected pid 1)');
  }
  const root = rootProof.rootHandle;
  const {Session, u64} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  await request(current.socketPath, {command: 'root-native-info'});

  const s = new Session('probe-info-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  try {
    const fsp = await s.openService('fsp-srv');
    // FS validates against the calling process: without SetCurrentProcess (cmd 1,
    // sent with the pid option) every save command answers 0x2ee002.
    const init = await s.ipc('SetCurrentProcess', fsp, 1, u64(0), {pid: true});
    console.log('SetCurrentProcess -> ' + code(init.canonicalResult ?? init.result));
    // 1-byte space input, and the 0x40-byte SaveDataInfoFilter, tried against a
    // range of command ids because the numbering differs between fs versions.
    // switchbrew: 60 OpenSaveDataInfoReader takes NO input, 61
    // OpenSaveDataInfoReaderBySaveDataSpaceId takes an input u8 space, 68
    // OpenSaveDataInfoReaderWithFilter takes 0x50 bytes. ReadSaveDataInfo
    // (reader cmd 0) takes ONLY an output buffer and returns a u64 count.
    const spaces = [1, 0];                       // User first, then System
    const sized = length => {const b = Buffer.alloc(length); b[0] = 1; return b;};
    const candidates = [];
    candidates.push({command: 60, label: 'no input', payload: Buffer.alloc(0)});
    for (const space of spaces) {
      for (const length of [1, 4, 8]) {
        const payload = Buffer.alloc(length);
        payload[0] = space;
        candidates.push({command: 61, label: `space=${space} ${length}B`, payload});
      }
    }
    // Extra shapes the wiki documents: 68 takes 0x50 bytes (SaveDataFilter),
    // 84 lists the save-data owners this process may see.
    const filter50 = Buffer.alloc(0x50);
    filter50[0] = 0;                                  // SaveDataFilter type
    filter50[0x48] = 1;                               // space = User
    candidates.push({command: 68, label: '0x50 filter', payload: filter50});
    candidates.push({command: 62, label: 'cache storage', payload: Buffer.alloc(4)});
    candidates.push({command: 84, label: 'accessible owners', payload: Buffer.alloc(0)});

    for (const candidate of candidates) {
      const reply = await s.ipc(`open reader ${candidate.command} ${candidate.label}`,
        fsp, candidate.command, candidate.payload).catch(error => ({result: -1, error, moves: []}));
      const result = Number(reply.canonicalResult ?? reply.result ?? -1) & 0x3fffff;
      const moves = reply.moves ? reply.moves.length : 0;
      console.log(`cmd ${candidate.command} (${candidate.label}): ${code(result)} moves=${moves}`);
      if (result !== 0 || moves === 0) continue;

      const reader = domain.oneHandle(reply);
      try {
        const buffer = s.base + 0x8000;
        const stride = 0x38;                     // sizeof(SaveDataInfo)
        const slots = 64;
        await s.write(buffer, Buffer.alloc(stride * slots));
        const read = await s.ipc('ReadSaveDataInfo', reader, 0, Buffer.alloc(0),
          {receive: [{address: buffer, size: stride * slots, mode: 0}]});
        const readResult = Number(read.canonicalResult ?? read.result ?? -1) & 0x3fffff;
        const count = read.data && read.data.length >= 8 ? Number(read.data.readBigUInt64LE()) : -1;
        console.log(`  ReadSaveDataInfo -> ${code(readResult)} count=${count}`);
        if (readResult !== 0 || count <= 0) continue;
        const bytes = await s.read(buffer, stride * Math.min(count, slots));
        for (let i = 0; i < Math.min(count, slots); i++) {
          const entry = bytes.subarray(i * stride, (i + 1) * stride);
          const id = entry.readBigUInt64LE(0);
          const appId = entry.readBigUInt64LE(0x28);
          const size = entry.readBigUInt64LE(0x30);
          const uid = entry.subarray(0x10, 0x20).toString('hex');
          if (!id && !appId) continue;
          console.log(`    id=${id} space=${SPACES[entry[8]] ?? entry[8]} ` +
            `type=${TYPES[entry[9]] ?? entry[9]} uid=${uid} ` +
            `app=0x${appId.toString(16)} size=${size}`);
        }
      } finally {
        await s.close(reader).catch(() => {});
      }
      console.log('  ^ reader works; that is the command and shape to use.');
    }
    console.log('probe finished; command ids that returned OK above are the reader.');
  } finally {
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
