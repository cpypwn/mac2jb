#!/usr/bin/env node
'use strict';
// Native GUI adapter. Keep the audited ns2jb snapshot unchanged and preserve
// the host's command output in the GUI's diagnostic stream.
process.umask(0o077);
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const timingDefaults = Object.freeze({delay: 50, enumerationTimeout: 4, loadWaitMs: 3000,
  runWaitMs: 3000, removeWaitMs: 3000, loadConfirmWaitMs: 1000});
function hidSettings(args) {
  const settings = {...timingDefaults, demo: false};
  const values = [...args];
  if (values.length && !values[0].startsWith('--')) settings.delay = Number(values.shift());
  const options = {'--enumeration-timeout': 'enumerationTimeout', '--load-wait-ms': 'loadWaitMs',
    '--run-wait-ms': 'runWaitMs', '--remove-wait-ms': 'removeWaitMs', '--load-confirm-wait-ms': 'loadConfirmWaitMs'};
  while (values.length) {
    const option = values.shift();
    if (option === '--demo') {
      if (settings.demo) throw Error('Duplicate HID option: --demo');
      settings.demo = true;
      continue;
    }
    const text = values.shift();
    if (!options[option] || text === undefined || !/^\d+$/.test(text)) throw Error('Invalid HID timing option: ' + option);
    settings[options[option]] = Number(text);
  }
  for (const name of Object.keys(timingDefaults)) {
    const value = settings[name];
    const minimum = name === 'delay' || name === 'enumerationTimeout' ? 1 : 0;
    const maximum = name === 'delay' ? 2000 : name === 'enumerationTimeout' ? 120 : 120000;
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw Error(`Invalid ${name}: use ${minimum}..${maximum}.`);
  }
  return settings;
}
function emit(type, fields = {}) { process.stdout.write(JSON.stringify({type, ...fields}) + '\n'); }
function lines(stream, callback, limit = 65536) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', bytes => {
    pending += bytes.toString();
    let match;
    while ((match = pending.search(/[\r\n]/)) >= 0) {
      const line = pending.slice(0, match); pending = pending.slice(match + 1);
      if (line) callback(Buffer.byteLength(line) > limit ? '[Input line exceeded its size limit]' : line);
    }
    if (Buffer.byteLength(pending) > limit) {callback('[Input line exceeded its size limit]'); pending = '';}
  });
  stream.on('end', () => {if (pending) callback(pending);});
}
function validStart(line, address) {
  const match = /^V=START\((\d+(?:,\d+){4})\)$/.exec(line);
  if (!match) return false;
  const words = match[1].split(',').map(Number);
  return words.every(Number.isSafeInteger) && words[0] === 39380 &&
    words.slice(1, 5).every(n => n >= 0 && n <= 255) &&
    words.slice(1, 5).join('.') === address;
}
function verifiedResult(result) {
  return result?.verified === true && result?.fs?.verified === true &&
    result?.fs?.restored === true && result?.fs?.cleanup?.cleanedUp === true;
}
function networkBindFailure(line, address) {
  const match = /\blisten\s+EADDRNOTAVAIL\b.*?\s(\d+(?:\.\d+){3}):(\d+)\b/.exec(line);
  if (!match || match[1] !== address || match[2] !== '39380') return null;
  return {address, diagnostic: line.trim().slice(0, 2048)};
}
function networkUnavailableMessage(address) {
  return `The Mac network address ${address} is no longer available. Refresh network addresses, choose the current Mac LAN address, and start again.`;
}
function signalGroup(child, signal) {
  if (!child?.pid) return;
  try {process.kill(-child.pid, signal);} catch (error) {if (error.code !== 'ESRCH') throw error;}
}
let current, stopping = false, stopTimer;
function stop() {
  stopping = true;
  signalGroup(current, 'SIGTERM');
  stopTimer = setTimeout(() => signalGroup(current, 'SIGKILL'), 2000);
  stopTimer.unref();
}
async function host(address) {
  if (!net.isIPv4(address)) throw Error('Choose the Mac’s LAN IPv4 address.');
  const folder = path.join(root, 'vendor/ns2jb');
  const runs = path.join(folder, 'runs');
  fs.mkdirSync(runs, {recursive: true, mode: 0o700}); fs.chmodSync(runs, 0o700);
  const active = path.join(runs, 'mac2jb-active-connect.txt');
  // A unique extracted workspace belongs to one GUI launch. Never overwrite an
  // existing record, including a symlink or a record from another host.
  if (fs.existsSync(active) || (() => {try {fs.lstatSync(active); return true;} catch {return false;}})())
    throw Error('This session already has a pairing record. Stop it and start a fresh session.');
  current = spawn(process.execPath, ['run.cjs', address], {
    cwd: folder, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    // Match the fork's bundled five-argument bootstrap.
    // GUI sessions finish after verification, regardless of inherited settings.
    env: {...process.env, NS2_BASIC_ARITY: '5', NS2_RPC_MODE: '0'}
  });
  const child = current;
  let published = false, directory, publicationError, networkFailure, networkTimer, progressed = false;
  function output(line) {
    try {
    const clean = line.trim();
    const bindFailure = networkBindFailure(clean, address);
    if (bindFailure && !networkFailure) {
      networkFailure = bindFailure;
      signalGroup(child, 'SIGTERM');
      networkTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), 2000); networkTimer.unref();
    }
    if (validStart(clean, address) && !published && !stopping && !networkFailure) {
      const temporary = active + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, `${child.pid}\n${clean}\n`, {mode: 0o600, flag: 'wx'});
      // link provides no-replace publication, unlike rename on an existing file.
      try {fs.linkSync(temporary, active);} finally {fs.unlinkSync(temporary);}
      published = true;
      emit('host-ready', {message: 'Fresh host pairing is ready.'});
    }
    if (clean.startsWith('Run folder: ')) {
      const candidate = path.resolve(clean.slice('Run folder: '.length));
      if (candidate.startsWith(runs + path.sep)) {directory = candidate; progressed = true; emit('run-folder', {path: candidate});}
    }
    if (/^(?:Waiting for Switch 2 at |Connected\b|[1-4]\/4 |Sending: |MAC2JB_GUI |Keyboard enumerated\. Sending|Typing line |Sent line )/.test(clean)) progressed = true;
    if (clean.startsWith('Waiting for Switch 2 at '))
      emit('host-stage', {stage: 'waiting', message: 'Waiting for the Switch to connect over the local network'});
    else if (clean.startsWith('Connected. Checking the application'))
      emit('host-stage', {stage: 'connected', message: 'Switch connected — checking the application'});
    else if (/^[1-4]\/4 /.test(clean)) emit('host-stage', {
      stage: 'pipeline', completed: Number(clean[0])-1, total: 4, message: clean});
    emit('log', {message: line});
    } catch (error) {
      publicationError ||= error;
      signalGroup(child, 'SIGTERM');
      emit('failed', {message: 'Could not safely publish host pairing: ' + error.message});
    }
  }
  lines(child.stdout, output); lines(child.stderr, output);
  const {code, signal} = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));
  });
  clearTimeout(stopTimer);
  clearTimeout(networkTimer);
  if (published) {
    try {if (fs.readFileSync(active, 'utf8').startsWith(`${child.pid}\n`)) fs.unlinkSync(active);} catch {}
  }
  // The run spawns a pipeline process. If run.cjs fails first, ensure no owned
  // descendant survives after its host has gone away.
  signalGroup(child, 'SIGTERM');
  let result;
  if (directory) {try {result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));} catch {}}
  if (networkFailure) {
    const retrySafe = !published && !progressed && !publicationError;
    const message = networkUnavailableMessage(address);
    emit(retrySafe ? 'network-unavailable' : 'failed', {...networkFailure, retrySafe,
      message: retrySafe ? message : message + ' Pairing or console activity may have started. Stop the session and restart the console before retrying.'});
    return 1;
  }
  if (stopping) {emit('cancelled', {message: 'Session stopped. Restart the console before another exploit attempt.'}); return 130;}
  if (code === 0 && !signal && !publicationError && verifiedResult(result)) {
    emit('verified', {message: 'FS execution verified; original instructions restored and scratch cleaned up.'}); return 0;
  }
  emit('failed', {message: result?.error || 'The host ended without a verified result. Restart the console before retrying.'});
  return code || 1;
}
async function hid(kind, controller, settings = timingDefaults) {
  if (!['bootstrap', 'commands'].includes(kind)) throw Error('Invalid transfer kind.');
  if (controller !== 'auto' && !/^usb-drd(?:[0-9]|1[0-5])$/.test(controller)) throw Error('Choose a controller from 0 to 15.');
  const {delay, enumerationTimeout, loadWaitMs, runWaitMs, removeWaitMs, loadConfirmWaitMs, demo = false} = settings;
  const candidates = controller === 'auto' ? ['usb-drd0', 'usb-drd1', 'usb-drd3'] : [controller];
  const bootstrap = fs.readFileSync(path.join(root, 'assets/bootstrap.bas'), 'utf8');
  const totalLines = (bootstrap.match(/\n/g) || []).length + (bootstrap && !bootstrap.endsWith('\n') ? 1 : 0);
  for (const candidate of candidates) {
    if (stopping) break;
    emit('controller', {controller: candidate, message: `Waiting for ${candidate} to enumerate`});
    const executable = path.join(root, kind === 'bootstrap' ? 'mac2jb-send' : 'mac2jb-commands');
    const args = kind === 'bootstrap' ? ['assets/bootstrap.bas', '--delay-ms', String(delay)] : [
      '--auto', '--delay-ms', String(delay), '--gui-events', '--enumeration-timeout', String(enumerationTimeout),
      '--load-wait-ms', String(loadWaitMs), '--run-wait-ms', String(runWaitMs),
      '--remove-wait-ms', String(removeWaitMs), '--load-confirm-wait-ms', String(loadConfirmWaitMs),
      ...(demo ? ['--demo'] : [])];
    current = spawn(executable, args, {cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, MAC2JB_AUTO_WORKER: '1', MAC2JB_CONTROLLER: candidate,
        MAC2JB_ENUMERATION_TIMEOUT_SECONDS: String(enumerationTimeout)}});
    const child = current;
    let output = '', typing = false, timedOut = false, announced = false, commandStep = 0, nativeEvents = false, nativeLineEvents = false;
    let timer, countdown;
    const started = performance.now();
    const enumerationProgress = () => {
      const elapsed = Math.min(enumerationTimeout * 1000, Math.max(0, performance.now() - started));
      emit('enumeration-progress', {controller: candidate, completed: elapsed, total: enumerationTimeout * 1000,
        remainingMs: Math.max(0, enumerationTimeout * 1000 - elapsed), durationMs: enumerationTimeout * 1000});
    };
    const markTyping = () => {
      typing = true; clearTimeout(timer); clearInterval(countdown);
      if (!announced) {
        announced = true;
        emit('typing', {kind, completed: 0, total: kind === 'commands' ? 4 : totalLines,
          message: kind === 'commands' ? 'USB keyboard connected. Sending four commands.' : 'USB keyboard connected. Typing the bootstrap.'});
      }
    };
    const observe = line => {
      output += line + '\n';
      if (line.startsWith('MAC2JB_GUI ')) {
        let event;
        try {event = JSON.parse(line.slice('MAC2JB_GUI '.length));} catch {return;}
        if (!event || typeof event !== 'object' || Array.isArray(event)) return;
        if (event.type === 'line-start' || event.type === 'line-complete') {
          if (kind !== 'bootstrap' || !Number.isSafeInteger(event.line) ||
              !Number.isSafeInteger(event.completed) || event.total !== totalLines ||
              event.line < 1 || event.line > totalLines ||
              event.completed !== event.line - (event.type === 'line-start' ? 1 : 0)) return;
          nativeLineEvents = true;
          markTyping();
          emit(event.type, {kind, line: event.line, completed: event.completed, total: totalLines,
            message: `${event.type === 'line-start' ? 'Typing' : 'Sent'} line ${event.line} of ${totalLines}`,
            ...(Number.isFinite(event.remainingMs) && event.remainingMs >= 0 ? {remainingMs: event.remainingMs} : {})});
          return;
        }
        nativeEvents = true;
        if (['typing', 'command-start', 'command-complete'].includes(event.type)) markTyping();
        if (event.type === 'command-start' || event.type === 'command-complete') {
          commandStep = event.step;
          emit(event.type, {kind, step: event.step, completed: event.completed, total: 4, label: event.label});
        } else if (event.type === 'wait') {
          emit('wait', {kind, completed: event.completed, total: 4, label: event.label,
            remainingMs: event.remainingMs, durationMs: event.durationMs});
        }
        return;
      }
      if (/Keyboard enumerated\. Sending|Sent line \d+|^Sending: /.test(line)) {
        markTyping();
      }
      const progress = /Sent line (\d+)/.exec(line);
      if (progress && kind === 'bootstrap' && !nativeLineEvents) {
        const completed = Number(progress[1]);
        if (Number.isSafeInteger(completed) && completed >= 1 && completed <= totalLines)
          emit('progress', {kind, line: Math.min(completed + 1, totalLines), completed, total: totalLines});
      }
      if (line.startsWith('Sending: ')) {
        if (!nativeEvents) {
          commandStep++;
          emit('command-start', {kind, step: commandStep, completed: commandStep-1, total: 4,
            label: ['LOAD', 'RUN', 'REMOVE', 'START'][commandStep-1] || 'command'});
        }
        emit('command', {message: line});
      }
      else emit('log', {message: line});
    };
    lines(child.stdout, observe); lines(child.stderr, observe);
    // Once terminated, wait for close (both output streams drained) before
    // deciding whether another controller is safe. Buffered typing evidence
    // must never be missed by a timeout race.
    enumerationProgress();
    countdown = setInterval(enumerationProgress, 100);
    timer = setTimeout(() => {
      if (!typing) {
        enumerationProgress(); clearInterval(countdown);
        timedOut = true; signalGroup(child, 'SIGTERM');
        stopTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), 2000); stopTimer.unref();
      }
    }, enumerationTimeout * 1000);
    let code, signal;
    try {
      ({code, signal} = await new Promise((resolve, reject) => {
        child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));
      }));
    } finally {
      // Spawn errors must also release timers; otherwise a 120-second selected
      // window would keep a failed adapter alive after ENOENT or EACCES.
      clearTimeout(timer); clearInterval(countdown); clearTimeout(stopTimer);
    }
    if (stopping) break;
    if (code === 0 && !signal) {emit('transfer-complete', {kind, message: 'Keyboard transfer completed. Check the Switch screen.'}); return 0;}
    if (signal && !timedOut) {
      const helper = path.basename(executable);
      emit('failed', {helper, signal, controller: candidate, partial: typing,
        message: `USB helper ${helper} terminated by ${signal} on ${candidate}. ` +
          'This does not establish that the USB driver is missing. Check macOS crash reports and the session logs. ' +
          'Automatic retry was stopped.' + (typing ? ' Input may be partial. Inspect and clear the Switch input before trying again.' : '')});
      return 1;
    }
    if (typing) {
      emit('failed', {partial: true, message: 'Input may be partial. Automatic retry was stopped. Inspect and clear the Switch input before trying again.'}); return 1;
    }
    const enumerationError = /USB host did not enumerate|USB enumeration error|selected controller|device did not enumerate|not enumerated|Waiting for USB host enumeration|USB host enumeration failed/i.test(output);
    if (!timedOut && !enumerationError) {
      emit('failed', {message: 'USB initialization failed. Check that the approved usbgadget driver is installed and loaded.'}); return code || 1;
    }
    emit('log', {message: `${candidate} did not enumerate; no typing was detected.`});
  }
  if (stopping) {emit('cancelled', {message: 'Transfer stopped. Inspect the Switch for partial input.'}); return 130;}
  emit('failed', {message: 'No controller connected. The Mac must NOT be supplying charging power to the Switch. Unplug and replug the Mac end of a data cable to renegotiate, then verify that power is directed toward the Mac. Software cannot force the power role. You can also choose a controller manually.'}); return 1;
}
async function main(args = process.argv.slice(2)) {
  if (args[0] === 'host' && args.length === 3 && args[2] === '--post-run-options')
    return require('./gui-session.cjs').main({root, address: args[1], emit, lines, verifiedResult});
  if (args.length === 1 && args[0] === '--self-test') {
    const address = '192.0.2.1';
    const value = 'V=START(' + [39380, ...address.split('.')].join(',') + ')';
    if (!validStart(value, address) || validStart(value, '192.0.2.2') ||
        validStart(value.slice(0, -1) + ',0,0,0,0)', address) ||
        verifiedResult({verified: true}) || !verifiedResult({verified: true,
          fs: {verified: true, restored: true, cleanup: {cleanedUp: true}}}))
      throw Error('GUI adapter self-test failed.');
    emit('self-test', {message: 'Pairing validation and result verification checks passed. No USB input sent.'});
    return 0;
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (args[0] === 'host' && args.length === 2) return host(args[1]);
  if (args[0] === 'hid' && args.length >= 3) return hid(args[1], args[2], hidSettings(args.slice(3)));
  throw Error('Usage: gui-host.cjs host IPv4 | hid bootstrap|commands auto|usb-drdN [delay-ms] [--demo]');
}
module.exports = {validStart, verifiedResult, hidSettings, lines, main, networkBindFailure, networkUnavailableMessage};
if (require.main === module) main().then(code => {process.exitCode = code;}).catch(error => {
  signalGroup(current, 'SIGTERM'); emit('failed', {message: error.message}); process.exitCode = 1;
});
