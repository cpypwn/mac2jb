const {response} = require('../../shared/ipc.cjs');
const {temporaryStorageInput, spacePacket} = require('./storage-probe-protocol.cjs');

async function querySpace(session, handle, command) {
  const path = Buffer.alloc(0x304);
  path[0] = 0x2f;
  await session.write(session.base + 0x2000, path);
  await session.write(session.base, spacePacket(command, session.base + 0x2000));
  const transport = await session.call('send', session.base, 4096, handle);
  if (transport) throw Error('Filesystem space request transport 0x' + transport.toString(16));
  const reply = response(await session.readOwned(session.base, 256));
  for (const returned of [...reply.copies, ...reply.moves]) session.handles.add(returned);
  if (reply.copies.length || reply.moves.length)
    throw Error('Filesystem space request returned an unexpected handle');
  if (reply.result) return {result: reply.result, canonicalResult: reply.canonicalResult, bytes: null};
  if (reply.data.length < 8) throw Error('Filesystem space reply has no size');
  const bytes = reply.data.readBigInt64LE();
  if (bytes < 0n) throw Error('Filesystem space reply is negative');
  return {result: 0, canonicalResult: 0, bytes: bytes.toString()};
}

async function probeFilesystem(session, root, name, command, data, spaceReader) {
  const row = {name, command};
  let handle;
  try {
    const opened = await session.ipc('Open ' + name + ' filesystem', root, command, data);
    row.openResult = opened.result;
    row.openCanonicalResult = opened.canonicalResult;
    if (opened.result) return row;
    if (opened.moves.length !== 1 || opened.copies.length)
      throw Error('Filesystem open did not return one moved handle');
    handle = opened.moves[0];
    row.total = await spaceReader(session, handle, 12);
    row.free = await spaceReader(session, handle, 11);
    const total = row.total.result === 0 ? BigInt(row.total.bytes) : -1n;
    const free = row.free.result === 0 ? BigInt(row.free.bytes) : -1n;
    row.verified = total >= 0n && free >= 0n && free <= total;
  } catch (error) {
    row.error = error.message;
  } finally {
    if (handle && session.handles.has(handle)) {
      try {await session.close(handle);}
      catch (error) {row.closeError = error.message;}
    }
  }
  return row;
}

async function probeStorage(session, {spaceReader = querySpace} = {}) {
  const report = {storage: []};
  let root;
  try {
    root = await session.openService('fsp-srv');
    const initialized = await session.ipc('Initialize fsp-srv', root, 1,
      Buffer.alloc(8), {pid: true});
    report.initializeResult = initialized.result;
    report.initializeCanonicalResult = initialized.canonicalResult;
    if (initialized.result) return report;
    report.storage.push(await probeFilesystem(session, root, 'sd', 18,
      Buffer.alloc(0), spaceReader));
    report.storage.push(await probeFilesystem(session, root, 'temporary', 51,
      temporaryStorageInput(), spaceReader));
  } finally {
    if (root && session.handles.has(root)) {
      try {await session.close(root);}
      catch (error) {report.closeError = error.message;}
    }
  }
  return report;
}

module.exports = {probeStorage, probeFilesystem, querySpace};
