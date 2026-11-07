'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {inspectPackage} = require('./contract.cjs');
const sdRoms = require('./sd-roms.cjs');

const nativeRoot = path.join(__dirname, 'upstream');
const commandIds = ['0x524f001a', '0x524f001b', '0x524f001c'];
const MAX_CUSTOM_BYTES = 256 * 1024 * 1024;

function check(value, message) {
  if (!value) throw Error(message);
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function builtLauncher(source) {
  const build = path.join(source, 'launcher/build');
  const report = JSON.parse(fs.readFileSync(path.join(build, 'report.json'), 'utf8'));
  const code = fs.readFileSync(path.join(build, 'code.bin'));
  const data = fs.readFileSync(path.join(build, 'data.bin'));
  check(report.format === 'hblauncher-native-app/1' && report.kind === 'launcher' &&
    report.abi === 3 && report.codeBytes === code.length && code.length > 0 &&
    report.dataBytes === data.length && report.codeSha256 === hash(code) &&
    report.dataSha256 === hash(data) && report.codeBase === '0x08000000' &&
    typeof report.dataBase === 'string' && report.dataBase.toLowerCase() === '0x0a000000',
  'The bundled ABI 3 launcher image does not match its build report');
  return report;
}

function verifySource(source, hostSource) {
  const abi = JSON.parse(fs.readFileSync(path.join(source, 'sdk/abi.json'), 'utf8'));
  check(abi.abiVersion === 3 && Number.isSafeInteger(abi.ctxSize) && abi.ctxSize > 0,
    'The bundled native SDK ABI is invalid');
  check(fs.statSync(path.join(source, 'assets/font_atlas.r8')).size === 1024 * 1024,
    'The bundled native font atlas is missing or damaged');
  const launcher = builtLauncher(source);
  const hello = inspectPackage(path.join(source, 'apps/hello-cpu'));
  const mintnes = inspectPackage(path.join(source, 'apps/mintnes'));
  const marker = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-report.json'), 'utf8'));
  const expectedMintNES = marker.apps?.find(app => app.id === 'mintnes');
  check(marker.format === 'mac2jb-native-build/1' &&
    marker.upstreamCommit === '18b4748ba98eeac7df17beb5d3418985eb74897c' &&
    marker.launcher?.codeSha256 === launcher.codeSha256 &&
    expectedMintNES?.codeSha256 === mintnes.codeSha256,
  'Bundled MintNES or launcher code does not match the verified native build');
  const payload = fs.readFileSync(path.join(hostSource, 'engine/switch2/ro/payload/process.c'), 'utf8');
  check(commandIds.every(id => new RegExp('command\\s*==\\s*' + id, 'i').test(payload)),
    'This host payload lacks native ABI 3 bulk mapping commands');
  return {launcher, hello, mintnes};
}

function packageFileName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 256 &&
    !path.isAbsolute(name) && !/[\\\x00-\x1f\x7f]/.test(name) &&
    name.split('/').every(part => part && part !== '.' && part !== '..');
}

async function copyNativePackage(folder, destination) {
  const source = await fsp.realpath(folder);
  const info = await fsp.lstat(folder);
  check(info.isDirectory() && !info.isSymbolicLink() && source === path.resolve(folder),
    'Choose a real built native app folder');
  const app = inspectPackage(source);
  const manifest = JSON.parse(await fsp.readFile(path.join(source, 'manifest.json'), 'utf8'));
  const files = new Set(['manifest.json', 'build/report.json', 'build/code.bin']);
  if (fs.existsSync(path.join(source, 'build/data.bin'))) files.add('build/data.bin');
  const icon = manifest.icon || 'icon.png';
  check(packageFileName(icon), 'Invalid native app icon path');
  if (fs.existsSync(path.join(source, icon))) files.add(icon);
  const assetNames = new Set();
  for (const name of manifest.assets || []) {
    if (/^\*\.[A-Za-z0-9]+$/.test(name)) {
      const assetRoot = path.join(source, 'assets');
      if (!fs.existsSync(assetRoot)) continue;
      const suffix = name.slice(1).toLowerCase();
      for (const file of await fsp.readdir(assetRoot))
        if (file.toLowerCase().endsWith(suffix)) assetNames.add(file);
    } else assetNames.add(name);
  }
  check(assetNames.size <= 64, 'Native app has more than 64 assets');
  for (const name of assetNames) {
    check(packageFileName(name), 'Invalid native app asset path');
    files.add('assets/' + name);
  }
  await fsp.mkdir(destination, {recursive: true, mode: 0o700});
  let total = 0;
  for (const name of files) {
    check(packageFileName(name), 'Invalid native app file path');
    const input = path.join(source, name), stat = await fsp.lstat(input);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 128 * 1024 * 1024 &&
      await fsp.realpath(input) === input, 'Invalid native app file: ' + name);
    total += stat.size;
    check(total <= MAX_CUSTOM_BYTES, 'Native app package is too large');
    const output = path.join(destination, name);
    await fsp.mkdir(path.dirname(output), {recursive: true, mode: 0o700});
    await fsp.writeFile(output, await fsp.readFile(input), {flag: 'wx', mode: 0o600});
  }
  const copied = inspectPackage(destination);
  check(copied.id === app.id && copied.codeSha256 === app.codeSha256,
    'The native app changed while staging');
  return copied;
}

async function preflightCustomNativeApp(root, folder) {
  const parent = path.join(root, 'runs');
  await fsp.mkdir(parent, {recursive: true, mode: 0o700});
  const info = await fsp.lstat(parent);
  check(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() &&
    (info.mode & 0o077) === 0 && await fsp.realpath(parent) === parent,
  'Native app staging requires a private owned runs directory');
  const directory = await fsp.mkdtemp(path.join(parent, 'custom-native-preflight-'));
  try {
    const packageFolder = path.join(directory, 'package');
    const app = await copyNativePackage(folder, packageFolder);
    return {directory, kind: 'native-app', packageFolder,
      app: {id: app.id, name: app.name, version: app.version,
        fingerprint: app.codeSha256},
      cleanup: () => fsp.rm(directory, {recursive: true, force: true})};
  } catch (error) {
    await fsp.rm(directory, {recursive: true, force: true});
    throw error;
  }
}

async function stageCustomNativeApp(runDirectory, appsRoot, folder) {
  const app = inspectPackage(folder);
  check(!fs.existsSync(path.join(appsRoot, app.id)),
    'The selected native app id matches a bundled app');
  const stageDir = await fsp.mkdtemp(path.join(runDirectory, 'native-custom-apps-'));
  try {
    await copyNativePackage(folder, path.join(stageDir, app.id));
    return {appsDir: stageDir, stageDir, app};
  } catch (error) {
    await fsp.rm(stageDir, {recursive: true, force: true});
    throw error;
  }
}

function parseOptions(args) {
  check(args.length >= 1 && path.isAbsolute(args[0]),
    'Usage: gui-native-hblauncher.cjs RUN_DIRECTORY [--app hello-cpu] [--app-folder FOLDER] [--sd-rom-folder /sd/roms/nes] [--frames N] [--seconds N]');
  const config = {runDirectory: path.resolve(args[0]), appId: null, frames: 720, seconds: 0,
    appFolder: null, sdRomFolder: sdRoms.DEFAULT_SD_ROM_FOLDER};
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    check(value !== undefined, 'Missing value for ' + key);
    if (key === '--app') {
      check(value === 'hello-cpu', 'Only the bundled Hello CPU diagnostic can be launched directly');
      config.appId = value;
    } else if (key === '--app-folder') {
      check(path.isAbsolute(value) && value.length <= 4096 && !/[\x00\r\n]/.test(value),
        'Choose a valid built native app folder');
      config.appFolder = path.resolve(value);
    } else if (key === '--sd-rom-folder') {
      config.sdRomFolder = sdRoms.validSDRomFolder(value);
    } else if (key === '--frames' || key === '--seconds') {
      const number = Number(value);
      check(Number.isSafeInteger(number) && number >= (key === '--frames' ? 1 : 0) &&
        number <= (key === '--frames' ? 3600 : 86400), 'Invalid ' + key + ' value');
      config[key === '--frames' ? 'frames' : 'seconds'] = number;
    } else throw Error('Unknown native launcher option: ' + key);
  }
  check(!config.appId || !config.appFolder, 'Choose one native app launch mode');
  return config;
}

async function runInspector(script, directory, root, emit, state, options) {
  const file = path.join(root, 'vendor/MintBrew/homebrew-launcher', script);
  check(fs.existsSync(file), 'The bundled display inspector is missing: ' + script);
  emit('progress', {message: 'Inspecting native display: ' + script});
  const child = (options.spawn || spawn)(process.execPath, [file, directory],
    {cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env});
  state.child = child;
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', bytes => {output = (output + bytes.toString()).slice(-8192);});
  }
  let timer;
  const result = await new Promise((resolve, reject) => {
    timer = setTimeout(() => {child.kill('SIGTERM'); reject(Error('Native display inspection timed out'));},
      options.inspectTimeoutMs || 300000);
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal}));
  }).finally(() => {clearTimeout(timer); state.child = null;});
  check(!state.stopping && result.code === 0 && !result.signal,
    'Native display inspection failed: ' + script + ': ' + output.trim().slice(-512));
}

async function prepareDisplay(directory, root, session, emit, state, options) {
  const inspectionFile = path.join(directory, 'display-inspection.json');
  const moduleFile = path.join(directory, 'compatibility-module.json');
  let inspected = false;
  try {
    inspected = JSON.parse(await fsp.readFile(inspectionFile, 'utf8')).session === session;
  } catch {}
  if (!inspected) await runInspector('inspect-display.cjs', directory, root, emit, state, options);
  if (!fs.existsSync(moduleFile) || !inspected)
    await runInspector('inspect-compatibility.cjs', directory, root, emit, state, options);
  const moduleStat = fs.lstatSync(moduleFile);
  check(JSON.parse(await fsp.readFile(inspectionFile, 'utf8')).session === session &&
    moduleStat.isFile() && !moduleStat.isSymbolicLink() && moduleStat.size <= 16 * 1024 * 1024,
    'Native display inspection belongs to another session');
}

async function main(args, options = {}) {
  const config = parseOptions(args);
  const root = options.root || path.resolve(__dirname, '../..');
  const source = options.nativeRoot || nativeRoot;
  const emit = options.emit || ((type, fields = {}) =>
    process.stdout.write('MAC2JB_HOMEBREW ' + JSON.stringify({type, ...fields}) + '\n'));
  const state = {stopping: false, child: null};
  const signals = options.signals || process;
  let directory = config.runDirectory, run, runtime, target, marker;
  let markerCreated = false, mutated = false;
  const stagedDirs = [];
  let appsDir = path.join(source, 'apps');
  let refreshAssets = null;
  let failure, cleanupBlocked = false, running = false;
  let attemptProof;
  const stop = () => {
    state.stopping = true;
    if (runtime) runtime.stopRequested = true;
    if (state.child) state.child.kill('SIGTERM');
  };
  signals.on('SIGINT', stop);
  signals.on('SIGTERM', stop);
  try {
    run = await (options.validateRun || require('../../scripts/gui-homebrew.cjs').validateRun)(
      root, directory, options.verifySession || require('../../scripts/gui-dump.cjs').verifiedSession);
    directory = run.directory;
    const result = JSON.parse(await fsp.readFile(path.join(directory, 'result.json'), 'utf8'));
    const trusted = run.trustedSource ? {
      profile: {id: run.trustedSource.profileId},
      sourceDirectory: run.trustedSource.directory
    } : (options.trustedProfileForDigest ||
      require('../../scripts/host-profiles.cjs').trustedProfileForDigest)(root, result.sourceSha256);
    check(!run.trustedSource || result.sourceSha256 === run.trustedSource.sourceSha256,
      'The held run does not match its validated patched host source');
    check(['kurumuz', 'cellenseres', 'astral'].includes(trusted.profile.id),
      'Native HBLauncher requires a supported held RPC session');
    verifySource(source, trusted.sourceDirectory);
    if (config.appFolder) {
      const staged = await stageCustomNativeApp(directory, appsDir, config.appFolder);
      appsDir = staged.appsDir;
      stagedDirs.push(staged.stageDir);
      emit('progress', {path: directory,
        message: 'Added ' + staged.app.name + ' to the private native app library'});
    }
    check(!fs.existsSync(path.join(directory, '.mac2jb-hblauncher-attempt.json')),
      'Another homebrew launcher already owns this console session');
    const request = options.request || require(path.join(root, 'vendor/ns2jb/rpc.cjs')).request;
    check((await request(directory, {command: 'status'}))?.ready === true,
      'The held RPC bridge is no longer ready');
    emit('started', {path: directory, message: 'Preparing native HBLauncher'});
    if (!config.appId && !config.appFolder && fs.existsSync(path.join(appsDir, 'mintnes/manifest.json'))) {
      const bundle = path.join(appsDir, 'mintnes/assets');
      const bundledCount = fs.existsSync(bundle) ? fs.readdirSync(bundle)
        .filter(name => /\.nes$/i.test(name)).length : 0;
      let macRoms = [];
      try {
        const found = await (options.readMacRoms || sdRoms.readMacRoms)(
          options.macRomDirectory || sdRoms.macRomDirectory(),
          Math.max(0, sdRoms.MAX_ROMS - bundledCount));
        macRoms = found.roms;
        if (macRoms.length) emit('progress', {path: directory,
          message: 'Found ' + macRoms.length + ' compatible ROMs in the Mac MintNES folder'});
        if (found.skipped?.length) emit('progress', {path: directory,
          message: 'Skipped ' + found.skipped.length + ' unsupported or extra Mac ROMs'});
      } catch (error) {
        emit('progress', {path: directory,
          message: 'Mac MintNES ROM folder unavailable: ' + error.message + '; using bundled ROMs'});
      }
      let sdRomsFound = [];
      try {
        const found = await (options.readSDRoms || sdRoms.readSDRoms)(directory, {
          folder: config.sdRomFolder,
          limit: Math.max(0, sdRoms.MAX_ROMS - bundledCount - macRoms.length),
          shouldStop: () => state.stopping,
          progress: message => emit('progress', {path: directory, message})});
        if (found.missing) {
          emit('progress', {path: directory,
            message: 'SD ROM folder ' + config.sdRomFolder + ' was not found; continuing with available MintNES ROMs'});
        } else if (found.roms.length) {
          sdRomsFound = found.roms;
          emit('progress', {path: directory,
            message: 'Read ' + sdRomsFound.length + ' compatible SD ROMs for MintNES'});
        } else {
          emit('progress', {path: directory,
            message: 'No compatible SD ROMs found; continuing with available MintNES ROMs'});
        }
        if (found.skipped?.length) emit('progress', {path: directory,
          message: 'Skipped ' + found.skipped.length + ' unsupported or extra SD ROMs'});
      } catch (error) {
        if (error.cleanupBlocked) throw error;
        emit('progress', {path: directory,
          message: 'SD ROM import unavailable: ' + error.message + '; continuing with available MintNES ROMs'});
      }
      const bundled = require(path.join(source, 'host/lib/packages.cjs'))
        .loadPackage(path.join(source, 'apps/mintnes')).assets;
      refreshAssets = async () => {
        const current = await (options.readMacRoms || sdRoms.readMacRoms)(
          options.macRomDirectory || sdRoms.macRomDirectory(),
          Math.max(0, sdRoms.MAX_ROMS - bundled.length));
        const assets = [], seen = new Set();
        for (const asset of [...bundled, ...current.roms, ...sdRomsFound]) {
          const key = asset.name.normalize('NFC').toLowerCase();
          if (seen.has(key) || assets.length >= sdRoms.MAX_ROMS) continue;
          seen.add(key);
          assets.push({name: asset.name, bytes: asset.bytes});
        }
        return assets;
      };
      if (macRoms.length || sdRomsFound.length) {
        try {
          const staged = await (options.stageApps || sdRoms.stageApps)(directory, appsDir,
            [...macRoms, ...sdRomsFound]);
          appsDir = staged.appsDir;
          stagedDirs.push(staged.stageDir);
          emit('progress', {path: directory,
            message: 'Staged ' + staged.imported.length + ' additional ROMs for MintNES'});
        } catch (error) {
          emit('progress', {path: directory,
            message: 'MintNES ROM staging unavailable: ' + error.message + '; using bundled ROMs'});
        }
      }
    }
    await prepareDisplay(directory, root, run.proof.session, emit, state, options);
    check(!state.stopping, 'Native HBLauncher stopped before launch');
    marker = path.join(directory, '.mac2jb-hblauncher-attempt.json');
    await fsp.writeFile(marker, JSON.stringify({application: 'native-hblauncher',
      sourceCommit: '18b4748ba98eeac7df17beb5d3418985eb74897c',
      started: new Date().toISOString()}) + '\n', {mode: 0o600, flag: 'wx'});
    markerCreated = true;
    mutated = true;
    const upstream = require(path.join(source, 'host/lib/common.cjs'));
    const log = new upstream.Log({file: path.join(directory, 'native-hblauncher.log'), quiet: true});
    const line = log.line.bind(log);
    log.line = (level, message, extra) => {
      const entry = line(level, message, extra);
      if (level === 'stage' || level === 'warn' || level === 'error')
        emit('progress', {path: directory, message: String(message).slice(0, 512)});
      return entry;
    };
    const Target = options.LiveTarget || require(path.join(source, 'host/lib/target.cjs')).LiveTarget;
    const Runtime = options.Runtime || require(path.join(source, 'host/lib/runtime.cjs')).Runtime;
    target = await Target.open({runDir: directory, log});
    runtime = new Runtime({target, runDir: directory, log, appsDir, refreshAssets});
    await runtime.open();
    if (!state.stopping) {
      const onReady = () => {
        if (!running) {
          running = true;
          emit('running', {path: directory,
            message: 'Native HBLauncher is running. Keep SmileBASIC and mac2jb open'});
        }
      };
      if (config.appId) {
        const status = await runtime.launchOneApp({appId: config.appId, onReady});
        check(status === 0, 'Hello CPU exited with status ' + status);
      } else {
        await runtime.run({maxEntries: 1000000, maxFrames: config.frames,
          deadline: config.seconds ? Date.now() + config.seconds * 1000 : 0,
          shouldStop: () => state.stopping, onReady});
      }
    }
    check(!runtime.cleanupBlocked, 'Native HBLauncher could not verify cleanup');
  } catch (error) {
    failure = error;
    cleanupBlocked = mutated || error.cleanupBlocked === true;
  } finally {
    if (runtime || target) {
      try {
        if (runtime) {
          const preDisplayFailure = Boolean(failure && !running &&
            runtime.displayAttempted === false && !runtime.launcher?.resident);
          await runtime.stop({teardown: preDisplayFailure});
          if (preDisplayFailure && !failure.cleanupBlocked && !runtime.cleanupBlocked &&
              runtime.blocks.length === 0 && runtime.mappedImages.length === 0 &&
              target.unsafeSources.size === 0 && target.mapped.length === 0) {
            const request = options.request || require(path.join(root, 'vendor/ns2jb/rpc.cjs')).request;
            check((await request(directory, {command: 'status'}))?.ready === true,
              'The held RPC bridge did not confirm readiness after native rollback');
            mutated = false;
            cleanupBlocked = false;
          }
        } else await target.close();
      } catch (error) {
        failure ||= error;
        cleanupBlocked = true;
      }
      if (runtime?.cleanupBlocked || target?.unsafeSources?.size) cleanupBlocked = true;
    }
    if (cleanupBlocked && !markerCreated && directory) {
      marker = path.join(directory, '.mac2jb-hblauncher-attempt.json');
      try {await fsp.writeFile(marker, JSON.stringify({application: 'native-hblauncher',
        unsafe: true, started: new Date().toISOString()}) + '\n',
      {mode: 0o600, flag: 'wx'}); markerCreated = true;} catch {}
    }
    if (markerCreated && marker && !mutated && !cleanupBlocked && failure) {
      try {await fsp.unlink(marker);} catch {cleanupBlocked = true;}
    }
    if (!cleanupBlocked) for (const stageDir of stagedDirs.reverse()) {
      try {await fsp.rm(stageDir, {recursive: true, force: true});}
      catch (error) {emit('progress', {path: directory,
        message: 'Could not remove temporary native app copy: ' + error.message});}
    }
    if (!failure && !cleanupBlocked && running && markerCreated && marker) {
      try {
        const request = options.request || require(path.join(root, 'vendor/ns2jb/rpc.cjs')).request;
        check((await request(directory, {command: 'status'}))?.ready === true,
          'The held RPC bridge ended before native launcher shutdown was verified');
        const bytes = await fsp.readFile(marker);
        const value = JSON.parse(bytes);
        check(value.application === 'native-hblauncher' &&
          value.sourceCommit === '18b4748ba98eeac7df17beb5d3418985eb74897c',
        'The native launcher attempt marker changed');
        attemptProof = {cleanupVerified: true, attemptMarkerSha256: hash(bytes),
          attemptMarkers: ['.mac2jb-hblauncher-attempt.json']};
      } catch (error) {failure ||= error;}
    }
    signals.off('SIGINT', stop);
    signals.off('SIGTERM', stop);
  }
  if (failure) {
    emit('failed', {path: directory, cleanupBlocked, retrySafe: !mutated && !cleanupBlocked,
      message: failure.message + (cleanupBlocked ?
        ' Finish RPC and restart the console before another native launch' : '')});
    failure.homebrewReported = true;
    throw failure;
  }
  emit('stopped', {path: directory, cleanupBlocked: false, ...attemptProof,
    message: 'Native HBLauncher stopped. Its display resources remain in this console session'});
  return {directory, running, stopped: true};
}

module.exports = {main, parseOptions, verifySource, builtLauncher, prepareDisplay,
  copyNativePackage, preflightCustomNativeApp, stageCustomNativeApp};
