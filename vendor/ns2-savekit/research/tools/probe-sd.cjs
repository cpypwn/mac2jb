#!/usr/bin/env node
// Is the SD card reachable through the promoted fsp-srv root?
//
//   node probe-sd.cjs <run-directory>
//
// We never checked fsp-srv's OpenSdCardFileSystem (switchbrew puts it at cmd 18,
// no input, returning an IFileSystem). If it opens here, the exploit gets a
// read-write view of sdmc: that is the storage the untethered payload wanted, and
// it exists outside the SmileBASIC Lua sandbox that refused sd:/.
//
// The probe tries a small range of ids because the numbering is the thing most
// likely to differ on this build, then lists '/' on whatever opens.
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const code = value => '0x' + (Number(value) & 0x3fffff).toString(16);

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(30000, () => socket.destroy(new Error('timeout')));
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
  const [runDirectory, firstArg, lastArg] = process.argv.slice(2);
  if (!runDirectory) {
    console.error('usage: node probe-sd.cjs <run-directory> [first] [last]');
    process.exit(2);
  }
  const first = Number(firstArg ?? 16);
  const last = Number(lastArg ?? 22);
  const engine = path.join(path.resolve(runDirectory), 'switch2');
  const current = JSON.parse(await fsp.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const rootProof = JSON.parse(await fsp.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  if (rootProof.session !== current.session || rootProof.pid !== 1 || !rootProof.rootHandle)
    throw Error('no promoted fsp-srv root in this run (expected pid 1)');
  const promoted = rootProof.rootHandle;
  const {Session, u64} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  const filesystem = require(path.join(engine, 'app/filesystem.cjs'));
  await request(current.socketPath, {command: 'root-native-info'});

  const s = new Session('probe-sd-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  // Two candidate sessions: a fresh fsp-srv opened through SM, and the promoted
  // root the acquisition left behind. The promoted handle is a post-RO artefact
  // and can answer `transport 0xf601` (the send itself refused) rather than a
  // command result, which is not an answer about the command; a fresh session
  // distinguishes "command refused" from "handle stale".
  const candidates = [];
  try {
    const fsp = await s.openService('fsp-srv');
    const init = await s.ipc('Initialize fsp-srv', fsp, 1, u64(0), {pid: true});
    console.error('fresh fsp-srv: ' + (init.result ? 'init ' + code(init.result) : 'initialized'));
    if (!init.result) candidates.push({label: 'fresh fsp-srv', handle: fsp});
  } catch (error) {
    console.error('fresh fsp-srv unavailable: ' + error.message.slice(0, 80));
  }
  candidates.push({label: 'promoted root', handle: promoted});

  try {
    for (const candidate of candidates) {
      for (let command = first; command <= last; command++) {
        let reply;
        try {
          reply = await s.ipc('sd cmd ' + command, candidate.handle, command, Buffer.alloc(0));
        } catch (error) {
          console.log(candidate.label + ' ' + command + ': ' + error.message.slice(0, 60));
          continue;
        }
        const result = Number(reply.canonicalResult ?? reply.result) & 0x3fffff;
        console.log(candidate.label + ' ' + command + ': ' + code(result) +
          (reply.moves.length ? ' handle' : '') + (reply.copies.length ? ' copy' : ''));
        if (result || reply.moves.length !== 1) continue;
        const handle = reply.moves[0];
        try {
          const entries = await filesystem.listDirectory(s, handle, '/', 24);
          console.log('   -> ' + entries.length + ' entries');
          for (const entry of entries.slice(0, 10)) {
            console.log('      ' + (entry.type === 1 ? '<dir> ' : String(entry.size).padStart(9) + ' ') + entry.name);
          }
        } catch (error) {
          console.log('   -> opened, listing failed: ' + error.message.slice(0, 60));
        }
        await s.close(handle).catch(() => {});
        break;
      }
    }
  } finally {
    await s.cleanup().catch(() => {});
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
