#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const overlays = require('./prepare-homebrew-apps.cjs');
const izdoom = require('../integrations/izdoom/prepare.cjs');
const ouncecake = require('../integrations/mintbrew-ouncecake/prepare.cjs');

const repository = path.resolve(__dirname, '..');
const source = path.join(repository, 'vendor/MintBrew');
const baseApps = ['hello-world', 'froggy-road', 'cpu-gpu-probe', 'chip8-test'];
const runtimeApps = [...baseApps, 'ftpd-sb', 'izdoom', 'stremio', 'ouncecake'];
const check = (condition, message) => {if (!condition) throw Error(message);};

function locate(input) {
  const root = path.resolve(input);
  for (const candidate of [root, path.join(root, 'vendor/MintBrew'), path.join(root, 'MintBrew')])
    if (fs.existsSync(path.join(candidate, 'homebrew-launcher/launcher-loop.cjs')) &&
        fs.existsSync(path.join(candidate, 'apps'))) return candidate;
  throw Error('MintBrew runtime not found under ' + root);
}
function inspect(root, prepared) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  check(manifest.name === 'MintBrew' && typeof manifest.version === 'string' &&
    /^\d+\.\d+\.\d+$/.test(manifest.version), 'Invalid MintBrew manifest.');
  const expected = prepared ? runtimeApps : baseApps;
  const apps = path.join(root, 'apps');
  const actual = fs.readdirSync(apps, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const name of expected) check(actual.includes(name), 'Missing MintBrew app: ' + name);
  if (prepared) for (const name of ['mintnes', 'mintftp'])
    check(!actual.includes(name), 'Unreleased MintBrew app is still staged: ' + name);
  for (const name of baseApps) {
    const manifest = JSON.parse(fs.readFileSync(path.join(apps, name, 'app.json')));
    check(manifest.id === name && manifest.abi === 1 && manifest.format === 'hblauncher.gpu-app',
      'Invalid MintBrew app manifest: ' + name);
    for (const stage of ['vertex', 'fragment', 'compute']) {
      const binary = fs.readFileSync(path.join(apps, name, manifest.shaders[stage]));
      check(binary.length >= 20 && binary.length % 4 === 0 && binary.readUInt32LE(0) === 0x07230203,
        'Invalid MintBrew app shader: ' + name + '/' + stage);
    }
  }
  if (prepared) {
    overlays.verifyFiles(path.join(apps, 'ftpd-sb'), overlays.verifyOverlay(repository).manifest);
    izdoom.verifyMintBrew(repository, root);
    ouncecake.verifyMintBrew(repository, root);
    const stremio = path.join(apps, 'stremio');
    const original = path.join(repository, 'stremio/app');
    for (const name of fs.readdirSync(original))
      check(fs.readFileSync(path.join(stremio, name)).equals(fs.readFileSync(path.join(original, name))),
        'Changed MintBrew Stremio app file: ' + name);
  }
  const shaderRoot = path.join(root, 'homebrew-launcher/shaders');
  for (const stage of ['vert', 'frag', 'comp']) {
    const binary = fs.readFileSync(path.join(shaderRoot, 'launcher.' + stage + '.spv'));
    check(binary.length >= 20 && binary.length % 4 === 0 && binary.readUInt32LE(0) === 0x07230203,
      'Invalid MintBrew launcher shader: ' + stage);
  }
  check(fs.statSync(path.join(shaderRoot, 'launcher-text.bin')).size === 1024 * 2048,
    'MintBrew type atlas has an unexpected size.');
  const plist = ['gui/Info.plist', 'source/gui/Info.plist']
    .map(name => path.join(repository, name)).find(file => fs.existsSync(file));
  check(plist, 'Missing mac2jb app version for MintBrew.');
  const version = fs.readFileSync(plist, 'utf8')
    .match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  check(version, 'Invalid mac2jb app version for MintBrew.');
  const metadata = JSON.parse(fs.readFileSync(path.join(shaderRoot, 'launcher-text.json'), 'utf8'));
  const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(shaderRoot, file))).digest('hex');
  check(metadata.mac2jbVersion === version &&
    metadata.atlasSha256 === sha('launcher-text.bin') &&
    metadata.layoutSha256 === sha('launcher-text.glsl'),
  'MintBrew type atlas does not match the mac2jb app version.');
  const text = fs.readFileSync(path.join(root, 'homebrew-launcher/launcher-text.py'), 'utf8');
  check(text.includes("('TITLE', 'MintBrew'") && text.includes('MAC2JB_HBLAUNCHER_FONT'),
    'MintBrew label or portable font setting is missing.');
  const loop = fs.readFileSync(path.join(root, 'homebrew-launcher/launcher-loop.cjs'), 'utf8');
  check(loop.includes('MintBrew game event source ready.') &&
    loop.includes('MintBrew continuous native frame loop running.'),
    'MintBrew readiness markers are missing.');
  return {root, apps: expected};
}
function main(args = process.argv.slice(2)) {
  const mode = args[0];
  check(['--check-source', '--prepare', '--check-runtime'].includes(mode) && args.length <= 2,
    'Usage: prepare-mintbrew.cjs --check-source | --prepare RUNTIME_ROOT | --check-runtime [RUNTIME_ROOT]');
  if (mode === '--check-source') {
    check(args.length === 1, '--check-source takes no runtime path.');
    const result = inspect(source, false);
    ouncecake.verifySource(repository);
    overlays.verifyOverlay(repository);
    const validator = process.env.SPIRV_VAL || path.join(repository, '.build-gui/homebrew/bin/spirv-val');
    for (const stage of ['vert', 'frag', 'comp'])
      execFileSync(validator, ['--target-env', 'vulkan1.0', path.join(source, 'homebrew-launcher/shaders/launcher.' + stage + '.spv')], {stdio: 'pipe'});
    console.log('MintBrew source ready: ' + result.apps.join(', '));
    return;
  }
  check(mode !== '--prepare' || args.length === 2, '--prepare requires a runtime path.');
  const root = locate(args[1] || process.cwd());
  if (mode === '--prepare') {
    check(fs.realpathSync(root) !== fs.realpathSync(source), 'Refusing to prepare MintBrew in its source folder.');
    inspect(root, false);
    for (const name of ['mintnes', 'mintftp']) fs.rmSync(path.join(root, 'apps', name), {recursive: true, force: true});
    if (!fs.existsSync(path.join(root, 'apps/ftpd-sb'))) overlays.installOverlays(repository, path.join(root, 'apps'));
    izdoom.prepareMintBrew(repository, root);
    ouncecake.prepareMintBrew(repository, root);
    const stremio = path.join(root, 'apps/stremio');
    if (!fs.existsSync(stremio)) fs.cpSync(path.join(repository, 'stremio/app'), stremio, {recursive: true});
  }
  const result = inspect(root, true);
  console.log('MintBrew runtime ready: ' + result.apps.join(', '));
}
if (require.main === module) {
  try {main();} catch (error) {console.error(error.message); process.exitCode = 1;}
}
module.exports = {locate, inspect};
