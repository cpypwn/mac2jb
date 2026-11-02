'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const genericMarker = '.mac2jb-hblauncher-attempt.json';
const ouncecakeMarker = '.mac2jb-ouncecake-attempt.json';

function releaseMarkers(directory, proof, ouncecakeMode = false) {
  const expected = ouncecakeMode ? [genericMarker, ouncecakeMarker] : [genericMarker];
  if (proof?.cleanupVerified !== true ||
      !/^[a-f0-9]{64}$/.test(proof.attemptMarkerSha256 || '') ||
      JSON.stringify(proof.attemptMarkers) !== JSON.stringify(expected)) {
    throw Error('The homebrew app did not prove its launch marker cleanup.');
  }
  const markers = expected.map(name => {
    const file = path.join(directory, name);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || (info.mode & 0o077) !== 0) {
        throw Error('The homebrew launch marker is not a private owned file.');
      }
      const bytes = fs.readFileSync(fd);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== proof.attemptMarkerSha256) throw Error('The homebrew launch marker changed.');
      return file;
    } finally {fs.closeSync(fd);}
  });
  for (const file of markers) fs.unlinkSync(file);
}

module.exports = {releaseMarkers};
