#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const pin = require('../packaging/SW2NES-source.json');
const {probe, companionRequest, validAddress} = require('./gui-civswitch-moonlight.cjs');

const PREFIX = 'MAC2JB_CIV_SW2NES ';
const SCRIPT_NAMES = ['app/notices.js', 'dist/runtime/quicknes.js', 'app/native.js', 'app/sw2nes.js'];

function emit(type, fields = {}) {
  process.stdout.write(PREFIX + JSON.stringify({type, ...fields}) + '\n');
}

function verifyPin() {
  if (pin.repository !== 'https://github.com/Rodpad/SW2NES' ||
      pin.tag !== 'v1.0.1' || pin.commit !== '974f5b47a6364b995c12f27d318477680aca5038' ||
      pin.asset !== 'https://github.com/Rodpad/SW2NES/releases/download/v1.0.1/sw2nes.civapp' ||
      pin.assetSize !== 833006 ||
      pin.assetSha256 !== 'dce4bb277c798baeb6e3ceb92c21ce5a565bd37556a0eb87a171b29715f6286e' ||
      pin.packageId !== 'sw2nes' || pin.packageRelease !== '1.0.1' || pin.license !== 'GPL-2.0' ||
      pin.bundledPackage !== 'integrations/sw2nes/v1.0.1/sw2nes.civapp' ||
      pin.bundledLicense !== 'integrations/sw2nes/v1.0.1/LICENSE')
    throw Error('SW2NES release pin is invalid');
  return pin;
}

function inspectPackage(bytes, source = pin) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== source.assetSize)
    throw Error('SW2NES package size does not match the pinned release');
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== source.assetSha256)
    throw Error('SW2NES package checksum does not match the pinned release');
  let item;
  try { item = JSON.parse(bytes.toString('utf8')); }
  catch { throw Error('SW2NES package is not valid JSON'); }
  if (item?.format !== 'civswitch-app' || item.version !== 1 ||
      item.id !== source.packageId || item.name !== 'SW2NES' ||
      item.metadata?.author !== 'Rodpad' || item.metadata.release !== source.packageRelease ||
      item.metadata.api !== 1 || !Array.isArray(item.scripts) ||
      item.scripts.length !== SCRIPT_NAMES.length ||
      item.scripts.some((script, index) => script?.name !== SCRIPT_NAMES[index] ||
        typeof script.source !== 'string' || !script.source.trim()) ||
      typeof item.icon !== 'string' || !item.icon.startsWith('data:image/png;base64,'))
    throw Error('SW2NES package metadata does not match the pinned release');
  return item;
}

async function readBundled(root, source = pin) {
  const file = path.join(path.resolve(root), source.bundledPackage);
  const license = path.join(path.resolve(root), source.bundledLicense);
  for (const item of [file, license]) {
    const stat = await fs.lstat(item);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unsafe bundled SW2NES file: ' + item);
  }
  const bytes = await fs.readFile(file);
  return {file, package: inspectPackage(bytes, source)};
}

async function install(root, address, options = {}) {
  const source = options.pin || pin;
  const companion = await (options.probe || probe)(address, options);
  if (companion.state.busy || companion.state.mode !== 'launcher' || companion.state.closed)
    throw Error('Return to the CivHomebrew launcher before installing SW2NES');
  const bundled = await readBundled(root, source);
  const reply = await (options.request || companionRequest)(address,
    {op: 'install', package: bundled.package}, options);
  if (reply.entry?.id !== source.packageId || reply.entry?.name !== 'SW2NES')
    throw Error('CivHomebrew did not confirm the SW2NES installation; inspect the Switch before retrying');
  return {file: bundled.file, entry: reply.entry};
}

async function launch(address, options = {}) {
  const source = options.pin || pin;
  const companion = await (options.probe || probe)(address, options);
  if (companion.state.busy || companion.state.mode !== 'launcher' || companion.state.closed)
    throw Error('Return to the CivHomebrew launcher before opening SW2NES');
  if (!companion.entries.some(entry => entry.id === source.packageId))
    throw Error('Install SW2NES in CivHomebrew before opening it');
  const reply = await (options.request || companionRequest)(address,
    {op: 'run', id: source.packageId}, options);
  if (reply.state !== 'accepted' || reply.name !== 'SW2NES')
    throw Error('CivHomebrew did not confirm SW2NES launch; inspect the Switch before retrying');
  return reply;
}

async function main(args = process.argv.slice(2), options = {}) {
  const report = options.emit || emit;
  verifyPin();
  if (args[0] === '--self-test' && args.length === 2) {
    const root = path.resolve(args[1]);
    const bundled = await readBundled(root, options.pin || pin);
    report('self-test', {version: pin.packageRelease, path: bundled.file,
      message: 'Bundled SW2NES package and GPL license verified'});
    return bundled;
  }
  if (args.length !== 3 || !['install', 'launch', 'status'].includes(args[0]))
    throw Error('Usage: gui-civswitch-sw2nes.cjs install|launch|status RUNTIME_ROOT SWITCH_IP');
  const [action, root, address] = args;
  if (!validAddress(address, options.allowLoopback)) throw Error('Enter a private Switch IPv4 address');
  if (action === 'status') {
    const bundled = await readBundled(root, options.pin || pin);
    const companion = await (options.probe || probe)(address, options);
    const installed = companion.entries.some(entry => entry.id === pin.packageId);
    const result = {connected: true, installed, busy: !!companion.state.busy,
      mode: companion.state.mode, version: pin.packageRelease, path: bundled.file,
      message: installed ? 'SW2NES is installed in CivHomebrew' : 'CivHomebrew is ready for SW2NES'};
    report('status', result);
    return result;
  }
  if (action === 'launch') {
    report('status', {message: 'Opening SW2NES through CivHomebrew'});
    await launch(address, options);
    report('launched', {message: 'SW2NES is opening on your Switch'});
    return {launched: true};
  }
  report('status', {message: 'Checking CivHomebrew on ' + address + ':9027'});
  const result = await install(root, address, options);
  report('installed', {version: pin.packageRelease, path: result.file,
    message: 'SW2NES installed in CivHomebrew. Add .nes ROMs to Root/nes over CivHomebrew FTP'});
  return result;
}

if (require.main === module) main().catch(error => {
  emit('error', {message: error.message});
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});

module.exports = {pin, inspectPackage, readBundled, install, launch, verifyPin, main};
