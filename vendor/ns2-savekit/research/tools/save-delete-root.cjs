#!/usr/bin/env node
// Delete a file from another title's save data through the exploit's promoted
// (pid=1) fsp-srv root, then commit.
//
//   node save-delete-root.cjs <run-directory> <program-id> <uid-hex> <save-path>
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(120000, () => socket.destroy(new Error('memory request timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', part => {input += part;});
    socket.on('end', () => {
      try {
        const result = JSON.parse(input);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) {reject(error);}
    });
  });
}

const code = value => '0x' + (Number(value) & 0x3fffff).toString(16);
const check = (ok, message) => {if (!ok) throw Error(message);};

async function main() {
  const [runDirectory, programText, uidText, savePath] = process.argv.slice(2);
  if (!runDirectory || !programText || !uidText || !savePath) {
    console.error('usage: node save-delete-root.cjs <run-directory> <program-id> <uid-hex> <save-path>');
    process.exit(2);
  }
  const run = path.resolve(runDirectory);
  const engine = path.join(run, 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const rootProof = JSON.parse(await fs.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  check(rootProof.session === current.session && rootProof.pid === 1 && rootProof.rootHandle,
    'The run has no promoted fsp-srv root');
  const root = rootProof.rootHandle;
  const {Session} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  const {packet} = require(path.join(run, 'shared/ipc.cjs'));
  const programId = BigInt(/^0x/i.test(programText) ? programText : '0x' + programText);
  const uid = Buffer.from(uidText.replace(/^0x/i, ''), 'hex');
  check(uid.length === 16, 'uid must be the raw 16-byte AccountUid');

  await request(current.socketPath, {command: 'root-native-info'});
  const s = new Session('save-delete-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();

  const pathCall = async (handle, command, name) => {
    const text = Buffer.from(name, 'utf8');
    check(name.startsWith('/') && text.length < 0x301, 'Invalid path ' + name);
    const buffer = Buffer.alloc(0x304);
    text.copy(buffer);
    const address = s.base + 0x2000;
    await s.write(address, buffer);
    const bytes = packet(command, Buffer.alloc(0));
    const a = BigInt(address);
    bytes.writeUInt32LE((4 | 1 << 16) >>> 0);
    bytes.writeUInt32LE(Number(0x301n << 16n | (a >> 36n & 7n) << 6n |
      ((a >> 32n) & 15n) << 12n), 8);
    bytes.writeUInt32LE(Number(a & 0xffffffffn), 12);
    return domain.send(s, 'DeleteFile ' + name, handle, bytes);
  };

  let save = null;
  try {
    const input = Buffer.alloc(0x48);
    input[0] = 1;
    input.writeBigUInt64LE(programId, 8);
    uid.copy(input, 0x10);
    input[0x28] = 1;
    const opened = await s.ipc('Open save read-write', root, 51, input);
    check(!opened.result && opened.moves.length === 1, 'Save open failed: ' + code(opened.result));
    save = opened.moves[0];
    const reply = await pathCall(save, 1, savePath);
    console.log('delete', savePath, '->', code(reply.canonicalResult ?? reply.result));
    const commit = await s.ipc('Commit save data filesystem', save, 10);
    console.log('commit ->', code(commit.result));
    check(!commit.result, 'Commit failed');
  } finally {
    if (save !== null) await s.close(save).catch(() => s.handles.delete(save));
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => {console.error('FAILED:', error.message); process.exit(1);});
