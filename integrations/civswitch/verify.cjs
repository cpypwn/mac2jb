'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function verify(root, source = false) {
  const directory = path.join(root, 'integrations/civswitch');
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'provenance.json'), 'utf8'));
  const payload = fs.readFileSync(path.join(directory, 'payload.txt'));
  const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  if (provenance.upstream !== 'https://github.com/Gezine/CivSwitch' ||
      provenance.commit !== 'f6b0f2bd285e7b32c0a1968181046f18edd79708' ||
      provenance.installerUpstreamCommit !== 'b1aa49dfbad6858c83da7b471baa49603f686258' ||
      provenance.installerSha256 !== 'e04dcc41c1ad85d5a9c138edd93bd2f7eb752fda872a258c1e1906eb1136c349' ||
      provenance.license !== 'MIT' || digest(payload) !== provenance.payloadSha256) {
    throw Error('CivSwitch payload provenance changed.');
  }
  const lines = payload.toString('ascii').split('\n');
  if (lines.pop() !== '' || lines.length !== provenance.payloadLines ||
      lines.some(line => !line.length || line.length + 1 > 254 ||
        [...line].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126))) {
    throw Error('CivSwitch chat payload has an invalid line.');
  }
  if (source) {
    const installer = path.join(root, 'vendor/CivSwitch/installer-creator/install.py');
    if (digest(fs.readFileSync(installer)) !== provenance.installerSha256)
      throw Error('CivSwitch upstream installer changed');
    for (const [name, expected] of Object.entries(provenance.files)) {
      const file = path.join(root, 'vendor/CivSwitch', name);
      if (!fs.statSync(file).isFile() || digest(fs.readFileSync(file)) !== expected)
        throw Error('CivSwitch upstream source changed: ' + name);
    }
  }
  return {lines: lines.length, sha256: provenance.payloadSha256};
}

if (require.main === module) {
  const root = path.resolve(__dirname, '../..');
  const source = process.argv[2] === '--source';
  if (process.argv.length > 3 || (process.argv.length === 3 && !source && process.argv[2] !== '--runtime'))
    throw Error('usage: node verify.cjs --source|--runtime');
  const result = verify(root, source);
  process.stdout.write('CivSwitch payload verified: ' + result.lines + ' lines, sha256 ' + result.sha256 + '\n');
}

module.exports = {verify};
