#!/usr/bin/env node
// Pull another title's save data through a held run.cjs --rpc session.
//
//   node save-pull.cjs <run-directory> <program-id> <output-directory>
//
// Mounts the save with fsp-srv command 51 (OpenSaveDataFileSystem, see libnx
// fsOpenSaveDataFileSystem) and walks it read-only.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');

const SPACES = {0: 'System', 1: 'User', 2: 'SdSystem', 3: 'Temporary', 4: 'ProperSystem'};
const TYPES = {0: 'System', 1: 'Account', 2: 'Bcat', 3: 'Device', 4: 'Temporary'};

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(120000, () => socket.destroy(new Error('memory request timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', part => {
      input += part;
      if (input.length > 16 * 1024 * 1024) socket.destroy(new Error('reply exceeded its limit'));
    });
    socket.on('end', () => {
      try {
        const result = JSON.parse(input);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const [runDirectory, programText, outputDirectory] = process.argv.slice(2);
  if (!runDirectory || !programText || !outputDirectory) {
    console.error('usage: node save-pull.cjs <run-directory> <program-id> <output-directory>');
    process.exit(2);
  }
  const engine = path.resolve(runDirectory, 'switch2');
  const read = file => fs.readFile(file, 'utf8').then(JSON.parse);
  const current = await read(path.join(engine, 'current-acquisition.json'));
  const {Session} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  const filesystem = require(path.join(engine, 'app/filesystem.cjs'));

  const info = await request(current.socketPath, {command: 'root-native-info'});
  console.error(`attached to ${info.session || current.session}`);

  const s = new Session('save-pull-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  try {
    const fsp = await s.openService('fsp-srv');

    let uids = [Buffer.alloc(16)];
    try {
      const acc = await s.openService('acc:su');
      const address = s.base + 0x8000;
      await s.write(address, Buffer.alloc(0x80));
      const listed = await s.ipc('list account users', acc, 2, Buffer.alloc(0),
        {receive: [{address, size: 0x80, mode: 0}]});
      const count = listed.result ? 0 : listed.data.readUInt32LE(0);
      if (count > 0 && count <= 8) {
        const bytes = await s.read(address, count * 16);
        for (let i = 0; i < count; i++) uids.push(bytes.subarray(i * 16, i * 16 + 16));
        console.error(`account users: ${count}`);
      }
    } catch (error) {
      console.error('account enumeration failed:', error.message);
    }

    const programId = BigInt(/^0x/i.test(programText) ? programText : '0x' + programText);
    let handle = null;
    let chosen = null;
    search:
    for (const space of [1, 2, 0]) {
      for (const type of [1, 0]) {
        for (const uid of uids) {
          const input = Buffer.alloc(0x48);
          input[0] = space;
          input.writeBigUInt64LE(programId, 8);
          uid.copy(input, 16);
          input.writeBigUInt64LE(0n, 0x20);
          input[0x28] = type;
          const reply = await s.ipc('Open save data', fsp, 51, input);
          const code = Number(reply.canonicalResult ?? reply.result) & 0x3fffff;
          console.error(`  space=${SPACES[space]} type=${TYPES[type]} uid=${uid.toString('hex').slice(0, 8) || '0'} -> ${code ? '0x' + code.toString(16) : 'ok'}`);
          if (!reply.result && reply.moves.length === 1) {
            handle = domain.oneHandle(reply);
            chosen = {space, type, uid};
            break search;
          }
        }
      }
    }
    if (!handle) {
      console.error('no save filesystem opened for ' + programText);
      process.exit(1);
    }
    console.error(`mounted space=${SPACES[chosen.space]} type=${TYPES[chosen.type]} uid=${chosen.uid.toString('hex') || '0'}`);

    await fs.mkdir(outputDirectory, {recursive: true});
    let files = 0;
    let bytes = 0;
    async function walk(directory, disk) {
      const entries = await filesystem.listDirectory(s, handle, directory, 128);
      await fs.mkdir(disk, {recursive: true});
      for (const entry of entries) {
        const full = (directory.endsWith('/') ? directory : directory + '/') + entry.name;
        const target = path.join(disk, entry.name);
        const opened = await filesystem.openFile(s, handle, full);
        if (!opened.result) {
          const size = Number(await filesystem.fileSize(s, opened.handle));
          const file = await fs.open(target, 'w');
          let offset = 0;
          while (offset < size) {
            const chunk = Math.min(0x40000, size - offset);
            const data = await filesystem.readFile(s, opened.handle, offset, chunk);
            if (!data.length) throw Error(`short read at ${full} +${offset}`);
            await file.write(data);
            offset += data.length;
          }
          await file.close();
          await s.close(opened.handle);
          files += 1;
          bytes += size;
          console.error(`  ${full} (${size} bytes)`);
        } else {
          await walk(full, target);
        }
      }
    }
    await walk('/', outputDirectory);
    console.error(`done: ${files} files, ${bytes} bytes -> ${outputDirectory}`);
  } finally {
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
