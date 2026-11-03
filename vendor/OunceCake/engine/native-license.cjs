'use strict';
const { idBytes, success, closeHandles } = require('./protocol.cjs');

// Hold the rights context until serving stops.
function licenseIpc(s, handle) {
  return async (id, input = Buffer.alloc(0), sends = [], receiveSize = 0) => {
    if (s.threads.size) throw new Error('Prepare native license before starting the server');
    if (!Number.isInteger(receiveSize) || receiveSize < 0 || receiveSize > 0x80000 ||
        0x5000 + receiveSize > s.bytes) throw new Error('ELicense output exceeds owned scratch');
    let at = 0x3000;
    const send = sends.map(bytes => {
      if (!Buffer.isBuffer(bytes) || at + bytes.length > 0x5000) throw new Error('ELicense input exceeds owned scratch');
      const item = {address: s.base + at, size: bytes.length, mode: 0, bytes};
      at += Math.max(16, Math.ceil(bytes.length / 16) * 16);
      return item;
    });
    for (const item of send) await s.write(item.address, item.bytes);
    const address = s.base + 0x5000;
    if (receiveSize) await s.write(address, Buffer.alloc(receiveSize));
    const reply = success(await s.ipc('Native license command ' + id, handle, id, input, {
      ...(send.length ? {send: send.map(({bytes, ...item}) => item)} : {}),
      ...(receiveSize ? {receive: [{address, size: receiveSize, mode: 0}]} : {}),
    }), 'Native license command ' + id);
    const output = receiveSize ? await s.readOwned(address, receiveSize) : Buffer.alloc(0);
    if (output.length !== receiveSize) throw new Error('Truncated ELicense output');
    return {...reply, output};
  };
}

function count(reply, label, limit = 8000) {
  if (!Buffer.isBuffer(reply.data) || reply.data.length < 4) throw new Error(label + ': missing count');
  const n = reply.data.readUInt32LE();
  if (n > limit) throw new Error(label + ': invalid count');
  return n;
}

async function nativeOwners(ipc, application, {optional = false} = {}) {
  let ids;
  let capacity = 64;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = count(await ipc(1004), 'ES1004');
    capacity = Math.max(capacity, before + 1);
    const list = await ipc(1005, Buffer.alloc(0), [], capacity * 16);
    const n = count(list, 'ES1005');
    if (n > capacity || n * 16 > list.output.length) throw new Error('ES1005: truncated ID list');
    const after = count(await ipc(1004), 'ES1004');
    if (before !== after || n !== after || n === capacity) {capacity *= 2; continue;}
    ids = Array.from({length: n}, (_, i) => list.output.subarray(i * 16, (i + 1) * 16).toString('hex'));
    if (new Set(ids).size !== ids.length || ids.some(id => /^0{32}$/.test(id))) throw new Error('ES1005: invalid license IDs');
    break;
  }
  if (!ids) throw new Error('ELicense index changed; no complete snapshot obtained');
  const matches = [];
  for (let at = 0; at < ids.length; at += 16) {
    const batch = ids.slice(at, at + 16);
    const reply = await ipc(1006, Buffer.alloc(0), [Buffer.from(batch.join(''), 'hex')], batch.length * 0x50);
    const n = count(reply, 'ES1006');
    if (n !== batch.length || n * 0x50 > reply.output.length) throw new Error('ES1006: incomplete license information');
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const entry = reply.output.subarray(i * 0x50, (i + 1) * 0x50);
      const uuid = entry.subarray(0, 16).toString('hex');
      if (!batch.includes(uuid) || seen.has(uuid)) throw new Error('ES1006: unexpected license ID');
      seen.add(uuid);
      if (entry.readBigUInt64LE(0x38) !== BigInt('0x' + application)) continue;
      const owner = Buffer.from(entry.subarray(0x20, 0x28));
      if (!owner.equals(Buffer.alloc(8))) matches.push({uuid, owner});
    }
  }
  if (!matches.length && !optional) throw new Error('No installed account ELicense for ' + application);
  return matches;
}

async function prepareNativeInstalledLicense({s, root, domain, service, programId, storage, optional = false}) {
  if (s.threads.size) throw new Error('Prepare native license before starting the server');
  const es = await service('es');
  const esIpc = licenseIpc(s, es);
  const matches = await nativeOwners(esIpc, programId, {optional});
  if (!matches.length) return false;
  const input = Buffer.alloc(16);
  input[0] = storage;
  idBytes(programId).copy(input, 8);
  const identity = success(await s.ipc('Get native content RightsId', root, 606, input), 'FS606 native content RightsId');
  if (identity.data.length < 16) throw new Error('FS606: incomplete RightsId');
  const rights = Buffer.from(identity.data.subarray(0, 16));
  if (rights.equals(Buffer.alloc(16))) return false;
  const application = rights.subarray(0, 8).toString('hex');
  if (application !== programId) throw new Error('FS606 rights prefix differs from native ProgramId; cannot select its context');
  const rightsHex = rights.toString('hex');
  let owned = s.nativeInstalledLicenseContext;
  if (owned && !s.handles.has(owned.handle)) owned = undefined;
  if (owned?.prepared.has(rightsHex)) return true;

  let context;
  try {
    if (!owned) {
      const created = await esIpc(2001);
      owned = {handle: domain.oneHandle(created), applications: new Map(), prepared: new Set()};
      s.nativeInstalledLicenseContext = owned;
    }
    context = owned.handle;
    owned.applications.set(application, matches);
    const accounts = [...new Map([...owned.applications.values()].flat().map(m => [m.owner.toString('hex'), m.owner])).values()];
    if (accounts.length < 1 || accounts.length > 8) throw new Error('Native context requires 1..8 ELicense owner accounts');
    const titles = [...owned.applications.keys()];
    const titleBytes = Buffer.concat(titles.map(idBytes));
    const accountBytes = Buffer.concat(accounts);
    const ctx = licenseIpc(s, context);
    await ctx(1, Buffer.from([0]), [accountBytes]);
    await ctx(2, Buffer.alloc(0), [titleBytes]);
    for (const [title, licenses] of owned.applications) {
      const owners = [...new Map(licenses.map(m => [m.owner.toString('hex'), m.owner])).values()];
      await ctx(17, Buffer.from([0]), [idBytes(title), Buffer.concat(owners)]);
    }
    await ctx(3);
    const filter = Buffer.alloc(4); filter.writeUInt32LE(2);
    const usable = await ctx(6, filter, [], titles.length * 8);
    const n = count(usable, 'IActiveRightsContext 6', titles.length);
    const accepted = Array.from({length: n}, (_, i) => usable.output.readBigUInt64LE(i * 8).toString(16).padStart(16, '0'));
    if (accepted.some(title => !owned.applications.has(title)) || titles.some(title => !accepted.includes(title))) {
      throw new Error('Native ELicense rights are not usable for ' + application);
    }
    console.log('Using installed ELicense for ' + application);
    await esIpc(503, Buffer.alloc(0), [rights, Buffer.alloc(4)]);
    owned.prepared.add(rightsHex);
    return true;
  } catch (error) {
    // Discard a partially configured context rather than reusing it.
    if (context) {
      s.nativeInstalledLicenseContext = undefined;
      try {await closeHandles(s, [context]);} catch (cleanupError) {
        throw new AggregateError([error, cleanupError], error.message + '; ' + cleanupError.message);
      }
    }
    throw error;
  }
}

module.exports = {prepareNativeInstalledLicense, nativeOwners};
