#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const pin = require('../packaging/Jellyfin-CivSwitch-source.json');
const {probe, companionRequest, validAddress} = require('./gui-civswitch-moonlight.cjs');

const PREFIX = 'MAC2JB_CIV_JELLYFIN ';
const SCRIPT_NAMES = [
  'third-party-notices.js', 'brand.js',
  'vendor/moonlight/app/src/streaming/native-io.js',
  'vendor/moonlight/app/src/streaming/native-texture.js',
  'vendor/moonlight-native-media-vod.js', 'http-stream.js', 'matroska.js',
  'native-http.js', 'vod-pacer.js', 'native-player.js', 'player-layout.js',
  'playback-options.js', 'app.js'
];

function emit(type, fields = {}) {
  process.stdout.write(PREFIX + JSON.stringify({type, ...fields}) + '\n');
}

function verifyPin() {
  if (pin.repository !== 'https://github.com/THZoria/jellyfin' ||
      pin.commit !== '26da7a92f95512167cae8cae209da745a8984831' ||
      pin.version !== '0.0.1' || pin.buildCommand !== 'python3 tools/build.py' ||
      pin.packageId !== 'jellyfin-civswitch' || pin.packageName !== 'Jellyfin' ||
      pin.packageAuthor !== 'SaoriYuki' || pin.packageSize !== 172610 ||
      pin.packageSha256 !== '347f8acb536a3ad521c554d9fafa7680be5f49b7de0a8867a05389aafd5b7e46' ||
      pin.bundledPackage !== 'integrations/jellyfin/0.0.1/jellyfin-civswitch.civapp' ||
      !Array.isArray(pin.bundledNotices) || pin.bundledNotices.length !== 2)
    throw Error('Jellyfin source pin is invalid');
  return pin;
}

function inspectPackage(bytes, source = pin) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== source.packageSize)
    throw Error('Jellyfin package size does not match the pinned build');
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== source.packageSha256)
    throw Error('Jellyfin package checksum does not match the pinned build');
  let item;
  try { item = JSON.parse(bytes.toString('utf8')); }
  catch { throw Error('Jellyfin package is not valid JSON'); }
  if (item?.format !== 'civswitch-app' || item.version !== 1 ||
      item.id !== source.packageId || item.name !== source.packageName ||
      item.metadata?.author !== source.packageAuthor ||
      item.metadata?.release !== source.version || item.metadata?.api !== 1 ||
      !Array.isArray(item.scripts) || item.scripts.length !== SCRIPT_NAMES.length ||
      item.scripts.some((script, index) => script?.name !== SCRIPT_NAMES[index] ||
        typeof script.source !== 'string' || !script.source.trim()) ||
      typeof item.icon !== 'string' || !item.icon.startsWith('data:image/png;base64,'))
    throw Error('Jellyfin package metadata does not match the pinned build');
  return item;
}

async function readBundled(root, source = pin) {
  const resolvedRoot = path.resolve(root);
  const file = path.join(resolvedRoot, source.bundledPackage);
  for (const relative of [source.bundledPackage, ...source.bundledNotices]) {
    const candidate = path.join(resolvedRoot, relative);
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error('Unsafe bundled Jellyfin file: ' + candidate);
  }
  return {file, package: inspectPackage(await fs.readFile(file), source)};
}

async function install(root, address, options = {}) {
  const source = options.pin || pin;
  const companion = await (options.probe || probe)(address, options);
  if (companion.state.busy || companion.state.mode !== 'launcher' || companion.state.closed)
    throw Error('Return to the CivHomebrew launcher before installing Jellyfin');
  const bundled = await readBundled(root, source);
  const reply = await (options.request || companionRequest)(address,
    {op: 'install', package: bundled.package}, options);
  if (reply.entry?.id !== source.packageId || reply.entry?.name !== source.packageName)
    throw Error('CivHomebrew did not confirm the Jellyfin installation; inspect the Switch before retrying');
  return {file: bundled.file, entry: reply.entry};
}

async function launch(address, options = {}) {
  const source = options.pin || pin;
  const companion = await (options.probe || probe)(address, options);
  if (companion.state.busy || companion.state.mode !== 'launcher' || companion.state.closed)
    throw Error('Return to the CivHomebrew launcher before opening Jellyfin');
  if (!companion.entries.some(entry => entry.id === source.packageId))
    throw Error('Install Jellyfin in CivHomebrew before opening it');
  const reply = await (options.request || companionRequest)(address,
    {op: 'run', id: source.packageId}, options);
  if (reply.state !== 'accepted' || reply.name !== source.packageName)
    throw Error('CivHomebrew did not confirm Jellyfin launch; inspect the Switch before retrying');
  return reply;
}

async function main(args = process.argv.slice(2), options = {}) {
  const report = options.emit || emit;
  verifyPin();
  if (args[0] === '--self-test' && args.length === 2) {
    const bundled = await readBundled(args[1], options.pin || pin);
    report('self-test', {version: pin.version, path: bundled.file,
      message: 'Bundled Jellyfin package and notices verified'});
    return bundled;
  }
  if (args.length !== 3 || !['install', 'launch', 'status'].includes(args[0]))
    throw Error('Usage: gui-civswitch-jellyfin.cjs install|launch|status RUNTIME_ROOT SWITCH_IP');
  const [action, root, address] = args;
  if (!validAddress(address, options.allowLoopback)) throw Error('Enter a private Switch IPv4 address');
  if (action === 'status') {
    const bundled = await readBundled(root, options.pin || pin);
    const companion = await (options.probe || probe)(address, options);
    const installed = companion.entries.some(entry => entry.id === pin.packageId);
    const result = {connected: true, installed, busy: !!companion.state.busy,
      mode: companion.state.mode, version: pin.version, path: bundled.file,
      message: installed ? 'Jellyfin is installed in CivHomebrew' : 'CivHomebrew is ready for Jellyfin'};
    report('status', result);
    return result;
  }
  if (action === 'launch') {
    report('status', {message: 'Opening Jellyfin through CivHomebrew'});
    await launch(address, options);
    report('launched', {message: 'Jellyfin is opening on your Switch'});
    return {launched: true};
  }
  report('status', {message: 'Checking CivHomebrew on ' + address + ':9027'});
  const result = await install(root, address, options);
  report('installed', {version: pin.version, path: result.file,
    message: 'Jellyfin installed in CivHomebrew. Open it and enter your server address'});
  return result;
}

if (require.main === module) main().catch(error => {
  emit('error', {message: error.message});
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});

module.exports = {pin, inspectPackage, readBundled, install, launch, verifyPin, main};
