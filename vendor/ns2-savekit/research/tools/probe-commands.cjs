#!/usr/bin/env node
// What does fsp-srv actually implement on this build?
//
//   node probe-commands.cjs <run-directory> [first] [last]
//
// Sends each command id with an empty input and records the result code, so ids
// that exist can be told apart from ids that do not. Everything is sent WITHOUT a
// valid SaveDataAttribute, so a destructive command cannot match a real save: the
// worst case is the same "not found" answer a wrong uid gets.
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

const code = v => '0x' + (Number(v) & 0x3fffff).toString(16);

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
    console.error('usage: node probe-commands.cjs <run-directory> [first] [last]');
    process.exit(2);
  }
  const first = Number(firstArg ?? 0);
  const last = Number(lastArg ?? 120);
  const engine = path.join(path.resolve(runDirectory), 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const {Session, u64} = require(path.join(engine, 'app/session.cjs'));
  const domain = require(path.join(engine, 'app/domain.cjs'));
  await request(current.socketPath, {command: 'root-native-info'});

  // The working tools do not openService at all: they reuse the promoted root handle
  // recorded for this run and send raw CMIF to it. Every earlier attempt here opened
  // a fresh fsp-srv handle, which is why nothing it sent was accepted.
  const rootProof = JSON.parse(await fs.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  if (rootProof.session !== current.session || rootProof.pid !== 1 || !rootProof.rootHandle)
    throw Error('The run has no promoted fsp-srv root (expected pid 1)');
  const root = rootProof.rootHandle;
  const s = new Session('probe-cmds-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();
  // Warning: an unknown id leaves the session unusable - after a sweep even the
  // puller answers transport 0xf601 and the console has to be restarted. Start the
  // range at a known-good id (53 or 62) when calibrating.
  if (first === 0) console.error('warning: command 0 wedges the session; starting at 0 is not safe');
  const byResult = new Map();
  try {
    for (let command = first; command <= last; command++) {
      let result, moves = 0, copies = 0;
      try {
        const reply = await s.ipc('cmd ' + command, root, command, Buffer.alloc(0));
        result = Number(reply.canonicalResult ?? reply.result) & 0x3fffff;
        moves = reply.moves.length;
        copies = reply.copies.length;
        for (const handle of [...reply.moves, ...reply.copies]) await s.close(handle).catch(() => {});
      } catch (error) {
        const transport = /transport (?:failed )?0x([0-9a-f]+)/i.exec(error.message || '');
        result = transport ? 'xport ' + transport[1] : (error.message || 'threw').slice(0, 50);
      }
      const key = String(result);
      if (!byResult.has(key)) byResult.set(key, []);
      byResult.get(key).push(command + (moves || copies ? `(+${moves}m/${copies}c)` : ''));
    }
  } finally {
    await s.cleanup().catch(() => {});
  }
  for (const [result, commands] of [...byResult.entries()].sort()) {
    console.log(`${result.padEnd(8)} ${commands.join(' ')}`);
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
