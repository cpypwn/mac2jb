#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {profiles, profileById, sourceDirectory, sourceDigest} = require('./host-profiles.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function verifyProfile(root, profile) {
  const folder = sourceDirectory(root, profile);
  if (sourceDigest(folder, profile) !== profile.sourceSha256) throw Error(profile.label + ' source digest mismatch.');
  const manifest = fs.readFileSync(path.join(folder, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const recorded = new Set();
  for (const line of manifest) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/.exec(line);
    if (!match || path.isAbsolute(match[2]) || match[2].split('/').some(part => part === '..' || part === '.') ||
        match[2].includes('\\') || recorded.has(match[2])) throw Error('Invalid host integrity manifest.');
    recorded.add(match[2]);
    const file = path.join(folder, match[2]);
    if (!fs.lstatSync(file).isFile() || hash(fs.readFileSync(file)) !== match[1]) throw Error('Host integrity mismatch: ' + file);
  }
  function walk(directory, relative = '') {
    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
      const name = relative + item.name;
      if (item.isDirectory()) walk(path.join(directory,item.name),name+'/');
      else if (!item.isFile() || (name !== 'SHA256SUMS' && !recorded.has(name)))
        throw Error('Unrecorded host source file: ' + name);
    }
  }
  walk(folder);
  const bytes = fs.readFileSync(path.join(root, profile.bootstrap));
  if (hash(bytes) !== profile.bootstrapSha256 || !bytes.equals(fs.readFileSync(path.join(folder,'bootstrap.bas'))))
    throw Error(profile.label + ' bootstrap mismatch.');
  if (!profile.licenseStatus || !fs.existsSync(path.join(folder,'README.md'))) throw Error('Missing host source attribution.');
  return folder;
}
function selectHost(root, id) {
  const profile = profileById(id), original = verifyProfile(root, profile);
  if (fs.existsSync(path.join(root,'selected-host.json'))) throw Error('Select a host only in a fresh runtime.');
  const active = path.join(root,'vendor/ns2jb');
  if (path.resolve(original) !== path.resolve(active)) {
    fs.rmSync(active,{recursive:true,force:true});
    fs.cpSync(original,active,{recursive:true,dereference:false});
  }
  const bootstrap = fs.readFileSync(path.join(root,profile.bootstrap));
  fs.writeFileSync(path.join(root,'assets/bootstrap.bas'),bootstrap,{mode:0o600});
  fs.writeFileSync(path.join(root,'assets/bootstrap.bas.sha256'),profile.bootstrapSha256+'  assets/bootstrap.bas\n',{mode:0o600});
  fs.writeFileSync(path.join(root,'selected-host.json'),JSON.stringify(profile,null,2)+'\n',{flag:'wx',mode:0o600});
  return profile;
}
function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--check') {
    for (const profile of profiles) verifyProfile(path.resolve(__dirname,'..'),profile);
    console.log('All pinned host sources and bootstraps verified.'); return;
  }
  if (args.length === 3 && args[0] === '--select') {
    // Foundation may retain /var while Node canonicalizes the same macOS
    // runtime to /private/var. Compare filesystem identities, not aliases.
    const root = fs.realpathSync(args[2]);
    // This operation is only for the new extracted runtime, never the checkout.
    if (!fs.existsSync(path.join(root,'source/LICENSE')) || !fs.existsSync(path.join(root,'node')) ||
        fs.realpathSync(path.resolve(__dirname,'..')) !== root) throw Error('Host selection requires a fresh bundled runtime.');
    selectHost(root,args[1]); return;
  }
  throw Error('Usage: prepare-host-profiles.cjs --check | --select PROFILE RUNTIME');
}
module.exports = {verifyProfile,selectHost,main};
if (require.main === module) {try {main();} catch(error) {console.error(error.message);process.exitCode=1;}}
