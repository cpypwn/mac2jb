'use strict';
// Ask the console for each title's own name, through ns.
//
// blawar/titledb is a Switch 1 catalogue, so a Switch 2 title can only be named
// by the console itself. ouncecake reads that through ns:ro (or ns:am2), which
// exposes a reader in command 7989; command 0 on that reader fills 0x4000 bytes
// of NACP for one title id.
//
// On the console this was measured on, ns is not usable from an application's SM:
// ns:ro was not even registered (0x615), and ns:am2's reader answered 0x5010 and
// then refused the send (0xf601). list-apps therefore reads the control NCA first
// (content-names.cjs, the path ouncecake falls back to) and only asks here for the
// titles that leaves unnamed, which is why this file keeps both buffer encodings.
//
// Two buffer encodings are tried, because which one a call wants is a property of
// the interface and only the console can say: the recv static ("pointer buffer",
// what ouncecake's fixed-output descriptor resolves to) first, then the map-alias
// descriptor. Whichever answers is used for the rest of the list; if neither does,
// every title keeps its id and the caller carries on.
//
// The session is passed in, not opened here, so this can be tested with a fake
// one. Every failure is a missing name, never an exception: a listing must not
// fail because a name could not be read.
const nacp = require('./nacp.cjs');

const OPEN_READER = 7989;
const READ_CONTROL = 0;
const NACP_SIZE = 0x4000;
const BUFFER = 0x10000;        // low half of the session's owned memory, unused

// An application's own SM refuses some services (ns:ro, ns:am2) - a smoke test
// here opened acc:u0 and fsp-srv but not those. The exploit's borrowed initialized
// SM client answers for them, so this is ouncecake's fallback (engine/session.cjs
// openServiceWithFallback): a hand-built GetService request on that SM handle.
const OPEN_SERVICE = 0x11;
const GET_SERVICE = 2;

async function rawService(s, sm, name) {
  const packet = Buffer.alloc(256);
  packet.writeUInt32LE(OPEN_SERVICE, 0);
  packet.writeUInt32LE(GET_SERVICE, 4);
  packet.write(name, 8);
  await s.write(s.base, packet);
  const transport = await s.call('send', s.base, 4096, sm);
  if (transport) throw Error('SM send refused: 0x' + transport.toString(16));
  const reply = await s.readOwned(s.base, 256);
  let at = 8, count = 0, handle = 0;
  if (reply.readUInt32LE(4) >>> 31) {
    const special = reply.readUInt32LE(at); at += 4;
    count = (special >>> 5) & 15;
    if (count) { handle = reply.readUInt32LE(at); at += 4; s.handles.add(handle); }
  }
  const result = reply.readUInt32LE(at);
  if (result || count !== 1 || !handle)
    throw Error('service unavailable: ' + name + ' (0x' +
      (result & 0x3fffff).toString(16) + ')');
  return handle;
}

async function openService(s, name, sm) {
  try {
    return await s.openService(name);
  } catch (error) {
    if (sm === undefined) throw error;
    return rawService(s, sm, name);
  }
}

const SHAPES = [
  {label: 'pointer', options: address => ({pointers: {receive: [{address, size: NACP_SIZE}]}})},
  {label: 'map-alias', options: address => ({receive: [{address, size: NACP_SIZE, mode: 0}]})},
];

async function readOne(s, reader, key, shape) {
  const address = s.base + BUFFER;
  const input = Buffer.alloc(16);
  input[0] = 1;
  input.writeBigUInt64LE(BigInt('0x' + key), 8);
  const reply = await s.ipc('Read title control data', reader, READ_CONTROL, input,
    shape.options(address));
  if (reply.result) return {result: reply.result};
  return {bytes: await s.readOwned(address, NACP_SIZE)};
}

async function read(s, ids, options = {}) {
  const note = options.note || (() => {});
  const names = {};
  let ns = null;
  for (const service of ['ns:ro', 'ns:am2']) {
    try {
      ns = await openService(s, service, options.sm);
      note('names: ' + service);
      break;
    } catch (error) {
      note('names: ' + service + ' unavailable (' + error.message + ')');
    }
  }
  if (ns === null) return names;

  let reader;
  try {
    const opened = await s.ipc('Open application name reader', ns, OPEN_READER, Buffer.alloc(0));
    if (opened.result || !opened.moves.length) {
      note('names: no control-data reader (0x' +
        (Number(opened.result) & 0x3fffff).toString(16) + ')');
      return names;
    }
    reader = opened.moves[0];
    let shape = null;
    for (const id of ids) {
      const key = String(id).toLowerCase().replace(/^0x/, '');
      let reply = null;
      if (shape) {
        reply = await readOne(s, reader, key, shape);
      } else {
        for (const candidate of SHAPES) {
          const attempt = await readOne(s, reader, key, candidate);
          if (!attempt.result) {
            shape = candidate;
            note('names: control data reads with the ' + shape.label + ' buffer');
            reply = attempt;
            break;
          }
          reply = attempt;
        }
        // The first refusal with nothing read means the read is not available at
        // all, not that this title has no name: stop instead of firing the list.
        if (!shape) {
          note('names: the console refused the control-data read (0x' +
            (Number(reply && reply.result) & 0x3fffff).toString(16) + ')');
          return names;
        }
      }
      if (reply.result) continue;
      const found = nacp.name(reply.bytes);
      if (found) names[key] = found;
    }
  } catch (error) {
    note('names: ' + error.message);
  } finally {
    if (reader !== undefined) await s.close(reader).catch(() => s.handles.delete(reader));
  }
  return names;
}

module.exports = {read, rawService, openService, SHAPES, OPEN_READER, OPEN_SERVICE,
  READ_CONTROL, NACP_SIZE, BUFFER};
