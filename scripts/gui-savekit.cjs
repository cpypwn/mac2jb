#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const {spawn} = require('node:child_process');
const {Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const readline = require('node:readline');
const provenance = require('../vendor/ns2-savekit/provenance.json');
const artemis = require('../packaging/ArtemisLauncher-v1.json');
const artemisBundles = require('../packaging/ArtemisLauncher-bundles.json');
const root = path.resolve(__dirname, '..');
const packageRoot = path.join(root, 'vendor/ns2-savekit');
const programId = provenance.demoProgramId;
const zip = path.join(packageRoot, provenance.editor.asset);
const uidPattern = /^[a-f0-9]{32}$/;
const filePattern = /^[A-Za-z0-9_.-]+$/;
const showcaseFiles = ['cpypwn.lua', 'ssslot006.ref',
  'save0006.dat', 'save0006.png', 'save0006_s.png'];
const oldShowcaseName = 'cpypwn-showcase.lua';
const oldShowcaseHashes = new Set([
  '2a5aea7bd4252e00c98fdd63e38a0cca68b9bcbf55831b6e7c107a1a5263ba4a',
  '0e4b371729a76c576894ee82239a20450499733c5e7f114481ba1a0fc87bc851',
  '922f06c597ba0a2aee906c146d0c175d4a6782b5493a74d3a5559b83693ecce4',
  '16c364686631521aa23e2d2e43302cd2713ac5e49cab24716727fbd1cc000c43'
]);
const artemisFiles = ['core.lua', 'exploita.lua', 'http.lua', 'inject.iet',
  'inject.lua', 'proggy.ttf', 'save9999.dat', 'saveg.dat', 'system.dat'];
const launcherFiles = artemisFiles.filter(name => !['save9999.dat', 'saveg.dat', 'system.dat'].includes(name));
const artemisShowcase = 'exploitb.lua';
const artemisUpdates = ['inject2.lua', 'http2.lua'];
const artemisBundledFiles = [...artemisFiles, artemisShowcase, ...artemisUpdates].sort();
const previousArtemisUpdateHashes = new Map([
  ['inject2.lua', 'b1ba6df3ceb14c81c720e43ea06d821effd6ba648787524f5c3c54ea8f7c1bf2'],
  ['http2.lua', '8977807d5675753a0334c1b3ae2c8095fdc49ae9bdfd2d2f04912cfecd5ac19e']
]);

function emit(type, fields = {}) {
  process.stdout.write('MAC2JB_SAVEKIT ' + JSON.stringify({type, ...fields}) + '\n');
}
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function check(ok, message) { if (!ok) throw Error(message); }

function artemisProfile(game) {
  check(game === 'seedsow' || game === 'nora', 'Choose Seedsow or Nora for the Artemis launcher.');
  const profile = artemis.assets[game];
  check(profile && /^[a-f0-9]{16}$/.test(profile.titleId) &&
    /^[a-f0-9]{64}$/.test(profile.sha256) &&
    profile.url === `https://github.com/alula/switch-artemis-launcher/releases/download/v1/${game === 'nora' ? 'nora2' : 'seedsow'}_save.zip`,
  'The Artemis launcher source is not pinned correctly.');
  return profile;
}

function artemisBundleProfile(game) {
  const upstream = artemisProfile(game);
  const bundled = artemisBundles.assets[game];
  check(artemisBundles.source === 'packaging/ArtemisLauncher-v1.json' &&
    artemisBundles.revision === artemis.revision && bundled &&
    bundled.path === `integrations/artemis/${game === 'nora' ? 'norahax' : 'seedsowhax'}-v1-mac2jb.zip` &&
    bundled.sourceSha256 === upstream.sha256 && /^[a-f0-9]{64}$/.test(bundled.sha256),
  'The bundled Artemis launcher provenance is incomplete.');
  return bundled;
}

async function downloadArtemis(profile, destination) {
  let address = profile.url;
  for (let redirects = 0; redirects < 6; redirects++) {
    const response = await new Promise((resolve, reject) => {
      const request = https.get(address, {headers: {'User-Agent': 'mac2jb-savekit'}}, resolve);
      request.setTimeout(30000, () => request.destroy(Error('Artemis launcher download timed out.')));
      request.once('error', reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const next = new URL(response.headers.location || '', address);
      response.resume();
      check(next.protocol === 'https:', 'Artemis launcher download redirected outside HTTPS.');
      address = next.href;
      continue;
    }
    if (response.statusCode !== 200) {
      response.resume();
      throw Error(`Could not download the Artemis launcher (HTTP ${response.statusCode}).`);
    }
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    try {
      await pipeline(response, new Transform({transform(chunk, _, done) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) done(Error('The Artemis launcher download is too large.'));
        else {digest.update(chunk); done(null, chunk);}
      }}), fs.createWriteStream(destination, {flags: 'wx', mode: 0o600}));
      check(digest.digest('hex') === profile.sha256,
        'The downloaded Artemis launcher failed its pinned integrity check.');
      return;
    } catch (error) {
      await fsp.rm(destination, {force: true});
      throw error;
    }
  }
  throw Error('The Artemis launcher download redirected too many times.');
}

async function cachedArtemisArchive(game, profile, cache =
  path.join(os.homedir(), 'Library/Application Support/mac2jb/Cache/ArtemisLauncher/v1')) {
  await fsp.mkdir(cache, {recursive: true, mode: 0o700});
  const archive = path.join(cache, game + '.zip');
  try {
    const info = await fsp.lstat(archive);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 2 * 1024 * 1024 &&
        sha(await fsp.readFile(archive)) === profile.sha256) return archive;
    await fsp.rm(archive, {force: true});
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const incoming = path.join(cache, `.${game}-${crypto.randomUUID()}.zip`);
  try {
    await downloadArtemis(profile, incoming);
    await fsp.rename(incoming, archive);
    return archive;
  } catch (error) {
    await fsp.rm(incoming, {force: true});
    throw Error(`Could not obtain the ${profile.title} Artemis launcher. Connect this Mac to the internet and try again. ${error.message}`);
  }
}

async function artemisShowcaseBytes() {
  const showcaseSource = path.join(root, 'integrations/artemis/cpypwn-showcase.lua');
  const showcaseInfo = await fsp.lstat(showcaseSource);
  check(showcaseInfo.isFile() && !showcaseInfo.isSymbolicLink() &&
    showcaseInfo.size > 0 && showcaseInfo.size < 28 * 1024,
  'The Artemis cpypwn showcase is missing or too large.');
  const showcase = await fsp.readFile(showcaseSource);
  check(showcase.includes(Buffer.from('"cpypwn"')) &&
    showcase.includes(Buffer.from('cpypwn_artemis_frame')),
  'The Artemis cpypwn showcase is incomplete.');
  return showcase;
}

function artemisHttpShowcase(http, showcase) {
  const ending = 'post_init()\ne:setEventHandler{ onEnterFrame = "n2h_http_frame" }\n';
  const handler = 'e:setEventHandler{onEnterFrame = "cpypwn_artemis_frame"}\n';
  check(http.endsWith(ending) && showcase.endsWith(handler),
    'The pinned Artemis HTTP script is incompatible with the cpypwn display.');
  const body = showcase.slice(0, -handler.length);
  return http + '\nif _G.n2h_clear then _G.n2h_clear() end\n' + body + `
local http_label_visible = false

function cpypwn_artemis_http_frame()
    n2h_http_frame()
    local ready = st.phase ~= "init" and st.phase ~= "dead"
    if ready and not http_label_visible then
        draw("cpypwn_http_status", 534, 70, 36, "0xFFFFFF", "http listening")
    elseif http_label_visible and not ready then
        e:tag{"lyprop", id = "~cpypwn_http_status", visible = "0"}
    end
    http_label_visible = ready
    cpypwn_artemis_frame()
end

e:setEventHandler{onEnterFrame = "cpypwn_artemis_http_frame"}
`;
}

function artemisInjectShowcase(inject) {
  const anchor = '\te:setEventHandler{ onEnterFrame = "n2h_launcher_idle" }\n' +
    '\tn2h_clear()\n\te:include(core_path)\n\te:include(payload)\n';
  const menu = 'function n2h_launcher_frame()\n';
  check(inject.includes(anchor) && inject.indexOf(anchor) === inject.lastIndexOf(anchor) &&
    inject.includes(menu) && inject.indexOf(menu) === inject.lastIndexOf(menu) &&
    inject.endsWith('launcher_main()'),
    'The pinned Artemis launcher is incompatible with the quiet HTTP display.');
  const quiet = inject.replace(anchor, '\te:setEventHandler{ onEnterFrame = "n2h_launcher_idle" }\n' +
    '\tn2h_clear()\n\tif mode == "http" then print = _G.n2h_orig_print end\n' +
    '\te:include(core_path)\n\te:include(payload)\n');
  return quiet.slice(0, quiet.indexOf(menu)) +
    'init_console()\nprint = _G.n2h_orig_print\nlaunch("http")\n';
}

async function stageArtemis(directory, archive, profile) {
  check(sha(await fsp.readFile(archive)) === profile.sha256,
    'The Artemis launcher archive failed its pinned integrity check.');
  const listed = await run('/usr/bin/unzip', ['-Z1', archive], root, 30000);
  check(listed.code === 0 && !listed.signal &&
    listed.stdout.trimEnd().split('\n').sort().join('\n') === artemisFiles.join('\n'),
  'The Artemis launcher archive does not contain the expected flat save files.');
  await fsp.mkdir(directory, {mode: 0o700});
  const extracted = await run('/usr/bin/ditto', ['-x', '-k', archive, directory]);
  check(extracted.code === 0 && !extracted.signal, 'Could not unpack the Artemis launcher save.');
  const files = (await fsp.readdir(directory)).sort();
  check(files.join('\n') === artemisFiles.join('\n'),
    'The Artemis launcher save contains unexpected files.');
  let total = 0;
  for (const name of files) {
    const info = await fsp.lstat(path.join(directory, name));
    check(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 256 * 1024,
      'The Artemis launcher save has an unsupported file: ' + name);
    total += info.size;
  }
  check(total <= 1024 * 1024, 'The Artemis launcher save is too large.');
  const showcase = await artemisShowcaseBytes();
  await fsp.writeFile(path.join(directory, artemisShowcase), showcase,
    {flag: 'wx', mode: 0o600});
  const http = await fsp.readFile(path.join(directory, 'http.lua'), 'utf8');
  const inject = await fsp.readFile(path.join(directory, 'inject.lua'), 'utf8');
  await fsp.writeFile(path.join(directory, 'http2.lua'),
    artemisHttpShowcase(http, showcase.toString('utf8')), {flag: 'wx', mode: 0o600});
  await fsp.writeFile(path.join(directory, 'inject2.lua'),
    artemisInjectShowcase(inject), {flag: 'wx', mode: 0o600});
  return [...files, artemisShowcase, ...artemisUpdates].sort();
}

async function stageBundledArtemis(directory, game) {
  const bundled = artemisBundleProfile(game);
  const archive = path.join(root, bundled.path);
  const info = await fsp.lstat(archive);
  check(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 2 * 1024 * 1024 &&
    sha(await fsp.readFile(archive)) === bundled.sha256,
  'The bundled Artemis launcher failed its integrity check.');
  const listed = await run('/usr/bin/unzip', ['-Z1', archive], root, 30000);
  check(listed.code === 0 && !listed.signal &&
    listed.stdout.trimEnd().split('\n').sort().join('\n') === artemisBundledFiles.join('\n'),
  'The bundled Artemis launcher has unexpected save files.');
  await fsp.mkdir(directory, {mode: 0o700});
  const extracted = await run('/usr/bin/ditto', ['-x', '-k', archive, directory]);
  check(extracted.code === 0 && !extracted.signal,
    'Could not unpack the bundled Artemis launcher.');
  const files = (await fsp.readdir(directory)).sort();
  check(files.join('\n') === artemisBundledFiles.join('\n'),
    'The bundled Artemis launcher unpacked unexpected files.');
  let total = 0;
  for (const name of files) {
    const fileInfo = await fsp.lstat(path.join(directory, name));
    check(fileInfo.isFile() && !fileInfo.isSymbolicLink() && fileInfo.size > 0 &&
      fileInfo.size <= 256 * 1024,
    'The bundled Artemis launcher has an unsupported file: ' + name);
    total += fileInfo.size;
  }
  check(total <= 1024 * 1024, 'The bundled Artemis launcher is too large.');
  const showcase = await artemisShowcaseBytes();
  const http = await fsp.readFile(path.join(directory, 'http.lua'), 'utf8');
  const inject = await fsp.readFile(path.join(directory, 'inject.lua'), 'utf8');
  check(sha(await fsp.readFile(path.join(directory, artemisShowcase))) === sha(showcase) &&
    await fsp.readFile(path.join(directory, 'http2.lua'), 'utf8') ===
      artemisHttpShowcase(http, showcase.toString('utf8')) &&
    await fsp.readFile(path.join(directory, 'inject2.lua'), 'utf8') ===
      artemisInjectShowcase(inject),
  'The bundled Artemis launcher does not match the current cpypwn integration.');
  return files;
}

async function run(executable, args, cwd = root, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    const limit = 8 * 1024 * 1024;
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        if (name === 'stdout') stdout += chunk;
        else stderr += chunk;
        process.stderr.write(chunk);
        if (stdout.length + stderr.length > limit) child.kill('SIGTERM');
      });
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({code, signal, stdout, stderr});
    });
  });
}

async function tool(name, args) {
  const timeout = name === 'save-write-stage.cjs' ? 1800000 : 300000;
  const result = await run(process.execPath, [path.join(packageRoot, 'tools', name), ...args], root, timeout);
  if (result.signal) throw Error(name + ' was interrupted. Restart the console before retrying.');
  return result;
}

function missingSaveArchive(result, titleId) {
  if (result.code !== 1 || result.signal) return false;
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  const title = BigInt('0x' + titleId).toString(16);
  if (!output.includes(`No save filesystem opened for 0x${title}`)) return false;
  const probes = [...output.matchAll(/^\s*space=[^\r\n]*->\s*(0x[0-9a-f]+|ok)\s*$/gmi)]
    .map(match => match[1].toLowerCase());
  return probes.length > 0 && probes.every(code => code === '0x7d402');
}

function absentSaveError(title) {
  const error = Error(`${title} has no save data yet. Launch the demo once, create a save, ` +
    'close the game fully, then start a fresh held RPC session and retry. No files were changed.');
  error.code = 'SAVE_ABSENT';
  return error;
}

async function stageEditor(directory) {
  check(sha(await fsp.readFile(zip)) === provenance.editor.sha256,
    'The bundled Seedsow editor save failed its integrity check.');
  await fsp.mkdir(directory, {mode: 0o700});
  const extracted = await run('/usr/bin/ditto', ['-x', '-k', zip, directory]);
  check(extracted.code === 0 && !extracted.signal, 'Could not unpack the bundled Seedsow editor save.');
  const files = [];
  for (const name of await fsp.readdir(directory)) {
    const file = path.join(directory, name);
    const info = await fsp.lstat(file);
    check(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024,
      'The editor save contains an unsupported entry: ' + name);
    if (name === '.nx_save_meta.bin') continue;
    check(filePattern.test(name) && !name.startsWith('.'),
      'The editor save contains an unsafe file name: ' + name);
    files.push(name);
  }
  files.sort();
  check(files.length === provenance.editor.installableFiles,
    'The editor save file count does not match its pinned release.');
  for (const name of showcaseFiles) check(!files.includes(name),
    'The upstream editor save already contains a showcase file: ' + name);
  const luaSource = path.join(root, 'integrations/seedsow-lua/cpypwn.lua');
  const bytes = await fsp.readFile(luaSource);
  check(bytes.length > 0 && bytes.length < 65536 &&
    bytes.includes(Buffer.from("p.screen('0xff000000')")) &&
    bytes.includes(Buffer.from("p.label('cpypwn', 509, 315, 80, 'cpypwn')")),
    'The cpypwn Lua showcase is missing or incomplete.');
  await fsp.writeFile(path.join(directory, 'cpypwn.lua'), bytes, {flag: 'wx', mode: 0o600});
  await fsp.writeFile(path.join(directory, 'ssslot006.ref'), 'cpypwn.lua\n',
    {flag: 'wx', mode: 0o600});
  for (const [target, source] of [
    ['save0006.dat', 'ssseed006.bin'],
    ['save0006.png', 'save0001.png'],
    ['save0006_s.png', 'save0001_s.png']
  ]) await fsp.copyFile(path.join(directory, source), path.join(directory, target), fs.constants.COPYFILE_EXCL);
  return files.concat(showcaseFiles).sort();
}

async function stageCustomEditor(directory, sourcePath) {
  check(typeof sourcePath === 'string' && path.isAbsolute(sourcePath) &&
    sourcePath.length <= 4096 && !/[\x00\r\n]/.test(sourcePath),
  'Choose a local Seedsow editor ZIP or folder.');
  const source = path.resolve(sourcePath);
  const sourceInfo = await fsp.lstat(source);
  check(!sourceInfo.isSymbolicLink(), 'The selected editor save cannot be a symbolic link.');
  let input = source;
  if (sourceInfo.isFile()) {
    check(path.extname(source).toLowerCase() === '.zip' && sourceInfo.size <= 64 * 1024 * 1024,
      'Choose an editor save ZIP smaller than 64 MiB or a folder.');
    const listed = await run('/usr/bin/unzip', ['-Z1', source], root, 30000);
    check(listed.code === 0 && !listed.signal, 'Could not inspect the selected editor ZIP.');
    const entries = listed.stdout.trimEnd().split('\n').filter(Boolean);
    check(entries.length > 0 && entries.length <= 1000, 'The editor ZIP has too many entries.');
    const names = new Set();
    for (const entry of entries) {
      check(!/[\x00\r\\]/.test(entry) && !entry.startsWith('/') && !entry.includes('//'),
        'The editor ZIP has an unsafe path.');
      const parts = entry.replace(/\/$/, '').split('/');
      check((parts.length <= 2 || parts[0] === '__MACOSX' && parts.length <= 3) &&
        parts.every(part => part && part !== '.' && part !== '..'),
        'The editor ZIP must contain flat save files or one enclosing folder.');
      const name = entry.toLowerCase();
      check(!names.has(name), 'The editor ZIP has a duplicate entry.');
      names.add(name);
    }
    const archive = directory + '-archive';
    await fsp.mkdir(archive, {recursive: true, mode: 0o700});
    const extracted = await run('/usr/bin/ditto', ['-x', '-k', source, archive]);
    check(extracted.code === 0 && !extracted.signal, 'Could not unpack the selected editor ZIP.');
    const top = (await fsp.readdir(archive)).filter(name =>
      !['.DS_Store', '__MACOSX'].includes(name) && !name.startsWith('._'));
    if (top.length === 1 && (await fsp.lstat(path.join(archive, top[0]))).isDirectory())
      input = path.join(archive, top[0]);
    else input = archive;
  } else check(sourceInfo.isDirectory(), 'Choose an editor save ZIP or folder.');
  await fsp.mkdir(directory, {recursive: true, mode: 0o700});
  let total = 0;
  const files = [];
  for (const name of await fsp.readdir(input)) {
    if (['.DS_Store', '.nx_save_meta.bin', 'manifest.json', '__MACOSX'].includes(name) ||
        name.startsWith('._')) continue;
    check(filePattern.test(name) && !name.startsWith('.') && name.length <= 255,
      'The editor save has an unsafe file name: ' + name);
    const file = path.join(input, name);
    const info = await fsp.lstat(file);
    check(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024,
      'The editor save must contain flat regular files smaller than 8 MiB: ' + name);
    total += info.size;
    check(total <= 64 * 1024 * 1024, 'The editor save exceeds 64 MiB.');
    await fsp.copyFile(file, path.join(directory, name), fs.constants.COPYFILE_EXCL);
    files.push(name);
  }
  files.sort();
  check(files.length >= 2 && files.length <= 500 &&
    files.includes('ssedit1.lua') && files.includes('sed01.asb'),
  'The selected files do not contain a Seedsow Lua Editor save.');
  return files;
}

async function backupProof(directory, uid, titleId) {
  const manifest = JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const id = manifest.titleId ?? manifest.programId;
  const selected = manifest.selection ?? {space: manifest.space, type: manifest.type,
    rank: manifest.rank, index: manifest.index, staticId: 0, uid: manifest.uid};
  check(manifest.archive?.includes('space=User type=Account') &&
        manifest.archive?.includes('uid=' + uid.slice(0, 16)) &&
        Number.isSafeInteger(manifest.files) && manifest.files > 0 &&
        manifest.entries?.length === manifest.files,
    'The demo backup did not identify the selected account save.');
  if (titleId) check(id === titleId &&
    selected.space === 1 && selected.type === 1 &&
    selected.rank === 0 && selected.index === 0 &&
    selected.staticId === 0 && selected.uid === uid,
  'The demo backup did not identify the selected title and account archive.');
  if (Object.hasOwn(manifest, 'programId') && Object.hasOwn(manifest, 'titleId'))
    check(manifest.programId === manifest.titleId,
      'The demo backup has conflicting program IDs.');
  for (const key of ['uid', 'space', 'type', 'rank', 'index'])
    if (Object.hasOwn(manifest, key))
      check(manifest[key] === selected[key],
        'The demo backup has conflicting ' + key + ' fields.');
  for (const entry of manifest.entries) {
    check(entry.path === '/' + path.posix.basename(entry.path) && filePattern.test(entry.path.slice(1)),
      'The Seedsow demo backup has an unsupported path.');
    const bytes = await fsp.readFile(path.join(directory, entry.path.slice(1)));
    check(bytes.length === entry.size && sha(bytes) === entry.sha256,
      'The Seedsow demo backup failed verification: ' + entry.path);
  }
  return {...manifest, titleId: id, selection: selected};
}

function chooseUser(candidates, source = process.stdin, game) {
  return new Promise((resolve, reject) => {
    const input = readline.createInterface({input: source});
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; input.close(); reject(Error('No game save user was selected.'));
    }, 600000);
    input.on('line', line => {
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (value?.action !== 'select-user' || !candidates.includes(value.uid)) return;
      settled = true; clearTimeout(timer); input.close(); resolve(value.uid);
    });
    input.once('close', () => {
      clearTimeout(timer);
      source.pause();
      source.unref?.();
      if (!settled) reject(Error('The save user selection was cancelled.'));
    });
    emit('choose-user', {...(game ? {game} : {}), stage: 'choose-user', users: candidates,
      message: `Choose the console account whose ${game ? artemisProfile(game).title : 'Seedsow Lullaby demo'} save should be updated.`});
  });
}

function existingEditorState(files) {
  const markers = ['ssedit1.lua', 'sed01.asb'];
  const found = markers.filter(name => files.has(name)).length;
  return found === 2 ? 'installed' : found === 1 ? 'partial' : 'fresh';
}

async function editorInstallPlan(extracted, backup, files) {
  const present = new Set(await fsp.readdir(backup));
  const state = existingEditorState(present);
  const slot = [...showcaseFiles, oldShowcaseName].filter(name => present.has(name));
  if (slot.length) {
    const reference = present.has('ssslot006.ref')
      ? (await fsp.readFile(path.join(backup, 'ssslot006.ref'), 'utf8')).trim() : '';
    const staged = await fsp.readFile(path.join(extracted, 'cpypwn.lua'));
    const newFileIsOurs = !present.has('cpypwn.lua') ||
      sha(await fsp.readFile(path.join(backup, 'cpypwn.lua'))) === sha(staged);
    const oldFileIsOurs = present.has(oldShowcaseName) &&
      oldShowcaseHashes.has(sha(await fsp.readFile(path.join(backup, oldShowcaseName))));
    if (!newFileIsOurs ||
        (reference !== 'cpypwn.lua' &&
         !(reference === oldShowcaseName && state === 'installed' && oldFileIsOurs)))
      return {kind: 'slot-conflict', files: [], present};
  }
  if (state === 'fresh') return {kind: 'fresh', files, present};
  if (state === 'partial') return {kind: 'partial', files: [], present};
  if (files.some(name => !showcaseFiles.includes(name) && !present.has(name)))
    return {kind: 'partial', files: [], present};
  for (const name of ['ssedit1.lua', 'sed01.asb']) {
    const live = await fsp.readFile(path.join(backup, name));
    const bundled = await fsp.readFile(path.join(extracted, name));
    if (sha(live) !== sha(bundled)) return {kind: 'different', files: [], present};
  }
  const updates = [];
  for (const name of showcaseFiles) {
    if (!present.has(name) || sha(await fsp.readFile(path.join(backup, name))) !==
        sha(await fsp.readFile(path.join(extracted, name)))) updates.push(name);
  }
  return {kind: updates.length ? 'showcase' : 'current', files: updates, present};
}

async function customEditorPlan(extracted, backup, files) {
  const present = new Set(await fsp.readdir(backup));
  const updates = [];
  for (const name of files) {
    if (!present.has(name) || sha(await fsp.readFile(path.join(backup, name))) !==
        sha(await fsp.readFile(path.join(extracted, name)))) updates.push(name);
  }
  return {kind: updates.length ? 'custom' : 'current', files: updates, present};
}

async function artemisInstallPlan(extracted, backup, files) {
  const present = new Set(await fsp.readdir(backup));
  const markers = launcherFiles.filter(name => present.has(name));
  if (markers.length) {
    if (markers.length !== launcherFiles.length)
      return {kind: 'partial', files: [], present};
    for (const name of launcherFiles) {
      if (sha(await fsp.readFile(path.join(backup, name))) !==
          sha(await fsp.readFile(path.join(extracted, name))))
        return {kind: 'different', files: [], present};
    }
    if (!['save9999.dat', 'saveg.dat', 'system.dat'].every(name => present.has(name)))
      return {kind: 'partial', files: [], present};
    if (sha(await fsp.readFile(path.join(backup, 'save9999.dat'))) !==
        sha(await fsp.readFile(path.join(extracted, 'save9999.dat'))))
      return {kind: 'different', files: [], present};
  }
  for (const name of artemisUpdates) {
    if (present.has(name) &&
        ![sha(await fsp.readFile(path.join(extracted, name))),
          previousArtemisUpdateHashes.get(name)].includes(
            sha(await fsp.readFile(path.join(backup, name)))))
      return {kind: 'custom-http', files: [], present};
  }
  const updates = [];
  for (const name of files) {
    if (markers.length && artemisFiles.includes(name)) continue;
    if (name === artemisShowcase && present.has(name)) continue;
    if (!present.has(name) || sha(await fsp.readFile(path.join(backup, name))) !==
        sha(await fsp.readFile(path.join(extracted, name)))) updates.push(name);
  }
  const customB = present.has(artemisShowcase) &&
    sha(await fsp.readFile(path.join(backup, artemisShowcase))) !==
    sha(await fsp.readFile(path.join(extracted, artemisShowcase)));
  return {kind: updates.length ? markers.length ? 'upgrade' : 'fresh' :
    customB ? 'custom' : 'current', files: updates, present};
}

async function install(runDirectory, sourcePath) {
  const runs = fs.realpathSync(path.join(root, 'vendor')).replace(/\/$/, '');
  const runPath = fs.realpathSync(runDirectory);
  check(runPath.startsWith(runs + '/ns2-savekit-host-') &&
        path.basename(path.dirname(runPath)) === 'runs',
    'The Seedsow save action needs its own patched SaveKit host run.');
  const stageRoot = await fsp.mkdtemp(path.join(root, 'seedsow-stage-'));
  const extracted = path.join(stageRoot, 'editor');
  let backup;
  try {
    emit('progress', {stage: 'checking', message: sourcePath
      ? 'Checking the selected Seedsow Lua Editor save' : 'Checking the bundled Seedsow Lua Editor save'});
    const files = sourcePath ? await stageCustomEditor(extracted, sourcePath) : await stageEditor(extracted);
    emit('progress', {stage: 'finding', message: 'Finding the Seedsow Lullaby demo save'});
    const listed = await tool('save-pull-root.cjs',
      [runPath, '0000000000000000', '.', '--list-uids']);
    check(listed.code === 0, 'Could not list console users. Restart the console before retrying.');
    const uids = [...new Set(listed.stdout.split('\n').map(line => line.trim().toLowerCase())
      .filter(line => uidPattern.test(line)))];
    check(uids.length > 0 && uids.length <= 8,
      'No console account IDs were available for the Seedsow demo save.');
    const uid = uids.length === 1 ? uids[0] : await chooseUser(uids);
    emit('progress', {stage: 'backup', message: 'Backing up the selected Seedsow demo save'});
    const backups = path.join(root, 'seedsow-backups');
    await fsp.mkdir(backups, {recursive: true, mode: 0o700});
    backup = await fsp.mkdtemp(path.join(backups, 'demo-' + uid.slice(0, 8) + '-'));
    const pulled = await tool('save-pull-root.cjs',
      [runPath, programId, backup, uid, '--space', '1', '--type', '1', '--rank', '0']);
    if (missingSaveArchive(pulled, programId)) {
      await fsp.rm(backup, {recursive: true, force: true});
      backup = undefined;
      throw absentSaveError('Seedsow Lullaby demo');
    }
    check(pulled.code === 0, 'The Seedsow demo backup failed. No save write was attempted.');
    const original = await backupProof(backup, uid);
    emit('backup', {backupPath: backup, message: 'Seedsow demo save backed up and verified'});
    const plan = sourcePath ? await customEditorPlan(extracted, backup, files) :
      await editorInstallPlan(extracted, backup, files);
    if (!plan.files.length) {
      const messages = {
        'slot-conflict': 'Save slot 6 contains another game or script. The save was backed up; no files were changed.',
        partial: 'The existing Seedsow editor is incomplete. The save was backed up; no files were changed.',
        different: 'The existing Seedsow editor differs from the bundled version. The save was backed up; no files were changed.',
        current: sourcePath
          ? 'The selected Seedsow editor save already matches the console save. The backup was kept; no files were changed.'
          : 'The Seedsow editor and cpypwn showcase are already current. The backup was kept; no files were changed.'
      };
      emit('skipped', {backupPath: backup, files: original.files,
        message: messages[plan.kind]});
      return;
    }
    const manifest = {
      title: sourcePath ? 'Seedsow Lullaby demo — selected editor save' :
        'Seedsow Lullaby demo — Seedsow Lua Editor v0.1.3 with cpypwn showcase',
      source: extracted, backup,
      files: plan.files.map(name => ({path: '/' + name, local: path.join(extracted, name),
        ...(plan.present.has(name) ? {replace: true} : {})}))
    };
    const manifestPath = path.join(stageRoot, 'manifest.json');
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
    emit('progress', {stage: 'writing', message: sourcePath
      ? 'Writing selected editor files and verifying every file'
      : 'Writing the editor and cpypwn showcase, then verifying every file'});
    const written = await tool('save-write-stage.cjs', [runPath, programId, uid, backup, manifestPath]);
    check(written.code === 0 && written.stdout.includes('verified ' + plan.files.length + ' written files after commit'),
      'The Seedsow editor write was not fully verified. Keep the backup and restart the console.');
    emit('complete', {backupPath: backup, files: plan.files.length,
      message: sourcePath
        ? 'Selected Seedsow Lua Editor save installed. Keep SmileBASIC open while using this held RPC session.'
        : 'Seedsow Lua Editor v0.1.3 and cpypwn showcase installed. Keep SmileBASIC open while using this held RPC session.'});
  } catch (error) {
    emit('failed', {backupPath: backup,
      ...(error.code === 'SAVE_ABSENT' ? {reason: 'save-absent'} : {}), message: error.message});
    process.exitCode = 1;
  } finally {
    await fsp.rm(stageRoot, {recursive: true, force: true});
  }
}

async function installArtemis(runDirectory, game) {
  const profile = artemisProfile(game);
  const runs = fs.realpathSync(path.join(root, 'vendor')).replace(/\/$/, '');
  const runPath = fs.realpathSync(runDirectory);
  check(runPath.startsWith(runs + '/ns2-savekit-host-') &&
        path.basename(path.dirname(runPath)) === 'runs',
    'The Artemis launcher needs its own patched SaveKit host run.');
  const stageRoot = await fsp.mkdtemp(path.join(root, 'artemis-stage-'));
  const extracted = path.join(stageRoot, 'save');
  const report = (type, fields) => emit(type, {game, ...fields});
  let backup;
  try {
    report('progress', {stage: 'checking', message: `Checking the bundled ${profile.title} Artemis launcher`});
    const files = await stageBundledArtemis(extracted, game);
    report('progress', {stage: 'finding', message: `Finding the ${profile.title} save`});
    const listed = await tool('save-pull-root.cjs',
      [runPath, '0000000000000000', '.', '--list-uids']);
    check(listed.code === 0, 'Could not list console users. Restart the console before retrying.');
    const uids = [...new Set(listed.stdout.split('\n').map(line => line.trim().toLowerCase())
      .filter(line => uidPattern.test(line)))];
    check(uids.length > 0 && uids.length <= 8,
      `No console account IDs were available for the ${profile.title} save.`);
    const uid = uids.length === 1 ? uids[0] : await chooseUser(uids, process.stdin, game);
    report('progress', {stage: 'backup', message: `Backing up the selected ${profile.title} save`});
    const backups = path.join(root, 'artemis-backups');
    await fsp.mkdir(backups, {recursive: true, mode: 0o700});
    backup = await fsp.mkdtemp(path.join(backups, `${game}-${uid.slice(0, 8)}-`));
    const pulled = await tool('save-pull-root.cjs',
      [runPath, profile.titleId, backup, uid, '--space', '1', '--type', '1', '--rank', '0']);
    if (missingSaveArchive(pulled, profile.titleId)) {
      await fsp.rm(backup, {recursive: true, force: true});
      backup = undefined;
      throw absentSaveError(profile.title);
    }
    check(pulled.code === 0, `The ${profile.title} backup failed. No save write was attempted.`);
    const original = await backupProof(backup, uid, profile.titleId);
    report('backup', {backupPath: backup, message: `${profile.title} save backed up and verified`});
    const plan = await artemisInstallPlan(extracted, backup, files);
    if (!plan.files.length) {
      const messages = {
        partial: 'A partial Artemis launcher is already in this save. The backup was kept; no files were changed.',
        different: 'The existing Artemis launcher differs from the pinned release. The backup was kept; no files were changed.',
        'custom-http': 'The existing Artemis HTTP update differs from mac2jb. The backup was kept; no files were changed.',
        custom: 'The Artemis HTTP showcase is current. The existing B payload was preserved; no files were changed.',
        current: 'The Artemis launcher and cpypwn HTTP showcase are current. The backup was kept; no files were changed.'
      };
      report('skipped', {backupPath: backup, files: original.files, message: messages[plan.kind]});
      return;
    }
    const manifest = {
      title: `${profile.title} — Artemis launcher v1`, source: extracted, backup,
      files: plan.files.map(name => ({path: '/' + name, local: path.join(extracted, name),
        ...(plan.present.has(name) ? {replace: true} : {})}))
    };
    const manifestPath = path.join(stageRoot, 'manifest.json');
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
    report('progress', {stage: 'writing', message: `Writing and verifying the ${profile.title} Artemis launcher`});
    const written = await tool('save-write-stage.cjs',
      [runPath, profile.titleId, uid, backup, manifestPath]);
    check(written.code === 0 &&
      written.stdout.includes('verified ' + plan.files.length + ' written files after commit'),
    `The ${profile.title} launcher write was not fully verified. Keep the backup and restart the console.`);
    report('complete', {backupPath: backup, files: plan.files.length,
      message: `${profile.title} Artemis launcher installed and verified with the cpypwn HTTP showcase${plan.present.has(artemisShowcase) && !plan.files.includes(artemisShowcase) ? '; the existing B payload was preserved' : ''}. Keep SmileBASIC open while using this held RPC session.`});
  } catch (error) {
    report('failed', {backupPath: backup,
      ...(error.code === 'SAVE_ABSENT' ? {reason: 'save-absent'} : {}), message: error.message});
    process.exitCode = 1;
  } finally {
    await fsp.rm(stageRoot, {recursive: true, force: true});
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') {
    artemisProfile('seedsow');
    artemisProfile('nora');
    const artemisDemo = await artemisShowcaseBytes();
    const stage = await fsp.mkdtemp(path.join(root, 'seedsow-check-'));
    try {
      const files = await stageEditor(path.join(stage, 'editor'));
      for (const game of ['seedsow', 'nora'])
        check((await stageBundledArtemis(path.join(stage, game), game)).length ===
          artemisBundledFiles.length, 'The bundled Artemis launcher is incomplete.');
      console.log('Seedsow editor and Artemis cpypwn showcases verified without RPC: ' +
        files.length + ' editor files, ' + artemisDemo.length + ' Artemis demo bytes.');
    } finally { await fsp.rm(stage, {recursive: true, force: true}); }
    return;
  }
  if (args.length === 3 && args[1] === '--artemis') {
    await installArtemis(args[0], args[2]);
    return;
  }
  if (args.length < 1 || args.length > 2)
    throw Error('Usage: gui-savekit.cjs <patched-run-directory> [editor-save-zip-or-folder] | <patched-run-directory> --artemis seedsow|nora');
  await install(args[0], args[1]);
}

module.exports = {stageEditor, stageCustomEditor, backupProof, chooseUser,
  existingEditorState, editorInstallPlan,
  customEditorPlan, artemisProfile,
  stageArtemis, stageBundledArtemis, artemisInstallPlan, cachedArtemisArchive,
  artemisHttpShowcase, artemisInjectShowcase, missingSaveArchive};
if (require.main === module) {
  main().catch(error => {emit('failed', {message: error.message}); process.exitCode = 1;});
}
