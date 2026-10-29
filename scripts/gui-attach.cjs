#!/usr/bin/env node
'use strict';
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');
const {spawn: spawnProcess} = require('node:child_process');
const {lines} = require('./gui-host.cjs');

const applications = Object.freeze({
  'launch-izlauncher': ['izlauncher', 'scripts/gui-izlauncher.cjs'],
  'launch-mintbrew': ['mintbrew', 'scripts/gui-mintbrew.cjs'],
  'launch-custom-homebrew': ['custom-homebrew', 'scripts/gui-custom-homebrew.cjs'],
  'launch-ouncecake': ['ouncecake', 'scripts/gui-ouncecake.cjs']
});
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
    if (!net.isIPv4(command.consoleAddress)) throw Error('Enter the Switch’s IPv4 address for OunceCake FTP.');
    return {application, script, config: {consoleAddress: command.consoleAddress, port: 2121}};
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
  if (application === 'custom-homebrew') {
    if (typeof command.customHomebrewPath !== 'string' || !path.isAbsolute(command.customHomebrewPath) ||
        command.customHomebrewPath.length > 4096 || /[\x00\r\n]/.test(command.customHomebrewPath))
      throw Error('Choose a valid local custom homebrew folder.');
    return {application, script, config: {customHomebrewPath:command.customHomebrewPath,
      consoleAddress:command.consoleAddress}};
  }
  if (application === 'izlauncher') {
    if (command.moduleIds !== undefined && !require('./izlauncher-modules.cjs').validIds(command.moduleIds))
      throw Error('Choose up to 15 distinct compatible IZlauncher modules.');
    if (command.moduleFolderPath === undefined)
      return {application, script, config: {...(command.moduleIds === undefined ? {} : {moduleIds:command.moduleIds})}};
    if (typeof command.moduleFolderPath !== 'string' || !path.isAbsolute(command.moduleFolderPath) ||
        command.moduleFolderPath.length > 4096 || /[\x00\r\n]/.test(command.moduleFolderPath))
      throw Error('Choose a valid local IZlauncher module folder.');
    return {application, script, config: {moduleFolderPath:command.moduleFolderPath,
      ...(command.moduleIds === undefined ? {} : {moduleIds:command.moduleIds})}};
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
  const stageIZModule = options.stageIZModule || ((selectedRoot, folder) =>
    require('./stage-custom-izmodule.cjs').stage(selectedRoot, folder));
  const listIZlauncherModules = options.listIZlauncherModules || (selectedRoot =>
    require('./izlauncher-modules.cjs').catalog(selectedRoot));
  const spawn = options.spawn || spawnProcess, signal = options.signal || signalOwned;
  const makeDumpDirectory = options.createDumpDirectory || createDumpDirectory;
  const graceMs = options.graceMs ?? 300000, pollMs = options.pollMs ?? 2000;
  const preparationAbort = new AbortController();
  let context, attachmentTask, verificationTask, homebrewTask, preflightTask, finishTask, child, dumpTask, dumpChild;
  let attachmentAttempted = false, ready = false, launchAttempted = false, statusBusy = false, claiming = false, preflightBusy = false;
  let finishing = false, closed = false, outputClosed = false, sourceLost = false, failure;
  let dumpBusy = false, dumpStarted = false, dumpClaimed = false, dumpStopTimer;
  let application, config, settled = false, running = false, cleanupBlocked = false, stopRequested = false;
  let awaitingGame = false, gameTitles = new Set(), monitor, stopTimer;
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
    finishing = true; ready = false; clearInterval(monitor);
    preparationAbort.abort();
    if (!child && !dumpChild) context?.abortVerification?.();
    finishTask = (async () => {
      safeEmit('rpc-finishing', {message: reason + ' Stopping this app’s helpers; the original host remains open.'});
      await attachmentTask?.catch(() => {});
      await preflightTask?.catch(() => {});
      stopHomebrew();
      stopDump();
      await homebrewTask?.catch(() => {});
      await dumpTask?.catch(() => {});
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
    fail('The original RPC session was lost: ' + error.message, Boolean(child));
    stopHomebrew(true);
    void finish('The source connection ended.');
  }
  function monitorSource() {
    if (finishing || closed || !ready || verificationTask || claiming || preflightBusy || dumpBusy) return;
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
    let retrySafeFailure;
    claiming = true;
    try {
      try {await verify();} catch (error) {lost(error); return;}
      if (finishing) return;
      // claim in the original run before any helper can issue a native request.
      // do not poll while this operation installs its ownership marker.
      await context.claimApplication(application);
    } finally {claiming = false;}
    if (finishing) return;
  const configurable = application === 'mintbrew' || application === 'ouncecake' || application === 'izlauncher' ||
      application === 'custom-homebrew' && config.customHomebrewKind === 'rpc-app';
    const moduleIds = application === 'izlauncher' && Array.isArray(config.moduleIds) && config.moduleIds.length
      ? require('./izlauncher-modules.cjs').withDefaults(config.moduleIds) : undefined;
    child = spawn(process.execPath, [path.join(root, selection.script), context.directory,
      ...(moduleIds ? ['--modules',JSON.stringify(moduleIds)] : []),
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
      if (event.type === 'panel') {
        if (application !== 'izlauncher' || settled || finishing) return;
        try {safeEmit('izlauncher-panel', require('./izlauncher-panel.cjs').verifyPanelEvent(root, event));}
        catch {protocolFailure('IZlauncher returned an invalid local panel address.');}
        return;
      }
      if (event.type === 'account-progress') {
        if (application === 'mintbrew' && event.watchProgress && typeof event.watchProgress === 'object' && !Array.isArray(event.watchProgress))
          safeEmit('account-progress', {watchProgress: event.watchProgress});
        return;
      }
      if (event.type === 'module-progress') {
        if (application === 'izlauncher' && !settled && !finishing &&
            typeof event.message === 'string' && Buffer.byteLength(event.message) <= 512 &&
            !/[\x00-\x1f\x7f]/.test(event.message))
          safeEmit('izlauncher-module-progress', {path: context.directory, message: event.message});
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
           event.ftpURL !== `ftp://${config.consoleAddress}:2121`)) {
        protocolFailure('OunceCake did not confirm the selected FTP endpoint.'); return;
      }
      if (event.cleanupBlocked === true) fail('The selected app could not confirm native shutdown.', true);
      const wasRunning = running;
      if (event.type === 'running') running = true;
      if (event.type === 'stopped' || event.type === 'failed') {running = false; settled = true;}
      if (event.type === 'failed') {
        if (event.retrySafe === true && !wasRunning && !cleanupBlocked && !finishing && !failure)
          retrySafeFailure = event;
        else fail(event.message || 'The selected homebrew app failed.');
      }
      if (retrySafeFailure) return;
      safeEmit('homebrew-' + event.type, {path: context.directory, message: event.message,
        ...(['izlauncher','mintbrew'].includes(application) ? {cleanupBlocked} : {}),
        ...(ouncecakeMode ? {host: event.host, port: event.port, ftpURL: event.ftpURL, cleanupBlocked} : {})});
    };
    lines(owned.stdout, observe, 1024 * 1024); lines(owned.stderr, observe);
    if (configurable) {
      owned.stdin.on('error', () => protocolFailure('Could not configure the selected app.'));
      try {
        if (application !== 'izlauncher') owned.stdin.write(JSON.stringify(config) + '\n');
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
    if (outcome.error || outcome.code !== 0 || outcome.signal || !settled) {
      fail('The selected app failed or did not confirm shutdown. This launch was not retried.', !settled || Boolean(outcome.signal));
      safeEmit('homebrew-failed', {path: context.directory, cleanupBlocked, message: failure});
    }
  }
  async function dumpSystemCode() {
    if (child) {
      safeEmit('dump-progress', {message:'Stopping the current app before reading system code.'});
      stopHomebrew();
      await homebrewTask;
      if (finishing || closed) return;
      if (child || !settled || cleanupBlocked || failure)
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
  async function control(line) {
    let command;
    try {command = JSON.parse(line);} catch {safeEmit('action-rejected', {message: 'Invalid attachment action.'}); return;}
    if (!command || typeof command !== 'object' || Array.isArray(command)) {safeEmit('action-rejected', {message: 'Invalid attachment action.'}); return;}
    if (closed || finishing) {safeEmit('action-rejected', {message: 'The attachment is closing.'}); return;}
    if (command.action === 'finish') {void finish(); return;}
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
          message: context.description || 'Attached to the existing held RPC session.'});
        if (pollMs > 0) {monitor = setInterval(monitorSource, pollMs); monitor.unref?.();}
      })().catch(error => {if (!finishing) {fail('Could not attach: ' + error.message); void finish('Attachment verification failed.');}});
      return;
    }
    if (!ready) {safeEmit('action-rejected', {message: 'Attach to a verified open RPC session first.'}); return;}
    if (command.action === 'dump-system-code') {
      if (dumpTask || dumpBusy || statusBusy || claiming || preflightBusy || cleanupBlocked || failure ||
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
    if (command.action === 'list-izlauncher-modules') {
      if (!availableHomebrew(root, 'izlauncher')) {
        safeEmit('action-rejected',{action:'list-izlauncher-modules',message:'IZlauncher is unavailable in this build.'});return;
      }
      if (launchAttempted || preflightBusy || dumpBusy) {safeEmit('action-rejected',{action:'list-izlauncher-modules',message:'Wait for the current IZlauncher operation to finish.'});return;}
      try {const modules=await listIZlauncherModules(root);
        if (!finishing) safeEmit('izlauncher-catalog',{modules});}
      catch(error){if (!finishing) safeEmit('action-rejected',{action:'list-izlauncher-modules',message:'IZlauncher module list failed: '+error.message});}
      return;
    }
    if (command.action === 'load-izlauncher-modules') {
      if (application!=='izlauncher'||!running||!child?.stdin?.writable||
          !require('./izlauncher-modules.cjs').validIds(command.ids)||!command.ids.length) {
        safeEmit('action-rejected',{action:'load-izlauncher-modules',message:'Select compatible modules while IZlauncher is running.'});return;
      }
      child.stdin.write(JSON.stringify({action:'load-modules',ids:command.ids})+'\n');return;
    }
    if (applications[command.action]) {
      if (!availableHomebrew(root, applications[command.action][0])) {
        safeEmit('action-rejected', {action:command.action,message:'This homebrew option is unavailable in this build.'}); return;
      }
      let selection;
      try {selection = launchConfiguration(command);} catch (error) {safeEmit('action-rejected', {message: error.message}); return;}
      if (launchAttempted || statusBusy || preflightBusy || dumpBusy) {safeEmit('action-rejected', {message: 'Only one homebrew launch attempt is allowed for this held session.'}); return;}
      if (selection.application === 'custom-homebrew') {
        preflightBusy = true;
        preflightTask = (async () => {
          let prepared;
          try {
            prepared = await preflightCustomApp(root,selection.config.customHomebrewPath);
            if (finishing || closed) return;
            if (prepared.kind === 'rpc-app' && prepared.adapter === 'ouncecake' && !net.isIPv4(selection.config.consoleAddress))
              throw Error('Enter the Switch’s IPv4 address for OunceCake-compatible FTP.');
            launchAttempted = true;
            safeEmit('homebrew-accepted', {action:'launch-custom-homebrew',
              customHomebrewKind:prepared.kind||'gpu-app',adapter:prepared.adapter,
              message:'Validated '+prepared.app.name+'. Opening the selected app.'});
            const staged = prepared;
            prepared = null;
            const selected = {...selection,config:{
              customHomebrewPath:staged.kind==='launcher'?staged.launcherFolder:
                staged.kind==='rpc-app'?staged.packageFolder:staged.appFolder,
              customHomebrewKind:staged.kind||'gpu-app',adapter:staged.adapter,
              ...(staged.adapter==='ouncecake'?{consoleAddress:selection.config.consoleAddress,port:2121}:{})}};
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
      if (selection.application === 'izlauncher' && selection.config.moduleFolderPath) {
        preflightBusy = true;
        preflightTask = (async () => {
          let prepared;
          try {
            prepared = await stageIZModule(root,selection.config.moduleFolderPath);
            if (finishing || closed) return;
            launchAttempted = true;
            safeEmit('homebrew-accepted', {action:'launch-izlauncher',
              message:'Added '+prepared.name+' '+prepared.version+' to this session. Opening IZlauncher.'});
            const moduleIds=[...new Set([...(selection.config.moduleIds||[]),prepared.id])];
            if(moduleIds?.length>15)throw Error('Choose no more than 15 IZlauncher modules, including the custom module.');
            prepared = null;
            homebrewTask = homebrew({...selection,config:{moduleIds}}).catch(error => {
              if (finishing && !child) return;
              fail('The selected app could not start: ' + error.message, Boolean(child));
              stopHomebrew();
              safeEmit('homebrew-failed', {path: context.directory, cleanupBlocked, message: failure + ' This launch was not retried.'});
            });
          } catch(error) {
            if (!finishing && !closed) safeEmit('action-rejected', {action:'launch-izlauncher',
              message:'IZlauncher module validation failed: '+error.message});
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
      if (statusBusy || launchAttempted || preflightBusy || dumpBusy) {safeEmit('action-rejected', {message: 'Wait for the current operation to finish.'}); return;}
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
