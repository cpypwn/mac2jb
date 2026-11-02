#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {artemisProfile, cachedArtemisArchive, stageArtemis} = require('./gui-savekit.cjs');
const upstream = require('../packaging/ArtemisLauncher-v1.json');
const root = path.resolve(__dirname, '..');
const bundleNames = {seedsow: 'seedsowhax-v1-mac2jb.zip', nora: 'norahax-v1-mac2jb.zip'};
const python = `import pathlib,sys,zipfile
folder=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w') as archive:
    for name in sys.argv[3:]:
        info=zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
        info.create_system=3
        info.external_attr=0o100600 << 16
        info.compress_type=zipfile.ZIP_DEFLATED
        archive.writestr(info, (folder/name).read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
`;

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-artemis-bundles-'));
  const manifest = {source: 'packaging/ArtemisLauncher-v1.json',
    revision: upstream.revision, assets: {}};
  try {
    for (const game of ['seedsow', 'nora']) {
      const profile = artemisProfile(game);
      const source = await cachedArtemisArchive(game, profile);
      const staged = path.join(temp, game);
      const files = await stageArtemis(staged, source, profile);
      const bundled = path.join(temp, bundleNames[game]);
      const result = spawnSync('python3', ['-c', python, staged, bundled, ...files],
        {encoding: 'utf8', timeout: 30000});
      if (result.error || result.status !== 0 || result.signal)
        throw Error('Could not build ' + game + ' launcher archive: ' +
          (result.error?.message || result.stderr || result.signal || result.status));
      const bytes = await fs.readFile(bundled);
      manifest.assets[game] = {
        path: `integrations/artemis/${bundleNames[game]}`,
        sourceSha256: profile.sha256,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      };
      await fs.copyFile(bundled, path.join(root, manifest.assets[game].path));
      console.log(`${game}: ${manifest.assets[game].sha256}`);
    }
    await fs.writeFile(path.join(root, 'packaging/ArtemisLauncher-bundles.json'),
      JSON.stringify(manifest, null, 2) + '\n');
  } finally {
    await fs.rm(temp, {recursive: true, force: true});
  }
}

main().catch(error => {console.error(error.message); process.exitCode = 1;});
