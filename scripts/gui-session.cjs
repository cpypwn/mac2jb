#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {networkBindFailure, networkUnavailableMessage} = require('./gui-host.cjs');
const {incompatibleLegacyStartHint, selectedProfile} = require('./host-profiles.cjs');
const {releaseMarkers} = require('./homebrew-reentry.cjs');
const heldMessage = '4/4 verified. SmileBASIC RPC and FS memory endpoint remain live while this process and the app stay open.';
const homebrewScripts = Object.freeze({
  ouncecake: 'scripts/gui-ouncecake.cjs',
  mintbrew: 'scripts/gui-mintbrew.cjs',
  'native-hblauncher': 'scripts/gui-native-hblauncher.cjs',
  'custom-homebrew': 'scripts/gui-custom-homebrew.cjs'
});
const nativeCleanupApps = new Set(['ouncecake', 'mintbrew', 'native-hblauncher', 'custom-homebrew']);
const artemisGameNames = Object.freeze({
  seedsow: 'Seedsow Lullaby',
  nora: 'Nora Princess 2',
  nora1: 'Nora, Princess and Stray Cat HD',
  hamidashi: 'Hamidashi Creative'
});

function availableHomebrew(root, application) {
  const marker = path.join(root, 'packaging/runtime-homebrew.json');
  if (!fs.existsSync(marker)) return true;
  try {
    const allowed = JSON.parse(fs.readFileSync(marker, 'utf8')).allowed;
    return Array.isArray(allowed) && allowed.includes(application);
  } catch { return false; }
}

function validLocalFTPURL(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'ftp:' && url.hostname === '127.0.0.1' &&
      Number(url.port) > 0 && Number(url.port) < 65536 &&
      url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
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
function validSavekitToolEvent(event, action, root) {
  if (!event || typeof event !== 'object' ||
      !['progress', 'accounts', 'titles', 'inventory', 'listing', 'backup', 'complete', 'failed'].includes(event.type) ||
      typeof event.message !== 'string' || Buffer.byteLength(event.message) > 512 ||
      /[\x00-\x1f\x7f]/.test(event.message)) return false;
  if (event.unsafe !== undefined && !(event.type === 'failed' && event.unsafe === true)) return false;
  if (event.safeToContinue !== undefined &&
      !(event.type === 'failed' && event.safeToContinue === true && event.unsafe !== true)) return false;
  if (event.type === 'complete' && event.action !== action) return false;
  if (event.type === 'accounts') return action === 'accounts' && Array.isArray(event.users) &&
    event.users.length <= 8 && new Set(event.users).size === event.users.length &&
    event.users.every(uid => typeof uid === 'string' && /^[a-f0-9]{32}$/.test(uid));
  if (event.type === 'titles') return action === 'titles' && Array.isArray(event.titles) &&
    event.titles.length <= 2048 && new Set(event.titles).size === event.titles.length &&
    event.titles.every(id => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id)) &&
    (event.names === undefined || event.names && typeof event.names === 'object' &&
      !Array.isArray(event.names) && Object.keys(event.names).length <= 2048 &&
      Object.entries(event.names).every(([id, name]) => event.titles.includes(id) &&
        typeof name === 'string' && Buffer.byteLength(name) >= 1 &&
        Buffer.byteLength(name) <= 160 &&
        !/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(name)));
  if (event.type === 'inventory') return action === 'inventory' &&
    Array.isArray(event.inventory) && event.inventory.length <= 256 &&
    Number.isSafeInteger(event.inventoryTotal) && event.inventoryTotal >= event.inventory.length && event.inventoryTotal <= 32768 &&
    Number.isSafeInteger(event.failedSpaces) && event.failedSpaces >= 0 && event.failedSpaces <= 8 &&
    event.truncated === (event.inventoryTotal > event.inventory.length) &&
    typeof event.reportPath === 'string' &&
    path.resolve(event.reportPath).startsWith(path.join(root, 'savekit-exports') + path.sep) &&
    event.inventory.every(entry => entry && typeof entry.id === 'string' && /^\d{1,20}$/.test(entry.id) &&
      typeof entry.titleId === 'string' && /^[a-f0-9]{16}$/.test(entry.titleId) &&
      typeof entry.uid === 'string' && /^[a-f0-9]{32}$/.test(entry.uid) &&
      Number.isInteger(entry.space) && entry.space >= 0 && entry.space <= 255 &&
      Number.isInteger(entry.type) && entry.type >= 0 && entry.type <= 255 &&
      Number.isInteger(entry.rank) && entry.rank >= 0 && entry.rank <= 1 &&
      Number.isSafeInteger(entry.index) && entry.index >= 0 && entry.index <= 65535 &&
      typeof entry.size === 'string' && /^\d{1,20}$/.test(entry.size));
  if (event.type === 'listing') return action === 'inspect' &&
    Array.isArray(event.entries) && event.entries.length <= 256 &&
    event.entries.every(entry => typeof entry.path === 'string' && entry.path.startsWith('/') &&
      entry.path.length <= 1024 && !/[\x00-\x1f\x7f]/.test(entry.path) &&
      (entry.size === null || Number.isSafeInteger(entry.size) && entry.size >= 0)) &&
    Number.isSafeInteger(event.files) && event.files >= 0 &&
    Number.isSafeInteger(event.bytes) && event.bytes >= 0;
  if (event.type === 'backup' || event.backupPath !== undefined) {
    if (typeof event.backupPath !== 'string' ||
        !path.resolve(event.backupPath).startsWith(path.join(root, 'savekit-exports') + path.sep)) return false;
  }
  if (event.type === 'backup') return Number.isSafeInteger(event.files) && event.files >= 0 &&
    Number.isSafeInteger(event.bytes) && event.bytes >= 0;
  if (event.type === 'progress') return typeof event.stage === 'string' &&
    /^[a-z-]{1,32}$/.test(event.stage);
  return true;
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
  seedsowSave = false, savekitTools = false,
  preflightCustomApp}) {
  if (!net.isIPv4(address)) throw Error('Choose the Mac’s LAN IPv4 address.');
  if ((seedsowSave || savekitTools) &&
      !selectedProfile(root).supportsSaveKit)
    throw Error('Seedsow and SaveKit operations require a SaveKit-capable host.');
  const folder = seedsowSave || savekitTools ? require('./prepare-seedsow-host.cjs').prepare(root) :
    path.join(root, 'vendor/ns2jb');
  const runs = path.join(folder, 'runs');
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
  let modloaderChild, modloaderTask, modloaderBusy = false, modloaderStarted = false, modloaderReady = false;
  let savekitChild, savekitTask, savekitBusy = false, savekitCompleted = false, savekitSkipped = false, savekitStage;
  let savekitCustom = false, savekitGame, savekitVariant,
    savekitSelected = false, savekitFinishedForHomebrew = false;
  let savekitUsers = new Set(), savekitFailurePublished = false;
  let toolChild, toolTask, toolBusy = false, toolAction, savekitSaveTouched = false;
  let savekitToolFailed = false;
  let preflightBusy = false, preflightTask;
  let homebrewRunning = false, homebrewSettled = false, homebrewStopTimer, homebrewFailurePublished = false;
  let homebrewStopRequested = false;
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
    if (savekitChild && savekitStage !== 'writing') signalGroup(savekitChild, 'SIGTERM');
    if (toolChild && !['write', 'delete'].includes(toolAction)) signalGroup(toolChild, 'SIGTERM');
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
      if (savekitChild) savekitTask.finally(releaseRunner);
      else if (toolChild) toolTask.finally(releaseRunner);
      else if (homebrewChild) {stopHomebrew(); homebrewTask.finally(releaseRunner);}
      else if (modloaderChild) {
        fail('The modloader was interrupted. Restart the Switch before trying again.');
        signalGroup(modloaderChild, 'SIGTERM');
        modloaderTask.finally(releaseRunner);
      }
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
        if (homebrewChild || homebrewAttempted && !homebrewSettled || cleanupBlocked || failure)
          throw Error('The current app did not confirm safe shutdown. The system-code dump was not started.');
      }
      if (finishing || closed) return;
      const status = await require(path.join(folder, 'rpc.cjs')).request(directory, {command: 'status'});
      if (status?.ready !== true) throw Error('The held RPC session is no longer ready for the system-code dump.');
      if (finishing || closed) return;
      await dump(true);
    }
    async function installSeedsowSave(sourcePath, artemisGame, balatroVariant, variant) {
      savekitBusy = true;
      const previousSavekitCompleted = savekitCompleted;
      savekitCompleted = false; savekitSkipped = false; savekitStage = undefined;
      savekitFailurePublished = false; savekitUsers.clear();
      let preSaveFailure, absentSaveFailure, unchangedSaveFailure, verifiedBackupPath;
      savekitChild = spawn(process.execPath,
        [path.join(root, 'scripts/gui-savekit.cjs'), directory,
          ...(balatroVariant ? ['--balatro', balatroVariant] :
            artemisGame === 'gravcirc' ? ['--gravcirc'] :
            artemisGame ? ['--artemis', artemisGame,
              ...(artemisGame === 'seedsow' && variant === 'full' ? ['full'] : [])] :
              variant === 'pro' ? ['--editor-pro'] : sourcePath ? [sourcePath] : [])],
        {cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
      const child = savekitChild, done = finished(child);
      child.stdin.on('error', error => {if (error.code !== 'EPIPE') fail('Could not select the save user.');});
      const observe = line => {
        if (!line.startsWith('MAC2JB_SAVEKIT ')) {safeEmit('log', {message: line}); return;}
        let event;
        try {event = JSON.parse(line.slice('MAC2JB_SAVEKIT '.length));}
        catch {fail('The save worker returned invalid progress.'); return;}
        if (!event || !['progress','choose-user','backup','complete','skipped','failed'].includes(event.type) ||
            typeof event.message !== 'string' || Buffer.byteLength(event.message) > 512 ||
            /[\x00-\x1f\x7f]/.test(event.message) ||
            artemisGame && event.game !== artemisGame) {
          fail('The save worker returned invalid progress.'); return;
        }
        if (event.type === 'progress') {
          savekitStage = event.stage;
          safeEmit('savekit-progress', {game: artemisGame, stage: event.stage, message: event.message});
        } else if (event.type === 'choose-user') {
          if (!Array.isArray(event.users) || event.users.length < 2 || event.users.length > 8 ||
              event.users.some(uid => typeof uid !== 'string' || !/^[a-f0-9]{32}$/.test(uid)) ||
              new Set(event.users).size !== event.users.length) {
            fail('The save worker returned an invalid account list.');
            child.kill('SIGTERM'); return;
          }
          savekitUsers = new Set(event.users);
          savekitStage = 'choose-user';
          safeEmit('savekit-choose-user', {game: artemisGame, users: event.users, message: event.message});
        } else if (['backup', 'complete', 'skipped'].includes(event.type)) {
          const backup = typeof event.backupPath === 'string' && path.resolve(event.backupPath);
          const backupRoot = path.join(root, artemisGame === 'balatro' ? 'balatro-backups' :
            artemisGame === 'gravcirc' ? 'gravcirc-backups' :
            artemisGame ? 'artemis-backups' : 'seedsow-backups');
          if (!backup || !backup.startsWith(backupRoot + path.sep) ||
              artemisGame && !path.basename(backup).startsWith(artemisGame + '-')) {
            fail('The save worker reported an invalid backup path.');
            child.kill('SIGTERM'); return;
          }
          if (event.type === 'backup') verifiedBackupPath = backup;
          if (event.type === 'complete' || event.type === 'skipped') {
            if (!Number.isSafeInteger(event.files) || event.files < 1 ||
                event.files > (event.type === 'skipped' ? 2048 : 500)) {
              fail('The save worker reported an invalid file count.'); return;
            }
            savekitCompleted = true;
            savekitSkipped = event.type === 'skipped';
            child.stdin.end();
          }
          safeEmit('savekit-' + event.type,
            {game: artemisGame, backupPath: backup, files: event.files, message: event.message});
        } else {
          if (event.reason === 'save-absent' && savekitStage === 'backup' && !event.backupPath) {
            absentSaveFailure = event.message;
            return;
          }
          if (event.reason === 'save-unchanged' && savekitStage === 'writing' &&
              typeof event.backupPath === 'string' && path.isAbsolute(event.backupPath) &&
              path.resolve(event.backupPath) === verifiedBackupPath) {
            unchangedSaveFailure = event.message;
            return;
          }
          if (event.reason === 'save-preflight' && savekitStage === 'backup' &&
              typeof event.backupPath === 'string' && path.isAbsolute(event.backupPath) &&
              path.resolve(event.backupPath) === verifiedBackupPath) {
            preSaveFailure = event.message;
            return;
          }
          if (artemisGame && savekitStage === 'checking' && !event.backupPath) {
            preSaveFailure = event.message;
            return;
          }
          savekitFailurePublished = true;
          fail(event.message);
          safeEmit('savekit-failed', {game: artemisGame, backupPath: event.backupPath, message: event.message});
        }
      };
      lines(child.stdout, observe, 1024 * 1024);
      lines(child.stderr, observe);
      const outcome = await done;
      savekitChild = undefined; savekitUsers.clear();
      if (outcome.error || outcome.code !== 0 || outcome.signal || !savekitCompleted) {
        if (unchangedSaveFailure && savekitStage === 'writing' &&
            !outcome.error && !outcome.signal && outcome.code === 1 && !failure) {
          savekitBusy = false; savekitTask = undefined; savekitStage = undefined;
          savekitCompleted = previousSavekitCompleted;
          savekitFailurePublished = false; savekitGame = undefined; savekitCustom = false;
          safeEmit('savekit-recoverable', {game: artemisGame,
            backupPath: verifiedBackupPath, message: unchangedSaveFailure});
          return;
        }
        if (absentSaveFailure && savekitStage === 'backup' &&
            !outcome.error && !outcome.signal && outcome.code === 1 && !failure) {
          savekitBusy = false; savekitTask = undefined; savekitStage = undefined;
          savekitCompleted = previousSavekitCompleted;
          savekitFailurePublished = false; savekitGame = undefined; savekitCustom = false;
          safeEmit('savekit-recoverable', {game: artemisGame, message: absentSaveFailure});
          return;
        }
        if (preSaveFailure && ['checking', 'backup'].includes(savekitStage) &&
            !outcome.error && !outcome.signal && outcome.code === 1 && !failure) {
          let rpcReady = false;
          try {
            rpcReady = (await require(path.join(folder, 'rpc.cjs')).request(directory,
              {command: 'status'}))?.ready === true;
          } catch {}
          if (rpcReady) {
            savekitBusy = false; savekitTask = undefined; savekitStage = undefined;
            savekitCompleted = previousSavekitCompleted;
            savekitFailurePublished = false; savekitGame = undefined; savekitCustom = false;
            safeEmit('savekit-recoverable', {game: artemisGame,
              message: preSaveFailure + ' Held RPC is still ready; choose another action.'});
            return;
          }
        }
        savekitBusy = false;
        fail('Save installation did not finish. Keep the backup and restart the console.');
        if (!savekitFailurePublished) safeEmit('savekit-failed',
          {game: artemisGame, message: failure + ' This write was not retried.'});
        finish('Save installation stopped.');
      } else {
        savekitBusy = false;
        savekitFinishedForHomebrew = true;
        safeEmit('savekit-ready', {game: artemisGame, message: savekitSkipped
          ? 'Existing save preserved. Held RPC is ready for homebrew or a game save backup.'
          : `${artemisGame === 'balatro' ? 'Balatro' :
            artemisGame === 'gravcirc' ? 'Gravity Circuit' :
            artemisGame ? 'Artemis launcher' : 'Seedsow'} save installed and verified. Held RPC is ready for homebrew or a game save backup.`});
      }
    }
    async function runSavekitTool(value, rawRequest) {
      toolBusy = true; toolAction = value.action;
      let completed = false, failureEvent, completionEvent, invalid = false;
      toolChild = spawn(process.execPath,
        [path.join(root, 'scripts/gui-savekit-tools.cjs'), directory],
        {cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
      const child = toolChild, done = finished(child);
      child.stdin.on('error', error => {
        if (error.code !== 'EPIPE') fail('Could not start the save data operation.');
      });
      child.stdin.end(JSON.stringify(rawRequest) + '\n');
      const observe = line => {
        if (!line.startsWith('MAC2JB_SAVEKIT ')) {safeEmit('log', {message: line}); return;}
        let event;
        try {event = JSON.parse(line.slice('MAC2JB_SAVEKIT '.length));}
        catch {event = undefined;}
        if (!validSavekitToolEvent(event, value.action, root)) {
          invalid = true;
          signalGroup(child, 'SIGTERM');
          return;
        }
        if (event.type === 'complete') {completed = true; completionEvent = event; return;}
        if (event.type === 'failed') {failureEvent = event; return;}
        const {type, ...fields} = event;
        safeEmit('savekit-tool-' + type, fields);
      };
      lines(child.stdout, observe, 1024 * 1024);
      lines(child.stderr, line => safeEmit('log', {message: line}));
      const outcome = await done;
      toolChild = undefined; toolBusy = false; toolAction = undefined;
      if (!outcome.error && outcome.code === 0 && !outcome.signal && completed && !invalid) {
        const {type, ...fields} = completionEvent;
        safeEmit('savekit-tool-complete', fields);
      } else {
        let safeToContinue = false;
        if (!invalid && !outcome.error && !outcome.signal && outcome.code === 1 &&
            !completed && failureEvent?.safeToContinue === true) {
          try {
            safeToContinue = (await require(path.join(folder, 'rpc.cjs')).request(directory,
              {command: 'status'}))?.ready === true;
          } catch {}
        }
        savekitToolFailed = !safeToContinue;
        const message = invalid ? 'The save data worker returned invalid progress.' :
          'The save data operation did not finish. Check the log and keep any backup.';
        if (failureEvent) {
          const {type, ...fields} = failureEvent;
          safeEmit('savekit-tool-failed', {...fields, safeToContinue,
            message: safeToContinue ? fields.message + ' Held RPC is ready; choose another save action or Done.' : fields.message});
        } else safeEmit('savekit-tool-failed', {action: value.action, message});
        if (!safeToContinue &&
            (['write', 'restore', 'delete', 'titles'].includes(value.action) || failureEvent?.unsafe === true)) {
          cleanupBlocked = true;
          fail(message + ' Restart the console before another save operation.');
          finish('Save data operation stopped.');
        }
      }
    }
    async function homebrew(application, config = {}) {
      homebrewApplication = application;
      homebrewAdapter = config.adapter;
      homebrewStopRequested = false;
      const ouncecakeMode = application === 'ouncecake' ||
        application === 'custom-homebrew' && config.customHomebrewKind === 'rpc-app' && config.adapter === 'ouncecake';
      let retrySafeFailure, cleanStopProof;
      const script = homebrewScripts[application];
      const configurable = application === 'mintbrew' || application === 'ouncecake' ||
        application === 'custom-homebrew' && config.customHomebrewKind === 'rpc-app';
      homebrewChild = spawn(process.execPath, [path.join(root, script), directory,
        ...(application === 'native-hblauncher' ? ['--sd-rom-folder', config.sdRomFolder] : []),
        ...(application === 'native-hblauncher' && config.nativeAppFolder ?
          ['--app-folder', config.nativeAppFolder] : []),
        ...(application === 'custom-homebrew' ? [
          config.customHomebrewKind==='launcher'?'--launcher-folder':
            config.customHomebrewKind==='rpc-app'?'--rpc-folder':'--app-folder', config.customHomebrewPath] : [])], {
        cwd: root, detached: true, stdio: [configurable ? 'pipe' : 'ignore', 'pipe', 'pipe']
      });
      if (configurable) {
        homebrewChild.stdin.on('error', error => {if (error.code !== 'EPIPE') fail('Could not configure the selected app.');});
        homebrewChild.stdin.write(JSON.stringify(config) + '\n');
        if (application === 'mintbrew') homebrewChild.stdin.end();
      }
      const child = homebrewChild, done = finished(child);
      const observe = line => {
        if (!line.startsWith('MAC2JB_HOMEBREW ')) {
          if (/^(?:MintBrew|HBLauncher|GPUBrewLauncher) continuous: \d+ frames \/ \d+\.\d{3}s$/.test(line)) return;
          safeEmit('log', {message: line}); return;
        }
        let event;
        try {event = JSON.parse(line.slice('MAC2JB_HOMEBREW '.length));}
        catch {safeEmit('log', {message: 'Invalid homebrew event.'}); return;}
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          safeEmit('log', {message: 'Invalid homebrew event.'}); return;
        }
        if (event.type === 'account-progress') {
          if (application === 'mintbrew' && event.watchProgress && typeof event.watchProgress === 'object' && !Array.isArray(event.watchProgress))
            safeEmit('account-progress', {watchProgress: event.watchProgress});
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
             event.httpURL !== `http://${config.consoleAddress}:2121/` ||
             application === 'ouncecake' && config.mode === 'ftp' && !validLocalFTPURL(event.ftpURL))) {
          fail('OunceCake did not confirm the selected file-service endpoint.'); stopHomebrew(); return;
        }
        if (nativeCleanupApps.has(application) && event.cleanupBlocked === true) {
          cleanupBlocked = true; fail('The selected app could not confirm native shutdown. Restart the console before stopping this session.');
        }
        const wasRunning = homebrewRunning;
        if (event.type === 'running') homebrewRunning = true;
        if (event.type === 'stopped' || event.type === 'failed') {homebrewRunning = false; homebrewSettled = true;}
        if (event.type === 'stopped') cleanStopProof = event;
        if (event.type === 'failed') {
          if (event.retrySafe === true && !wasRunning && !cleanupBlocked && !finishing) retrySafeFailure = event;
          else {fail(event.message || 'The selected homebrew app failed. Restart the console.'); homebrewFailurePublished = true;}
        }
        if (retrySafeFailure) return;
        safeEmit('homebrew-' + event.type, {path: event.path || directory, message: event.message,
          ...(['mintbrew','native-hblauncher'].includes(application) ? {cleanupBlocked} : {}),
          ...(ouncecakeMode ? {host:event.host,port:event.port,httpURL:event.httpURL,
            ...(event.ftpURL && validLocalFTPURL(event.ftpURL) ? {ftpURL:event.ftpURL} : {}),cleanupBlocked} : {})});
      };
      lines(child.stdout, observe, 1024 * 1024); lines(child.stderr, observe);
      const outcome = await done;
      clearTimeout(homebrewStopTimer); homebrewStopTimer = undefined;
      homebrewChild = undefined; homebrewRunning = false; homebrewStopRequested = false;
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
      } else if (cleanStopProof?.cleanupVerified === true && !failure && !cleanupBlocked && !closed && !finishing) {
        try {
          const status = await require(path.join(folder, 'rpc.cjs')).request(directory, {command: 'status'});
          if (finishing || closed) return;
          if (status?.ready !== true) throw Error('The held RPC session is no longer ready.');
        } catch (error) {
          if (finishing || closed) return;
          fail(error.message);
          safeEmit('homebrew-failed', {path: directory, message: error.message});
          return;
        }
        try {
          releaseMarkers(directory, cleanStopProof, ouncecakeMode);
        } catch (error) {
          safeEmit('homebrew-reentry-unavailable', {message: 'Another launch is unavailable: ' + error.message + ' Finish this session before trying another app.'});
          return;
        }
        homebrewAttempted = false; homebrewSettled = false; homebrewApplication = undefined;
        homebrewAdapter = undefined; homebrewFailurePublished = false;
        awaitingGame = false; gameTitles.clear();
        safeEmit('homebrew-ready', {message: 'RPC is ready. Choose another homebrew app.'});
      } else if (!failure && !cleanupBlocked && !closed && !finishing && homebrewSettled) {
        safeEmit('homebrew-reentry-unavailable', {
          message: 'The launcher stopped, but it did not prove cleanup for another launch. Finish this session before trying another app.'});
      }
    }
    async function runModloader(modsFolder) {
      let failedEvent, readyEvent;
      modloaderChild = spawn(process.execPath,
        [path.join(root, 'scripts/gui-modloader.cjs'), directory, modsFolder], {
          cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe']
        });
      const child = modloaderChild, done = finished(child);
      const observe = line => {
        if (!line.startsWith('MAC2JB_MODLOADER ')) {
          safeEmit('log', {message: line}); return;
        }
        let event;
        try {event = JSON.parse(line.slice('MAC2JB_MODLOADER '.length));}
        catch {safeEmit('log', {message: 'Invalid modloader event.'}); return;}
        if (!event || typeof event.message !== 'string' ||
            Buffer.byteLength(event.message) > 512 || /[\x00-\x1f\x7f]/.test(event.message)) return;
        if (event.type === 'started' && !modloaderStarted) {
          modloaderStarted = true;
          homebrewAttempted = true;
          safeEmit('modloader-started', {message: event.message});
        } else if (event.type === 'progress' && modloaderStarted && !modloaderReady) {
          safeEmit('modloader-progress', {message: event.message});
        } else if (event.type === 'ready' && modloaderStarted && !readyEvent &&
                   typeof event.path === 'string' && path.dirname(event.path) === directory) {
          readyEvent = event;
        } else if (event.type === 'failed' && !failedEvent) {
          failedEvent = event;
        }
      };
      lines(child.stdout, observe); lines(child.stderr, observe);
      const outcome = await done;
      modloaderChild = undefined;
      modloaderBusy = false;
      if (failedEvent && !closed && !finishing) {
        const retrySafe = failedEvent.retrySafe === true && !modloaderStarted;
        if (!retrySafe) {
          homebrewAttempted = true;
          fail(failedEvent.message);
        }
        safeEmit('modloader-failed', {message: failedEvent.message, retrySafe});
      } else if (readyEvent && !outcome.error && outcome.code === 0 && !outcome.signal &&
          !closed && !finishing) {
        modloaderReady = true;
        safeEmit('modloader-ready', {path: readyEvent.path, message: readyEvent.message});
      } else if (!closed && !finishing) {
        homebrewAttempted = true;
        fail('Modloader ended without confirming the game handoff. Restart the Switch before trying again.');
        safeEmit('modloader-failed', {message: failure, retrySafe: false});
      }
    }
    async function control(line) {
      let command;
      try {command = JSON.parse(line);} catch {safeEmit('action-rejected', {message: 'Invalid session action.'}); return;}
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        safeEmit('action-rejected', {message: 'Invalid session action.'}); return;
      }
      if (!ready || closed || finishing) {safeEmit('action-rejected', {message: 'The session is not ready for this action.'}); return;}
      if ((modloaderBusy || modloaderStarted || modloaderReady) && command.action !== 'finish') {
        safeEmit('action-rejected', {action: command.action,
          message: 'Modloader is the final action for this boot. Finish the session before launching the game.'});
        return;
      }
      if (command.action === 'select-seedsow-user') {
        if (!(seedsowSave || savekitTools) || savekitStage !== 'choose-user' || !savekitChild?.stdin?.writable ||
            typeof command.uid !== 'string' || !savekitUsers.has(command.uid)) {
          safeEmit('action-rejected', {message: 'Choose a save user from this session.'}); return;
        }
        savekitStage = 'backup';
        savekitUsers.clear();
        savekitChild.stdin.write(JSON.stringify({action: 'select-user', uid: command.uid}) + '\n');
        return;
      }
      if (command.action === 'finish') {
        if (cleanupBlocked) {safeEmit('action-rejected', {message:'Restart the console, then stop this session. Native shutdown was not confirmed.'}); return;}
        if (savekitBusy || toolBusy || dumpBusy || helper || statusBusy || modloaderBusy ||
            homebrewChild && !homebrewRunning && !homebrewSettled && !awaitingGame) {
          safeEmit('action-rejected', {message: 'Wait for the current operation to finish.'}); return;
        }
        choiceMade = true; finish(); return;
      }
      if (command.action === 'stop-homebrew') {
        if (!rpcHeldConfirmed || !homebrewChild || homebrewSettled || homebrewStopRequested ||
            !(homebrewRunning || awaitingGame) || cleanupBlocked || failure || statusBusy ||
            dumpBusy || savekitBusy || toolBusy ) {
          safeEmit('action-rejected', {action: command.action,
            message: 'The current homebrew app is not ready for a controlled stop.'});
          return;
        }
        homebrewStopRequested = true;
        safeEmit('homebrew-stopping', {message: 'Stopping the current homebrew app and checking RPC.'});
        stopHomebrew();
        return;
      }
      if (command.action === 'finish-savekit') {
        if (!savekitTools || !(savekitSelected || savekitCompleted ||
            savekitSaveTouched) ||
            savekitFinishedForHomebrew || !rpcHeldConfirmed || savekitBusy || toolBusy ||
            statusBusy || helper || preflightBusy || dumpBusy  || homebrewAttempted || failure) {
          safeEmit('action-rejected', {action: command.action,
            message: 'Wait for SaveKit to finish before returning to homebrew.'}); return;
        }
        if (savekitToolFailed) {
          safeEmit('action-rejected', {action: command.action,
            message: 'Finish this session and restart the console after a failed save operation.'}); return;
        }
        savekitSelected = false;
        savekitFinishedForHomebrew = true;
        safeEmit('savekit-done', {message: 'SaveKit finished. Choose another option in this held session.'});
        return;
      }
      if (command.action === 'start-savekit') {
        if (!savekitTools || !rpcHeldConfirmed || savekitSelected || savekitToolFailed ||
            savekitBusy || toolBusy ||
            homebrewAttempted  || helper || statusBusy || preflightBusy || dumpBusy || failure) {
          safeEmit('action-rejected', {action: command.action,
            message: 'SaveKit needs a free, verified held RPC session.'}); return;
        }
        savekitFinishedForHomebrew = false;
        savekitSelected = true;
        safeEmit('savekit-selected', {message: 'SaveKit is ready in this held RPC session'});
        return;
      }
      if (['install-seedsow-save', 'install-artemis-save', 'install-balatro-save', 'install-gravcirc-save'].includes(command.action)) {
        if (!(seedsowSave || savekitTools) || !rpcHeldConfirmed  || savekitSelected ||
            savekitBusy || savekitToolFailed || toolBusy ||
            cleanupBlocked || failure || homebrewAttempted ||
            helper || statusBusy || preflightBusy || dumpBusy) {
          safeEmit('action-rejected', {action: command.action,
            message: 'Save installation needs this session’s verified held RPC.'});
          return;
        }
        const artemisGame = command.action === 'install-artemis-save' ? command.game :
          command.action === 'install-balatro-save' ? 'balatro' :
          command.action === 'install-gravcirc-save' ? 'gravcirc' : undefined;
        if (command.action === 'install-artemis-save' &&
            (!Object.hasOwn(artemisGameNames, artemisGame) || command.sourcePath !== undefined ||
             command.variant !== undefined &&
             !(artemisGame === 'seedsow' && ['demo', 'full'].includes(command.variant)))) {
          safeEmit('action-rejected', {action: command.action,
            message: 'Choose a supported Artemis game for the launcher.'}); return;
        }
        if (command.action === 'install-seedsow-save' &&
            (command.variant !== undefined && command.variant !== 'pro' ||
             command.variant === 'pro' && command.sourcePath !== undefined ||
             command.game !== undefined)) {
          safeEmit('action-rejected', {action: command.action,
            message: 'Choose the bundled Pro editor or a local Seedsow editor save.'}); return;
        }
        if (command.action === 'install-balatro-save' &&
            (!['upstream', 'showcase'].includes(command.variant) ||
             command.sourcePath !== undefined || command.game !== undefined)) {
          safeEmit('action-rejected', {action: command.action,
            message: 'Choose the original Balatro save or the cpypwn showcase.'}); return;
        }
        if (command.action === 'install-gravcirc-save' &&
            (command.sourcePath !== undefined || command.game !== undefined || command.variant !== undefined)) {
          safeEmit('action-rejected', {action: command.action,
            message: 'The Gravity Circuit save is bundled with this app.'}); return;
        }
        if (command.sourcePath !== undefined &&
            (typeof command.sourcePath !== 'string' || !path.isAbsolute(command.sourcePath) ||
             command.sourcePath.length > 4096 || /[\x00\r\n]/.test(command.sourcePath))) {
          safeEmit('action-rejected', {action: command.action,
            message: 'Choose a local Seedsow editor ZIP or folder.'}); return;
        }
        savekitCustom = command.sourcePath !== undefined;
        savekitGame = artemisGame;
        savekitVariant = command.variant;
        savekitTask = installSeedsowSave(command.sourcePath, artemisGame,
          command.action === 'install-balatro-save' ? command.variant : undefined,
          command.action === 'install-artemis-save' || command.action === 'install-seedsow-save' ?
            command.variant : undefined).catch(error => {
          fail(error.message);
          safeEmit('savekit-failed', {game: artemisGame, message: error.message});
          finish('Save installation stopped.');
        });
        return;
      }
      if (command.action === 'savekit-tool') {
        if (!savekitTools || !rpcHeldConfirmed  || toolBusy || savekitBusy ||
            homebrewAttempted || helper || statusBusy || preflightBusy || dumpBusy || failure ||
            seedsowSave && !savekitCompleted && !savekitSelected) {
          safeEmit('action-rejected', {action: command.action,
            message: 'Save data tools need this session’s verified held RPC.'}); return;
        }
        let value;
        try {value = require('./gui-savekit-tools.cjs').request(command.request);}
        catch (error) {
          safeEmit('action-rejected', {action: command.action, message: error.message}); return;
        }
        if (!['accounts', 'titles', 'inventory'].includes(value.action)) {
          savekitSaveTouched = true;
          savekitFinishedForHomebrew = false;
        }
        toolTask = runSavekitTool(value, command.request).catch(error => {
          const message = 'Save data operation stopped: ' + error.message;
          safeEmit('savekit-tool-failed', {action: value.action, message});
          if (['write', 'restore', 'delete'].includes(value.action)) {
            cleanupBlocked = true;
            fail(message); finish('Save data operation stopped.');
          }
        });
        return;
      }
      if (command.action === 'modloader-install') {
        if (typeof command.modsFolder !== 'string' || !path.isAbsolute(command.modsFolder) ||
            command.modsFolder.length > 4096 || /[\x00\r\n]/.test(command.modsFolder)) {
          safeEmit('action-rejected', {action: command.action, message: 'Choose an unpacked mod folder.'});
          return;
        }
        if (!selectedProfile(root).supportsModloader || !rpcHeldConfirmed ||
            homebrewAttempted || savekitSelected || savekitBusy || toolBusy ||
            savekitSaveTouched && !savekitFinishedForHomebrew  || helper ||
            statusBusy || preflightBusy || dumpBusy || cleanupBlocked || failure) {
          safeEmit('action-rejected', {action: command.action,
            message: 'Modloader needs a free Kurumuz or Cellenseres held RPC session owned by this app.'});
          return;
        }
        try {require('./gui-modloader.cjs').validateModsFolder(command.modsFolder);}
        catch (error) {
          safeEmit('action-rejected', {action: command.action, message: error.message});
          return;
        }
        modloaderBusy = true;
        modloaderTask = runModloader(command.modsFolder).catch(error => {
          modloaderBusy = false;
          homebrewAttempted = true;
          fail('Modloader stopped: ' + error.message);
          safeEmit('modloader-failed', {message: failure, retrySafe: false});
        });
        return;
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
            savekitBusy || savekitCompleted || toolBusy ||
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
      if (['launch-ouncecake','launch-mintbrew','launch-native-hblauncher','launch-custom-homebrew'].includes(command.action)) {
        if (savekitSelected || savekitBusy || toolBusy ||
            savekitSaveTouched && !savekitFinishedForHomebrew) {
          safeEmit('action-rejected', {action: command.action,
            message: 'Wait for the save operation to finish, or start a fresh session after another save operation.'}); return;
        }
        if (!availableHomebrew(root, command.action.slice('launch-'.length))) {
          safeEmit('action-rejected',{action:command.action,message:'This homebrew option is unavailable in this build.'}); return;
        }
        if (command.action === 'launch-custom-homebrew' &&
            (typeof command.customHomebrewPath !== 'string' || !path.isAbsolute(command.customHomebrewPath) ||
             command.customHomebrewPath.length > 4096 || /[\x00\r\n]/.test(command.customHomebrewPath))) {
          safeEmit('action-rejected', {message:'Choose a valid local custom homebrew folder.'}); return;
        }
        if (command.action === 'launch-ouncecake' && !net.isIPv4(command.consoleAddress)) {
          safeEmit('action-rejected', {message:'Enter the Switch’s IPv4 address for OunceCake.'}); return;
        }
        if (command.action === 'launch-ouncecake' && command.mode !== undefined &&
            !['webdav','ftp'].includes(command.mode)) {
          safeEmit('action-rejected', {action:command.action,message:'Choose OunceCake WebDAV or FTP.'}); return;
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
        let sdRomFolder;
        if (command.action === 'launch-native-hblauncher') {
          try {sdRomFolder = require('../integrations/mintbrew-native/sd-roms.cjs')
            .validSDRomFolder(command.sdRomFolder);}
          catch (error) {safeEmit('action-rejected', {action:command.action,message:error.message}); return;}
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
                throw Error('Enter the Switch’s IPv4 address for OunceCake-compatible WebDAV.');
              const target = prepared.kind === 'native-app' ? 'native-hblauncher' : 'custom-homebrew';
              if (!availableHomebrew(root, target))
                throw Error('The selected homebrew runtime is unavailable in this build.');
              if (target === 'native-hblauncher') {
                const report = privateJSON(path.join(directory, 'result.json'));
                const {profiles} = require('./host-profiles.cjs');
                const nativeProfiles = profiles.filter(profile => profile.supportsNativeHBLauncher);
                if (!nativeProfiles.some(profile => report.sourceSha256 === profile.sourceSha256)) {
                  const run = await require('./gui-homebrew.cjs').validateRun(root, directory,
                    require('./gui-dump.cjs').verifiedSession);
                  if (!nativeProfiles.some(profile => run.trustedSource?.profileId === profile.id &&
                      run.trustedSource.sourceSha256 === report.sourceSha256))
                    throw Error('Native HBLauncher apps require a supported held RPC session.');
                }
              }
              const staged = prepared;
              const config = target === 'native-hblauncher' ? {nativeAppFolder:staged.packageFolder,
                  sdRomFolder:require('../integrations/mintbrew-native/sd-roms.cjs').DEFAULT_SD_ROM_FOLDER} : {
                  customHomebrewPath:staged.kind==='launcher'?staged.launcherFolder:
                    staged.kind==='rpc-app'?staged.packageFolder:staged.appFolder,
                  customHomebrewKind:staged.kind||'gpu-app',adapter:staged.adapter,
                  ...(staged.adapter==='ouncecake'?{consoleAddress:command.consoleAddress,port:2121}:{})};
              homebrewAttempted = true;
              safeEmit('homebrew-accepted', {action:'launch-custom-homebrew',
                customHomebrewKind:staged.kind||'gpu-app',adapter:staged.adapter,
                message:target==='native-hblauncher' ?
                  'Validated '+staged.app.name+'. Select it in HBLauncher on your Switch.' :
                  'Validated '+staged.app.name+'. Opening the selected app.'});
              prepared = null;
              homebrewTask = homebrew(target,config).catch(error => {
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
        homebrewAttempted = true;
        const application = command.action.slice('launch-'.length);
        homebrewTask = homebrew(application, application === 'ouncecake' ? {consoleAddress:command.consoleAddress,
          port:2121,...(command.mode === 'ftp' ? {mode:'ftp'} : {})} :
          {addonUrls: command.addonUrls || [], libraryItems: command.libraryItems || [],
            ...(application === 'mintbrew' ? {quality:command.quality ?? '720p'} : {}),
            ...(application === 'native-hblauncher' ? {sdRomFolder} : {}),
            ...(command.action === 'launch-custom-homebrew' ? {customHomebrewPath:command.customHomebrewPath} : {})}).catch(error => {
          if (nativeCleanupApps.has(application)) cleanupBlocked = true;
          fail(error.message); safeEmit('homebrew-failed', {path: directory,
            message: error.message + ' Finish RPC and restart the console. This launch was not retried.',cleanupBlocked});
        });
        return;
      }
      if (command.action === 'rpc-status') {
        if (statusBusy || helper || homebrewAttempted || preflightBusy || dumpBusy  || savekitBusy || toolBusy) {
          safeEmit('action-rejected', {message: 'Wait for the current operation to finish.'}); return;
        }
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
    if (modloaderChild) {
      fail('The original RPC session ended while Modloader was installing. Restart the Switch.');
      signalGroup(modloaderChild, 'SIGTERM');
      await modloaderTask;
    }
    if (savekitChild) {
      fail('The original RPC session ended during the save operation. Keep the backup and restart the console.');
      signalGroup(savekitChild, 'SIGTERM');
      await savekitTask;
    }
    if (toolChild) {
      fail('The original RPC session ended during the save data operation. Keep any backup and restart the console.');
      signalGroup(toolChild, 'SIGTERM');
      await toolTask;
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
      safeEmit('verified', {message: modloaderReady ?
        'Modloader installed and host cleanup verified. Close SmileBASIC without restarting the Switch, then launch the game.' : savekitCompleted ?
        savekitSkipped ? 'Existing save preserved, backup verified, and RPC cleanup confirmed.' :
          savekitGame === 'balatro' ? 'Balatro save installed and verified. Close SmileBASIC, then open Balatro.' :
          savekitGame === 'gravcirc' ? 'Gravity Circuit save installed and verified. Close SmileBASIC, then open Gravity Circuit.' :
          savekitGame ? `${artemisGameNames[savekitGame] || 'Artemis'} launcher installed and verified. Close SmileBASIC, then open ${savekitGame === 'seedsow' && savekitVariant === 'full' ? 'the full game' : 'the demo'}.` :
          savekitCustom ? 'Selected Seedsow editor save installed and verified. Close SmileBASIC, then open the demo.' :
          savekitVariant === 'pro' ? 'Seedsow Lua Editor Pro v0.4.0 installed and verified. Close SmileBASIC, then open the demo.' :
            'Seedsow Lua Editor v0.1.3 and cpypwn showcase installed and verified. Close SmileBASIC, open the demo, then load editor slot 1. The showcase is in slot 6.' : homebrewAttempted ?
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
    if (modloaderChild?.pid) signalGroup(modloaderChild, 'SIGKILL');
    if (savekitChild?.pid) signalGroup(savekitChild, 'SIGKILL');
    if (toolChild?.pid) signalGroup(toolChild, 'SIGKILL');
    fs.rmSync(controls, {recursive: true, force: true});
  }
}
module.exports = {main, heldResult, heldMessage, validSavekitToolEvent, validLocalFTPURL};
