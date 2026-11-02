#!/usr/bin/env node
// Inspect and diff SmileBASIC 4's `f/###/META` - the per-workspace metadata file
// that carries the name shown in direct mode and a 40x69 thumbnail.
//
//   node tools/smb-meta.cjs dump <META> [--png out.png]
//   node tools/smb-meta.cjs diff <META-a> <META-b>
//   node tools/smb-meta.cjs name <META> <new name>            (in place)
//   node tools/smb-meta.cjs icon <META> <image.png>           (in place)
//
// Layout as measured on hardware (docs/RESULTS.md, 2026-10-29):
//   the file is exactly 0x70 + 40*69*4 = 11152 bytes; the 11040-byte tail renders
//   a crisp 40x69 32-bit icon (BGRA, alpha 0xff) at 0x70, and 0x70 also holds the
//   UTF-16LE header text "PCPM0005" + the workspace name. That overlap is why this
//   tool treats the name region and the icon region as separate views of the same
//   bytes and always reports both, rather than pretending one of them is wrong.
//
// The in-place writers are deliberately conservative: they refuse to grow the file,
// refuse a name longer than the existing NUL-terminated slot, and keep the file
// length identical so the save write stays a same-size replace.
const fs = require('node:fs');
const path = require('node:path');

const HEADER = 0x70;
const WIDTH = 40;
const HEIGHT = 69;
const ICON_BYTES = WIDTH * HEIGHT * 4;
const NAME_TAG = 'PCPM0005';
// The name lives in one 32-byte block at NAME_BLOCK: the 8-byte tag plus a
// NUL-terminated UTF-16 name. [WORKSPACE] fills it exactly (11 chars = 22 bytes +
// 2), so 22 bytes is the measured capacity. '--allow-overlap' can write past it,
// which overwrites the thumbnail's first pixels - measured to be a black margin in
// this sample, but not proven harmless on the console.
const NAME_BLOCK = 32;
const NAME_CAPACITY = NAME_BLOCK - NAME_TAG.length - 2;

function parse(buffer) {
  const info = {size: buffer.length, headerWords: [], name: null, nameOffset: null,
    nameBytes: 0, icon: null, problems: []};
  if (buffer.length < HEADER + ICON_BYTES) info.problems.push(
    `size ${buffer.length} is smaller than the ${HEADER + ICON_BYTES}-byte layout`);
  for (let off = 0; off < HEADER; off += 4) info.headerWords.push(buffer.readUInt32LE(off));
  const tagAt = buffer.indexOf(Buffer.from(NAME_TAG, 'latin1'), 0, 'latin1');
  info.headerWords = info.headerWords;
  info.tagOffset = tagAt;
  if (tagAt < 0) {
    info.problems.push('PCPM0005 tag not found');
  } else {
    const start = tagAt + NAME_TAG.length;
    let end = start;
    while (end + 1 < buffer.length && buffer.readUInt16LE(end) !== 0) end += 2;
    info.nameOffset = start;
    info.nameBytes = end - start;
    info.name = buffer.toString('utf16le', start, end);
    // Capacity is the block's, not the current string's: deriving it from the name
    // made a shorter name shrink the slot and a later longer write be refused.
    info.nameCapacity = NAME_CAPACITY;
  }
  if (buffer.length >= HEADER + ICON_BYTES) {
    info.icon = {offset: HEADER, width: WIDTH, height: HEIGHT, bytes: ICON_BYTES};
    // The header's u32 at 0x08 has been 11040 in every sample, i.e. the icon size.
    info.declaredPayload = buffer.readUInt32LE(0x08);
    if (info.declaredPayload !== ICON_BYTES)
      info.problems.push(`header payload ${info.declaredPayload} != ${ICON_BYTES}`);
  }
  return info;
}

function dump(file, png) {
  const buffer = fs.readFileSync(file);
  const info = parse(buffer);
  console.log(`file        ${file} (${info.size} bytes)`);
  console.log(`header      ${info.headerWords.slice(0, 4).map(w => '0x' + w.toString(16)).join(' ')} ...`);
  console.log(`tag         ${info.tagOffset >= 0 ? '0x' + info.tagOffset.toString(16) : 'missing'} ${NAME_TAG}`);
  if (info.name !== null) {
    console.log(`name        ${JSON.stringify(info.name)} at 0x${info.nameOffset.toString(16)} ` +
      `(${info.nameBytes} bytes of UTF-16, capacity ${info.nameCapacity})`);
  }
  if (info.icon) console.log(`icon        ${WIDTH}x${HEIGHT} BGRA at 0x${HEADER.toString(16)} ` +
    `(${ICON_BYTES} bytes; header says ${info.declaredPayload})`);
  for (const problem of info.problems) console.log('PROBLEM     ' + problem);
  if (png && info.icon) {
    // Minimal PNG via zlib, so this needs no image library.
    const zlib = require('node:zlib');
    const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
    for (let y = 0; y < HEIGHT; y++) {
      raw[y * (1 + WIDTH * 3)] = 0;
      for (let x = 0; x < WIDTH; x++) {
        const src = HEADER + (y * WIDTH + x) * 4;
        const dst = y * (1 + WIDTH * 3) + 1 + x * 3;
        raw[dst] = buffer[src + 2];      // B,G,R,A -> R,G,B
        raw[dst + 1] = buffer[src + 1];
        raw[dst + 2] = buffer[src];
      }
    }
    const chunk = (type, data) => {
      const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(require('node:zlib').crc32 ? zlib.crc32(body) : crc32(body));
      return Buffer.concat([length, body, crc]);
    };
    function crc32(buf) {
      let table = crc32.table;
      if (!table) {
        table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
          table[n] = c;
        }
      }
      let c = -1;
      for (const byte of buf) c = table[(c ^ byte) & 0xFF] ^ (c >>> 8);
      return (c ^ -1) >>> 0;
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(WIDTH, 0); ihdr.writeUInt32BE(HEIGHT, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    fs.writeFileSync(png, Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
    ]));
    console.log(`png         ${png}`);
  }
  return info;
}

function ranges(a, b) {
  const out = [];
  let start = -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const same = i < a.length && i < b.length && a[i] === b[i];
    if (!same && start < 0) start = i;
    if (same && start >= 0) { out.push([start, i]); start = -1; }
  }
  if (start >= 0) out.push([start, Math.max(a.length, b.length)]);
  return out;
}

function diff(fileA, fileB) {
  const a = fs.readFileSync(fileA), b = fs.readFileSync(fileB);
  const ia = parse(a), ib = parse(b);
  console.log(`A ${fileA} (${a.length})  name ${JSON.stringify(ia.name)}`);
  console.log(`B ${fileB} (${b.length})  name ${JSON.stringify(ib.name)}`);
  if (a.length !== b.length) console.log(`LENGTH DIFFERS by ${b.length - a.length} bytes`);
  const parts = ranges(a, b);
  console.log(`${parts.length} differing range(s):`);
  for (const [start, end] of parts.slice(0, 40)) {
    const region = start < HEADER ? 'header' : start < HEADER + ICON_BYTES ? 'icon/name' : 'tail';
    console.log(`  0x${start.toString(16)}..0x${end.toString(16)} (${end - start} B, ${region}) ` +
      `A=${a.subarray(start, Math.min(end, start + 8)).toString('hex')} ` +
      `B=${b.subarray(start, Math.min(end, start + 8)).toString('hex')}`);
  }
}

// Rewrite the NUL-terminated UTF-16 name in place. The slot is whatever the file
// already has: growing it would move the icon and change the file size, which the
// save write must not do.
function setName(file, name, allowOverlap = false) {
  const buffer = fs.readFileSync(file);
  const info = parse(buffer);
  if (info.nameOffset === null) throw Error('no PCPM0005 name slot in ' + file);
  const encoded = Buffer.from(name, 'utf16le');
  const capacity = allowOverlap ? NAME_BLOCK * 8 : info.nameCapacity;
  if (encoded.length > capacity) {
    throw Error(`name ${JSON.stringify(name)} needs ${encoded.length} bytes but the slot holds ` +
      `${capacity} (${Math.floor(capacity / 2)} UTF-16 characters); pass --allow-overlap to ` +
      'write past the block, which overwrites thumbnail pixels');
  }
  const slot = Buffer.alloc(capacity + 2);                // + the terminating NUL
  encoded.copy(slot, 0);
  slot.copy(buffer, info.nameOffset);
  fs.writeFileSync(file, buffer);
  console.log(`name -> ${JSON.stringify(name)} (${encoded.length}/${capacity} bytes)` +
    (allowOverlap ? ' - overlapping thumbnail pixels' : ''));
}

function setIcon(file, png) {
  // Accept a PNG through the OS converter so this stays dependency-free: sips is
  // present on macOS, and the icon is only 40x69.
  const buffer = fs.readFileSync(file);
  const info = parse(buffer);
  if (!info.icon) throw Error('no icon region in ' + file);
  const {execFileSync} = require('node:child_process');
  const raw = path.join(path.dirname(png), '.smb-icon.rgba');
  execFileSync('sips', ['-s', 'format', 'png', '-z', String(HEIGHT), String(WIDTH), png,
    '--out', raw + '.png'], {stdio: 'ignore'});
  const decoded = execFileSync('sips', ['-s', 'format', 'bmp', raw + '.png', '--out', raw + '.bmp'],
    {stdio: 'ignore'});
  // Fall back to node-canvas-free decoding: a 24-bit BMP written by sips.
  const bmp = fs.readFileSync(raw + '.bmp');
  const dataOffset = bmp.readUInt32LE(10);
  const width = bmp.readInt32LE(18), height = Math.abs(bmp.readInt32LE(22));
  const bpp = bmp.readUInt16LE(28);
  if (width !== WIDTH || height !== HEIGHT) throw Error(`expected ${WIDTH}x${HEIGHT}, got ${width}x${height}`);
  if (bpp !== 24) throw Error(`expected a 24-bit BMP, got ${bpp} bpp`);
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  for (let y = 0; y < HEIGHT; y++) {
    const srcY = height === HEIGHT ? HEIGHT - 1 - y : y;   // bottom-up BMP
    for (let x = 0; x < WIDTH; x++) {
      const s = dataOffset + srcY * stride + x * 3;
      const d = HEADER + (y * WIDTH + x) * 4;
      buffer[d] = bmp[s]; buffer[d + 1] = bmp[s + 1]; buffer[d + 2] = bmp[s + 2]; buffer[d + 3] = 0xFF;
    }
  }
  fs.writeFileSync(file, buffer);
  fs.rmSync(raw + '.png', {force: true}); fs.rmSync(raw + '.bmp', {force: true});
  console.log(`icon -> ${png} (${WIDTH}x${HEIGHT} BGRA)`);
}

function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb === 'dump') {
    const pngAt = rest.indexOf('--png');
    dump(rest[0], pngAt >= 0 ? rest[pngAt + 1] : null);
  } else if (verb === 'diff') diff(rest[0], rest[1]);
  else if (verb === 'name') setName(rest[0],
    rest.slice(1).filter(a => a !== '--allow-overlap').join(' '), rest.includes('--allow-overlap'));
  else if (verb === 'icon') setIcon(rest[0], rest[1]);
  else {
    console.error('usage: smb-meta.cjs dump <META> [--png out.png] | diff <a> <b> | ' +
      'name <META> <text> [--allow-overlap] | icon <META> <png>');
    process.exit(2);
  }
}

module.exports = {parse, diff, setName, setIcon, HEADER, WIDTH, HEIGHT, ICON_BYTES};
if (require.main === module) {
  try { main(); } catch (error) { console.error('FAILED: ' + error.message); process.exit(1); }
}
