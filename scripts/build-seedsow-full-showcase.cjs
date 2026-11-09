#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {stageFullSeedsow} = require('./seedsow-full-save.cjs');

const titleId = '0100ee5021c9e000';
const bundleHash = '77568b7afe824ae087e0c4064ea710c77b0889e77c262a603d2d2eb96e6f6f54';
const required = ['autosave.dat', 'saveg.dat', 'system.dat', 'save0001.dat',
  'save0001.png', 'save0001_s.png'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', timeout: 60000});
  if (result.error || result.status !== 0 || result.signal)
    throw Error(`${path.basename(command)} failed: ${result.error?.message || result.stderr || result.signal || result.status}`);
  return result.stdout;
}

async function checkedBackup(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const selected = manifest.selection ?? manifest;
  if ((manifest.titleId ?? manifest.programId) !== titleId || manifest.partial !== false ||
      !/^[0-9a-f]{32}$/i.test(selected.uid) ||
      selected.space !== 1 || selected.type !== 1 || selected.rank !== 0 ||
      selected.index !== 0 || selected.staticId && selected.staticId !== 0 ||
      !manifest.archive?.includes('uid=' + selected.uid.slice(0, 16)) ||
      !Array.isArray(manifest.entries) || manifest.entries.length !== manifest.files ||
      manifest.files < required.length)
    throw Error('Select a complete SaveKit backup of the Seedsow full game (0100ee5021c9e000).');
  const names = new Set();
  for (const entry of manifest.entries) {
    const name = entry.path?.slice(1);
    if (entry.path !== '/' + name || !/^[A-Za-z0-9_.-]+$/.test(name) || names.has(name))
      throw Error('The backup contains an unsupported or duplicate path.');
    const info = await fs.lstat(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size ||
        hash(await fs.readFile(path.join(directory, name))) !== entry.sha256)
      throw Error('The backup file failed verification: ' + name);
    names.add(name);
  }
  for (const name of required)
    if (!names.has(name)) throw Error('The full-game backup is missing ' + name + '.');
  return [...names].sort();
}

function showcaseHttp(http, showcase) {
  const ending = 'post_init()\ne:setEventHandler{ onEnterFrame = "n2h_http_frame" }\n';
  const handler = 'e:setEventHandler{onEnterFrame = "cpypwn_artemis_frame"}\n';
  if (!http.endsWith(ending) || !showcase.endsWith(handler))
    throw Error('The bundled Artemis HTTP script is incompatible with this showcase.');
  return http + '\nif _G.n2h_clear then _G.n2h_clear() end\n' +
    showcase.slice(0, -handler.length) + `
local http_label_visible = false

function cpypwn_artemis_http_frame()
    n2h_http_frame()
    local ready = st.phase ~= "init" and st.phase ~= "dead"
    if ready and not http_label_visible then
        draw("cpypwn_http_status", 636, 52, 26, "0xD7FFE8", "http listening on 8080")
    elseif http_label_visible and not ready then
        e:tag{"lyprop", id = "~cpypwn_http_status", visible = "0"}
    end
    http_label_visible = ready
    cpypwn_artemis_frame()
end

e:setEventHandler{onEnterFrame = "cpypwn_artemis_http_frame"}
`;
}

async function build(backup, output) {
  backup = path.resolve(backup);
  output = path.resolve(output);
  if (output.startsWith(backup + path.sep))
    throw Error('Place the output ZIP outside the original backup folder.');
  const original = await checkedBackup(backup);
  const kit = path.resolve(__dirname, '..');
  const archive = path.join(kit, 'integrations/artemis/seedsowhax-v2-mac2jb.zip');
  if (hash(await fs.readFile(archive)) !== bundleHash)
    throw Error('The pinned Artemis launcher bundle failed verification.');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'seedsow-full-showcase-'));
  try {
    const stage = path.join(temp, 'save');
    await fs.mkdir(stage);
    run('/usr/bin/ditto', ['-x', '-k', archive, stage]);
    await stageFullSeedsow(stage, backup);
    const showcase = await fs.readFile(path.join(kit, 'integrations/artemis/cpypwn-full-showcase.lua'), 'utf8');
    const http = await fs.readFile(path.join(stage, 'http.lua'), 'utf8');
    await fs.writeFile(path.join(stage, 'exploitb.lua'), showcase);
    await fs.writeFile(path.join(stage, 'http2.lua'), showcaseHttp(http, showcase));
    const installed = new Set(await fs.readdir(stage));
    for (const name of original)
      if (name !== 'save9999.dat' && !installed.has(name))
        await fs.copyFile(path.join(backup, name), path.join(stage, name));
    const files = (await fs.readdir(stage)).sort();
    const python = 'import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:\n for name in sys.argv[3:]: z.write(root/name,name)\n';
    await fs.mkdir(path.dirname(output), {recursive: true});
    run('python3', ['-c', python, stage, output, ...files]);
    console.log(`Prepared ${output} with ${files.length} verified full-game save files.`);
    console.log('Load save slot 1 in the full game to run the cpypwn showcase and HTTP server.');
  } finally {
    await fs.rm(temp, {recursive: true, force: true});
  }
}

if (require.main === module) {
  if (process.argv.length !== 4) {
    console.error('Usage: node build-seedsow-full-showcase.cjs <full-game-SaveKit-backup-folder> <output.zip>');
    process.exitCode = 2;
  } else {
    build(process.argv[2], process.argv[3]).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = {checkedBackup, showcaseHttp, build};
