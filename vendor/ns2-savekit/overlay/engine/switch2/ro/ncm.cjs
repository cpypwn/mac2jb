// Read-only enumeration of installed, full system-program content metadata.
// This is a bounded NCM IPC query, never a raw NAND or generic memory read.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const check = (ok, message) => {if (!ok) throw Error(message);};
const CAPACITY = 1024;
const KEY_SIZE = 16;

function listInput(metaType = 1, installType = 0) {
  const data = Buffer.alloc(32);
  data[0] = metaType; // NcmContentMetaType
  data[1] = installType; // NcmContentInstallType
  data.writeBigUInt64LE(0xffffffffffffffffn, 24);
  return data;
}

function parse(reply, bytes) {
  check(!reply.result && reply.data.length >= 8, 'NCM list returned an error or short reply');
  const total = reply.data.readInt32LE(0), written = reply.data.readInt32LE(4);
  check(total >= 0 && written >= 0 && written <= CAPACITY && written <= total &&
    bytes.length === CAPACITY * KEY_SIZE, 'NCM list count or output buffer is invalid');
  const keys = [];
  for (let i = 0; i < written; i++) {
    const at = i * KEY_SIZE;
    keys.push({id: '0x' + bytes.readBigUInt64LE(at).toString(16).padStart(16, '0'),
      version: bytes.readUInt32LE(at + 8), type: bytes[at + 12], installType: bytes[at + 13]});
  }
  return {total, written, complete: total === written, keys};
}

async function listSystem(context, request, state) {
  const {s, live, save} = context;
  const handle = Number(request.handle);
  const dumpDirectory = process.env.NS2_FIRMWARE_DUMP_DIR;
  check(!request.dumpOutput || dumpDirectory && path.isAbsolute(dumpDirectory),
    'Firmware inventory requires a dedicated output directory');
  check(state.services?.some(item => item.name === 'ncm' && item.handle === handle) && s.handles.has(handle) &&
    !s.threads.size, 'NCM enumeration requires an owned service and idle native worker');
  const storage = Number(request.storage ?? 3), metaType = Number(request.metaType ?? 1);
  const installType = Number(request.installType ?? 0);
  const opened = await s.ipc('NCM OpenContentMetaDatabase ' + storage, handle, 5, Buffer.from([storage]));
  if (opened.result) throw Error('NCM metadata database ' + storage + ' open failed: 0x' +
    (opened.canonicalResult ?? (opened.result & 0x3fffff)).toString(16));
  check(opened.moves.length === 1 && !opened.copies.length,
    'NCM metadata database returned an invalid handle');
  const database = opened.moves[0], address = s.base + 0x4000;
  const length = CAPACITY * KEY_SIZE;
  let safeToClose = false;
  try {
    check(address + length <= s.base + s.bytes, 'Owned NCM output allocation is too small');
    await s.write(address, Buffer.alloc(length));
    const reply = await s.ipc('NCM List content meta', database, 5, listInput(metaType, installType),
      {receive: [{address, size: length, mode: 0}]});
    const bytes = await s.readOwned(address, length);
    safeToClose = true;
    const listed = parse(reply, bytes);
    const rawFile = request.dumpOutput ? path.join(dumpDirectory, 'ncm-system-programs.bin') :
      path.join(__dirname, live.session + '-ncm-' + storage + '-' + metaType + '.bin');
    await fs.writeFile(rawFile, bytes, {mode: 0o600});
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const result = {at: new Date().toISOString(), storage, metaType, installType,
      ...listed, rawFile, sha256};
    (state.ncmInventories ||= []).push(result);
    await save();
    return result;
  } finally {
    // A timed-out/uncertain IPC must not be followed by a new console request.
    if (safeToClose) await s.close(database);
  }
}

module.exports = {listInput, parse, listSystem};
