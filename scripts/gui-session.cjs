#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {networkBindFailure, networkUnavailableMessage} = require('./gui-host.cjs');
const {incompatibleLegacyStartHint} = require('./host-profiles.cjs');
const heldMessage = '4/4 verified. SmileBASIC RPC and FS memory endpoint remain live while this process and the app stay open.';
const homebrewScripts = Object.freeze({
  ouncecake: 'scripts/gui-ouncecake.cjs',
  mintbrew: 'scripts/gui-mintbrew.cjs',
  izlauncher: 'scripts/gui-izlauncher.cjs',
  'custom-homebrew': 'scripts/gui-custom-homebrew.cjs'
});
const nativeCleanupApps = new Set(['ouncecake', 'izlauncher', 'mintbrew', 'custom-homebrew']);

function availableHomebrew(root, application) {
  const marker = path.join(root, 'packaging/runtime-homebrew.json');
  if (!fs.existsSync(marker)) return true;
  try {
    const allowed = JSON.parse(fs.readFileSync(marker, 'utf8')).allowed;
    return Array.isArray(allowed) && allowed.includes(application);
  } catch { return false; }
}

function heldResult(result) {
  return result?.verified === true && result.fs?.verified === true && result.fs?.restored === true &&
    result.fs?.retainedEndpoint?.ready === true && result.fs?.cleanup?.deferred === true &&
    result.fs?.cleanup?.donor?.cleanedUp === true && result.rpc?.mode === 'held' &&
    result.rpc?.state === 'listening' && !result.error && !result.completed &&
    (!result.cleanupErrors || Array.isArray(result.cleanupErrors) && result.cleanupErrors.length === 0);
}
function privateJSON(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 || info.size > 8 * 1024 * 1024)
    throw Error('Invalid session report: ' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function ownedRun(candidate, runs) {
  const directory = path.resolve(candidate);
  const info = fs.lstatSync(directory);
  if (path.dirname(directory) !== runs || !info.isDirectory() || info.isSymbolicLink() ||
      info.uid !== process.getuid() || (info.mode & 0o077) !== 0 ||
      !fs.realpathSync(directory).startsWith(fs.realpathSync(runs) + path.sep))
    throw Error('The host reported a run folder outside this session.');
  return directory;
}
function quote(text) { return "'" + text.replace(/'/g, "'\\''") + "'"; }
function signalGroup(child, signal) {
  if (!child?.pid) return;
  try {process.kill(-child.pid, signal);} catch (error) {if (error.code !== 'ESRCH') throw error;}
}
function finished(child) {
  return new Promise(resolve => {
    child.once('error', error => resolve({code: null, signal: null, error}));
    child.once('close', (code, signal) => resolve({code, signal}));
  });
}
function heldSignalGuard(message) {
  // the fork prints its held status just before installing stop handlers.
  // buffer a signal in that short interval without altering the fork source.
  let armed = false, tail = '';
  const queued = new Set(), handlers = new Map();
  const originalWrite = process.stdout.write;
  process.stdout.write = function(chunk, ...args) {
    tail = (tail + (Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk)));
    if (tail.includes(message)) armed = true;
    tail = tail.slice(-message.length);
    return originalWrite.call(this, chunk, ...args);
  };
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => {
      if (process.listenerCount(signal) > 1) return;
      if (armed) queued.add(signal);
      else {
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    handlers.set(signal, handler); process.on(signal, handler);
  }
  process.on('newListener', (signal, listener) => {
    if (!handlers.has(signal) || listener === handlers.get(signal)) return;
    process.nextTick(() => {
      if (queued.has(signal) && process.listenerCount(signal) > 1) {
        queued.delete(signal); process.emit(signal);
      }
    });
  });
}

async function main({root, address, emit, lines, verifiedResult, input = process.stdin, graceMs = 300000,
  preflightCustomApp, listIZlauncherModules}) {
  if (!net.isIPv4(address)) throw Error('Choose the Mac’s LAN IPv4 address.');
  const folder = path.join(root, 'vendor/ns2jb'), runs = path.join(folder, 'runs');
  fs.mkdirSync(runs, {recursive: true, mode: 0o700}); fs.chmodSync(runs, 0o700);
  const active = path.join(runs, 'mac2jb-active-connect.txt');
  try {fs.lstatSync(active); throw Error('This session already has a pairing record. Start a fresh session.');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  const dumps = path.join(root, 'dumps');
  fs.mkdirSync(dumps, {recursive: true, mode: 0o700});
  if (fs.lstatSync(dumps).isSymbolicLink()) throw Error('The dump folder must belong to this private session.');
  fs.chmodSync(dumps, 0o700);
  const dumpDirectory = fs.mkdtempSync(path.join(fs.realpathSync(dumps), 'post-run-')); fs.chmodSync(dumpDirectory, 0o700);
  const controls = fs.mkdtempSync(path.join(runs, '.mac2jb-control-'));
  const guard = path.join(controls, 'held-signal-guard.cjs');
  fs.writeFileSync(guard, '(' + heldSignalGuard.toString() + ')(' + JSON.stringify(heldMessage) + ');\n',
    {mode: 0o600, flag: 'wx'});
  let runner, helper, directory, rpcCommand, published = false, ready = false, choiceMade = false;
  let finishing = false, closed = false, outputClosed = false, failure, cancelBeforeReady = false;
  let finishTimer, helperTimer, dumpTask, dumpBusy = false, statusBusy = false;
  let rpcHeldConfirmed = false, homebrewAttempted = false, homebrewChild, homebrewTask;
  let preflightBusy = false, preflightTask;
  let homebrewRunning = false, homebrewSettled = false, homebrewStopTimer, homebrewFailurePublished = false;
  let homebrewApplication, homebrewAdapter, awaitingGame = false, gameTitles = new Set(), cleanupBlocked = false;
  let networkFailure, progressed = false;
  const safeEmit = (type, fields = {}) => {
    if (outputClosed) return;
    try {emit(type, fields);} catch (error) {
      if (error.code !== 'EPIPE') throw error;
      outputClosed = true; finish('The app connection closed.');
    }
  };
  function fail(message) {failure ||= message;}
  function held() {
    safeEmit('rpc-held', {path: directory, rpcCommand, message: 'RPC remains open. Keep SmileBASIC and mac2jb open.'});
    rpcHeldConfirmed = true;
  }
  function stopHomebrew() {
    if (!homebrewChild) return;
    if (cleanupBlocked) {signalGroup(homebrewChild, 'SIGKILL'); return;}
    if (!homebrewSettled) {
      try {homebrewChild.kill('SIGTERM');} catch (error) {if (error.code !== 'ESRCH') fail(error.message);}
    }
    homebrewStopTimer ||= setTimeout(() => {
      fail('The homebrew app did not confirm shutdown. Finish RPC and restart the console.');
      if (nativeCleanupApps.has(homebrewApplication)) cleanupBlocked = true;
      signalGroup(homebrewChild, 'SIGKILL');
    }, 300000);
    homebrewStopTimer.unref();
  }
  function finish(reason = 'Finishing the session.') {
    if (closed || finishing) return;
    finishing = true;
    if (statusBusy) fail('The RPC status check was interrupted. Restart the console before another attempt.');
    if (helper) {
      fail('The firmware dump was interrupted. Keep its partial files and restart the console before retrying.');
      signalGroup(helper, 'SIGTERM');
      helperTimer = setTimeout(() => signalGroup(helper, 'SIGKILL'), 2000);
      helperTimer.unref();
    }
    if (ready) {
      safeEmit('rpc-finishing', {message: reason + ' Releasing held resources and closing RPC.'});
      const releaseRunner = () => {
        if (closed) return;
        if (cleanupBlocked) {
          // an uncertain native worker must keep its code and handles. end the
          // local bridge without executing the fork's native cleanup underneath it.
          fail('The selected app shutdown was not confirmed. Restart the console; native resources were retained.');
          signalGroup(runner, 'SIGKILL'); return;
        }
        // homebrew owners stop while rpc is live, before fork ipc cleanup.
        try {runner.kill('SIGTERM');} catch (error) {if (error.code !== 'ESRCH') fail(error.message);}
        finishTimer = setTimeout(() => {
          fail('Held-session cleanup timed out. Restart the console before another attempt.');
          safeEmit('log', {message: failure});
          signalGroup(runner, 'SIGKILL');
        }, graceMs);
        finishTimer.unref();
      };
      if (homebrewChild) {stopHomebrew(); homebrewTask.finally(releaseRunner);}
      else if (preflightTask) preflightTask.finally(releaseRunner);
      else releaseRunner();
    } else {
      cancelBeforeReady = true;
      signalGroup(runner, 'SIGTERM');
      finishTimer = setTimeout(() => signalGroup(runner, 'SIGKILL'), 2000);
    }
    finishTimer?.unref();
  }
  const stop = () => finish('Session stopped.');
  const pipeError = error => {
    if (error.code !== 'EPIPE') {fail(error.message);}
    outputClosed = true; finish('The app connection closed.');
  };
  process.stdout.on('error', pipeError);
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    runner = spawn(process.execPath, ['--require', guard, 'run.cjs', '--rpc', address], {
      cwd: folder, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, NS2_BASIC_ARITY: '5', NS2_RPC_MODE: '0', NS2_FIRMWARE_DUMP_DIR: dumpDirectory}
    });
    const runnerDone = finished(runner);
    function output(line) {
      try {
        const clean = line.trim();
        const bindFailure = networkBindFailure(clean, address);
        if (bindFailure && !networkFailure) {networkFailure = bindFailure; finish('The selected Mac network address is unavailable.');}
        const start = /^V=START\((\d+(?:,\d+){4})\)$/.exec(clean);
        if (start && !published && !finishing && !networkFailure) {
          const values = start[1].split(',').map(Number);
          if (values[0] === 39380 && values.slice(1).join('.') === address &&
              values.every(Number.isSafeInteger) && values.slice(1).every(value => value <= 255)) {
            const temporary = active + '.' + process.pid + '.tmp';
            fs.writeFileSync(temporary, `${runner.pid}\n${clean}\n`, {mode: 0o600, flag: 'wx'});
            try {fs.linkSync(temporary, active);} finally {fs.unlinkSync(temporary);}
            published = true; safeEmit('host-ready', {startCommand: clean, message: 'Fresh host pairing is ready.'});
          }
        }
        if (clean.startsWith('Run folder: ')) {
          const candidate = ownedRun(clean.slice('Run folder: '.length), runs);
          if (directory && directory !== candidate) throw Error('The host changed its run folder.');
          directory = candidate; progressed = true; safeEmit('run-folder', {path: directory});
        }
        if (/^(?:Waiting for Switch 2 at |Connected\b|[1-4]\/4 |Sending: |MAC2JB_GUI |Keyboard enumerated\. Sending|Typing line |Sent line )/.test(clean)) progressed = true;
        if (clean.startsWith('Waiting for Switch 2 at '))
          safeEmit('host-stage', {stage: 'waiting', message: 'Waiting for the Switch to connect over the local network'});
        else if (clean.startsWith('Connected. Checking the application'))
          safeEmit('host-stage', {stage: 'connected', message: 'Switch connected — checking the application'});
        else if (/^[1-4]\/4 /.test(clean))
          safeEmit('host-stage', {stage: 'pipeline', completed: Number(clean[0])-1, total: 4, message: clean});
        if (clean === heldMessage && !ready && !finishing) {
          const report = directory && privateJSON(path.join(directory, 'result.json'));
          const connection = directory && privateJSON(path.join(directory, 'connection.json'));
          if (!directory || !heldResult(report) ||
              report.fs.retainedEndpoint.session !== path.basename(directory) ||
              connection.addresses?.session !== path.basename(directory) || connection.addresses?.target !== 'switch2' ||
              !Number.isSafeInteger(connection.port) || connection.port < 1 || connection.port > 65535)
            throw Error('The host did not verify a restored, live held session.');
          ready = true;
          rpcCommand = [process.execPath, path.join(folder, 'rpc.cjs'), directory, 'status'].map(quote).join(' ');
          safeEmit('post-run-ready', {path: directory, rpcCommand,
            message: 'FS execution and restoration verified. Preparing the selected session action.'});
        }
        if (!incompatibleLegacyStartHint(clean, 5)) safeEmit('log', {message: line});
      } catch (error) {fail(error.message); finish('The session could not be verified.');}
    }
    lines(runner.stdout, output); lines(runner.stderr, output);

    async function dump(keepRPC) {
      safeEmit('dump-started', {path: dumpDirectory, message: 'Dumping installed system code. Keep SmileBASIC open.'});
      helper = spawn(process.execPath, [path.join(root, 'scripts/gui-dump.cjs'), directory, dumpDirectory], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: {...process.env, NS2_FIRMWARE_DUMP_DIR: dumpDirectory}
      });
      const child = helper;
      const helperDone = finished(child);
      const observe = line => {
        if (line.trim().startsWith('Firmware:')) safeEmit('dump-progress', {message: line.trim()});
        else safeEmit('log', {message: line});
      };
      lines(child.stdout, observe); lines(child.stderr, observe);
      const outcome = await helperDone;
      clearTimeout(helperTimer); helper = undefined;
      if (closed || finishing) return;
      if (outcome.error || outcome.code !== 0 || outcome.signal)
        throw Error('The firmware dump failed. Partial files were retained; do not retry this session.');
      const manifest = privateJSON(path.join(dumpDirectory, 'firmware-dump.json'));
      if (manifest.complete !== true || !Array.isArray(manifest.entries) ||
          !Number.isSafeInteger(manifest.inventory?.total) || manifest.inventory.total < 0 ||
          manifest.entries.length !== manifest.inventory.total)
        throw Error('The firmware dump did not produce a complete inventory.');
      safeEmit('dump-complete', {path: dumpDirectory, message: 'Firmware dump completed and its inventory verified.'});
      if (keepRPC) held();
      else finish('Firmware dump completed.');
    }
    async function dumpFromHeldRPC() {
      if (homebrewChild) {
        safeEmit('dump-progress', {message: 'Stopping the current app before reading system code.'});
        stopHomebrew();
        await homebrewTask;
        if (finishing || closed) return;
        if (homebrewChild || !homebrewSettled || cleanupBlocked || failure)
          throw Error('The current app did not confirm safe shutdown. The system-code dump was not started.');
      }
      if (finishing || closed) return;
      const status = await require(path.join(folder, 'rpc.cjs')).request(directory, {command: 'status'});
      if (status?.ready !== true) throw Error('The held RPC session is no longer ready for the system-code dump.');
      if (finishing || closed) return;
      await dump(true);
    }
    async function homebrew(application, config = {}) {
      homebrewApplication = application;
      homebrewAdapter = config.adapter;
      const ouncecakeMode = application === 'ouncecake' ||
        application === 'custom-homebrew' && config.customHomebrewKind === 'rpc-app' && config.adapter === 'ouncecake';
      let retrySafeFailure;
      const script = homebrewScripts[application];
      const configurable = application === 'mintbrew' || application === 'ouncecake' || application === 'izlauncher' ||
        application === 'custom-homebrew' && config.customHomebrewKind === 'rpc-app';
      const moduleIds = application === 'izlauncher' && Array.isArray(config.moduleIds) && config.moduleIds.length
        ? require('./izlauncher-modules.cjs').withDefaults(config.moduleIds) : undefined;
      homebrewChild = spawn(process.execPath, [path.join(root, script), directory,
        ...(moduleIds ? ['--modules',JSON.stringify(moduleIds)] : []),
        ...(application === 'custom-homebrew' ? [
          config.customHomebrewKind==='launcher'?'--launcher-folder':
            config.customHomebrewKind==='rpc-app'?'--rpc-folder':'--app-folder', config.customHomebrewPath] : [])], {
        cwd: root, detached: true, stdio: [configurable ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: {...process.env, ...(application === 'izlauncher' ? {HB_STREAM_HOST: address} : {})}
      });
      if (configurable) {
        homebrewChild.stdin.on('error', error => {if (error.code !== 'EPIPE') fail('Could not configure the selected app.');});
        if (application !== 'izlauncher') homebrewChild.stdin.write(JSON.stringify(config) + '\n');
        if (application === 'mintbrew') homebrewChild.stdin.end();
      }
      const child = homebrewChild, done = finished(child);
      const observe = line => {
        if (!line.startsWith('MAC2JB_HOMEBREW ')) {safeEmit('log', {message: line}); return;}
        let event;
        try {event = JSON.parse(line.slice('MAC2JB_HOMEBREW '.length));}
        catch {safeEmit('log', {message: 'Invalid homebrew event.'}); return;}
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          safeEmit('log', {message: 'Invalid homebrew event.'}); return;
        }
        if (event.type === 'panel') {
          if (application !== 'izlauncher') return;
          try {safeEmit('izlauncher-panel', require('./izlauncher-panel.cjs').verifyPanelEvent(root, event));}
          catch {fail('IZlauncher returned an invalid local panel address.'); stopHomebrew();}
          return;
        }
        if (event.type === 'account-progress') {
          if (application === 'mintbrew' && event.watchProgress && typeof event.watchProgress === 'object' && !Array.isArray(event.watchProgress))
            safeEmit('account-progress', {watchProgress: event.watchProgress});
          return;
        }
        if (event.type === 'module-progress') {
          if (application === 'izlauncher' && !homebrewSettled && !finishing &&
              typeof event.message === 'string' && Buffer.byteLength(event.message) <= 512 &&
              !/[\x00-\x1f\x7f]/.test(event.message))
            safeEmit('izlauncher-module-progress', {path: directory, message: event.message});
          return;
        }
        if (event.type === 'catalog') {
          if (!ouncecakeMode || gameTitles.size !== 0 || awaitingGame || homebrewRunning || homebrewSettled ||
              !Array.isArray(event.games) || event.games.length > 1000 || event.games.length === 0 ||
              event.games.some(game => !game || !/^[a-f0-9]{16}$/.test(game.titleId) ||
                typeof game.name !== 'string' || Buffer.byteLength(game.name) > 160 ||
                /[\x00-\x1f\x7f]/.test(game.name) || !Array.isArray(game.storages) ||
                game.storages.length < 1 || game.storages.length > 3 || new Set(game.storages).size !== game.storages.length ||
                game.storages.some(value => ![2,4,5].includes(value))) ||
              new Set(event.games.map(game => game.titleId)).size !== event.games.length) {
            fail('OunceCake returned an invalid game list.'); stopHomebrew(); return;
          }
          gameTitles = new Set(event.games.map(game => game.titleId)); awaitingGame = true;
          safeEmit('homebrew-catalog', {games:event.games,path:directory,message:event.message}); return;
        }
        if (!['started','progress','running','stopped','failed'].includes(event.type)) return;
        if (ouncecakeMode && event.type === 'running' &&
            (awaitingGame || gameTitles.size === 0 || event.host !== config.consoleAddress || event.port !== 2121 ||
             event.ftpURL !== `ftp://${config.consoleAddress}:2121`)) {
          fail('OunceCake did not confirm the selected FTP endpoint.'); stopHomebrew(); return;
        }
        if (nativeCleanupApps.has(application) && event.cleanupBlocked === true) {
          cleanupBlocked = true; fail('The selected app could not confirm native shutdown. Restart the console before stopping this session.');
        }
        const wasRunning = homebrewRunning;
        if (event.type === 'running') homebrewRunning = true;
        if (event.type === 'stopped' || event.type === 'failed') {homebrewRunning = false; homebrewSettled = true;}
        if (event.type === 'failed') {
          if (event.retrySafe === true && !wasRunning && !cleanupBlocked && !finishing) retrySafeFailure = event;
          else {fail(event.message || 'The selected homebrew app failed. Restart the console.'); homebrewFailurePublished = true;}
        }
        if (retrySafeFailure) return;
        safeEmit('homebrew-' + event.type, {path: event.path || directory, message: event.message,
          ...(['izlauncher','mintbrew'].includes(application) ? {cleanupBlocked} : {}),
          ...(ouncecakeMode ? {host:event.host,port:event.port,ftpURL:event.ftpURL,cleanupBlocked} : {})});
      };
      lines(child.stdout, observe, 1024 * 1024); lines(child.stderr, observe);
      const outcome = await done;
      clearTimeout(homebrewStopTimer); homebrewStopTimer = undefined;
      homebrewChild = undefined; homebrewRunning = false;
      if (retrySafeFailure && !outcome.error && outcome.code === 1 && !outcome.signal &&
          homebrewSettled && !cleanupBlocked && !closed && !finishing) {
        try {
          const status = await require(path.join(folder, 'rpc.cjs')).request(directory, {command: 'status'});
          if (status?.ready !== true) throw Error('The held RPC session is no longer ready.');
          homebrewAttempted = false; homebrewSettled = false; homebrewApplication = undefined; homebrewAdapter = undefined;
          safeEmit('homebrew-failed', {path: retrySafeFailure.path || directory, retrySafe: true,
            message: retrySafeFailure.message || 'Preparation failed before transfer. RPC remains open; choose another app.'});
          return;
        } catch (error) {fail(error.message);}
      }
      if (outcome.error || outcome.code !== 0 || outcome.signal || !homebrewSettled) {
        if (nativeCleanupApps.has(application) && !homebrewSettled) cleanupBlocked = true;
        fail('The selected app failed or did not confirm shutdown. Restart the console.');
        if (!homebrewFailurePublished) safeEmit('homebrew-failed', {path: directory,
          message: failure + ' This launch was not retried.',cleanupBlocked});
      }
    }
    async function control(line) {
      let command;
      try {command = JSON.parse(line);} catch {safeEmit('action-rejected', {message: 'Invalid session action.'}); return;}
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        safeEmit('action-rejected', {message: 'Invalid session action.'}); return;
      }
      if (!ready || closed || finishing) {safeEmit('action-rejected', {message: 'The session is not ready for this action.'}); return;}
      if (command.action === 'finish') {
        if (cleanupBlocked) {safeEmit('action-rejected', {message:'Restart the console, then stop this session. Native shutdown was not confirmed.'}); return;}
        if (dumpBusy || helper || statusBusy || homebrewChild && !homebrewRunning && !homebrewSettled && !awaitingGame) {
          safeEmit('action-rejected', {message: 'Wait for the current operation to finish.'}); return;
        }
        choiceMade = true; finish(); return;
      }
      if (command.action === 'select-ouncecake-game') {
        if (!(homebrewApplication === 'ouncecake' || homebrewApplication === 'custom-homebrew' && homebrewAdapter === 'ouncecake') ||
            !awaitingGame || !homebrewChild || homebrewSettled || cleanupBlocked ||
            typeof command.titleId !== 'string' || !gameTitles.has(command.titleId)) {
          safeEmit('action-rejected', {message:'Choose one game from this session’s OunceCake list.'}); return;
        }
        awaitingGame = false;
        homebrewChild.stdin.write(JSON.stringify({action:'select-game',titleId:command.titleId}) + '\n'); return;
      }
      if (command.action === 'dump-system-code') {
        if (!rpcHeldConfirmed || dumpTask || dumpBusy || helper || statusBusy || preflightBusy || cleanupBlocked ||
            failure || homebrewChild && (!homebrewRunning || homebrewSettled)) {
          safeEmit('action-rejected', {action:'dump-system-code',
            message:'Wait for a verified held RPC session and a safely running or stopped app before dumping system code.'});
          return;
        }
        dumpBusy = true;
        dumpTask = dumpFromHeldRPC().catch(error => {
          fail(error.message); finish('The system-code dump did not finish.');
        }).finally(() => {dumpBusy = false;});
        return;
      }
      if (command.action === 'list-izlauncher-modules') {
        if (!availableHomebrew(root, 'izlauncher')) {
          safeEmit('action-rejected',{action:'list-izlauncher-modules',message:'IZlauncher is unavailable in this build.'}); return;
        }
        if (!rpcHeldConfirmed || homebrewAttempted || preflightBusy || dumpBusy) {
          safeEmit('action-rejected',{action:'list-izlauncher-modules',message:'Hold RPC before listing IZlauncher modules.'}); return;
        }
        try {const modules=await (listIZlauncherModules||require('./izlauncher-modules.cjs').catalog)(root);
          if (!finishing) safeEmit('izlauncher-catalog',{modules});}
        catch(error){if (!finishing) safeEmit('action-rejected',{action:'list-izlauncher-modules',message:'IZlauncher module list failed: '+error.message});}
        return;
      }
      if (command.action === 'load-izlauncher-modules') {
        if (homebrewApplication!=='izlauncher'||!homebrewRunning||!homebrewChild?.stdin?.writable||
            !require('./izlauncher-modules.cjs').validIds(command.ids)||!command.ids.length) {
          safeEmit('action-rejected',{action:'load-izlauncher-modules',message:'Select compatible modules while IZlauncher is running.'}); return;
        }
        homebrewChild.stdin.write(JSON.stringify({action:'load-modules',ids:command.ids})+'\n');return;
      }
      if (['launch-ouncecake','launch-mintbrew','launch-izlauncher','launch-custom-homebrew'].includes(command.action)) {
        if (!availableHomebrew(root, command.action.slice('launch-'.length))) {
          safeEmit('action-rejected',{action:command.action,message:'This homebrew option is unavailable in this build.'}); return;
        }
        if (command.action === 'launch-izlauncher' && command.moduleIds !== undefined &&
            !require('./izlauncher-modules.cjs').validIds(command.moduleIds)) {
          safeEmit('action-rejected',{action:'launch-izlauncher',message:'Choose up to 15 distinct compatible IZlauncher modules.'}); return;
        }
        if (command.action === 'launch-izlauncher' && command.moduleFolderPath !== undefined &&
            (typeof command.moduleFolderPath !== 'string' || !path.isAbsolute(command.moduleFolderPath) ||
             command.moduleFolderPath.length > 4096 || /[\x00\r\n]/.test(command.moduleFolderPath))) {
          safeEmit('action-rejected', {action:'launch-izlauncher',message:'Choose a valid local IZlauncher module folder.'}); return;
        }
        if (command.action === 'launch-custom-homebrew' &&
            (typeof command.customHomebrewPath !== 'string' || !path.isAbsolute(command.customHomebrewPath) ||
             command.customHomebrewPath.length > 4096 || /[\x00\r\n]/.test(command.customHomebrewPath))) {
          safeEmit('action-rejected', {message:'Choose a valid local custom homebrew folder.'}); return;
        }
        if (command.action === 'launch-ouncecake' && !net.isIPv4(command.consoleAddress)) {
          safeEmit('action-rejected', {message:'Enter the Switch’s IPv4 address for OunceCake FTP.'}); return;
        }
        if (command.action === 'launch-mintbrew' && (command.addonUrls !== undefined &&
            (!Array.isArray(command.addonUrls) || command.addonUrls.length > 32 ||
             command.addonUrls.some(url => typeof url !== 'string' || url.length > 4096)) ||
            command.libraryItems !== undefined && (!Array.isArray(command.libraryItems) || command.libraryItems.length > 500 ||
             command.libraryItems.some(item => !item || typeof item !== 'object' || Array.isArray(item))))) {
          safeEmit('action-rejected', {message:'The add-on configuration is invalid.'}); return;
        }
        if (command.action === 'launch-mintbrew' && command.quality !== undefined &&
            !['720p','540p','360p','180p'].includes(command.quality)) {
          safeEmit('action-rejected', {message:'Choose a supported Stremio quality.'}); return;
        }
        if (!rpcHeldConfirmed || homebrewAttempted || helper || statusBusy || preflightBusy || dumpBusy) {
          safeEmit('action-rejected', {message: 'Homebrew requires this session’s held RPC and can be launched only once.'}); return;
        }
        if (command.action === 'launch-custom-homebrew') {
          preflightBusy = true;
          preflightTask = (async () => {
            let prepared;
            try {
              const homebrewModule=require('./gui-homebrew.cjs');
              prepared = await (preflightCustomApp || homebrewModule.preflightCustomHomebrew ||
                homebrewModule.preflightCustomApp)(root,command.customHomebrewPath);
              if (finishing || closed) return;
              if (prepared.kind === 'rpc-app' && prepared.adapter === 'ouncecake' && !net.isIPv4(command.consoleAddress))
                throw Error('Enter the Switch’s IPv4 address for OunceCake-compatible FTP.');
              homebrewAttempted = true;
              safeEmit('homebrew-accepted', {action:'launch-custom-homebrew',
                customHomebrewKind:prepared.kind||'gpu-app',adapter:prepared.adapter,
                message:'Validated '+prepared.app.name+'. Opening the selected app.'});
              const staged = prepared;
              prepared = null;
              homebrewTask = homebrew('custom-homebrew',{
                customHomebrewPath:staged.kind==='launcher'?staged.launcherFolder:
                  staged.kind==='rpc-app'?staged.packageFolder:staged.appFolder,
                customHomebrewKind:staged.kind||'gpu-app',adapter:staged.adapter,
                ...(staged.adapter==='ouncecake'?{consoleAddress:command.consoleAddress,port:2121}:{})}).catch(error => {
                fail(error.message);safeEmit('homebrew-failed', {path:directory,
                  message:error.message+' Finish RPC and restart the console. This launch was not retried.',cleanupBlocked});
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
        if (command.action === 'launch-izlauncher' && command.moduleFolderPath) {
          preflightBusy = true;
          preflightTask = (async () => {
            let prepared;
            try {
              prepared = await require('./stage-custom-izmodule.cjs').stage(root,command.moduleFolderPath);
              if (finishing || closed) return;
              homebrewAttempted = true;
              safeEmit('homebrew-accepted', {action:'launch-izlauncher',
                message:'Added '+prepared.name+' '+prepared.version+' to this session. Opening IZlauncher.'});
              const moduleIds=[...new Set([...(command.moduleIds||[]),prepared.id])];
              if(moduleIds?.length>15)throw Error('Choose no more than 15 IZlauncher modules, including the custom module.');
              prepared = null;
              homebrewTask = homebrew('izlauncher',{moduleIds}).catch(error => {
                cleanupBlocked = true;fail(error.message);safeEmit('homebrew-failed', {path:directory,
                  message:error.message+' Finish RPC and restart the console. This launch was not retried.',cleanupBlocked});
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
        homebrewAttempted = true;
        const application = command.action.slice('launch-'.length);
        homebrewTask = homebrew(application, application === 'ouncecake' ? {consoleAddress:command.consoleAddress,port:2121} :
          {addonUrls: command.addonUrls || [], libraryItems: command.libraryItems || [],
            ...(application === 'mintbrew' ? {quality:command.quality ?? '720p'} : {}),
            ...(command.action === 'launch-izlauncher' && Array.isArray(command.moduleIds) ? {moduleIds:command.moduleIds} : {}),
            ...(command.action === 'launch-custom-homebrew' ? {customHomebrewPath:command.customHomebrewPath} : {})}).catch(error => {
          if (nativeCleanupApps.has(application)) cleanupBlocked = true;
          fail(error.message); safeEmit('homebrew-failed', {path: directory,
            message: error.message + ' Finish RPC and restart the console. This launch was not retried.',cleanupBlocked});
        });
        return;
      }
      if (command.action === 'rpc-status') {
        if (statusBusy || helper || homebrewAttempted || preflightBusy || dumpBusy) {safeEmit('action-rejected', {message: 'Wait for the current operation to finish.'}); return;}
        statusBusy = true; safeEmit('rpc-status-started', {message: 'Checking the held RPC connection.'});
        try {
          const result = await require(path.join(folder, 'rpc.cjs')).request(directory, {command: 'status'});
          safeEmit('rpc-status', {ready: result?.ready === true, calls: result?.calls,
            message: result?.ready === true ? 'RPC is connected.' : 'RPC is not ready.'});
        } catch (error) {safeEmit('rpc-status', {ready: false, message: 'RPC status failed: ' + error.message});}
        finally {statusBusy = false;}
        return;
      }
      if (command.action !== 'post-run' || typeof command.keepRPC !== 'boolean' ||
          typeof command.dumpFirmware !== 'boolean' || choiceMade) {
        safeEmit('action-rejected', {message: 'Choose post-run options once for this session.'}); return;
      }
      choiceMade = true;
      if (command.dumpFirmware) dumpTask = dump(command.keepRPC).catch(error => {fail(error.message); finish('The dump did not finish.');});
      else if (command.keepRPC) held();
      else finish();
    }
    const inputEnd = () => finish('The app closed its session controls.');
    lines(input, line => {control(line).catch(error => {fail(error.message); finish();});}, 4 * 1024 * 1024);
    input.once('end', inputEnd); input.resume();
    const outcome = await runnerDone;
    closed = true; clearTimeout(finishTimer);
    await preflightTask?.catch(()=>{});
    if (homebrewChild) {
      fail('The original RPC session ended while homebrew was active. Restart the console.');
      // when the original connection disappears, no further native cleanup is
      // trustworthy. Only end the local helper; the console must be restarted.
      if (nativeCleanupApps.has(homebrewApplication)) cleanupBlocked = true;
      stopHomebrew(); await homebrewTask;
    }
    if (helper) {
      fail('The host ended during the firmware dump. Restart the console before retrying.');
      signalGroup(helper, 'SIGTERM');
      helperTimer = setTimeout(() => signalGroup(helper, 'SIGKILL'), 2000); helperTimer.unref();
    }
    if (dumpTask) await dumpTask;
    input.removeListener('end', inputEnd); input.pause();
    let result;
    if (directory) {try {result = privateJSON(path.join(directory, 'result.json'));} catch (error) {fail(error.message);}}
    if (networkFailure) {
      const retrySafe = !published && !progressed && !ready && !failure;
      const message = networkUnavailableMessage(address);
      safeEmit(retrySafe ? 'network-unavailable' : 'failed', {...networkFailure, retrySafe,
        message: retrySafe ? message : message + ' Pairing or console activity may have started. Stop the session and restart the console before retrying.'});
      return 1;
    }
    if (!failure && ready && outcome.code === 0 && !outcome.signal && !outcome.error &&
        verifiedResult(result) && result.rpc?.mode === 'held' && result.rpc?.state === 'closed' &&
        typeof result.completed === 'string' && !result.error &&
        (!result.cleanupErrors || result.cleanupErrors.length === 0)) {
      safeEmit('verified', {message: homebrewAttempted ?
        'FS execution and fork cleanup verified; Homebrew workers stopped. Restart the console to release retained graphics allocations.' :
        'FS execution verified; held RPC closed and all resources cleaned up.'});
      return 0;
    }
    if (cancelBeforeReady && !failure) {
      safeEmit('cancelled', {message: 'Session stopped. Restart the console before another exploit attempt.'}); return 130;
    }
    safeEmit('failed', {path: dumpDirectory, message: failure || result?.error || outcome.error?.message ||
      'The host ended without verified cleanup. Restart the console before retrying.'});
    return outcome.code || 1;
  } finally {
    clearTimeout(finishTimer); clearTimeout(helperTimer); clearTimeout(homebrewStopTimer);
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    // keep the stdout error listener through process exit so a late epipe cannot
    // interrupt cleanup or turn a clean shutdown into an uncaught exception.
    if (published) {
      try {if (fs.readFileSync(active, 'utf8').startsWith(`${runner.pid}\n`)) fs.unlinkSync(active);} catch {}
    }
    if (!closed && runner?.pid) signalGroup(runner, 'SIGKILL');
    if (helper?.pid) signalGroup(helper, 'SIGKILL');
    if (homebrewChild?.pid) signalGroup(homebrewChild, 'SIGKILL');
    fs.rmSync(controls, {recursive: true, force: true});
  }
}
module.exports = {main, heldResult, heldMessage};
