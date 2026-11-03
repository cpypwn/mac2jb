'use strict';
// The console's own title name, out of a control NACP.
//
// A NACP is 0x4000 bytes: 16 language slots of 0x300 at 0, each with a 0x200-byte
// short name, then the publisher block. A newer (Switch 2) NACP deflates the name
// block and says so at 0x3215: format 1 means the block is [u16 size][raw
// deflate] instead of plain text. This is the read ouncecake does, and for a
// Switch 2 title it is the only source: blawar/titledb is a Switch 1 catalogue.
//
// The parse is offline and total: anything malformed returns null, because a name
// is a convenience and must never fail a listing.
const zlib = require('node:zlib');

const SLOTS = 16;
const SLOT_SIZE = 0x300;
const NAME_SIZE = 0x200;
const BLOCK = SLOTS * SLOT_SIZE;   // 0x3000
const FORMAT_OFFSET = 0x3215;
const MIN_SIZE = FORMAT_OFFSET + 1;

// Control characters and bidi overrides would wreck a terminal line; keep the
// words, drop the noise.
function clean(value) {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The name block, inflated when the header says it is deflated.
function block(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < MIN_SIZE) return null;
  let titles = bytes.subarray(0, Math.min(BLOCK, bytes.length));
  if (bytes[FORMAT_OFFSET] !== 1) return titles;
  const size = titles.readUInt16LE();
  if (size < 2 || 2 + size > titles.length) return null;
  return zlib.inflateRawSync(titles.subarray(2, 2 + size),
    {maxOutputLength: SLOTS * SLOT_SIZE});
}

// One entry per language slot: a cleaned name, or null where the slot is empty or
// not valid UTF-8.
function names(bytes) {
  let titles;
  try {
    titles = block(bytes);
  } catch {
    return [];
  }
  if (!titles) return [];
  const out = [];
  for (let slot = 0; slot < SLOTS; slot++) {
    const entry = titles.subarray(slot * SLOT_SIZE, (slot + 1) * SLOT_SIZE);
    if (entry.length < NAME_SIZE) break;
    const found = entry.subarray(0, NAME_SIZE).indexOf(0);
    const end = found < 0 ? NAME_SIZE : found;    // a full slot is unterminated
    if (!end) { out.push(null); continue; }
    try {
      out.push(clean(new TextDecoder('utf-8', {fatal: true}).decode(entry.subarray(0, end))));
    } catch {
      out.push(null);
    }
  }
  return out;
}

// Slot 0 is American English, so the first non-empty name is the English one.
function name(bytes) {
  for (const value of names(bytes)) if (value) return value;
  return null;
}

module.exports = {name, names, clean, FORMAT_OFFSET, SLOTS, SLOT_SIZE, NAME_SIZE};
