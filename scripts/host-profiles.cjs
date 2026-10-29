#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const manifest = require('../packaging/host-profiles.json');
const profiles = Object.freeze(manifest.profiles.map(row => Object.freeze({...row,
  startPort: row.startPort || 39380, saveName: row.saveName || 'NS2'})));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function profileById(id) {
  const profile = profiles.find(row => row.id === id);
  if (!profile) throw Error('Unknown host profile.');
  return profile;
}
function sourceDirectory(root, profile) {
  // The source copy remains immutable when a different active host is selected.
  const original = path.join(root, 'source', profile.sourceDirectory);
  return fs.existsSync(original) ? original : path.join(root, profile.sourceDirectory);
}
function sourceDigest(folder, profile) {
  if (profile?.engine === 'izmysh') {
    const names = [];
    function walkIZMYSH(directory, relative = '') {
      for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
        const name = relative + item.name, file = path.join(directory, item.name);
        if (item.isDirectory()) walkIZMYSH(file, name + '/');
        else if (item.isFile()) names.push(name);
        else throw Error('Unexpected IZMYSH source file: ' + name);
      }
    }
    walkIZMYSH(folder);
    return hash(JSON.stringify(names.sort().map(name => [name, hash(fs.readFileSync(path.join(folder, name)))])));
  }
  const names = ['run.cjs', 'bootstrap.bas'];
  for (const name of ['rpc.cjs', 'dump-firmware.cjs'])
    if (fs.existsSync(path.join(folder, name))) names.push(name);
  function walk(relative) {
    for (const item of fs.readdirSync(path.join(folder, relative), {withFileTypes: true})) {
      const name = relative + '/' + item.name;
      if (item.isDirectory()) walk(name);
      else if (item.isFile()) names.push(name);
      else throw Error('Unexpected host source file: ' + name);
    }
  }
  walk('engine');
  return hash(JSON.stringify(names.sort().map(name => [name, hash(fs.readFileSync(path.join(folder, name)))])));
}
function selectedProfile(root) {
  let selected;
  try {selected = JSON.parse(fs.readFileSync(path.join(root, 'selected-host.json'), 'utf8'));}
  catch (error) {if (error.code === 'ENOENT') return profileById(manifest.default); throw error;}
  const profile = profileById(selected.id);
  if (selected.sourceSha256 !== profile.sourceSha256 || selected.bootstrapSha256 !== profile.bootstrapSha256 ||
      selected.revision !== profile.revision || (selected.startPort || 39380) !== (profile.startPort || 39380) ||
      (selected.saveName || 'NS2') !== (profile.saveName || 'NS2'))
    throw Error('Selected host metadata does not match its pinned source.');
  return profile;
}
function trustedProfileForDigest(root, digest) {
  const profile = profiles.find(row => row.sourceSha256 === digest && row.supportsHeldRPC);
  if (!profile) throw Error('This session was not created by a supported pinned RPC host.');
  const directory = sourceDirectory(root, profile);
  if (sourceDigest(directory, profile) !== profile.sourceSha256) throw Error('The pinned host source failed its integrity check.');
  return {profile, sourceDirectory: directory};
}
function validStartCommand(command, profile = profileById(manifest.default), address) {
  const match = typeof command === 'string' && /^V=START\((\d+(?:,\d+)*)\)$/.exec(command);
  if (!match) return false;
  const fields = match[1].split(',');
  const port = profile.startPort || 39380;
  if (fields.length !== profile.startArgumentCount || fields[0] !== String(port)) return false;
  if (!fields.every((field, index) => /^(?:0|[1-9]\d*)$/.test(field) && Number.isSafeInteger(Number(field)) &&
      Number(field) <= (index === 0 ? 65535 : index < 5 ? 255 : 281474976710655))) return false;
  return address === undefined || fields.slice(1, 5).join('.') === address;
}
function incompatibleLegacyStartHint(line, startArgumentCount) {
  if (startArgumentCount !== 5) return false;
  const clean = line.trim();
  return /^If BASIC says Wrong number of arguments, use the older nine-argument form instead:$/.test(clean) ||
    /^V=START\(\d+(?:,\d+){8}\)$/.test(clean);
}
module.exports = {profiles, profileById, selectedProfile, sourceDirectory, sourceDigest, trustedProfileForDigest, validStartCommand, incompatibleLegacyStartHint};
