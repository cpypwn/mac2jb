#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const {probe, companionRequest, validAddress} = require('./gui-civswitch-moonlight.cjs');

const PREFIX = 'MAC2JB_CIV_PACKAGE ';
const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

function emit(type, fields = {}) {
  process.stdout.write(PREFIX + JSON.stringify({type, ...fields}) + '\n');
}

function inspectPackage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_PACKAGE_BYTES)
    throw Error('Choose a .civapp package smaller than 32 MiB');
  let item;
  try { item = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  catch { throw Error('The .civapp package is not valid JSON'); }
  if (!item || item.format !== 'civswitch-app' || item.version !== 1 ||
      typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.id) ||
      typeof item.name !== 'string' || !item.name.trim() || item.name.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(item.name) ||
      !Array.isArray(item.scripts) || !item.scripts.length || item.scripts.length > 64)
    throw Error('The selected file is not a supported CivHomebrew app package');
  const names = new Set();
  for (const script of item.scripts) {
    if (!script || typeof script.name !== 'string' || script.name.length > 240 ||
        script.name.startsWith('/') || script.name.includes('\\') ||
        /[\u0000-\u001f\u007f]/.test(script.name) ||
        script.name.split('/').some(part => !part || part === '.' || part === '..') ||
        names.has(script.name) ||
        typeof script.source !== 'string' || !script.source.trim())
      throw Error('The .civapp package contains an invalid script');
    names.add(script.name);
  }
  return item;
}

async function readPackage(file) {
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.civapp')
    throw Error('Choose a .civapp package');
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > MAX_PACKAGE_BYTES)
      throw Error('Choose a .civapp package smaller than 32 MiB');
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw Error('The .civapp package changed while reading it');
    return inspectPackage(bytes);
  } catch (error) {
    if (error.code === 'ELOOP') throw Error('Choose a regular .civapp file, not a symbolic link');
    throw error;
  } finally {
    await handle?.close();
  }
}

async function install(address, file, options = {}) {
  const item = await readPackage(file);
  const companion = await (options.probe || probe)(address, options);
  if (companion.state.busy || companion.state.mode !== 'launcher' || companion.state.closed)
    throw Error('Return to the CivHomebrew launcher before installing a package');
  const reply = await (options.request || companionRequest)(address,
    {op: 'install', package: item}, options);
  if (reply.entry?.id !== item.id)
    throw Error('CivHomebrew did not confirm the package installation; inspect the Switch before retrying');
  return {id: item.id, name: item.name, entry: reply.entry};
}

async function main(args = process.argv.slice(2), options = {}) {
  const report = options.emit || emit;
  if (args[0] === '--self-test' && args.length === 2) {
    const root = path.resolve(args[1]);
    const helper = await fs.lstat(path.join(root, 'scripts/gui-civswitch-package.cjs'));
    const companion = await fs.lstat(path.join(root, 'scripts/gui-civswitch-moonlight.cjs'));
    if (!helper.isFile() || helper.isSymbolicLink() ||
        !companion.isFile() || companion.isSymbolicLink())
      throw Error('The CivHomebrew package helper is missing or unsafe');
    report('self-test', {message: 'CivHomebrew package helper ready'});
    return true;
  }
  if (args.length !== 4 || args[0] !== 'install')
    throw Error('Usage: gui-civswitch-package.cjs install RUNTIME_ROOT SWITCH_IP CIVAPP_FILE');
  const [, , address, file] = args;
  if (!validAddress(address, options.allowLoopback)) throw Error('Enter a private Switch IPv4 address');
  report('status', {message: 'Checking the selected CivHomebrew package'});
  const result = await install(address, file, options);
  report('installed', {id: result.id, message: result.name + ' installed in CivHomebrew'});
  return result;
}

if (require.main === module) main().catch(error => {
  emit('error', {message: error.message});
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});

module.exports = {MAX_PACKAGE_BYTES, inspectPackage, readPackage, install, main};
