#!/usr/bin/env node
'use strict';
process.umask(0o077);
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {collectMods} = require('../integrations/ns2jb-modloader/lib/mods.cjs');

const check = (value, message) => {if (!value) throw Error(message);};
const emit = (type, fields = {}) => process.stdout.write('MAC2JB_MODLOADER ' + JSON.stringify({type, ...fields}) + '\n');
const installMessage = 'Modloader installed. Finish this session, close SmileBASIC without restarting the Switch, then launch the game. Restart the Switch before installing a different mod.';
const civInstallMessage = 'Modloader installed. Disconnect this attachment, stop the original FS host, then close Civilization VII without restarting the Switch before launching the game. Restart the Switch before installing a different mod.';
const codeEntries = ['install.cjs', 'LICENSE', 'lib', 'native'];
const modEntries = ['contents', 'exefs_patches'];
const present = file => {try {fs.lstatSync(file); return true;} catch (error) {
  if (error.code === 'ENOENT') return false;
  throw error;
}};

function ownedDirectory(directory) {
  check(typeof directory === 'string' && path.isAbsolute(directory) &&
    directory.length <= 4096 && !/[\x00\r\n]/.test(directory), 'Choose an absolute mod folder.');
  const absolute = path.resolve(directory), info = fs.lstatSync(absolute);
  check(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    fs.realpathSync(absolute) === absolute, 'The mod folder must be an owned directory without symlinks.');
  return absolute;
}

function inspectTree(source, count = {files: 0}) {
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    const file = path.join(source, entry.name), info = fs.lstatSync(file);
    check(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()),
      'Mod folders may contain only regular files and directories: ' + file);
    check(info.uid === process.getuid(), 'A mod file is owned by another user: ' + file);
    if (info.isDirectory()) inspectTree(file, count);
    else check(++count.files <= 20000, 'The selected folder has too many mod files.');
  }
  return count;
}

function validateModsFolder(directory) {
  const absolute = ownedDirectory(directory);
  for (const name of modEntries) {
    const entry = path.join(absolute, name);
    if (!present(entry)) continue;
    const info = fs.lstatSync(entry);
    check(info.isDirectory() && !info.isSymbolicLink(), name + ' must be a real directory.');
    inspectTree(entry);
  }
  collectMods(absolute);
  return absolute;
}

function modsFolderFromCommand(command) {
  const source = command.source ?? (command.modsFolder === undefined ? 'sd' : 'mac');
  check(source === 'sd' || source === 'mac', 'Choose a supported mod source.');
  if (source === 'sd') {
    check(command.modsFolder === undefined, 'This option does not require a mods folder.');
    return null;
  }
  check(typeof command.modsFolder === 'string' && path.isAbsolute(command.modsFolder) &&
    command.modsFolder.length <= 4096 && !/[\x00\r\n]/.test(command.modsFolder),
  'Choose an unpacked mod folder.');
  return command.modsFolder;
}

function copyRegularTree(source, destination) {
  const info = fs.lstatSync(source);
  check(!info.isSymbolicLink(), 'A selected file changed to a symlink: ' + source);
  if (info.isDirectory()) {
    fs.mkdirSync(destination, {mode: 0o700});
    for (const entry of fs.readdirSync(source)) copyRegularTree(path.join(source, entry), path.join(destination, entry));
    return;
  }
  check(info.isFile(), 'Only regular files can be staged: ' + source);
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let output;
  try {
    const opened = fs.fstatSync(input);
    check(opened.isFile() && opened.dev === info.dev && opened.ino === info.ino,
      'A selected file changed during staging: ' + source);
    output = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let copied = 0, size;
    while ((size = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
      let written = 0;
      while (written < size) written += fs.writeSync(output, buffer, written, size - written);
      copied += size;
    }
    const final = fs.fstatSync(input);
    check(copied === opened.size && final.size === opened.size && final.mtimeMs === opened.mtimeMs,
      'A selected file changed during staging: ' + source);
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(input);
  }
}

function stage(run, modsFolder, sourceRoot = path.resolve(__dirname, '../integrations/ns2jb-modloader')) {
  const session = ownedDirectory(run), mods = modsFolder == null ? null : validateModsFolder(modsFolder);
  const staging = fs.mkdtempSync(path.join(session, '.mac2jb-modloader-'));
  fs.chmodSync(staging, 0o700);
  try {
    for (const name of codeEntries) copyRegularTree(path.join(sourceRoot, name), path.join(staging, name));
    const ouncecake = path.resolve(sourceRoot, '../../vendor/OunceCake');
    const stagedOuncecake = path.join(staging, 'vendor', 'OunceCake');
    fs.mkdirSync(stagedOuncecake, {recursive: true, mode: 0o700});
    copyRegularTree(path.join(ouncecake, 'engine'), path.join(stagedOuncecake, 'engine'));
    copyRegularTree(path.join(ouncecake, 'LICENSE'), path.join(stagedOuncecake, 'LICENSE'));
    for (const name of modEntries) if (mods && present(path.join(mods, name)))
      copyRegularTree(path.join(mods, name), path.join(staging, name));
    const staged = mods ? collectMods(staging) : {games: [], patches: []};
    if (mods) check(staged.games.length + staged.patches.length > 0, 'No loadable mod files were staged.');
    require(path.join(staging, 'lib/native/artifacts.cjs')).artifacts();
    return {staging, games: staged.games.map(game => game.titleId), patches: staged.patches.length};
  } catch (error) {
    fs.rmSync(staging, {recursive: true, force: true});
    throw error;
  }
}

function installArguments(staging, run, modSource) {
  return [path.join(staging, 'install.cjs'), '--run-dir', run,
    ...(modSource && modSource !== '/ns2jb-modloader' ? ['--mod-source', modSource] : [])];
}

function boundedLine(line) {
  return String(line).trim().replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512);
}

async function modloaderHost(root, result, report, verifyCiv =
  require('./prepare-civswitch-savekit.cjs').verifyPreparedRun) {
  const target = result.connection.addresses?.target;
  if (target === 'civ7') {
    check(report.target === 'civ7', 'The held CivSwitch FS run has an unexpected target.');
    const prepared = await verifyCiv(null, result.directory);
    check(prepared.target === 'civ7' && prepared.sourceSha256 === report.sourceSha256,
      'The held CivSwitch FS run does not match its prepared source.');
    return 'civ7';
  }
  check(target === 'switch2' && (!report.target || report.target === 'switch2'),
    'Modloader requires a verified ns2jb or CivSwitch FS session.');
  const profiles = require('./host-profiles.cjs').profiles.filter(profile => profile.supportsModloader);
  check(profiles.some(profile => report.sourceSha256 === profile.sourceSha256 ||
    result.trustedSource?.profileId === profile.id && result.trustedSource.sourceSha256 === report.sourceSha256),
  'Modloader requires a held Kurumuz or Cellenseres RPC session.');
  return 'switch2';
}

async function install(run, modsFolder) {
  const root = path.resolve(__dirname, '..');
  let result, staged, target, captureStarted = false, uploadStarted = false, uploaded;
  try {
    result = await require('./gui-homebrew.cjs').validateRun(root, run,
      require('./gui-dump.cjs').verifiedSession);
    const report = JSON.parse(fs.readFileSync(path.join(result.directory, 'result.json'), 'utf8'));
    target = await modloaderHost(root, result, report);
    staged = stage(result.directory, modsFolder);
    if (target === 'civ7') {
      process.env.NS2_TARGET = 'civ7';
      process.env.NS2_TARGET_ROOT = result.directory;
      captureStarted = true;
      await require('../integrations/ns2jb-modloader/lib/native-capture.cjs')
        .captureNative(result.directory, path.join(staged.staging, 'preflight'));
      fs.rmSync(path.join(staged.staging, 'preflight'), {recursive: true, force: true});
    }
    if (modsFolder == null) {
      emit('started', {message: 'Reading mods from the Switch SD card'});
    } else {
      emit('started', {message: 'Uploading selected mods to the Switch SD card'});
      uploadStarted = true;
      uploaded = await require('./gui-modloader-sd.cjs').uploadSelectedMods(result.directory, staged.staging);
    }
  } catch (error) {
    if (staged) fs.rmSync(staged.staging, {recursive: true, force: true});
    error.retrySafe = !captureStarted && !uploadStarted && error.retrySafe !== false;
    throw error;
  }
  if (uploaded) emit('progress', {message: 'Verified ' + uploaded.files + ' SD mod file(s) for ' +
    staged.games.length + ' game mod set(s) and ' + staged.patches + ' global patch(es)'});
  const child = spawn(process.execPath,
    installArguments(staged.staging, result.directory, uploaded?.source), {
    cwd: staged.staging, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ...(target === 'civ7' ? {NS2_TARGET: 'civ7', NS2_TARGET_ROOT: result.directory} : {})}
  });
  let readyLine = false, stoppedReason = '';
  function observe(stream) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      for (let end; (end = pending.indexOf('\n')) !== -1;) {
        const line = boundedLine(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (line.startsWith('READY')) readyLine = true;
        if (line.startsWith('INSTALL STOPPED: ')) stoppedReason = line.slice('INSTALL STOPPED: '.length).slice(0, 300);
        if (line) emit('progress', {message: line});
      }
    });
    stream.on('end', () => {if (pending.trim()) emit('progress', {message: boundedLine(pending)});});
  }
  observe(child.stdout); observe(child.stderr);
  const outcome = await new Promise(resolve => {
    child.once('error', error => resolve({error}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  check(!outcome.error && outcome.code === 0 && !outcome.signal && readyLine,
    (stoppedReason ? 'Modloader stopped: ' + stoppedReason.replace(/[.!?]+$/, '') + '. ' : '') +
    'The game handoff was not verified. Restart the Switch before trying again.');
  const lock = JSON.parse(fs.readFileSync(path.join(result.directory, 'ns2jb-modloader-install.json'), 'utf8'));
  const resident = JSON.parse(fs.readFileSync(path.join(staged.staging, 'state', path.basename(result.directory), 'resident-install.json'), 'utf8'));
  check(lock.status === 'ready' && resident.verified === true && resident.readyForGameHandoff === true &&
    resident.handoff?.stockRoProtocolVerified === true,
  'Modloader did not verify the final game handoff. Restart the Switch before trying again.');
  emit('ready', {path: staged.staging, message: target === 'civ7' ? civInstallMessage : installMessage});
}

module.exports = {validateModsFolder, modsFolderFromCommand, copyRegularTree, stage, install, installArguments, installMessage,
  civInstallMessage, modloaderHost};
if (require.main === module) {
  install(process.argv[2], process.argv[3]).catch(error => {
    emit('failed', {message: boundedLine(error.message), retrySafe: error.retrySafe === true});
    process.exitCode = 1;
  });
}
