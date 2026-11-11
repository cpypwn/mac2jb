#!/usr/bin/env node
'use strict';
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');
const {spawn: spawnProcess} = require('node:child_process');
const {lines} = require('./gui-host.cjs');
const {validSavekitToolEvent, validLocalFTPURL} = require('./gui-session.cjs');

const applications = Object.freeze({
  'launch-mintbrew': ['mintbrew', 'scripts/gui-mintbrew.cjs'],
  'launch-native-hblauncher': ['native-hblauncher', 'scripts/gui-native-hblauncher.cjs'],
  'launch-custom-homebrew': ['custom-homebrew', 'scripts/gui-custom-homebrew.cjs'],
  'launch-ouncecake': ['ouncecake', 'scripts/gui-ouncecake.cjs']
});
const artemisGames = new Set(['seedsow', 'nora', 'nora1', 'hamidashi']);
function availableHomebrew(root, application) {
  const marker = path.join(root, 'packaging/runtime-homebrew.json');
  if (!fs.existsSync(marker)) return true;
  try {
    const allowed = JSON.parse(fs.readFileSync(marker, 'utf8')).allowed;
    return Array.isArray(allowed) && allowed.includes(application);
  } catch { return false; }
}
function launchConfiguration(command) {
  const selected = applications[command.action];
  if (!selected) throw Error('Choose a supported homebrew app.');
  const [application, script] = selected;
  if (application === 'ouncecake') {
    if (!net.isIPv4(command.consoleAddress)) throw Error('Enter the Switch’s IPv4 address for OunceCake WebDAV.');
    if (command.mode !== undefined && !['webdav','ftp'].includes(command.mode))
      throw Error('Choose OunceCake WebDAV or FTP.');
    return {application, script, config: {consoleAddress: command.consoleAddress, port: 2121,
      ...(command.mode === 'ftp' ? {mode:'ftp'} : {})}};
  }
  if (application === 'mintbrew') {
    if (command.addonUrls !== undefined && (!Array.isArray(command.addonUrls) || command.addonUrls.length > 32 ||
        command.addonUrls.some(url => typeof url !== 'string' || url.length > 4096)) ||
        command.libraryItems !== undefined && (!Array.isArray(command.libraryItems) || command.libraryItems.length > 500 ||
        command.libraryItems.some(item => !item || typeof item !== 'object' || Array.isArray(item))))
      throw Error('The add-on configuration is invalid.');
    if (command.quality !== undefined && !['720p', '540p', '360p', '180p'].includes(command.quality))
      throw Error('Choose a supported Stremio quality.');
    return {application, script, quality: command.quality ?? '720p',
      config: {addonUrls: command.addonUrls || [], libraryItems: command.libraryItems || [],
        ...(application === 'mintbrew' ? {quality:command.quality ?? '720p'} : {})}};
  }
  if (application === 'native-hblauncher') {
    const sdRomFolder = require('../integrations/mintbrew-native/sd-roms.cjs')
      .validSDRomFolder(command.sdRomFolder);
    return {application, script, config: {sdRomFolder}};
  }
  if (application === 'custom-homebrew') {
    if (typeof command.customHomebrewPath !== 'string' || !path.isAbsolute(command.customHomebrewPath) ||
        command.customHomebrewPath.length > 4096 || /[\x00\r\n]/.test(command.customHomebrewPath))
      throw Error('Choose a valid local custom homebrew folder.');
    return {application, script, config: {customHomebrewPath:command.customHomebrewPath,
      consoleAddress:command.consoleAddress}};
  }
  return {application, script, config: {}};
}
function validCatalog(games) {
  return Array.isArray(games) && games.length > 0 && games.length <= 1000 &&
    games.every(game => game && /^[a-f0-9]{16}$/.test(game.titleId) && typeof game.name === 'string' &&
      Buffer.byteLength(game.name) <= 160 && !/[\x00-\x1f\x7f]/.test(game.name) && Array.isArray(game.storages) &&
      game.storages.length >= 1 && game.storages.length <= 3 && new Set(game.storages).size === game.storages.length &&
      game.storages.every(value => [2, 4, 5].includes(value))) && new Set(games.map(game => game.titleId)).size === games.length;
}
function signalOwned(child, signal, group = false) {
  if (!child) return;
  try {
    if (group && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {if (error.code !== 'ESRCH') throw error;}
}
function createDumpDirectory(root) {
  const dumps = path.join(root, 'dumps');
  fs.mkdirSync(dumps, {recursive:true, mode:0o700});
  const info = fs.lstatSync(dumps);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid())
    throw Error('The system-code dump folder is not private to this app session.');
  fs.chmodSync(dumps, 0o700);
  const destination = fs.mkdtempSync(path.join(fs.realpathSync(dumps), 'attached-'));
  fs.chmodSync(destination, 0o700);
  return destination;
}

async function main(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const input = options.input || process.stdin, output = options.output || process.stdout;
  const signals = options.signals || process;
  const emit = options.emit || ((type, fields) => output.write(JSON.stringify({type, ...fields}) + '\n'));
  const prepare = options.prepare || require('./rpc-attachment.cjs').prepare;
  const homebrewModule=require('./gui-homebrew.cjs');
  const preflightCustomApp = options.preflightCustomApp ||
    homebrewModule.preflightCustomHomebrew || homebrewModule.preflightCustomApp;
  const validateModloaderFolder = options.validateModloaderFolder ||
    require('./gui-modloader.cjs').validateModsFolder;
  const spawn = options.spawn || spawnProcess, signal = options.signal || signalOwned;
  const releaseMarkers = options.releaseMarkers || require('./homebrew-reentry.cjs').releaseMarkers;
  const makeDumpDirectory = options.createDumpDirectory || createDumpDirectory;
  const graceMs = options.graceMs ?? 300000, pollMs = options.pollMs ?? 2000;
  const preparationAbort = new AbortController();
  let context, attachmentTask, verificationTask, homebrewTask, preflightTask, finishTask, child, dumpTask, dumpChild;
  let modloaderTask, modloaderChild;
  let attachmentAttempted = false, ready = false, launchAttempted = false, statusBusy = false, claiming = false, preflightBusy = false;
  let finishing = false, closed = false, outputClosed = false, sourceLost = false, failure;
  let dumpBusy = false, dumpStarted = false, dumpClaimed = false, dumpStopTimer;
  let application, config, settled = false, running = false, cleanupBlocked = false, stopRequested = false;
  let awaitingGame = false, gameTitles = new Set(), monitor, stopTimer;
  let savekitSelected = false, savekitClaimed = false, savekitBusy = false;
  let modloaderBusy = false, modloaderStarted = false, modloaderReady = false;
  let savekitTask, savekitChild, savekitStage, savekitUsers = new Set();
  let toolBusy = false, toolTask, toolChild;
  let resolveDone;
  const done = new Promise(resolve => {resolveDone = resolve;});
  function safeEmit(type, fields = {}) {
    if (outputClosed) return;
    try {emit(type, fields);} catch (error) {
      outputClosed = true;
      if (error.code !== 'EPIPE') failure ||= 'The app event connection failed.';
      void finish('The app connection closed.');
    }
  }
  function fail(message, uncertain = false) {
    failure ||= message;
    if (uncertain && !cleanupBlocked) {
      cleanupBlocked = true;
      safeEmit('cleanup-blocked', {path: context?.directory, resourcesRetained: true,
        message: message + ' The original host and native resources were retained; restart the console before another app attempt.'});
    }
  }
  function stopHomebrew(force = false) {
    if (!child) return;
    if (force || cleanupBlocked || sourceLost) {signal(child, 'SIGKILL', true); return;}
    if (!settled && !stopRequested) {stopRequested = true; signal(child, 'SIGTERM', false);}
    stopTimer ||= setTimeout(() => {
      fail('The selected app did not confirm shutdown.', true);
      signal(child, 'SIGKILL', true);
    }, graceMs);
    stopTimer.unref?.();
  }
  function stopDump() {
    if (!dumpChild) return;
    fail('The system-code dump was interrupted. Keep its partial files and restart the console.', true);
    signal(dumpChild, 'SIGTERM', false);
    dumpStopTimer ||= setTimeout(() => signal(dumpChild, 'SIGKILL', true), 2000);
    dumpStopTimer.unref?.();
  }
  function finish(reason = 'Detaching from the held session.') {
    if (finishing) return finishTask || done;
    const releaseIdleSaveKit = savekitClaimed && !savekitBusy && !toolBusy &&
      !savekitChild && !toolChild;
    finishing = true; ready = false; clearInterval(monitor);
    preparationAbort.abort();
    if (!child && !dumpChild && !modloaderChild && !releaseIdleSaveKit) context?.abortVerification?.();
    finishTask = (async () => {
      safeEmit('rpc-finishing', {message: reason + ' Stopping this app’s helpers; the original host remains open.'});
      await attachmentTask?.catch(() => {});
      await preflightTask?.catch(() => {});
      stopHomebrew();
      stopDump();
      if (savekitChild) signal(savekitChild, 'SIGTERM', false);
      if (toolChild) signal(toolChild, 'SIGTERM', false);
      await homebrewTask?.catch(() => {});
      await dumpTask?.catch(() => {});
      await modloaderTask?.catch(() => {});
      await savekitTask?.catch(() => {});
      await toolTask?.catch(() => {});
      if (releaseIdleSaveKit && !sourceLost && !cleanupBlocked && !failure) {
        try {await releaseSaveKit();}
        catch (error) {fail('Could not release the idle SaveKit claim: ' + error.message, true);}
      }
      if (dumpClaimed && !dumpStarted && !sourceLost && !cleanupBlocked) {
        try {await context.releaseApplication(); dumpClaimed = false;}
        catch (error) {fail('Could not release the unused dump claim: ' + error.message, true);}
      }
      context?.abortVerification?.();
      await verificationTask?.catch(() => {});
      if (context) {
        try {await context.close();} catch (error) {fail('Could not close the attachment authorization: ' + error.message);}
      }
      closed = true;
      if (failure) safeEmit('failed', {path: context?.directory, cleanupBlocked, resourcesRetained: true, message: failure});
      safeEmit('rpc-detached', {path: context?.directory, sourceSession: context?.sourceSession,
        cleanupBlocked, resourcesRetained: true,
        message: cleanupBlocked ? 'Detached. The original host and uncertain native resources remain held. Restart the console.' :
          'Detached. The original RPC host and its held resources remain open.'});
      resolveDone(failure ? 1 : 0);
    })().catch(error => {
      fail('Attachment shutdown failed: ' + error.message, Boolean(child));
      if (child) {try {signal(child, 'SIGKILL', true);} catch {}}
      safeEmit('failed', {cleanupBlocked, resourcesRetained: true, message: failure});
      closed = true; resolveDone(1);
    });
    return finishTask;
  }
  async function verify() {
    if (!context) throw Error('No verified attachment is available.');
    if (verificationTask) return verificationTask;
    verificationTask = Promise.resolve().then(() => context.verify()).then(status => {
      if (status?.ready === false) throw Error('The original RPC session is no longer ready.');
      return status;
    });
    try {return await verificationTask;} finally {verificationTask = undefined;}
  }
  function lost(error) {
    if (sourceLost || closed || finishing) return;
    sourceLost = true;
    fail('The original RPC session was lost: ' + error.message, Boolean(child || modloaderStarted));
    stopHomebrew(true);
    if (modloaderChild) signal(modloaderChild, 'SIGTERM', true);
    void finish('The source connection ended.');
  }
  function monitorSource() {
    if (finishing || closed || !ready || verificationTask || claiming || preflightBusy || dumpBusy ||
        savekitBusy || toolBusy || savekitClaimed || modloaderBusy || modloaderReady) return;
    void verify().catch(lost);
  }
  function protocolFailure(message) {
    fail(message);
    stopHomebrew();
  }
  async function homebrew(selection) {
    ({application, config} = selection);
    const ouncecakeMode = application === 'ouncecake' ||
      application === 'custom-homebrew' && config.customHomebrewKind === 'rpc-app' && config.adapter === 'ouncecake';
    let retrySafeFailure, cleanStopProof;
    claiming = true;
    try {
      try {await verify();} catch (error) {lost(error); return;}
      if (finishing) return;
      // claim in the original run before any helper can issue a native request.
      // do not poll while this operation installs its ownership marker.
      await context.claimApplication(application);
    } finally {claiming = false;}
    if (finishing) {
      try {await context.releaseApplication();}
      catch (error) {fail('Could not release the unused application claim: ' + error.message, true);}
      return;
    }
  const configurable = application === 'mintbrew' || application === 'ouncecake' ||
      application === 'custom-homebrew' && config.customHomebrewKind === 'rpc-app';
    child = spawn(process.execPath, [path.join(root, selection.script), context.directory,
      ...(application === 'native-hblauncher' ? ['--sd-rom-folder', config.sdRomFolder] : []),
      ...(application === 'native-hblauncher' && config.nativeAppFolder ?
        ['--app-folder', config.nativeAppFolder] : []),
      ...(application === 'custom-homebrew' ? [
        config.customHomebrewKind==='launcher'?'--launcher-folder':
          config.customHomebrewKind==='rpc-app'?'--rpc-folder':'--app-folder', config.customHomebrewPath] : [])], {
      cwd: root, detached: true, stdio: [configurable ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {...process.env, MAC2JB_ATTACHED_RUN_MANIFEST: context.manifestPath}
    });
    const owned = child;
    const outcomeTask = new Promise(resolve => {
      owned.once('error', error => resolve({error}));
      owned.once('close', (code, exitSignal) => resolve({code, signal: exitSignal}));
    });
    const observe = line => {
      if (!line.startsWith('MAC2JB_HOMEBREW ')) {safeEmit('log', {message: line}); return;}
      let event;
      try {event = JSON.parse(line.slice('MAC2JB_HOMEBREW '.length));}
      catch {protocolFailure('The selected app returned an invalid event.'); return;}
      if (!event || typeof event !== 'object' || Array.isArray(event)) {protocolFailure('The selected app returned an invalid event.'); return;}
      if (sourceLost || closed) return;
      if (event.type === 'account-progress') {
        if (application === 'mintbrew' && event.watchProgress && typeof event.watchProgress === 'object' && !Array.isArray(event.watchProgress))
          safeEmit('account-progress', {watchProgress: event.watchProgress});
        return;
      }
      if (event.type === 'catalog') {
        if (!ouncecakeMode || gameTitles.size || awaitingGame || running || settled || finishing || !validCatalog(event.games)) {
          protocolFailure('OunceCake returned an invalid game list.'); return;
        }
        gameTitles = new Set(event.games.map(game => game.titleId)); awaitingGame = true;
        safeEmit('homebrew-catalog', {games: event.games, path: context.directory, message: event.message}); return;
      }
      if (!['started', 'progress', 'running', 'stopped', 'failed'].includes(event.type)) return;
      if (settled) {protocolFailure('The selected app sent activity after shutdown.'); return;}
      if (ouncecakeMode && event.type === 'running' &&
          (awaitingGame || gameTitles.size === 0 || event.host !== config.consoleAddress || event.port !== 2121 ||
           event.httpURL !== `http://${config.consoleAddress}:2121/` ||
           config.mode === 'ftp' && !validLocalFTPURL(event.ftpURL))) {
        protocolFailure('OunceCake did not confirm the selected file-service endpoint.'); return;
      }
      if (event.cleanupBlocked === true) fail('The selected app could not confirm native shutdown.', true);
      const wasRunning = running;
      if (event.type === 'running') running = true;
      if (event.type === 'stopped' || event.type === 'failed') {
        running = false; settled = true;
        if (event.type === 'stopped') cleanStopProof = event;
      }
      if (event.type === 'failed') {
        if (event.retrySafe === true && !wasRunning && !cleanupBlocked && !finishing && !failure)
          retrySafeFailure = event;
        else fail(event.message || 'The selected homebrew app failed.');
      }
      if (retrySafeFailure) return;
      safeEmit('homebrew-' + event.type, {path: context.directory, message: event.message,
        ...(['mintbrew','native-hblauncher'].includes(application) ? {cleanupBlocked} : {}),
        ...(ouncecakeMode ? {host: event.host, port: event.port, httpURL: event.httpURL,
          ...(event.ftpURL && validLocalFTPURL(event.ftpURL) ? {ftpURL:event.ftpURL} : {}),cleanupBlocked} : {})});
    };
    lines(owned.stdout, observe, 1024 * 1024); lines(owned.stderr, observe);
    if (configurable) {
      owned.stdin.on('error', () => protocolFailure('Could not configure the selected app.'));
      try {
        owned.stdin.write(JSON.stringify(config) + '\n');
        if (application === 'mintbrew') owned.stdin.end();
      } catch {protocolFailure('Could not configure the selected app.');}
    }
    const outcome = await outcomeTask;
    clearTimeout(stopTimer); stopTimer = undefined;
    child = undefined; running = false; awaitingGame = false;
    if (retrySafeFailure && !outcome.error && outcome.code === 1 && !outcome.signal && settled &&
        !cleanupBlocked && !sourceLost && !finishing && !closed && !failure) {
      claiming = true;
      try {
        await verificationTask?.catch(() => {});
        if (sourceLost || finishing) throw Error('The held RPC session changed during cleanup.');
        await context.releaseApplication();
        launchAttempted = false; application = undefined; config = undefined; settled = false;
        safeEmit('homebrew-failed', {path: context.directory, retrySafe: true,
          message: retrySafeFailure.message || 'Preparation failed before transfer. RPC remains open; choose another app.'});
        return;
      } catch (error) {fail('Could not restore the held session after preparation failed: ' + error.message, true);}
      finally {claiming = false;}
    }
    if (!outcome.error && outcome.code === 0 && !outcome.signal && settled &&
        !cleanupBlocked && !sourceLost && !finishing && !closed && !failure) {
      claiming = true;
      try {
        await verificationTask?.catch(() => {});
        if (sourceLost || finishing) throw Error('The held RPC session changed during shutdown.');
        const status = await verify();
        if (status?.ready !== true) throw Error('The held RPC session is no longer ready.');
        releaseMarkers(context.directory, cleanStopProof, ouncecakeMode);
        await context.releaseApplication();
        launchAttempted = false; application = undefined; config = undefined; settled = false;
        stopRequested = false; gameTitles = new Set();
        safeEmit('homebrew-ready', {path: context.directory,
          message: 'Homebrew stopped. RPC is ready for another app.'});
        return;
      } catch (error) {fail('Could not prepare the held session for another app: ' + error.message, true);}
      finally {claiming = false;}
    }
    if (failure || outcome.error || outcome.code !== 0 || outcome.signal || !settled) {
      fail('The selected app failed or did not confirm shutdown. This launch was not retried.', !settled || Boolean(outcome.signal));
      safeEmit('homebrew-failed', {path: context.directory, cleanupBlocked, message: failure});
    }
  }
  async function installModloader(modsFolder) {
    let started = false, readyEvent, failedEvent;
    claiming = true;
    try {
      await verify();
      if (finishing) return;
      await context.claimApplication('modloader');
    } finally {claiming = false;}
    if (finishing) {
      try {await context.releaseApplication();}
      catch (error) {fail('Could not release the unused modloader claim: ' + error.message, true);}
      return;
    }
    modloaderChild = spawn(process.execPath,
      [path.join(root, 'scripts/gui-modloader.cjs'), context.directory, modsFolder], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, MAC2JB_ATTACHED_RUN_MANIFEST: context.manifestPath}
      });
    const owned = modloaderChild;
    const outcomeTask = new Promise(resolve => {
      owned.once('error', error => resolve({error}));
      owned.once('close', (code, exitSignal) => resolve({code, signal: exitSignal}));
    });
    const observe = line => {
      if (!line.startsWith('MAC2JB_MODLOADER ')) {safeEmit('log', {message:line}); return;}
      let event;
      try {event = JSON.parse(line.slice('MAC2JB_MODLOADER '.length));}
      catch {fail('Modloader returned an invalid event.', true); return;}
      if (!event || typeof event.message !== 'string' || Buffer.byteLength(event.message) > 512 ||
          /[\x00-\x1f\x7f]/.test(event.message)) {
        fail('Modloader returned an invalid event.', true); return;
      }
      if (event.type === 'started' && !started) {
        started = true; modloaderStarted = true; launchAttempted = true;
        safeEmit('modloader-started', {path:context.directory, message:event.message});
      } else if (event.type === 'progress' && started && !readyEvent) {
        safeEmit('modloader-progress', {path:context.directory, message:event.message});
      } else if (event.type === 'ready' && started && !readyEvent &&
                 typeof event.path === 'string' && path.dirname(event.path) === context.directory) {
        readyEvent = event;
      } else if (event.type === 'failed' && !failedEvent) {
        failedEvent = event;
      }
    };
    lines(owned.stdout, observe); lines(owned.stderr, observe);
    const outcome = await outcomeTask;
    modloaderChild = undefined;
    if (sourceLost || finishing || closed) return;
    if (failedEvent?.retrySafe === true && !started && !failure &&
        !outcome.error && outcome.code === 1 && !outcome.signal) {
      claiming = true;
      try {
        await context.releaseApplication();
        safeEmit('modloader-failed', {path:context.directory, retrySafe:true,
          message:failedEvent.message});
        return;
      } catch (error) {
        fail('Could not release the modloader claim after preflight failed: ' + error.message, true);
      } finally {claiming = false;}
    }
    if (readyEvent && !failure && !outcome.error && outcome.code === 0 && !outcome.signal) {
      modloaderReady = true;
      safeEmit('modloader-ready', {path:context.directory, message:readyEvent.message});
      return;
    }
    fail(failedEvent?.message || 'Modloader ended without confirming the game handoff. Restart the Switch before trying again.',
      started || Boolean(outcome.signal) || Boolean(outcome.error));
    safeEmit('modloader-failed', {path:context.directory, retrySafe:false,
      cleanupBlocked, message:failure});
  }
  async function dumpSystemCode() {
    if (child) {
      safeEmit('dump-progress', {message:'Stopping the current app before reading system code.'});
      stopHomebrew();
      await homebrewTask;
      if (finishing || closed) return;
      if (child || launchAttempted && !settled || cleanupBlocked || failure)
        throw Error('The current app did not confirm safe shutdown. The system-code dump was not started.');
    }
    if (finishing || closed) return;
    if (launchAttempted) await verify();
    else {
      claiming = true;
      try {await context.claimApplication('system-code-dump'); dumpClaimed = true;}
      finally {claiming = false;}
    }
    if (finishing || closed) return;
    const destination = makeDumpDirectory(root);
    dumpChild = spawn(process.execPath, [path.join(root, 'scripts/gui-dump.cjs'), context.directory, destination], {
      cwd:root, detached:true, stdio:['ignore','pipe','pipe'],
      env:{...process.env, NS2_FIRMWARE_DUMP_DIR:destination}
    });
    dumpStarted = true;
    const helper = dumpChild;
    const outcomeTask = new Promise(resolve => {
      helper.once('error', error => resolve({error}));
      helper.once('close', (code, exitSignal) => resolve({code, signal:exitSignal}));
    });
    const observe = line => {
      if (line.trim().startsWith('Firmware:')) safeEmit('dump-progress', {message:line.trim()});
      else safeEmit('log', {message:line});
    };
    lines(helper.stdout, observe); lines(helper.stderr, observe);
    safeEmit('dump-started', {path:destination, message:'Dumping installed system code through the held RPC session.'});
    const outcome = await outcomeTask;
    clearTimeout(dumpStopTimer); dumpStopTimer = undefined; dumpChild = undefined;
    if (finishing || closed) return;
    if (outcome.error || outcome.code !== 0 || outcome.signal)
      throw Error('The firmware dump failed. Partial files were retained; do not retry this session.');
    const file = path.join(destination, 'firmware-dump.json'), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
      throw Error('The firmware dump did not produce an owned inventory.');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.complete !== true || !Array.isArray(manifest.entries) ||
        !Number.isSafeInteger(manifest.inventory?.total) || manifest.inventory.total < 0 ||
        manifest.entries.length !== manifest.inventory.total)
      throw Error('The firmware dump did not produce a complete inventory.');
    if (dumpClaimed) {await context.releaseApplication(); dumpClaimed = false;}
    safeEmit('dump-complete', {path:destination, message:'Firmware dump completed and its inventory verified.'});
  }
  async function claimSaveKit() {
    if (savekitClaimed) return;
    claiming = true;
    try {
      await context.claimApplication('savekit');
      savekitClaimed = true;
    } finally {claiming = false;}
  }
  async function releaseSaveKit() {
    if (!savekitClaimed) return;
    claiming = true;
    try {
      await context.releaseApplication();
      savekitClaimed = false;
    } finally {claiming = false;}
  }
  async function installSave(command) {
    savekitBusy = true; savekitStage = 'checking'; savekitUsers = new Set();
    const game = command.action === 'install-artemis-save' ? command.game :
      command.action === 'install-balatro-save' ? 'balatro' :
      command.action === 'install-gravcirc-save' ? 'gravcirc' : undefined;
    let completed = false, skipped = false, backupPath, reportedFailure;
    try {
      await claimSaveKit();
      const args = [path.join(root, 'scripts/gui-savekit.cjs'), context.directory,
        ...(command.action === 'install-balatro-save' ? ['--balatro', command.variant] :
          command.action === 'install-gravcirc-save' ? ['--gravcirc'] :
          command.action === 'install-artemis-save' ? ['--artemis', game,
            ...(game === 'seedsow' && command.variant === 'full' ? ['full'] : [])] :
          command.variant === 'pro' ? ['--editor-pro'] : command.sourcePath ? [command.sourcePath] : [])];
      savekitChild = spawn(process.execPath, args, {cwd:root, detached:true,
        stdio:['pipe','pipe','pipe'], env:{...process.env, MAC2JB_ATTACHED_RUN_MANIFEST:context.manifestPath}});
      const helper = savekitChild;
      const outcomeTask = new Promise(resolve => {
        helper.once('error', error => resolve({error}));
        helper.once('close', (code, signal) => resolve({code, signal}));
      });
      helper.stdin.on('error', error => {
        if (error.code !== 'EPIPE') reportedFailure = 'Could not select the console account.';
      });
      const observe = line => {
        if (!line.startsWith('MAC2JB_SAVEKIT ')) {safeEmit('log', {message:line}); return;}
        let event;
        try {event = JSON.parse(line.slice('MAC2JB_SAVEKIT '.length));} catch {}
        if (!event || !['progress','choose-user','backup','complete','skipped','failed'].includes(event.type) ||
            typeof event.message !== 'string' || Buffer.byteLength(event.message) > 512 ||
            /[\x00-\x1f\x7f]/.test(event.message) || game && event.game !== game) {
          reportedFailure = 'The save worker returned invalid progress.';
          signal(helper, 'SIGTERM', false); return;
        }
        if (event.type === 'progress') {
          savekitStage = event.stage;
          safeEmit('savekit-progress', {game, stage:event.stage, message:event.message});
        } else if (event.type === 'choose-user') {
          if (!Array.isArray(event.users) || event.users.length < 2 || event.users.length > 8 ||
              event.users.some(uid => typeof uid !== 'string' || !/^[a-f0-9]{32}$/.test(uid)) ||
              new Set(event.users).size !== event.users.length) {
            reportedFailure = 'The save worker returned an invalid account list.';
            signal(helper, 'SIGTERM', false); return;
          }
          savekitUsers = new Set(event.users);
          savekitStage = 'choose-user';
          safeEmit('savekit-choose-user', {game, users:event.users, message:event.message});
        } else if (['backup','complete','skipped'].includes(event.type)) {
          const backupRoot = path.join(root, game === 'balatro' ? 'balatro-backups' :
            game === 'gravcirc' ? 'gravcirc-backups' : game ? 'artemis-backups' : 'seedsow-backups');
          if (typeof event.backupPath !== 'string' ||
              !path.resolve(event.backupPath).startsWith(backupRoot+path.sep) ||
              game && !path.basename(event.backupPath).startsWith(game+'-')) {
            reportedFailure = 'The save worker reported an invalid backup path.';
            signal(helper, 'SIGTERM', false); return;
          }
          backupPath = event.backupPath;
          if (event.type !== 'backup') {
            if (!Number.isSafeInteger(event.files) || event.files < 1 || event.files >
                (event.type === 'skipped' ? 2048 : 500)) {
              reportedFailure = 'The save worker reported an invalid file count.';
              signal(helper, 'SIGTERM', false); return;
            }
            completed = true; skipped = event.type === 'skipped';
            helper.stdin.end();
          }
          safeEmit('savekit-'+event.type, {game, backupPath, files:event.files, message:event.message});
        } else {
          reportedFailure = event.message;
          if (event.reason === 'save-absent' || event.reason === 'save-preflight' ||
              event.reason === 'save-unchanged') reportedFailure = {recoverable:event.message};
          else safeEmit('savekit-failed', {game, backupPath:event.backupPath, message:event.message});
        }
      };
      lines(helper.stdout, observe, 1024*1024);
      lines(helper.stderr, observe, 1024*1024);
      const outcome = await outcomeTask;
      savekitChild = undefined;
      if (finishing || closed) return;
      if (!outcome.error && outcome.code === 0 && !outcome.signal && completed && !reportedFailure) {
        await releaseSaveKit();
        safeEmit('savekit-ready', {game, message:skipped ?
          'Existing save preserved. Choose another option in this held session.' :
          'Save installed and verified. Choose another option in this held session.'});
        return;
      }
      if (!outcome.error && !outcome.signal && outcome.code === 1 &&
          reportedFailure?.recoverable && ['checking','backup','writing'].includes(savekitStage)) {
        try {
          await releaseSaveKit();
          safeEmit('savekit-recoverable', {game, backupPath, message:reportedFailure.recoverable});
          return;
        } catch {}
      }
      fail(typeof reportedFailure === 'string' ? reportedFailure :
        'Save installation did not finish. Keep its backup and restart the console.', true);
      safeEmit('savekit-failed', {game, backupPath, message:failure});
    } catch (error) {
      fail('Save installation failed: '+error.message, Boolean(savekitChild));
      safeEmit('savekit-failed', {game, backupPath, message:failure});
    } finally {
      savekitBusy = false; savekitStage = undefined; savekitUsers.clear(); savekitChild = undefined;
    }
  }
  async function runSaveKitTool(value, rawRequest) {
    toolBusy = true;
    let completed, failureEvent, invalid = false;
    try {
      toolChild = spawn(process.execPath,
        [path.join(root, 'scripts/gui-savekit-tools.cjs'), context.directory],
        {cwd:root, detached:true, stdio:['pipe','pipe','pipe'],
          env:{...process.env, MAC2JB_ATTACHED_RUN_MANIFEST:context.manifestPath}});
      const helper = toolChild;
      const outcomeTask = new Promise(resolve => {
        helper.once('error', error => resolve({error}));
        helper.once('close', (code, signal) => resolve({code, signal}));
      });
      helper.stdin.on('error', error => {if (error.code !== 'EPIPE') invalid = true;});
      helper.stdin.end(JSON.stringify(rawRequest)+'\n');
      const observe = line => {
        if (!line.startsWith('MAC2JB_SAVEKIT ')) {safeEmit('log', {message:line}); return;}
        let event;
        try {event = JSON.parse(line.slice('MAC2JB_SAVEKIT '.length));} catch {}
        if (!validSavekitToolEvent(event, value.action, root)) {
          invalid = true; signal(helper, 'SIGTERM', false); return;
        }
        if (event.type === 'complete') {completed = event; return;}
        if (event.type === 'failed') {failureEvent = event; return;}
        const {type, ...fields} = event;
        safeEmit('savekit-tool-'+type, fields);
      };
      lines(helper.stdout, observe, 1024*1024);
      lines(helper.stderr, line => safeEmit('log', {message:line}), 1024*1024);
      const outcome = await outcomeTask;
      toolChild = undefined;
      if (finishing || closed) return;
      if (!outcome.error && outcome.code === 0 && !outcome.signal && completed && !invalid) {
        const {type, ...fields} = completed;
        safeEmit('savekit-tool-complete', fields);
        return;
      }
      let safeToContinue = !invalid && !outcome.error && !outcome.signal && outcome.code === 1 &&
        failureEvent?.safeToContinue === true;
      if (safeToContinue) {
        try {safeToContinue = (await verify())?.ready === true;} catch {safeToContinue = false;}
      }
      const message = invalid ? 'The save data worker returned invalid progress.' :
        failureEvent?.message || 'The save data operation did not finish. Keep any backup.';
      const {type:discardedType, ...failureFields} = failureEvent || {};
      safeEmit('savekit-tool-failed', {action:value.action, ...failureFields,
        safeToContinue, message});
      if (!safeToContinue && (['write','restore','delete','titles'].includes(value.action) || failureEvent?.unsafe))
        fail(message+' Restart the console before another save operation.', true);
    } catch (error) {
      fail('The save data operation failed: '+error.message, Boolean(toolChild));
      safeEmit('savekit-tool-failed', {action:value.action, message:failure});
    } finally {toolBusy = false; toolChild = undefined;}
  }
  async function control(line) {
    let command;
    try {command = JSON.parse(line);} catch {safeEmit('action-rejected', {message: 'Invalid attachment action.'}); return;}
    if (!command || typeof command !== 'object' || Array.isArray(command)) {safeEmit('action-rejected', {message: 'Invalid attachment action.'}); return;}
    if (closed || finishing) {safeEmit('action-rejected', {message: 'The attachment is closing.'}); return;}
    if (command.action === 'finish') {
      if (modloaderBusy) {
        safeEmit('action-rejected', {action:command.action,
          message:'Wait for the modloader installation to finish before disconnecting.'});
        return;
      }
      void finish(); return;
    }
    if (command.action === 'attach') {
      if (attachmentAttempted) {safeEmit('action-rejected', {message: 'Attach only once in this session.'}); return;}
      if (!command.connection || command.connection.kind !== 'local') {
        safeEmit('action-rejected', {message: 'Choose an existing RPC run folder on this Mac.'}); return;
      }
      attachmentAttempted = true;
      attachmentTask = (async () => {
        context = await prepare(root, command.connection, {signal: preparationAbort.signal});
        if (finishing) return;
        await verify();
        if (finishing) return;
        ready = true;
        safeEmit('rpc-attached', {path: context.directory, sourceSession: context.sourceSession,
          profileId: context.profileId,
          message: context.description || 'Attached to the existing held RPC session.'});
        if (pollMs > 0) {monitor = setInterval(monitorSource, pollMs); monitor.unref?.();}
      })().catch(error => {if (!finishing) {fail('Could not attach: ' + error.message); void finish('Attachment verification failed.');}});
      return;
    }
    if (!ready) {safeEmit('action-rejected', {message: 'Attach to a verified open RPC session first.'}); return;}
    if (modloaderBusy || modloaderStarted || modloaderReady) {
      safeEmit('action-rejected', {action:command.action,
        message:'Modloader is the final action for this boot. Finish this session before launching the game.'});
      return;
    }
    if (command.action === 'start-savekit') {
      if (!['civswitch-fs','artemis-seedsow'].includes(context.profileId) || savekitSelected || savekitBusy || toolBusy ||
          launchAttempted || child || dumpBusy || dumpTask || preflightBusy || claiming || cleanupBlocked || failure) {
        safeEmit('action-rejected', {action:command.action,
          message:'SaveKit needs a free, verified filesystem session.'}); return;
      }
      savekitBusy = true;
      try {
        await claimSaveKit();
        savekitSelected = true;
        safeEmit('savekit-selected', {message:'SaveKit is ready in this held RPC session'});
      } catch (error) {
        safeEmit('action-rejected', {action:command.action, message:'Could not start SaveKit: '+error.message});
      } finally {savekitBusy = false;}
      return;
    }
    if (command.action === 'finish-savekit') {
      if (!savekitSelected || savekitBusy || toolBusy || savekitChild || toolChild || cleanupBlocked || failure) {
        safeEmit('action-rejected', {action:command.action,
          message:'Wait for SaveKit to finish before returning to homebrew.'}); return;
      }
      savekitBusy = true;
      try {
        await releaseSaveKit();
        savekitSelected = false;
        safeEmit('savekit-done', {message:'SaveKit finished. Choose another option in this held session.'});
      } catch (error) {
        fail('Could not leave SaveKit safely: '+error.message, true);
        safeEmit('savekit-tool-failed', {message:failure});
      } finally {savekitBusy = false;}
      return;
    }
    if (command.action === 'select-seedsow-user') {
      if (!savekitChild?.stdin?.writable || !savekitUsers.has(command.uid) ||
          savekitStage !== 'choose-user') {
        safeEmit('action-rejected', {action:command.action,
          message:'Choose an account from the current save installation.'}); return;
      }
      savekitUsers.clear();
      savekitChild.stdin.end(JSON.stringify({uid:command.uid})+'\n');
      return;
    }
    if (['install-seedsow-save','install-artemis-save','install-balatro-save','install-gravcirc-save'].includes(command.action)) {
      if (!['civswitch-fs','artemis-seedsow'].includes(context.profileId) || savekitSelected || savekitBusy || toolBusy ||
          launchAttempted || child || dumpBusy || dumpTask || preflightBusy || claiming || cleanupBlocked || failure) {
        safeEmit('action-rejected', {action:command.action,
          message:'Save installation needs a free, verified filesystem session.'}); return;
      }
      if (command.action === 'install-artemis-save' &&
          (!artemisGames.has(command.game) || command.sourcePath !== undefined ||
           command.variant !== undefined && !(command.game === 'seedsow' &&
           ['demo','full'].includes(command.variant)))) {
        safeEmit('action-rejected', {action:command.action, message:'Choose a supported Artemis save.'}); return;
      }
      if (command.action === 'install-seedsow-save' &&
          (command.variant !== undefined && command.variant !== 'pro' ||
           command.variant === 'pro' && command.sourcePath !== undefined || command.game !== undefined)) {
        safeEmit('action-rejected', {action:command.action, message:'Choose a Seedsow editor save.'}); return;
      }
      if (command.action === 'install-balatro-save' &&
          (!['upstream','showcase'].includes(command.variant) || command.sourcePath !== undefined)) {
        safeEmit('action-rejected', {action:command.action, message:'Choose a supported Balatro save.'}); return;
      }
      if (command.action === 'install-gravcirc-save' &&
          (command.sourcePath !== undefined || command.game !== undefined || command.variant !== undefined)) {
        safeEmit('action-rejected', {action:command.action, message:'The Gravity Circuit save is bundled.'}); return;
      }
      if (command.sourcePath !== undefined &&
          (typeof command.sourcePath !== 'string' || !path.isAbsolute(command.sourcePath) ||
           command.sourcePath.length > 4096 || /[\x00\r\n]/.test(command.sourcePath))) {
        safeEmit('action-rejected', {action:command.action, message:'Choose a local Seedsow editor ZIP or folder.'}); return;
      }
      savekitTask = installSave(command);
      return;
    }
    if (command.action === 'savekit-tool') {
      if (!savekitSelected || !savekitClaimed || savekitBusy || toolBusy ||
          launchAttempted || child || dumpBusy || preflightBusy || cleanupBlocked || failure) {
        safeEmit('action-rejected', {action:command.action,
          message:'Save data tools need the current verified SaveKit session.'}); return;
      }
      let value;
      try {value = require('./gui-savekit-tools.cjs').request(command.request);}
      catch (error) {safeEmit('action-rejected', {action:command.action, message:error.message}); return;}
      toolTask = runSaveKitTool(value, command.request);
      return;
    }
    if (command.action === 'stop-homebrew') {
      if (!child || settled || stopRequested || cleanupBlocked || sourceLost || failure) {
        safeEmit('action-rejected', {action:command.action,
          message:'Wait for a running homebrew app before stopping it.'}); return;
      }
      safeEmit('homebrew-stopping', {path:context.directory, message:'Stopping the current homebrew app.'});
      stopHomebrew();
      return;
    }
    if (command.action === 'modloader-install') {
      if (context.profileId !== 'civswitch-fs' || launchAttempted || child || statusBusy ||
          preflightBusy || dumpBusy || savekitSelected || savekitBusy || toolBusy || claiming ||
          cleanupBlocked || failure) {
        safeEmit('action-rejected', {action:command.action,
          message:'Modloader needs a free, verified CivSwitch filesystem session.'});
        return;
      }
      try {validateModloaderFolder(command.modsFolder);}
      catch (error) {
        safeEmit('action-rejected', {action:command.action, message:error.message});
        return;
      }
      modloaderBusy = true;
      modloaderTask = installModloader(command.modsFolder).catch(error => {
        if (finishing || closed) return;
        fail('Modloader stopped: ' + error.message, Boolean(modloaderStarted || modloaderChild));
        safeEmit('modloader-failed', {path:context.directory, cleanupBlocked,
          retrySafe:false, message:failure});
      }).finally(() => {modloaderBusy = false; modloaderChild = undefined;});
      return;
    }
    if (command.action === 'dump-system-code') {
      if (dumpTask || dumpBusy || statusBusy || claiming || preflightBusy || savekitSelected ||
          savekitBusy || toolBusy || cleanupBlocked || failure ||
          child && (!running || settled)) {
        safeEmit('action-rejected', {action:'dump-system-code',
          message:'Wait for a verified held RPC session and a safely running or stopped app before dumping system code.'});
        return;
      }
      dumpBusy = true;
      dumpTask = dumpSystemCode().catch(error => {
        if (finishing || closed) return;
        fail('The system-code dump did not finish: ' + error.message, dumpStarted);
        void finish('The system-code dump failed.');
      }).finally(() => {dumpBusy = false;});
      return;
    }
    if (applications[command.action]) {
      if (['civswitch-fs','artemis-seedsow'].includes(context.profileId) &&
          ['launch-mintbrew', 'launch-native-hblauncher'].includes(command.action)) {
        safeEmit('action-rejected', {action:command.action,
          message:'This launcher requires a SmileBASIC held RPC session. This filesystem session remains available for SaveKit and OunceCake.'});
        return;
      }
      if (!availableHomebrew(root, applications[command.action][0])) {
        safeEmit('action-rejected', {action:command.action,message:'This homebrew option is unavailable in this build.'}); return;
      }
      if (command.action === 'launch-native-hblauncher' &&
          !require('./host-profiles.cjs').profiles.some(profile =>
            profile.id === context.profileId && profile.supportsNativeHBLauncher)) {
        safeEmit('action-rejected', {action:command.action,
          message:'Native HBLauncher requires a supported held RPC session.'}); return;
      }
      let selection;
      try {selection = launchConfiguration(command);} catch (error) {safeEmit('action-rejected', {message: error.message}); return;}
      if (launchAttempted || statusBusy || preflightBusy || dumpBusy || savekitSelected ||
          savekitBusy || toolBusy || cleanupBlocked || failure) {
        safeEmit('action-rejected', {message:savekitSelected || savekitBusy || toolBusy ?
          'Wait for SaveKit to finish.' :
          'Only one homebrew launch attempt is allowed for this held session.'}); return;}
      if (selection.application === 'custom-homebrew') {
        preflightBusy = true;
        preflightTask = (async () => {
          let prepared;
          try {
            prepared = await preflightCustomApp(root,selection.config.customHomebrewPath);
            if (finishing || closed) return;
            if (['civswitch-fs','artemis-seedsow'].includes(context.profileId) &&
                !(prepared.kind === 'rpc-app' && prepared.adapter === 'ouncecake'))
              throw Error('This app requires a SmileBASIC held RPC session. This filesystem session supports OunceCake-compatible RPC packages.');
            if (prepared.kind === 'rpc-app' && prepared.adapter === 'ouncecake' && !net.isIPv4(selection.config.consoleAddress))
              throw Error('Enter the Switch’s IPv4 address for OunceCake-compatible WebDAV.');
            const target = prepared.kind === 'native-app' ? 'native-hblauncher' : 'custom-homebrew';
            if (!availableHomebrew(root,target))
              throw Error('The selected homebrew runtime is unavailable in this build.');
            if (target === 'native-hblauncher' &&
                !require('./host-profiles.cjs').profiles.some(profile =>
                  profile.id === context.profileId && profile.supportsNativeHBLauncher))
              throw Error('Native HBLauncher apps require a supported held RPC session.');
            const staged = prepared;
            const selected = target === 'native-hblauncher' ? {
              application:target,script:applications['launch-native-hblauncher'][1],
              config:{nativeAppFolder:staged.packageFolder,
                sdRomFolder:require('../integrations/mintbrew-native/sd-roms.cjs').DEFAULT_SD_ROM_FOLDER}} :
              {...selection,config:{
                customHomebrewPath:staged.kind==='launcher'?staged.launcherFolder:
                  staged.kind==='rpc-app'?staged.packageFolder:staged.appFolder,
                customHomebrewKind:staged.kind||'gpu-app',adapter:staged.adapter,
                ...(staged.adapter==='ouncecake'?{consoleAddress:selection.config.consoleAddress,port:2121}:{})}};
            launchAttempted = true;
            safeEmit('homebrew-accepted', {action:'launch-custom-homebrew',
              customHomebrewKind:staged.kind||'gpu-app',adapter:staged.adapter,
              message:target==='native-hblauncher' ?
                'Validated '+staged.app.name+'. Select it in HBLauncher on your Switch.' :
                'Validated '+staged.app.name+'. Opening the selected app.'});
            prepared = null;
            homebrewTask = homebrew(selected).catch(error => {
              if (finishing && !child) return;
              fail('The selected app could not start: ' + error.message, Boolean(child));
              stopHomebrew();
              safeEmit('homebrew-failed', {path: context.directory, cleanupBlocked, message: failure + ' This launch was not retried.'});
            }).finally(async () => {await staged.cleanup();});
          } catch(error) {
            if (!finishing && !closed) safeEmit('action-rejected', {action:'launch-custom-homebrew',
              message:'Custom homebrew validation failed: '+error.message});
          } finally {
            if (prepared) await prepared.cleanup().catch(()=>{});
            preflightBusy = false;preflightTask = undefined;
          }
        })();
        return;
      }
      launchAttempted = true;
      homebrewTask = homebrew(selection).catch(error => {
        if (finishing && !child) return;
        fail('The selected app could not start: ' + error.message, Boolean(child));
        stopHomebrew();
        safeEmit('homebrew-failed', {path: context.directory, cleanupBlocked, message: failure + ' This launch was not retried.'});
      });
      return;
    }
    if (command.action === 'select-ouncecake-game') {
      if (!(application === 'ouncecake' || application === 'custom-homebrew' && config?.adapter === 'ouncecake') ||
          !awaitingGame || !child || settled || cleanupBlocked ||
          typeof command.titleId !== 'string' || !gameTitles.has(command.titleId)) {
        safeEmit('action-rejected', {message: 'Choose one game from this session’s OunceCake list.'}); return;
      }
      awaitingGame = false;
      child.stdin.write(JSON.stringify({action: 'select-game', titleId: command.titleId}) + '\n'); return;
    }
    if (command.action === 'rpc-status') {
      if (statusBusy || launchAttempted || preflightBusy || dumpBusy || savekitBusy || toolBusy) {
        safeEmit('action-rejected', {message: 'Wait for the current operation to finish.'}); return;}
      statusBusy = true; safeEmit('rpc-status-started', {message: 'Checking the original held RPC connection.'});
      try {
        const status = await verify();
        if (!finishing) safeEmit('rpc-status', {ready: true, calls: status?.calls, message: 'RPC is connected.'});
      } catch (error) {if (!finishing) {safeEmit('rpc-status', {ready: false, message: 'RPC status failed: ' + error.message}); lost(error);}}
      finally {statusBusy = false;}
      return;
    }
    safeEmit('action-rejected', {message: 'Unsupported attachment action.'});
  }
  const stop = () => {void finish('Attachment stopped.');};
  const inputEnd = () => {void finish('The app closed its attachment controls.');};
  const pipeError = error => {outputClosed = true; if (error.code !== 'EPIPE') fail('The app event connection failed.'); void finish('The app connection closed.');};
  const inputError = () => {fail('The app control connection failed.'); void finish();};
  signals.on('SIGTERM', stop); signals.on('SIGINT', stop); output.on('error', pipeError);
  input.on('error', inputError);
  lines(input, line => {void control(line).catch(error => {fail(error.message); void finish();});}, 4 * 1024 * 1024);
  input.once('end', inputEnd); input.resume();
  try {return await done;}
  finally {
    clearInterval(monitor); clearTimeout(stopTimer); clearTimeout(dumpStopTimer);
    signals.removeListener('SIGTERM', stop); signals.removeListener('SIGINT', stop);
    input.removeListener('end', inputEnd); input.removeListener('error', inputError); input.pause();
    // retain the stdout error listener through exit, just like gui-session,
    // so a delayed EPIPE cannot interrupt owned-helper cleanup.
  }
}
module.exports = {main, launchConfiguration, validCatalog};
if (require.main === module) main().then(code => {process.exitCode = code;}).catch(error => {
  try {process.stdout.write(JSON.stringify({type: 'failed', message: error.message, resourcesRetained: true}) + '\n');} catch {}
  process.exitCode = 1;
});
