'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const FS_ID = '0400000000000000';
const PAGE = 0x1000;
const MAX_MODULE = 64 * 1024 * 1024;
const check = (ok, message) => {if (!ok) throw Error(message);};
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const align = (n, size = PAGE) => Math.ceil(n / size) * size;

function parseArgs(args) {
  let run, out, planOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--fs-only' && !run) run = args[++i];
    else if (arg === '--out' && !out) out = args[++i];
    else if (arg === '--plan-only') planOnly = true;
    else throw Error('Unknown or repeated FS dump argument: ' + arg);
    if ((arg === '--fs-only' && (!run || run.startsWith('--'))) ||
        (arg === '--out' && (!out || out.startsWith('--')))) throw Error(arg + ' requires a path');
  }
  check(run, '--fs-only requires the held run directory');
  run = path.resolve(run);
  out = out ? path.resolve(out) : path.join(run, 'fs-memory-' + new Date().toISOString().replace(/[:.]/g, '-'));
  return {run, out, planOnly};
}

function checkedInfo(reply, pid) {
  check(reply && reply.result === 0 && reply.queryResult === 0 && reply.programId === FS_ID &&
    reply.pid === pid, 'FS process identity or mapping query failed');
  const m = reply.memory;
  const address = Number(m.address), size = Number(m.size);
  check(Number.isSafeInteger(address) && address >= 0 && Number.isSafeInteger(size) && size > 0 &&
    Number.isSafeInteger(address + size) && address + size <= 2 ** 39,
  'Invalid FS mapping extent');
  return {...m, address, size};
}

// Capture only contiguous mappings around the verified FS method.
async function planModule(client, handle, pid, anchor, onMapping = async () => {}) {
  const text = checkedInfo(await client.info(handle, BigInt(anchor), BigInt(pid)), pid);
  await onMapping(text);
  check(text.address <= anchor && anchor < text.address + text.size && text.address >= 2 ** 32 &&
    text.address % PAGE === 0 && text.size % PAGE === 0 &&
    text.type === 3 && [4, 5].includes(text.permissions) && !text.attributes,
  'The verified FS method is not in a clean executable code mapping');
  const segments = [{...text, name: '.text', readMethod: 'ro-alias'}];
  let cursor = text.address + text.size;
  for (let i = 0; i < 8; i++) {
    const m = checkedInfo(await client.info(handle, BigInt(cursor), BigInt(pid)), pid);
    await onMapping(m);
    // PermissionLocked RO pages require the retained reader.
    const lockedRo = m.type === 4 && m.permissions === 1 && m.attributes === 0x10;
    check(m.address === cursor && [3, 4].includes(m.type) && (!m.attributes || lockedRo) &&
      m.size % PAGE === 0 && [1, 3].includes(m.permissions),
    'FS main module layout is not contiguous RO/data; no guessed dump was made');
    check(m.address + m.size - text.address <= MAX_MODULE, 'FS module exceeds 64 MiB bound');
    if (m.permissions === 3) {
      check(segments.length > 1, 'FS read-only data mapping is missing');
      segments.push({...m, name: '.data', readMethod: 'ro-alias'});
      return segments;
    }
    segments.push({...m, name: lockedRo ? '.rodata.locked.' + segments.length :
      segments.length === 1 ? '.rodata' : '.rodata.' + segments.length,
      readMethod: lockedRo ? 'retained' : 'ro-alias'});
    cursor = m.address + m.size;
  }
  throw Error('FS writable data mapping not found within bounded main module layout');
}

// Keep live addresses; this is a snapshot, not NSO.
function buildElf(segments, buffers) {
  check(segments.length >= 3 && segments.length === buffers.length, 'ELF segment count differs');
  let offset = align(64 + segments.length * 56);
  const offsets = buffers.map((bytes, i) => {
    check(bytes.length === segments[i].size, 'ELF segment is incomplete');
    const at = offset; offset = align(offset + bytes.length); return at;
  });
  let strings = '\0';
  const names = segments.map(s => {const at = Buffer.byteLength(strings); strings += s.name + '\0'; return at;});
  const strName = Buffer.byteLength(strings); strings += '.shstrtab\0';
  const strBytes = Buffer.from(strings);
  const strOffset = offset;
  const sectionOffset = align(strOffset + strBytes.length, 8);
  const sectionCount = segments.length + 2;
  const elf = Buffer.alloc(sectionOffset + sectionCount * 64);
  Buffer.from('7f454c4602010100', 'hex').copy(elf);
  elf.writeUInt16LE(2, 16); // ET_EXEC: addresses already relocated by the loader.
  elf.writeUInt16LE(183, 18); elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(BigInt(segments[0].address), 24);
  elf.writeBigUInt64LE(64n, 32); elf.writeBigUInt64LE(BigInt(sectionOffset), 40);
  elf.writeUInt16LE(64, 52); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(segments.length, 56);
  elf.writeUInt16LE(64, 58); elf.writeUInt16LE(sectionCount, 60); elf.writeUInt16LE(sectionCount - 1, 62);
  segments.forEach((s, i) => {
    const ph = 64 + i * 56, sh = sectionOffset + (i + 1) * 64;
    const flags = ((s.permissions & 1) ? 4 : 0) | ((s.permissions & 2) ? 2 : 0) | ((s.permissions & 4) ? 1 : 0);
    elf.writeUInt32LE(1, ph); elf.writeUInt32LE(flags, ph + 4);
    [offsets[i], s.address, s.address, s.size, s.size, PAGE].forEach((v, j) => elf.writeBigUInt64LE(BigInt(v), ph + 8 + j * 8));
    elf.writeUInt32LE(names[i], sh); elf.writeUInt32LE(1, sh + 4);
    elf.writeBigUInt64LE(BigInt(2 | (s.permissions & 2 ? 1 : 0) | (s.permissions & 4 ? 4 : 0)), sh + 8);
    elf.writeBigUInt64LE(BigInt(s.address), sh + 16);
    elf.writeBigUInt64LE(BigInt(offsets[i]), sh + 24); elf.writeBigUInt64LE(BigInt(s.size), sh + 32);
    elf.writeBigUInt64LE(BigInt(PAGE), sh + 48);
    buffers[i].copy(elf, offsets[i]);
  });
  strBytes.copy(elf, strOffset);
  const sh = sectionOffset + (sectionCount - 1) * 64;
  elf.writeUInt32LE(strName, sh); elf.writeUInt32LE(3, sh + 4);
  elf.writeBigUInt64LE(BigInt(strOffset), sh + 24); elf.writeBigUInt64LE(BigInt(strBytes.length), sh + 32);
  elf.writeBigUInt64LE(1n, sh + 48);
  return elf;
}

async function bulkRead(client, handle, pid, address, length) {
  const input = Buffer.alloc(32);
  [pid, address, length, 0].forEach((v, i) => input.writeBigUInt64LE(BigInt(v), i * 8));
  const reply = await client.worker({kind: 'ro-process', handle: client.handle, processHandle: handle,
    id: 0x524f0016, hex: input.toString('hex')}, 30000);
  if (!reply || reply.transport || reply.kernelPid !== client.pid) {
    client.pending = true;
    throw Error('Bulk reply did not come from the verified RO process; native state is uncertain');
  }
  const data = Buffer.from(reply.data || '', 'hex');
  if (data.length < 56) {client.pending = true; throw Error('Bulk read metadata is truncated; native state is uncertain');}
  if (data.readBigUInt64LE(40) !== 0n) {
    // Stop requests if an alias may remain mapped.
    client.pending = true;
    throw Error('RO alias unmap failed; no further native request was issued');
  }
  check(reply.result === 0 && data.readBigUInt64LE(0) === BigInt(pid) &&
    data.readBigUInt64LE(8) === BigInt('0x' + FS_ID) && data.readBigUInt64LE(16) === 0n &&
    data.readBigUInt64LE(32) === 0n && data.readBigUInt64LE(48) === BigInt(length) &&
    reply.length === length && typeof reply.outputFile === 'string' &&
    /^[0-9a-f]{64}$/.test(reply.sha256 || ''), 'FS bulk read failed or its metadata differs');
  const bytes = await fs.readFile(reply.outputFile);
  check(bytes.length === length && sha256(bytes) === reply.sha256, 'FS bulk capture length/hash differs on disk');
  return {bytes, sourceFile: reply.outputFile, sha256: reply.sha256};
}

async function readSegment(client, handle, pid, segment, address, length) {
  if (segment.readMethod !== 'retained') return bulkRead(client, handle, pid, address, length);
  check(segment.type === 4 && segment.permissions === 1 && segment.attributes === 0x10 &&
    address >= segment.address && address + length <= segment.address + segment.size,
  'Retained FS segment is not the verified PermissionLocked read-only mapping');
  let bytes;
  try {bytes = await client.memory.read(address, length);}
  catch (error) {client.pending = true; throw error;} // No further native IPC after an uncertain endpoint read.
  check(Buffer.isBuffer(bytes) && bytes.length === length, 'Retained FS segment read was truncated');
  const digest = sha256(bytes);
  const capture = client.memory.captures?.at(-1);
  if (capture) check(capture.address === address && capture.length === length && capture.sha256 === digest,
    'Retained FS segment capture metadata differs');
  return {bytes, sha256: digest, sourceFile: capture?.outputFile};
}

async function captureFs({client, proof, out, planOnly = false, signal, log = console.log}) {
  await fs.mkdir(out); // Exclusive: never clear or overwrite an existing dump.
  const file = path.join(out, 'fs-memory.json');
  const journal = {format: 'fs-process-snapshot-v1', programId: FS_ID, session: proof.session,
    scope: 'main FS code mapping and contiguous RO/data mappings, with live ASLR addresses',
    originalNso: false, atomicSnapshot: false, complete: false, segments: [], started: new Date().toISOString()};
  const save = async () => {
    const temporary = file + '.next';
    await fs.writeFile(temporary, JSON.stringify(journal, null, 2) + '\n', {flag: 'wx'});
    await fs.rename(temporary, file);
  };
  const cancelled = () => {if (signal?.aborted) throw Error('FS dump cancelled after the current native operation completed');};
  let failure;
  try {
    await save();
    log('FS process dump folder: ' + out);
    cancelled();
    await client.open();
    check(client.memory.info.session === proof.session && client.memory.reportFile === proof.report,
      'The FS proof belongs to a different retained endpoint');
    const handle = await client.fsProcess();
    const identity = await client.info(handle);
    check(identity.result === 0 && identity.programId === FS_ID && identity.pid === proof.identity.pid,
      'Target process is not the verified native FS');
    journal.pid = identity.pid;
    journal.mappingQueries = [];
    const segments = await planModule(client, handle, identity.pid, proof.notifier.target, async mapping => {
      journal.mappingQueries.push(mapping);
      await save();
    });
    journal.plan = segments;
    await save();
    for (const s of segments) log(s.name + ': 0x' + s.address.toString(16) + ', ' + s.size +
      ' bytes, permissions=' + s.permissions + ', attributes=0x' + s.attributes.toString(16) + ', reader=' + s.readMethod);
    if (planOnly) {journal.planOnly = true; return journal;}
    const buffers = [];
    for (const segment of segments) {
      cancelled();
      const parts = [], chunks = [];
      for (let offset = 0; offset < segment.size; offset += 0x100000) {
        cancelled();
        const length = Math.min(0x100000, segment.size - offset);
        const part = await readSegment(client, handle, identity.pid, segment, segment.address + offset, length);
        parts.push(part.bytes);
        chunks.push({address: segment.address + offset, length, sha256: part.sha256,
          sourceFile: part.sourceFile, readMethod: segment.readMethod});
        log(segment.name + ': ' + (offset + length) + '/' + segment.size + ' bytes');
      }
      const bytes = Buffer.concat(parts);
      const name = segment.name.slice(1) + '.bin';
      await fs.writeFile(path.join(out, name), bytes, {flag: 'wx'});
      const digest = sha256(bytes);
      check(sha256(await fs.readFile(path.join(out, name))) === digest, 'Saved FS segment hash differs');
      journal.segments.push({...segment, file: name, sha256: digest, chunks});
      buffers.push(bytes);
      await save();
    }
    cancelled();
    const elf = buildElf(segments, buffers);
    await fs.writeFile(path.join(out, 'fs-main.elf'), elf, {flag: 'wx'});
    journal.elf = {file: 'fs-main.elf', size: elf.length, sha256: sha256(elf)};
    check(sha256(await fs.readFile(path.join(out, 'fs-main.elf'))) === journal.elf.sha256, 'Saved FS ELF hash differs');
    journal.captureComplete = true;
    return journal;
  } catch (error) {
    failure = error; journal.error = error.message;
    throw error;
  } finally {
    let cleanupError;
    try {
      if (client.record) await client.close();
      journal.cleanup = {closed: !client.pending, pending: !!client.pending};
      journal.complete = !!journal.captureComplete && !client.pending && !failure;
    } catch (error) {
      cleanupError = error;
      journal.complete = false;
      journal.cleanup = {closed: false, pending: !!client.pending, error: error.message};
      journal.error ||= error.message;
      log('FS dump cleanup failed: ' + error.message);
    }
    journal.finished = new Date().toISOString();
    try {await save();} catch (error) {log('FS dump journal save failed: ' + error.message); cleanupError ||= error;}
    if (!failure && cleanupError) throw cleanupError;
  }
}

async function main(args) {
  const options = parseArgs(args);
  const engine = path.join(options.run, 'switch2');
  const current = await readJson(path.join(engine, 'fs-execution-current.json'));
  check(current.session === path.basename(options.run) && current.verified && current.restored &&
    current.programId === FS_ID && current.retainedEndpoint?.ready, 'A held, verified FS execution run is required');
  const proof = await readJson(current.file);
  check(proof.session === current.session && proof.verified && proof.identity?.programId === FS_ID &&
    proof.identity.pid === current.pid && proof.notifier?.target && proof.trials?.length === 2 &&
    proof.trials.every(t => t.verified && t.restored), 'FS execution proof is incomplete or not restored');
  const execution = await readJson(path.join(engine, 'ro/current-execution.json'));
  const payload = await fs.readFile(path.join(engine, 'ro/payload/main'));
  check(execution.verified && execution.session === current.session && execution.report === proof.report &&
    sha256(payload) === execution.payloadSha256, 'The current RO payload or session differs from the verified one');
  const {Client} = require(path.join(engine, 'process/client.cjs'));
  const cancellation = new AbortController();
  const stop = () => cancellation.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await captureFs({...options, client: new Client(), proof, signal: cancellation.signal});
    if (result.planOnly) console.log('FS mapping plan saved; no segment bytes captured.');
    else {check(result.complete, 'FS dump did not complete'); console.log('FS ELF saved: ' + path.join(options.out, result.elf.file));}
    return result;
  } finally {process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);}
}

module.exports = {parseArgs, checkedInfo, planModule, buildElf, bulkRead, readSegment, captureFs, main};
