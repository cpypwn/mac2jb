'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const MEDIA_SCRIPTS = [
  'third-party-notices.js',
  'vendor/moonlight/app/src/streaming/native-io.js',
  'vendor/moonlight/app/src/streaming/native-texture.js',
  'vendor/moonlight-native-media-vod.js',
  'http-stream.js',
  'matroska.js',
  'native-http.js',
  'vod-pacer.js',
  'native-player.js'
];

async function build({projectRoot, installToken, initialAddress, sourcePackage} = {}) {
  if (!/^[0-9a-f]{48}$/.test(installToken || '')) throw Error('Expected a persistent Stremio install token');
  if (initialAddress !== undefined && !/^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(initialAddress))
    throw Error('Expected a Mac IPv4 address and port');
  const root = path.resolve(projectRoot || process.cwd());
  const file = sourcePackage || path.join(root, 'integrations/jellyfin/0.0.1/jellyfin-civswitch.civapp');
  const reference = JSON.parse(await fs.readFile(file, 'utf8'));
  if (reference.format !== 'civswitch-app' || !Array.isArray(reference.scripts))
    throw Error('Native media reference package is invalid');
  const scripts = MEDIA_SCRIPTS.map(name => {
    const script = reference.scripts.find(entry => entry.name === name);
    if (!script || typeof script.source !== 'string') throw Error('Native media script missing: ' + name);
    return script;
  });
  const icon = await fs.readFile(path.join(__dirname, 'icon.png'));
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (icon.length < 24 || !icon.subarray(0, 8).equals(pngSignature) ||
      icon.readUInt32BE(16) !== 256 || icon.readUInt32BE(20) !== 256)
    throw Error('CivHomebrew Stremio icon must be a 256x256 PNG');
  const iconData = 'data:image/png;base64,' + icon.toString('base64');
  scripts.push({name: 'install.js', source: `window.CivStremioConfig=${JSON.stringify({
    token: installToken, initialAddress: initialAddress || '', icon: iconData
  })};`});
  scripts.push({name: 'app.js', source: await fs.readFile(path.join(__dirname, 'app.js'), 'utf8')});
  const item = {format: 'civswitch-app', version: 1, id: 'civ-stremio', name: 'Stremio',
    metadata: {author: 'cpypwn', release: '0.1.0', api: 1,
      description: 'CivHomebrew Stremio client with a configurable Mac streaming bridge'},
    scripts, icon: iconData};
  const bytes = Buffer.from(JSON.stringify(item));
  if (bytes.length > 32 * 1024 * 1024) throw Error('CivHomebrew package exceeds 32 MiB');
  return {item, bytes};
}

module.exports = {build, MEDIA_SCRIPTS};
