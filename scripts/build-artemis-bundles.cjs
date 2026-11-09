#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {artemisProfile, cachedArtemisArchive, stageArtemis} = require('./gui-savekit.cjs');
const upstream = require('../packaging/ArtemisLauncher-v2.json');
const nora1 = require('../packaging/ArtemisLauncher-nora1.json');
const root = path.resolve(__dirname, '..');
const bundleNames = {seedsow: 'seedsowhax-v2-mac2jb.zip',
  nora: 'norahax-v2-mac2jb.zip', hamidashi: 'hamihax-v2-mac2jb.zip',
  nora1: 'norahax-nora1-mac2jb.zip'};
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

async function nora1Archive(temp) {
  const folder = path.join(root, nora1.sourceDirectory);
  const files = Object.keys(nora1.files).sort();
  const listed = (await fs.readdir(folder)).sort();
  if (listed.join('\n') !== files.join('\n'))
    throw Error('The pinned Nora 1 source has unexpected files.');
  for (const name of files) {
    const source = path.join(folder, name);
    const info = await fs.lstat(source);
    if (!info.isFile() || info.isSymbolicLink() ||
        crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex') !== nora1.files[name])
      throw Error('The pinned Nora 1 source changed: ' + name);
  }
  const archive = path.join(temp, 'nora1-source.zip');
  const result = spawnSync('python3', ['-c', python, folder, archive, ...files],
    {encoding: 'utf8', timeout: 30000});
  if (result.error || result.status !== 0 || result.signal)
    throw Error('Could not build the pinned Nora 1 source archive: ' +
      (result.error?.message || result.stderr || result.signal || result.status));
  if (crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex') !==
      nora1.sourceArchiveSha256)
    throw Error('The pinned Nora 1 source archive failed its integrity check.');
  return archive;
}

async function main() {
  const sourceDir = process.argv[2];
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mac2jb-artemis-bundles-'));
  const manifest = {source: 'packaging/ArtemisLauncher-v2.json',
    revision: upstream.revision, assets: {}};
  try {
    for (const game of ['seedsow', 'nora', 'hamidashi', 'nora1']) {
      const profile = artemisProfile(game);
      const source = game === 'nora1' ? await nora1Archive(temp) : sourceDir
        ? path.join(sourceDir, path.basename(new URL(profile.url).pathname))
        : await cachedArtemisArchive(game, profile);
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
      if (game === 'nora1') {
        manifest.assets[game].source = 'packaging/ArtemisLauncher-nora1.json';
        manifest.assets[game].revision = nora1.revision;
      }
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
