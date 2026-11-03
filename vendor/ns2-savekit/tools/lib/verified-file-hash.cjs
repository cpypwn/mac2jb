'use strict';

const crypto = require('node:crypto');

async function hashFile(session, filesystem, handle, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 * 1024)
    throw Error('Invalid save file size');
  const hash = crypto.createHash('sha256');
  for (let offset = 0; offset < size;) {
    const length = Math.min(0x40000, size - offset);
    const bytes = await filesystem.readFile(session, handle, offset, length);
    if (!Buffer.isBuffer(bytes) || bytes.length !== length)
      throw Error('Save file read returned fewer bytes than expected');
    hash.update(bytes);
    offset += length;
  }
  return hash.digest('hex');
}

module.exports = {hashFile};
