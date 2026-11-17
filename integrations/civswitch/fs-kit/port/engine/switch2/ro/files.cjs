// Native FS client operations on retained handles; all buffers belong to s.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {packet, response} = require("../../shared/ipc.cjs");
const {loadTarget, programId} = require('../../shared/target.cjs');
const target = loadTarget();
const check = (ok, message) => { if (!ok) throw Error(message); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function pathRequest(command, input, address, length = 0x301) {
  const bytes = packet(command, input), pointer = BigInt(address);
  bytes.writeUInt32LE(4 | 1 << 16);
  bytes.writeUInt32LE(Number(BigInt(length) << 16n | (pointer >> 36n & 7n) << 6n |
    (pointer >> 32n & 15n) << 12n), 8);
  bytes.writeUInt32LE(Number(pointer & 0xffffffffn), 12);
  return bytes;
}

// Two-path rename requests (IFileSystem 5/6) need two inline X descriptors. packet() can only
// describe one, so the header is rebuilt here: pointer data at 8 and 16, CMIF message at the
// 16-byte aligned raw-data offset (32) with no input payload.
function pathRequest2(command, first, second, length = 0x301) {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt32LE(4 | 2 << 16);
  bytes.writeUInt32LE(8, 4);
  for (const [offset, address] of [[8, first], [16, second]]) {
    const pointer = BigInt(address);
    bytes.writeUInt32LE(Number(BigInt(length) << 16n | (pointer >> 36n & 7n) << 6n |
      (pointer >> 32n & 15n) << 12n), offset);
    bytes.writeUInt32LE(Number(pointer & 0xffffffffn), offset + 4);
  }
  bytes.write('SFCI', 32, 'ascii');
  bytes.writeUInt32LE(command, 40);
  return bytes;
}

// Ordinary (non-domain) path IPC: the packet comes prebuilt from pathRequest() because the
// inline X descriptor has to point at this session's own scratch. Mirrors Session#ipc
// except that the caller supplies the final packet bytes.
async function rawPathIpc(s, label, handle, bytes) {
  await s.write(s.base, bytes);
  const transport = await s.call('send', s.base, 4096, handle);
  check(!transport, label + ': transport 0x' + transport.toString(16));
  const reply = response(await s.readOwned(s.base, 256));
  for (const child of [...reply.copies, ...reply.moves]) s.handles.add(child);
  return reply;
}

// Shared write-side path plumbing: validate the path, stage it in this session's own scratch
// at +0x2000 and issue one ordinary (non-domain) IFileSystem request on the SD handle.
async function sdPathCall(s, label, handle, command, input = Buffer.alloc(0)) {
  const text = Buffer.from(label, 'utf8');
  check(label.startsWith('/') && !label.includes('\0') && text.length < 0x301,
    'Invalid filesystem path');
  const filename = Buffer.alloc(0x304); text.copy(filename);
  await s.write(s.base + 0x2000, filename);
  return rawPathIpc(s, 'SD ' + label, handle, pathRequest(command, input, s.base + 0x2000));
}

function sdHandle(s, handle) {
  check(Number.isInteger(handle) && s.handles.has(handle),
    'The SD handle is not owned by this session');
}

// Every SD mutation is opt-in: NS2_ALLOW_WRITES must be 1 in the engine process. Otherwise the
// attempt is still recorded (with a synthetic 0xE401) so the report shows what was refused.
async function beginWrite(command, request, state, save) {
  const entry = {at: new Date().toISOString(), operation: command,
    handle: Number(request.handle), path: String(request.path ?? '')};
  if (process.env.NS2_ALLOW_WRITES === '1') return {entry};
  Object.assign(entry, {result: 0xE401, canonicalResult: 0x401,
    error: 'writes disabled (set NS2_ALLOW_WRITES=1)'});
  state.calls.push(entry); await save();
  return {entry, disabled: true};
}

async function dispatch(context, request, state, domain) {
  const {s, live, save} = context;
  const command = request.command.slice('root-native-'.length);
  if (command === 'code-close') {
    const handle = Number(request.handle);
    const code = state.codeFileSystems?.find(item => item.handle === handle);
    check(!s.threads.size && code && s.handles.has(handle) &&
      code !== state.codeFileSystems[0] && !code.domainRoot,
    'Close requires an idle analysis CodeFS; the retained binding is preserved');
    await s.close(handle);
    code.closedAt = new Date().toISOString();
    (state.closedCodeFileSystems ||= []).push(code);
    state.codeFileSystems = state.codeFileSystems.filter(item => item !== code);
    await save();
    return {handle, title: code.title, closed: true, at: code.closedAt};
  }
  if (command === 'code-domain') {
    const handle = Number(request.handle);
    const code = state.codeFileSystems?.find(item => item.handle === handle);
    check(code && s.handles.has(handle), 'Code-domain conversion requires the owned CodeFS');
    if (!code.domainRoot) {
      const reply = await domain.send(s, 'RO CodeFS ConvertToDomain', handle, domain.wire.control(0));
      check(!reply.result && reply.data.readUInt32LE() > 0, 'CodeFS domain conversion failed');
      code.domainRoot = reply.data.readUInt32LE();
      check(code.domainRoot <= 0x4000, 'CodeFS object ID exceeds the native domain capacity');
      await save();
    }
    return {handle, root: code.domainRoot};
  }
  if (command === 'donor-cleanup') {
    const donor = state.donor;
    check(donor?.ready && !donor.pendingRemoval && !s.threads.size && !s.pendingIpc && state.worker?.joined,
      'Donor cleanup requires the completed launch and an idle worker');
    const filesystem = require('../app/filesystem.cjs');
    const handle = await require('../app/mounted-save.cjs').cloneMountedFilesystem(s, donor.mount || 'save');
    try {
      for (const item of donor.files.filter(item => item.created && !item.removed)) {
        check(['main', 'main.npdm'].includes(item.name) && item.verified, 'Unknown donor file');
        const name = '/' + item.name;
        const opened = await filesystem.openFile(s, handle, name);
        check(!opened.result, 'Owned donor file is missing');
        try {
          check(await filesystem.fileSize(s, opened.handle) === BigInt(item.size) &&
            hash(await filesystem.readFile(s, opened.handle, 0, item.size)) === item.sha256,
          'Owned donor file changed');
        } finally {await s.close(opened.handle);}
        donor.pendingRemoval = item.name; await save();
        const filename = Buffer.alloc(0x301); filename.write(name);
        await s.write(s.base + 0x2000, filename);
        const removed = await domain.send(s, 'Remove owned RO donor ' + name, handle,
          pathRequest(1, Buffer.alloc(0), s.base + 0x2000));
        check(!removed.result, 'Donor file removal failed');
        check(!(await s.ipc('Commit donor cleanup', handle, 10)).result, 'Donor cleanup commit failed');
        check((await filesystem.pathMethod(s, handle, 7, name)).canonicalResult === 0x202,
          'Owned donor file still exists');
        item.removed = true; delete donor.pendingRemoval; await save();
      }
    } finally {await s.close(handle);}
    donor.cleanedUp = true; await save();
    return {cleanedUp: true, files: donor.files.filter(item => item.removed).map(item => item.name)};
  }
  if (command === 'donor-prepare') {
    const manifest = require('./payload/manifest.json');
    const roProgramId = programId(target).slice(2);
    const policyFile = path.join(__dirname, live.session + '-code-' + roProgramId, 'main.npdm');
    const main = await fs.readFile(path.join(__dirname, 'payload/main'));
    const policy = await fs.readFile(policyFile);
    check(manifest.platform === live.platform && manifest.programId === roProgramId &&
      main.length === manifest.payloadBytes && hash(main) === manifest.payloadSha256 &&
      hash(policy) === manifest.policySha256, 'The payload or this console\'s RO policy is unsupported');
    check(!s.threads.size, 'Prepare the donor before launching a worker');
    if (state.donor?.ready) return state.donor;
    const directory = path.join(__dirname, '../app');
    if (!state.donor) {
      const handle = await require(path.join(directory, 'mounted-save.cjs')).cloneMountedFilesystem(s, 'save');
      state.donor = {handle, mount: 'save', files: [], checkedAbsent: [], created: new Date().toISOString()};
      await save();
    }
    const donor = state.donor;
    check(s.handles.has(donor.handle) && !donor.root, 'Donor session is unavailable or already converted');
    const pathCall = async (name, id, input = Buffer.alloc(0)) => {
      const filename = Buffer.alloc(0x301); filename.write('/' + name);
      await s.write(s.base + 0x2000, filename);
      return domain.send(s, 'RO donor /' + name + ' command ' + id, donor.handle,
        pathRequest(id, input, s.base + 0x2000));
    };
    if (!donor.preflightComplete) {
      const names = ['main', 'main.npdm', 'rtld', 'sdk', ...Array.from({length: 10}, (_, i) => 'subsdk' + i)];
      for (const name of names) {
        const reply = await pathCall(name, 7);
        if (!reply.result && ['main', 'main.npdm'].includes(name)) {
          check(reply.data.readUInt32LE() === 1, 'Existing donor path is not a file');
          const file = name === 'main' ? path.join(__dirname, 'payload/main') :
            policyFile;
          const expected = await fs.readFile(file), mode = Buffer.alloc(4); mode.writeUInt32LE(1);
          check(expected.length > 0 && expected.length <= 0x10000, 'Existing donor comparison exceeds its buffer');
          const child = domain.oneHandle(await pathCall(name, 8, mode));
          let stale;
          try {
            const size = await s.ipc('Existing donor file size', child, 4);
            check(!size.result, 'Existing donor size query failed');
            const length = Number(size.data.readBigUInt64LE());
            check(length > 0 && length <= 0x10000, 'Existing donor exceeds its comparison buffer');
            const args = Buffer.alloc(24); args.writeBigUInt64LE(BigInt(length), 16);
            const read = await s.ipc('Existing donor verification', child, 0, args,
              {receive: [{address: s.base + 0x4000, size: length, mode: 1}]});
            check(!read.result && read.data.readBigUInt64LE() === BigInt(length), 'Existing donor read was incomplete');
            const current = await s.readOwned(s.base + 0x4000, length);
            if (current.equals(expected)) {
              if (!donor.files.some(f => f.name === name)) donor.files.push({name, file, size: expected.length,
                sha256: hash(expected), verified: true, reused: true});
            } else stale = {name, size: length, sha256: hash(current)};
          } finally { await s.close(child); }
          if (stale) {
            donor.pendingStaleRemoval = stale; await save();
            const removed = await pathCall(name, 1);
            check(!removed.result, 'Stale donor /' + name + ' removal failed');
            check(!(await s.ipc('Commit stale donor removal', donor.handle, 10)).result,
              'Stale donor removal commit failed');
            check((await pathCall(name, 7)).canonicalResult === 0x202,
              'Stale donor /' + name + ' still exists');
            (donor.removedStale ||= []).push(stale);
            delete donor.pendingStaleRemoval;
            if (!donor.checkedAbsent.includes(name)) donor.checkedAbsent.push(name);
            await save();
          }
        } else {
          check(reply.canonicalResult === 0x202, 'The donor root already contains /' + name + ' or lookup failed');
          if (!donor.checkedAbsent.includes(name)) donor.checkedAbsent.push(name);
        }
      }
      donor.preflightComplete = true;
      await save();
    }
    for (const name of ['main.npdm', 'main']) {
      const file = name === 'main' ? path.join(__dirname, 'payload/main') :
        policyFile;
      const bytes = await fs.readFile(file), digest = hash(bytes);
      check(bytes.length > 0 && bytes.length <= 0x100000, 'Unexpected donor file size');
      const previous = donor.files.find(f => f.name === name);
      if (previous?.verified) { check(previous.sha256 === digest, 'Prepared donor content changed'); continue; }
      check(!previous, 'An incomplete donor write requires inspection');
      const input = Buffer.alloc(16); input.writeBigUInt64LE(BigInt(bytes.length), 8);
      const created = await pathCall(name, 0, input);
      check(!created.result, 'Donor file creation failed: ' + created.canonicalResult);
      const entry = {name, file, size: bytes.length, sha256: digest, created: true};
      donor.files.push(entry); await save();
      const mode = Buffer.alloc(4); mode.writeUInt32LE(3);
      const opened = await pathCall(name, 8, mode);
      const child = domain.oneHandle(opened);
      try {
        for (let offset = 0; offset < bytes.length; offset += 0x10000) {
          const part = bytes.subarray(offset, offset + 0x10000), args = Buffer.alloc(24);
          args.writeUInt32LE(1); args.writeBigUInt64LE(BigInt(offset), 8);
          args.writeBigUInt64LE(BigInt(part.length), 16);
          await s.write(s.base + 0x4000, part);
          const written = await s.ipc('RO donor write', child, 1, args,
            {send: [{address: s.base + 0x4000, size: part.length, mode: 1}]});
          check(!written.result, 'Donor write failed');
        }
        const chunks = [];
        for (let offset = 0; offset < bytes.length; offset += 0x10000) {
          const size = Math.min(0x10000, bytes.length - offset), args = Buffer.alloc(24);
          args.writeBigUInt64LE(BigInt(offset), 8); args.writeBigUInt64LE(BigInt(size), 16);
          const read = await s.ipc('RO donor readback', child, 0, args,
            {receive: [{address: s.base + 0x4000, size, mode: 1}]});
          check(!read.result && read.data.readBigUInt64LE() === BigInt(size), 'Donor readback failed');
          chunks.push(await s.readOwned(s.base + 0x4000, size));
        }
        check(hash(Buffer.concat(chunks)) === digest, 'Donor file hash differs');
        entry.verified = true;
        await save();
      } finally { await s.close(child); }
    }
    check(!(await s.ipc('RO donor commit', donor.handle, 10)).result, 'Donor commit failed');
    const converted = await domain.send(s, 'RO donor ConvertToDomain', donor.handle, domain.wire.control(0));
    check(!converted.result && converted.data.readUInt32LE() > 0, 'Donor domain conversion failed');
    donor.root = converted.data.readUInt32LE();
    check(donor.root <= 0x4000, 'Donor object ID exceeds the native domain capacity');
    donor.ready = true; await save();
    return donor;
  }
  if (command === 'code-open') {
    const handle = Number(request.handle), title = BigInt(request.title);
    const dumpDirectory = process.env.NS2_FIRMWARE_DUMP_DIR;
    check(!request.dumpOutput || dumpDirectory && path.isAbsolute(dumpDirectory),
      'Firmware capture requires a dedicated output directory');
    check(state.domainCopies?.some(item => item.handle === handle) && s.handles.has(handle),
      'Code open requires a retained copied root');
    const existing = !request.fresh && state.codeFileSystems?.find(item => item.title === title.toString() && s.handles.has(item.handle));
    if (existing) return existing;
    const attributes = Number(request.attributes ?? 1), storage = Number(request.storage ?? 3);
    check(Number.isInteger(attributes) && attributes >= 0 && attributes <= 15, 'Invalid content attributes');
    check([3, 4, 5].includes(storage), 'Unsupported code storage');
    const input = Buffer.alloc(16); input[0] = attributes; input[1] = storage; input.writeBigUInt64LE(title, 8);
    const infoSize = Number(request.infoSize ?? 0x1a4);
    check(Number.isInteger(infoSize) && infoSize >= 0x100 && infoSize <= 0x2000, 'Invalid code-info capacity');
    const output = s.base + 0x4000, guard = Buffer.alloc(32, 0x5c);
    await s.write(output - 32, Buffer.concat([guard, Buffer.alloc(infoSize), guard]));
    const reply = await s.ipc('RO pivot: OpenCodeFileSystem', handle, 0, input,
      {receive: [{address: output, size: infoSize}]});
    const entry = {at: new Date().toISOString(), operation: command, sourceRoot: handle,
      title: title.toString(), storage, attributes, infoSize, result: reply.result, canonicalResult: reply.canonicalResult};
    state.calls.push(entry); await save();
    if (reply.result) return entry;
    entry.handle = domain.oneHandle(reply);
    (state.codeFileSystems ||= []).push(entry); await save();
    check((await s.readOwned(output - 32, 32)).equals(guard) &&
      (await s.readOwned(output + infoSize, 32)).equals(guard), 'Code-info output exceeded its buffer');
    const info = await s.readOwned(output, infoSize);
    const directory = request.dumpOutput ?
      path.join(dumpDirectory, title.toString(16).padStart(16, '0')) :
      path.join(__dirname, live.session + '-code-' + title.toString(16).padStart(16, '0'));
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    entry.directory = directory;
    entry.codeInfo = {file: path.join(directory, 'code-info.bin'), sha256: hash(info),
      isSigned: info[infoSize - 4], targetHash: info.subarray(infoSize - 0x24, infoSize - 4).toString('hex')};
    await fs.writeFile(entry.codeInfo.file, info, {mode: 0o600});
    await save();
    return entry;
  }
  if (command === 'file-capture') {
    const handle = Number(request.handle), name = request.name;
    const code = state.codeFileSystems?.find(item => item.handle === handle);
    check(code && s.handles.has(handle) && (['main', 'main.npdm', 'rtld', 'sdk'].includes(name) ||
      code.listing?.entries.some(entry => entry.type === 1 && entry.name === name)),
      'Capture requires an owned CodeFS and a code filename');
    const filename = Buffer.alloc(0x301); filename.write('/' + name);
    await s.write(s.base + 0x2000, filename);
    const input = Buffer.alloc(4); input.writeUInt32LE(1);
    const opened = await domain.send(s, 'RO pivot: open /' + name, handle,
      pathRequest(8, input, s.base + 0x2000));
    check(!opened.result, 'Code file did not open: ' + opened.canonicalResult);
    const child = domain.oneHandle(opened);
    let safeToClose = false;
    try {
      const sizeReply = await s.ipc('RO pivot: code file size', child, 4);
      safeToClose = true;
      check(!sizeReply.result, 'Code file size failed');
      const size = Number(sizeReply.data.readBigUInt64LE());
      check(Number.isSafeInteger(size) && size > 0 && size <= 256 * 1024 * 1024, 'Unexpected code-file size');
      const length = request.limit === undefined ? size : Math.min(size, Number(request.limit));
      check(Number.isInteger(length) && length > 0, 'Invalid capture limit');
      const output = s.base + 0x4000;
      const capacity = Math.min(0x10000, s.bytes - 0x4000);
      const file = path.join(code.directory, name + (length === size ? '' : '.sample'));
      const temporary = file + '.partial';
      const out = await fs.open(temporary, 'wx', 0o600);
      const digest = crypto.createHash('sha256');
      let header = Buffer.alloc(0), captured = 0;
      try {
        for (let offset = 0; offset < length;) {
          const n = Math.min(capacity, length - offset), data = Buffer.alloc(24);
          data.writeBigUInt64LE(BigInt(offset), 8); data.writeBigUInt64LE(BigInt(n), 16);
          safeToClose = false;
          const reply = await s.ipc('RO pivot: read code file', child, 0, data,
            {receive: [{address: output, size: n, mode: 1}]});
          if (reply.result) safeToClose = true;
          check(!reply.result && reply.data.readBigUInt64LE() === BigInt(n), 'Code file read was short or failed');
          const bytes = await s.readOwned(output, n);
          safeToClose = true;
          const written = await out.write(bytes, 0, bytes.length, offset);
          check(written.bytesWritten === bytes.length, 'Local code-file write was short');
          digest.update(bytes);
          if (header.length < 0x100) header = Buffer.concat([header, bytes]).subarray(0, 0x100);
          offset += n; captured = offset;
        }
        await out.sync();
      } finally {await out.close();}
      check(captured === length, 'Code-file capture stopped early');
      await fs.link(temporary, file); // Never replace a pre-existing capture.
      await fs.unlink(temporary);
      const entry = {at: new Date().toISOString(), name, file, size, captured: length,
        sha256: digest.digest('hex'),
        header: header.toString('hex')};
      (code.files ||= []).push(entry); await save();
      return entry;
    } finally { if (safeToClose) await s.close(child); }
  }
  if (command === 'sd-list') {
    // Read-only directory listing on a caller-provided IFileSystem handle. The handle comes
    // from fsp-srv cmd18 OpenSdCardFileSystem, obtained through root-native-ipc; it is an
    // ordinary (non-domain) session handle, so the path packet goes out through rawPathIpc
    // instead of domain.send.
    const handle = Number(request.handle), label = String(request.path ?? '/');
    check(Number.isInteger(handle) && s.handles.has(handle),
      'The SD listing handle is not owned by this session');
    const text = Buffer.from(label, 'utf8');
    check(label.startsWith('/') && !label.includes('\0') && text.length < 0x301,
      'Invalid filesystem path');
    const filename = Buffer.alloc(0x304); text.copy(filename);
    await s.write(s.base + 0x2000, filename);
    const mode = Buffer.alloc(4); mode.writeUInt32LE(3);
    const opened = await rawPathIpc(s, 'RO SD OpenDirectory ' + label, handle,
      pathRequest(9, mode, s.base + 0x2000));
    const entry = {at: new Date().toISOString(), operation: command, handle, path: label,
      result: opened.result, canonicalResult: opened.canonicalResult};
    state.calls.push(entry); await save();
    if (opened.result) return entry;
    const directory = domain.oneHandle(opened);
    const entries = [];
    try {
      while (entries.length < 128) {
        const reply = await s.ipc('RO SD ReadDirectory ' + label, directory, 0, Buffer.alloc(0),
          {receive: [{address: s.base + 0x6000, size: 4 * 0x310, mode: 0}]});
        check(!reply.result, 'SD directory read failed: ' + reply.canonicalResult);
        const count = Number(reply.data.readBigUInt64LE());
        check(count >= 0 && count <= 4, 'Invalid SD directory entry count');
        if (!count) break;
        const bytes = await s.readOwned(s.base + 0x6000, count * 0x310);
        for (let i = 0; i < count; i++) {
          const item = bytes.subarray(i * 0x310, (i + 1) * 0x310);
          entries.push({name: item.subarray(0, 0x301).toString('utf8').split('\0')[0],
            type: item[0x304], size: item.readBigUInt64LE(0x308).toString()});
        }
      }
    } finally { await s.close(directory); }
    entry.entries = entries; await save();
    return entry;
  }
  if (command === 'sd-read') {
    // Read-only readback of an SD file into the console scratch; only the size, hash and a
    // short hex prefix are mirrored into the local report, the file stays on the console.
    const handle = Number(request.handle), label = String(request.path ?? '');
    const offset = Number(request.offset ?? 0), limit = Number(request.length ?? 0x1000);
    check(Number.isInteger(handle) && s.handles.has(handle),
      'The SD read handle is not owned by this session');
    check(Number.isSafeInteger(offset) && offset >= 0 && Number.isInteger(limit) &&
      limit > 0 && limit <= 0x4000, 'Invalid SD read range');
    const text = Buffer.from(label, 'utf8');
    check(label.startsWith('/') && !label.includes('\0') && text.length < 0x301,
      'Invalid filesystem path');
    const filename = Buffer.alloc(0x304); text.copy(filename);
    await s.write(s.base + 0x2000, filename);
    const output = s.base + 0x6000;
    const opened = await rawPathIpc(s, 'RO SD OpenFile ' + label, handle,
      pathRequest(8, Buffer.from([1, 0, 0, 0]), s.base + 0x2000));
    const entry = {at: new Date().toISOString(), operation: command, handle, path: label,
      result: opened.result, canonicalResult: opened.canonicalResult};
    state.calls.push(entry); await save();
    if (opened.result) return entry;
    const child = domain.oneHandle(opened);
    let safeToClose = false;
    try {
      const sized = await s.ipc('RO SD file size ' + label, child, 4);
      safeToClose = true;
      check(!sized.result, 'SD file size failed: ' + sized.canonicalResult);
      const size = Number(sized.data.readBigUInt64LE());
      entry.size = size;
      const length = Math.min(limit, size - offset);
      check(length > 0, 'SD read range lies outside the file');
      const data = Buffer.alloc(24);
      data.writeBigUInt64LE(BigInt(offset), 8); data.writeBigUInt64LE(BigInt(length), 16);
      safeToClose = false;
      const reply = await s.ipc('RO SD read file ' + label, child, 0, data,
        {receive: [{address: output, size: length, mode: 1}]});
      safeToClose = true;
      check(!reply.result && reply.data.readBigUInt64LE() === BigInt(length),
        'SD file read was short or failed: ' + reply.canonicalResult);
      const bytes = await s.readOwned(output, length);
      Object.assign(entry, {offset, length, sha256: hash(bytes), hex: bytes.toString('hex')});
    } finally { if (safeToClose) await s.close(child); }
    await save();
    return entry;
  }
  if (command === 'sd-create') {
    const {entry, disabled} = await beginWrite(command, request, state, save);
    if (disabled) return entry;
    sdHandle(s, entry.handle);
    const size = Number(request.size ?? 0), option = Number(request.option ?? 0);
    check(Number.isSafeInteger(size) && size >= 0 && Number.isSafeInteger(option) &&
      option >= 0 && option <= 0xffffffff, 'Invalid SD create parameters');
    const input = Buffer.alloc(16);
    input.writeUInt32LE(option >>> 0); input.writeBigUInt64LE(BigInt(size), 8);
    const reply = await sdPathCall(s, entry.path, entry.handle, 0, input);
    Object.assign(entry, {size, result: reply.result, canonicalResult: reply.canonicalResult});
    state.calls.push(entry); await save();
    return entry;
  }
  if (command === 'sd-mkdir') {
    const {entry, disabled} = await beginWrite(command, request, state, save);
    if (disabled) return entry;
    sdHandle(s, entry.handle);
    const reply = await sdPathCall(s, entry.path, entry.handle, 2);
    Object.assign(entry, {result: reply.result, canonicalResult: reply.canonicalResult});
    state.calls.push(entry); await save();
    return entry;
  }
  if (command === 'sd-delete') {
    const {entry, disabled} = await beginWrite(command, request, state, save);
    if (disabled) return entry;
    sdHandle(s, entry.handle);
    const reply = await sdPathCall(s, entry.path, entry.handle, 1);
    Object.assign(entry, {result: reply.result, canonicalResult: reply.canonicalResult});
    state.calls.push(entry); await save();
    return entry;
  }
  if (command === 'sd-delete-dir') {
    const {entry, disabled} = await beginWrite(command, request, state, save);
    if (disabled) return entry;
    sdHandle(s, entry.handle);
    const recursive = request.recursive === true;
    const reply = await sdPathCall(s, entry.path, entry.handle, recursive ? 4 : 3);
    Object.assign(entry, {recursive, result: reply.result,
      canonicalResult: reply.canonicalResult});
    state.calls.push(entry); await save();
    return entry;
  }
  if (command === 'sd-rename') {
    // Best effort: two-slot X descriptors are not used anywhere else in the port, so a
    // transport failure is reported as 0xE402 instead of aborting; the FTP layer can then
    // fall back to read + create + write + delete.
    const {entry, disabled} = await beginWrite(command, request, state, save);
    if (disabled) return entry;
    sdHandle(s, entry.handle);
    const label = entry.path, next = String(request.path2 ?? '');
    const text = Buffer.from(label, 'utf8'), nextText = Buffer.from(next, 'utf8');
    check(label !== next, 'SD rename source and destination are equal');
    check(label.startsWith('/') && !label.includes('\0') && text.length < 0x301 &&
      next.startsWith('/') && !next.includes('\0') && nextText.length < 0x301,
      'Invalid filesystem path');
    const firstPath = Buffer.alloc(0x304); text.copy(firstPath);
    const secondPath = Buffer.alloc(0x304); nextText.copy(secondPath);
    await s.write(s.base + 0x2000, firstPath);
    await s.write(s.base + 0x2400, secondPath);
    entry.path2 = next;
    try {
      const reply = await rawPathIpc(s, 'SD rename ' + label, entry.handle,
        pathRequest2(request.directory === true ? 6 : 5, s.base + 0x2000, s.base + 0x2400));
      Object.assign(entry, {result: reply.result, canonicalResult: reply.canonicalResult});
    } catch (error) {
      Object.assign(entry, {result: 0xE402, canonicalResult: 0x402,
        error: 'rename unsupported: ' + error.message});
    }
    state.calls.push(entry); await save();
    return entry;
  }
  if (command === 'sd-write') {
    // Open-or-create with the Appendable bit (flags 7 = read+write+append; patch 22) because the
    // SD image filesystem rejects a write that grows the file otherwise (Fs 2002-6201, RUN 105).
    // Write at most one 0x4000-byte chunk from hex, flush, then GetSize to prove the length landed.
    const {entry, disabled} = await beginWrite(command, request, state, save);
    if (disabled) return entry;
    sdHandle(s, entry.handle);
    const label = entry.path;
    const offset = Number(request.offset ?? 0), truncate = request.truncate === true;
    const hex = String(request.hex ?? '');
    check(Number.isSafeInteger(offset) && offset >= 0 && hex.length > 0 && hex.length <= 0x8000 &&
      hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex), 'Invalid SD write payload');
    const bytes = Buffer.from(hex, 'hex');
    check(bytes.length > 0 && bytes.length <= 0x4000, 'SD write chunk must be 1..0x4000 bytes');
    const preallocate = Number(request.size ?? 0);
    check(Number.isSafeInteger(preallocate) && preallocate >= 0, 'Invalid SD write size');
    let opened = await sdPathCall(s, label, entry.handle, 8, Buffer.from([7, 0, 0, 0]));
    if (opened.canonicalResult === 0x202) {
      const create = Buffer.alloc(16);
      create.writeBigUInt64LE(BigInt(preallocate), 8);
      const created = await sdPathCall(s, label, entry.handle, 0, create);
      check(!created.result, 'SD write could not create the file: ' + created.canonicalResult);
      opened = await sdPathCall(s, label, entry.handle, 8, Buffer.from([7, 0, 0, 0]));
    }
    Object.assign(entry, {offset, result: opened.result, canonicalResult: opened.canonicalResult});
    if (opened.result) { state.calls.push(entry); await save(); return entry; }
    const file = domain.oneHandle(opened);
    const output = s.base + 0x4000;
    let safeToClose = true;
    try {
      // Patch 21 (RUN 105): the SD image filesystem rejects IFile::Write that would grow the file
      // through EOF (it returned 0x307202 for a freshly created 0-byte file). Size the file to the
      // write end first, exactly like donor-prepare does on the save filesystem, then write.
      const target = offset + bytes.length;
      const before = await s.ipc('SD file size before write ' + label, file, 4);
      check(!before.result, 'SD file size failed: ' + before.canonicalResult);
      const current = Number(before.data.readBigUInt64LE());
      const finalSize = truncate ? target : Math.max(current, target);
      if (truncate || current < target) {
        const resizeInput = Buffer.alloc(8);
        resizeInput.writeBigUInt64LE(BigInt(finalSize));
        safeToClose = false;
        const resized = await s.ipc('SD resize file ' + label, file, 3, resizeInput);
        safeToClose = true;
        check(!resized.result, 'SD file resize failed: ' + resized.canonicalResult);
        const afterResize = await s.ipc('SD file size after resize ' + label, file, 4);
        if (!afterResize.result) {
          Object.assign(entry, {sizeAfterResize: Number(afterResize.data.readBigUInt64LE())});
        }
      }
      await s.write(output, bytes);
      const data = Buffer.alloc(24);
      data.writeBigUInt64LE(BigInt(offset), 8);
      data.writeBigUInt64LE(BigInt(bytes.length), 16);
      safeToClose = false;
      const written = await s.ipc('SD write file ' + label, file, 1, data,
        {send: [{address: output, size: bytes.length, mode: 1}]});
      safeToClose = true;
      if (written.result) {
        Object.assign(entry, {failed: 'write', target, result: written.result,
          canonicalResult: written.canonicalResult});
        state.calls.push(entry); await save();
      }
      check(!written.result, 'SD file write failed: ' + written.canonicalResult);
      const flushed = await s.ipc('SD flush file ' + label, file, 2);
      check(!flushed.result, 'SD file flush failed: ' + flushed.canonicalResult);
      const sized = await s.ipc('SD file size ' + label, file, 4);
      check(!sized.result, 'SD file size failed: ' + sized.canonicalResult);
      const size = Number(sized.data.readBigUInt64LE());
      check(size >= target, 'SD write size mismatch: ' + size);
      Object.assign(entry, {written: bytes.length, size, finalSize, sha256: hash(bytes)});
    } finally { if (safeToClose) await s.close(file); }
    state.calls.push(entry); await save();
    return entry;
  }
  if (command === 'sd-commit') {
    const {entry, disabled} = await beginWrite(command, request, state, save);
    if (disabled) return entry;
    sdHandle(s, entry.handle);
    const reply = await s.ipc('SD commit', entry.handle, 10);
    Object.assign(entry, {result: reply.result, canonicalResult: reply.canonicalResult});
    state.calls.push(entry); await save();
    return entry;
  }
  throw Error('Unknown native file operation');
}

module.exports = {dispatch, pathRequest};
