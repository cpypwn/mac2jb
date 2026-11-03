#!/usr/bin/env node
// Verify an NSO0 before anything is allowed to execute it.
//
//   node tools/nso-verify.cjs <file.nso>            # verify, human output
//   node tools/nso-verify.cjs <file.nso> --json     # machine output
//   node tools/nso-verify.cjs <file.nso> --no-hash  # header/bounds only
//
// Exit codes are the contract the launcher relies on:
//   0  valid NSO0 - safe to copy to the SD card and execute
//   3  present but INVALID (must show "invalid main", not run it)
//   4  missing / unreadable
//   2  bad usage
//
// What is checked (all of it measurable, none of it a trust fall):
//   * magic "NSO0", version 0, reserved 0, no unknown flag bits
//   * section file ranges are in order, non-overlapping, and inside the file
//     (this is the truncation check: the last section must end within the file)
//   * LZ4-compressed sections decompress to exactly the declared size
//   * declaration/`--no-hash` aside, the header's SHA-256 over each decompressed
//     section matches the bytes (flags bits 3/4/5); a flipped byte fails here
//   * module name is at the documented offset, sized, printable and NUL-terminated
//   * memory offsets are page aligned and leave room for the preceding section
//
// The layout is from switchbrew's NSO0 page (retrieved 2026-10-29), not guessed:
// sections are stored compressed, in order, starting at the end of the 0x100
// header, and each section's *file* size is at 0x60/0x64/0x68.
const fs = require('node:fs');
const crypto = require('node:crypto');

const VERSION = 0;
const FLAG_TEXT_COMPRESS = 1 << 0;
const FLAG_RO_COMPRESS = 1 << 1;
const FLAG_DATA_COMPRESS = 1 << 2;
const FLAG_TEXT_HASH = 1 << 3;
const FLAG_RO_HASH = 1 << 4;
const FLAG_DATA_HASH = 1 << 5;
const FLAG_EXEC_ONLY = 1 << 6;          // 20.0.0+
const FLAG_ZBIC = 1 << 7;               // 22.0.0+, zstd based
const KNOWN_FLAGS = 0xFF;
const PAGE = 0x1000;
const MAX_SECTION = 0x20000000;         // 512 MiB: refuse to allocate more

function align(n) { return Math.ceil(n / PAGE) * PAGE; }

// Raw LZ4 block decoder (LZ4_decompress_safe semantics). Input is untrusted, so
// every length is bounds checked instead of trusted.
function lz4Block(src, destSize) {
  if (!Number.isInteger(destSize) || destSize < 0 || destSize > MAX_SECTION)
    throw Error(`refusing to allocate section of ${destSize} bytes`);
  const out = Buffer.alloc(destSize);
  let i = 0, o = 0;
  while (i < src.length) {
    const token = src[i++];
    let literals = token >>> 4;
    if (literals === 15) {
      let b;
      do {
        if (i >= src.length) throw Error('LZ4 length runs past input');
        b = src[i++]; literals += b;
      } while (b === 255);
    }
    if (i + literals > src.length) throw Error('LZ4 literals run past input');
    if (o + literals > destSize) throw Error('LZ4 literals overrun output');
    src.copy(out, o, i, i + literals);
    i += literals; o += literals;
    if (i >= src.length) break;                       // final sequence: literals only
    if (i + 2 > src.length) throw Error('LZ4 match offset truncated');
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    if (offset === 0 || offset > o) throw Error(`LZ4 match offset ${offset} out of range`);
    let length = (token & 0x0F) + 4;
    if ((token & 0x0F) === 15) {
      let b;
      do {
        if (i >= src.length) throw Error('LZ4 match length runs past input');
        b = src[i++]; length += b;
      } while (b === 255);
    }
    if (o + length > destSize) throw Error('LZ4 match overruns output');
    for (let k = 0; k < length; k++, o++) out[o] = out[o - offset];
  }
  if (o !== destSize) throw Error(`LZ4 produced ${o} bytes, header says ${destSize}`);
  return out;
}

function parse(buffer, {hashes = true} = {}) {
  const problems = [];
  const notes = [];
  const fail = message => problems.push(message);
  const header = {};

  if (buffer.length < 0x100) {
    return {ok: false, problems: ['file is shorter than the 0x100 NSO header'], header};
  }
  header.magic = buffer.toString('latin1', 0, 4);
  header.version = buffer.readUInt32LE(4);
  header.reserved = buffer.readUInt32LE(8);
  header.flags = buffer.readUInt32LE(0x0C);
  header.fileSize = buffer.length;
  header.compressed = {text: !!(header.flags & FLAG_TEXT_COMPRESS),
    rodata: !!(header.flags & FLAG_RO_COMPRESS), data: !!(header.flags & FLAG_DATA_COMPRESS)};
  header.hashed = {text: !!(header.flags & FLAG_TEXT_HASH),
    rodata: !!(header.flags & FLAG_RO_HASH), data: !!(header.flags & FLAG_DATA_HASH)};
  header.executeOnly = !!(header.flags & FLAG_EXEC_ONLY);
  header.zbic = !!(header.flags & FLAG_ZBIC);

  if (header.magic !== 'NSO0') fail(`magic is ${JSON.stringify(header.magic)}, expected "NSO0"`);
  if (header.version !== VERSION) fail(`version is ${header.version}, expected ${VERSION}`);
  if (header.reserved !== 0) fail(`reserved word is 0x${header.reserved.toString(16)}, expected 0`);
  const unknown = header.flags & ~KNOWN_FLAGS;
  if (unknown) fail(`unknown flag bits 0x${unknown.toString(16)}`);
  if (header.zbic) fail('zbic-compressed NSO (flag 7): this verifier only implements LZ4');

  const seg = (name, fileOff, memOff, size, fileOffsetAt, sizeAt) => {
    const fileSize = buffer.readUInt32LE(fileOffsetAt);
    const entry = {name, fileOff, memOff, size, fileSize};
    if (fileOff < 0x100) fail(`${name}: file offset 0x${fileOff.toString(16)} is inside the header`);
    if (fileOff > buffer.length) fail(`${name}: file offset 0x${fileOff.toString(16)} is past the file`);
    if (memOff % PAGE !== 0) fail(`${name}: memory offset 0x${memOff.toString(16)} is not page aligned`);
    if (size === 0) fail(`${name}: declared size is 0`);
    if (size > MAX_SECTION) fail(`${name}: declared size 0x${size.toString(16)} is implausible`);
    const compressed = !!(header.flags & {text: FLAG_TEXT_COMPRESS, rodata: FLAG_RO_COMPRESS,
      data: FLAG_DATA_COMPRESS}[name]);
    if (!compressed && fileSize !== size) {
      fail(`${name}: not compressed but file size 0x${fileSize.toString(16)} != size 0x${size.toString(16)}`);
    }
    if (compressed && (fileSize === 0 || fileSize > size + 0x100)) {
      // LZ4 cannot meaningfully expand; a file size far above the declared size
      // means the header and the bytes disagree, which is what a broken copy looks like.
      fail(`${name}: compressed file size 0x${fileSize.toString(16)} vs size 0x${size.toString(16)} disagree`);
    }
    if (fileOff + fileSize > buffer.length) {
      fail(`${name}: needs bytes 0x${fileOff.toString(16)}..0x${(fileOff + fileSize).toString(16)} but the file ends at 0x${buffer.length.toString(16)} (truncated)`);
    }
    return entry;
  };

  const text = {fileOff: buffer.readUInt32LE(0x10), memOff: buffer.readUInt32LE(0x14),
    size: buffer.readUInt32LE(0x18)};
  const rodata = {fileOff: buffer.readUInt32LE(0x20), memOff: buffer.readUInt32LE(0x24),
    size: buffer.readUInt32LE(0x28)};
  const data = {fileOff: buffer.readUInt32LE(0x30), memOff: buffer.readUInt32LE(0x34),
    size: buffer.readUInt32LE(0x38)};
  header.text = seg('text', text.fileOff, text.memOff, text.size, 0x60, 0x18);
  header.rodata = seg('rodata', rodata.fileOff, rodata.memOff, rodata.size, 0x64, 0x28);
  header.data = seg('data', data.fileOff, data.memOff, data.size, 0x68, 0x38);
  header.bss = buffer.readUInt32LE(0x3C);
  header.moduleId = buffer.toString('hex', 0x40, 0x60).replace(/(00)+$/, '');
  header.moduleNameOffset = buffer.readUInt32LE(0x1C);
  header.moduleNameSize = buffer.readUInt32LE(0x2C);

  const segments = [header.text, header.rodata, header.data];
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1], cur = segments[i];
    if (cur.fileOff + 0 === prev.fileOff) fail(`${cur.name}: shares a file offset with ${prev.name}`);
    if (cur.fileOff < prev.fileOff + prev.fileSize)
      fail(`${cur.name}: file offset 0x${cur.fileOff.toString(16)} overlaps ${prev.name} ending at 0x${(prev.fileOff + prev.fileSize).toString(16)}`);
    if (cur.memOff < align(prev.memOff + prev.size))
      fail(`${cur.name}: memory offset 0x${cur.memOff.toString(16)} collides with ${prev.name} ending at 0x${(prev.memOff + prev.size).toString(16)}`);
  }
  if (header.text.memOff !== 0) notes.push(`text memory offset is 0x${header.text.memOff.toString(16)}, expected 0`);
  if (header.bss > 0x40000000) fail(`bss size 0x${header.bss.toString(16)} is implausible (>= 1 GiB)`);
  else if (header.bss % PAGE !== 0) notes.push(`bss size 0x${header.bss.toString(16)} is not page aligned`);

  // Module name: switchbrew says offset == sizeof(header) == 0x100.
  const nameOff = header.moduleNameOffset;
  const nameSize = header.moduleNameSize;
  if (nameOff !== 0x100) fail(`module name offset is 0x${nameOff.toString(16)}, expected 0x100`);
  if (nameSize < 1 || nameSize > 0x100) fail(`module name size ${nameSize} is out of range`);
  if (nameOff + nameSize > buffer.length) fail('module name runs past the file');
  else if (nameSize >= 1) {
    const raw = buffer.subarray(nameOff, nameOff + nameSize);
    header.moduleName = raw.toString('latin1').replace(/\0.*$/, '');
    if (!raw.includes(0)) fail('module name is not NUL terminated');
    if (!/^[\x20-\x7e]+$/.test(header.moduleName)) fail('module name is not printable ASCII');
    // The header must say where the text starts right after the name.
    if (header.text.fileOff !== nameOff + nameSize)
      notes.push(`text starts at 0x${header.text.fileOff.toString(16)}, not right after the module name (0x${(nameOff + nameSize).toString(16)})`);
  }

  if (header.fileSize > header.data.fileOff + header.data.fileSize + 0x1000)
    notes.push(`${header.fileSize - (header.data.fileOff + header.data.fileSize)} trailing bytes after the data section`);

  // Section contents: decompress and, when the header carries hashes, check them.
  const section = (entry, hashFlag, hashOffset) => {
    const compressed = header.compressed[entry.name];
    const raw = buffer.subarray(entry.fileOff, entry.fileOff + entry.fileSize);
    let bytes = raw;
    if (compressed) {
      try {
        bytes = lz4Block(raw, entry.size);
        entry.decompressed = true;
      } catch (error) {
        fail(`${entry.name}: LZ4 decompression failed: ${error.message}`);
        return;
      }
    }
    entry.firstWord = bytes.readUInt32LE(0);
    if (!hashes || !(header.flags & hashFlag)) {
      if (header.flags & hashFlag) notes.push(`${entry.name}: hash check skipped (--no-hash)`);
      return;
    }
    const want = buffer.toString('hex', hashOffset, hashOffset + 0x20);
    const got = crypto.createHash('sha256').update(bytes).digest('hex');
    entry.sha256 = got;
    if (want === '0'.repeat(64)) notes.push(`${entry.name}: header hash is all zero, nothing to compare`);
    else if (want !== got) fail(`${entry.name}: sha256 ${got.slice(0, 16)}… != header ${want.slice(0, 16)}…`);
    else entry.hashVerified = true;
  };
  if (problems.length === 0) {
    section(header.text, FLAG_TEXT_HASH, 0xA0);
    section(header.rodata, FLAG_RO_HASH, 0xC0);
    section(header.data, FLAG_DATA_HASH, 0xE0);
  }

  // A decompressed .text that starts with a zero word is not code. This catches a
  // header that parses but points at the wrong bytes, which bounds checks alone
  // would accept.
  if (header.text.firstWord === 0) fail('decompressed text starts with a zero word - not real code');
  return {ok: problems.length === 0, problems, notes, header};
}

function describe(result) {
  const h = result.header;
  const lines = [];
  lines.push(`file          ${h.fileSize} bytes`);
  lines.push(`magic         ${JSON.stringify(h.magic)}  version ${h.version}  flags 0x${(h.flags || 0).toString(16)}`);
  lines.push(`module        ${JSON.stringify(h.moduleName || '')} (id ${h.moduleId || ''})`);
  for (const name of ['text', 'rodata', 'data']) {
    const s = h[name];
    if (!s) continue;
    lines.push(`${name.padEnd(13)} file 0x${s.fileOff.toString(16)}..0x${(s.fileOff + s.fileSize).toString(16)} ` +
      `(${s.fileSize} B${s.decompressed ? ', LZ4' : ''}) -> memory 0x${s.memOff.toString(16)} +0x${s.size.toString(16)}` +
      `${s.hashVerified ? '  sha256 ok' : ''}`);
  }
  lines.push(`bss           0x${(h.bss || 0).toString(16)}`);
  for (const note of result.notes) lines.push(`note          ${note}`);
  for (const problem of result.problems) lines.push(`PROBLEM       ${problem}`);
  lines.push(result.ok ? 'VERDICT       valid NSO0' : 'VERDICT       INVALID - do not execute');
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const hashes = !argv.includes('--no-hash');
  const file = argv.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node nso-verify.cjs <file.nso> [--json] [--no-hash]');
    process.exit(2);
  }
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    const missing = {ok: false, missing: true, problems: [`cannot read ${file}: ${error.message}`]};
    if (json) console.log(JSON.stringify(missing, null, 2));
    else console.log(`MISSING       ${error.message}`);
    process.exit(4);
  }
  let result;
  try {
    result = parse(buffer, {hashes});
  } catch (error) {
    result = {ok: false, problems: [`parser threw: ${error.message}`], notes: [], header: {}};
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(describe(result));
  process.exit(result.ok ? 0 : 3);
}

module.exports = {parse, lz4Block, describe};
if (require.main === module) main();
