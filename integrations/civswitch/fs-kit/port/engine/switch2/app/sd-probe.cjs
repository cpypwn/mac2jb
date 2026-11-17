// Read-only SD card filesystem probe from the application phase.
//
// Why this exists (RUN 88 / RUN 89): every fsp-srv command that creates a new
// object on the promoted root (cmd 18 OpenSdCardFileSystem, cmd 400
// OpenDeviceOperator) answers result 0 with one moved handle, but the first
// request on that handle dies with transport 0xF601 (ResultKernelConnectionClosed).
// CloneObject style handles (control 2 / control 1) stay usable, so the problem
// looks specific to sessions the server creates through the promoted root.
//
// This stage asks the same questions from the stock application process, BEFORE
// 2/4 replaces the retained root. Run with:
//   node app/sd-probe.cjs early   (after app/qualify, before 2/4)
//   node app/sd-probe.cjs late    (4/4, after the RO payload restores the loader)
// It never writes to the card and never closes a session it did not open.
const fs = require('node:fs/promises');
const path = require('node:path');
const {Session, live, u32, u64} = require('./session.cjs');
const {packet, response} = require('../../shared/ipc.cjs');
const filesystem = require('./filesystem.cjs');

const DIR_ENTRY = 0x310;

// Same wire shape as the engine's rawPathIpc: the path packet carries an inline
// X descriptor in the CMIF header padding, so it must be sent verbatim.
async function rawIpc(s, label, handle, bytes) {
  await s.write(s.base, bytes);
  const transport = await s.call('send', s.base, 4096, handle);
  if (transport) throw Error(label + ': transport 0x' + transport.toString(16));
  return response(await s.readOwned(s.base, 256));
}

async function pathIpc(s, label, handle, command, filename, input = Buffer.alloc(0)) {
  const name = Buffer.alloc(0x304);
  name.write(filename);
  await s.write(s.base + 0x2000, name);
  return rawIpc(s, label + ' ' + filename, handle, filesystem.pathPacket(command, input, s.base + 0x2000));
}

function space(reply) {
  return {result: reply.result, canonicalResult: reply.canonicalResult,
    copies: reply.copies, moves: reply.moves,
    bytes: reply.data.length >= 8 ? reply.data.readBigInt64LE().toString() : null};
}

async function readDirectory(s, label, directory, maxEntries = 64) {
  const entries = [];
  for (;;) {
    const reply = await s.ipc(label + ' ReadDirectory', directory, 0, Buffer.alloc(0),
      {receive: [{address: s.base + 0x6000, size: 4 * DIR_ENTRY, mode: 0}]});
    if (reply.result) throw Error(label + ' ReadDirectory result 0x' + reply.result.toString(16));
    const count = Number(reply.data.readBigUInt64LE());
    if (!count) return entries;
    const bytes = await s.readOwned(s.base + 0x6000, count * DIR_ENTRY);
    for (let index = 0; index < count; index++) {
      const item = bytes.subarray(index * DIR_ENTRY, (index + 1) * DIR_ENTRY);
      entries.push({name: item.subarray(0, 0x301).toString('utf8').split('\0')[0],
        type: item[0x304], size: item.readBigUInt64LE(0x308).toString()});
      if (entries.length >= maxEntries) return entries;
    }
  }
}

async function main() {
  const label = process.argv[2] || 'early';
  const proof = {label, session: live.session, started: new Date().toISOString(), steps: []};
  const record = (name, value) => {
    proof.steps.push({name, at: new Date().toISOString(), ...value});
    console.log(JSON.stringify({step: name, value}));
  };
  let session;
  try {
    session = new Session('sd-probe-' + label + '-' + Date.now());
    await session.initialize();
    record('session', {base: session.base, bytes: session.bytes});
    const root = await session.openService('fsp-srv');
    record('fsp-srv', {handle: root});
    const init = await session.ipc('SD probe Initialize fsp-srv', root, 1, u64(0), {pid: true});
    record('initialize', {result: init.result, canonicalResult: init.canonicalResult});
    const opened = await session.ipc('SD probe OpenSdCardFileSystem', root, 18);
    record('open-sd', {result: opened.result, canonicalResult: opened.canonicalResult,
      copies: opened.copies, moves: opened.moves});
    const handle = !opened.result && opened.moves.length === 1 && !opened.copies.length
      ? opened.moves[0] : null;
    proof.handle = handle;
    if (handle !== null) {
      // Any answer other than 0xF601 proves the session is alive; a sane size
      // proves it is the card's root filesystem.
      record('total-space', space(await pathIpc(session, 'SD GetTotalSpace', handle, 12, '/')));
      record('free-space', space(await pathIpc(session, 'SD GetFreeSpace', handle, 11, '/')));
      try {
        const directory = await pathIpc(session, 'SD OpenDirectory', handle, 9, '/', u32(3));
        record('open-directory', {result: directory.result, canonicalResult: directory.canonicalResult,
          copies: directory.copies, moves: directory.moves});
        if (!directory.result && directory.moves.length === 1 && !directory.copies.length) {
          const entries = await readDirectory(session, 'SD', directory.moves[0]);
          record('list-root', {count: entries.length, entries: entries.slice(0, 24)});
          proof.listing = entries;
        }
      } catch (error) {record('list-root-gap', {message: error.message});}
      proof.verified = true;
    }
  } catch (error) {
    proof.error = error.message;
    record('error', {message: error.message});
  } finally {
    if (session) {try {await session.cleanup();} catch (error) {record('cleanup-gap', {message: error.message});}}
  }
  proof.finished = new Date().toISOString();
  const file = path.join(__dirname, 'sd-probe-' + label + '.json');
  await fs.writeFile(file, JSON.stringify(proof, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify({file}));
}

main().catch(error => {console.error(error.stack); process.exitCode = 1;});
