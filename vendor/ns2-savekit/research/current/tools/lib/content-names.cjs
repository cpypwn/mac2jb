'use strict';
// A title's name out of its control NCA, for when the ns reader will not answer.
//
// This is ouncecake's second path (engine/content.cjs: resolveControlContent +
// controlName), and on this console it is the one that works: ns:ro had gone and
// ns:am2 answered its name command with 0x5010, while every title still named
// through here.
//
// The shape, one title at a time:
//   ncm    OpenContentMetaDatabase(storage)          5
//          GetLatestContentMetaKey(id)               6  -> the meta key
//          GetContentIdByType(key, Control)          3  -> the control NCA's id
//          GetContentInfo(key, Control)             24  -> attributes
//          OpenContentStorage(storage)               4
//   store  ResolvePath(contentId)                     8  -> the NCA's path
//   root   OpenContentFileSystem(attrs, Control, id, path)  10
//   fs     /control.nacp -> NACP -> name
//
// The session, domain, filesystem and promoted root are passed in, so the caller
// owns them and this file stays testable with fakes. A title that has no name is
// skipped; nothing here throws on one.
const nacp = require('./nacp.cjs');

const CONTROL = 3;            // NcmContentType_Control
const NACP_SIZE = 0x4000;     // one control NACP
const PATH_SIZE = 0x300;      // the resolved NCA path
const PATH_BUFFER = 0x2000;   // low half of the session's owned memory, unused
const OUT_BUFFER = 0x3000;
const DEFAULT_STORAGE = 4;    // BuiltInUser

function idBytes(id) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt('0x' + String(id).replace(/^0x/, '')));
  return bytes;
}

async function controlContent(s, db, id) {
  const latest = await s.ipc('Get latest content meta key', db, 6, idBytes(id));
  if (latest.result) return null;
  const key = Buffer.from(latest.data.subarray(0, 16));
  const input = Buffer.alloc(24);
  input[0] = CONTROL;
  key.copy(input, 8);
  const content = await s.ipc('Get control content id', db, 3, input);
  if (content.result) return null;
  const contentId = Buffer.from(content.data.subarray(0, 16));
  const info = await s.ipc('Get control content info', db, 24, input);
  if (info.result) return null;
  return {contentId, attributes: info.data[21] & 15};
}

// `packet(command, input, options)` is the run engine's shared/ipc.cjs builder:
// the recv static here is the fixed single output that ouncecake's fixedOutput
// builds, and the send static is its pathRequest.
async function nameOf({s, domain, filesystem, root, db, store, packet, id, note}) {
  const found = await controlContent(s, db, id);
  if (!found) return null;
  const pathAddress = s.base + PATH_BUFFER;
  const outAddress = s.base + OUT_BUFFER;
  const resolved = await domain.send(s, 'Resolve control NCA path', store,
    packet(8, found.contentId,
      {pointers: {receive: [{address: outAddress, size: PATH_SIZE, fixed: true}]}}));
  if (resolved.result) return null;
  const pathBytes = await s.readOwned(outAddress, PATH_SIZE);
  const end = pathBytes.indexOf(0);
  if (end <= 0) return null;
  const contentPath = pathBytes.subarray(0, end).toString('utf8');
  if (!contentPath) return null;
  const pathBuffer = Buffer.alloc(PATH_SIZE + 1);
  Buffer.from(contentPath).copy(pathBuffer);
  await s.write(pathAddress, pathBuffer);
  const openInput = Buffer.alloc(16);
  openInput[0] = found.attributes;
  openInput.writeUInt32LE(CONTROL, 4);
  idBytes(id).copy(openInput, 8);
  const mounted = await domain.send(s, 'Open control filesystem', root,
    packet(10, openInput,
      {pointers: {send: [{address: pathAddress, size: PATH_SIZE + 1}]}}));
  if (mounted.result || !mounted.moves.length) return null;
  const control = mounted.moves[0];
  try {
    const file = await filesystem.openFile(s, control, '/control.nacp');
    if (file.result) return null;
    try {
      const size = Number(await filesystem.fileSize(s, file.handle));
      if (size < NACP_SIZE) return null;
      return nacp.name(await filesystem.readFile(s, file.handle, 0, NACP_SIZE));
    } finally {
      await s.close(file.handle).catch(() => s.handles.delete(file.handle));
    }
  } finally {
    await s.close(control).catch(() => s.handles.delete(control));
  }
}

// `storages` maps a lowercase title id to the ncm storage it was listed from.
async function readTitles(options) {
  const {s, note = () => {}, ids, storages = {}} = options;
  const names = {};
  // Callers pass ids with or without 0x; compare on one spelling.
  const storageOf = {};
  for (const [id, storage] of Object.entries(storages))
    storageOf[String(id).toLowerCase().replace(/^0x/, '')] = storage;
  const databases = new Map();
  const stores = new Map();
  const close = async handle => {
    if (handle === null || handle === undefined) return;
    await s.close(handle).catch(() => s.handles.delete(handle));
  };
  const open = async (storage, command, label) => {
    const reply = await s.ipc(label + ' ' + storage, options.ncm, command, Buffer.from([storage]));
    if (reply.result || !reply.moves.length) return null;
    return reply.moves[0];
  };
  try {
    for (const id of ids) {
      const key = String(id).toLowerCase().replace(/^0x/, '');
      const storage = storageOf[key] ?? DEFAULT_STORAGE;
      try {
        if (!databases.has(storage))
          databases.set(storage, await open(storage, 5, 'Open content meta database'));
        if (!stores.has(storage))
          stores.set(storage, await open(storage, 4, 'Open content storage'));
        const db = databases.get(storage), store = stores.get(storage);
        if (!db || !store) continue;
        const value = await nameOf({...options, db, store, id: key});
        if (value) names[key] = value;
      } catch (error) {
        note(`content: ${key}: ${error.message}`);
      }
    }
  } finally {
    for (const handle of [...databases.values(), ...stores.values()]) await close(handle);
  }
  return names;
}

module.exports = {readTitles, controlContent, idBytes, CONTROL, NACP_SIZE, PATH_SIZE,
  PATH_BUFFER, OUT_BUFFER, DEFAULT_STORAGE};
