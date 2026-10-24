#!/usr/bin/env node
'use strict';
// Native GUI adapter. Keep the audited ns2jb snapshot unchanged and never emit
// its per-session START credentials to the GUI's diagnostic stream.
process.umask(0o077);
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const redact = value => String(value).replace(/V=START\([^\r\n)]*\)/g, 'V=START(<private session>)');
function emit(type, fields = {}) { process.stdout.write(JSON.stringify({type, ...fields}) + '\n'); }
function lines(stream, callback) {
  let pending = '';
  stream.on('data', bytes => {
    pending += bytes.toString();
    let match;
    while ((match = pending.search(/[\r\n]/)) >= 0) {
      const line = pending.slice(0, match); pending = pending.slice(match + 1);
      if (line) callback(line);
    }
    if (pending.length > 65536) {callback(pending.slice(0, 65536)); pending = '';}
  });
  stream.on('end', () => {if (pending) callback(pending);});
}
function validStart(line, address) {
  const match = /^V=START\((\d+(?:,\d+){8})\)$/.exec(line);
  if (!match) return false;
  const words = match[1].split(',').map(Number);
  return words.every(Number.isSafeInteger) && words[0] === 39380 &&
    words.slice(1, 5).every(n => n >= 0 && n <= 255) &&
    words.slice(1, 5).join('.') === address && words.slice(5).every(n => n >= 0);
}
function verifiedResult(result) {
  return result?.verified === true && result?.fs?.verified === true &&
    result?.fs?.restored === true && result?.fs?.cleanup?.cleanedUp === true;
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
    cwd: folder, detached: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const child = current;
  let published = false, directory, publicationError;
  function output(line) {
    try {
    const clean = line.trim();
    if (validStart(clean, address) && !published && !stopping) {
      const temporary = active + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, `${child.pid}\n${clean}\n`, {mode: 0o600, flag: 'wx'});
      // link provides no-replace publication, unlike rename on an existing file.
      try {fs.linkSync(temporary, active);} finally {fs.unlinkSync(temporary);}
      published = true;
      emit('host-ready', {message: 'Fresh host pairing is ready.'});
    }
    if (clean.startsWith('Run folder: ')) {
      const candidate = path.resolve(clean.slice('Run folder: '.length));
      if (candidate.startsWith(runs + path.sep)) {directory = candidate; emit('run-folder', {path: candidate});}
    }
    emit('log', {message: redact(line)});
    } catch (error) {
      publicationError ||= error;
      signalGroup(child, 'SIGTERM');
      emit('failed', {message: 'Could not safely publish host pairing: ' + redact(error.message)});
    }
  }
  lines(child.stdout, output); lines(child.stderr, output);
  const {code, signal} = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));
  });
  clearTimeout(stopTimer);
  if (published) {
    try {if (fs.readFileSync(active, 'utf8').startsWith(`${child.pid}\n`)) fs.unlinkSync(active);} catch {}
  }
  // The run spawns a pipeline process. If run.cjs fails first, ensure no owned
  // descendant survives after its host has gone away.
  signalGroup(child, 'SIGTERM');
  let result;
  if (directory) {try {result = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'));} catch {}}
  if (stopping) {emit('cancelled', {message: 'Session stopped. Restart the console before another exploit attempt.'}); return 130;}
  if (code === 0 && !signal && !publicationError && verifiedResult(result)) {
    emit('verified', {message: 'FS execution verified; original instructions restored and scratch cleaned up.'}); return 0;
  }
  emit('failed', {message: redact(result?.error || 'The host ended without a verified result. Restart the console before retrying.')});
  return code || 1;
}
async function hid(kind, controller, delay = 50) {
  if (!['bootstrap', 'commands'].includes(kind)) throw Error('Invalid transfer kind.');
  if (controller !== 'auto' && !/^usb-drd(?:[0-9]|1[0-5])$/.test(controller)) throw Error('Choose a controller from 0 to 15.');
  if (!Number.isInteger(delay) || delay < 1 || delay > 2000) throw Error('Invalid typing delay.');
  const candidates = controller === 'auto' ? ['usb-drd0', 'usb-drd1', 'usb-drd3'] : [controller];
  const totalLines = fs.readFileSync(path.join(root, 'assets/bootstrap.bas'), 'utf8').split('\n').length - 1;
  for (const candidate of candidates) {
    if (stopping) break;
    emit('controller', {controller: candidate, message: `Trying ${candidate}…`});
    const executable = path.join(root, kind === 'bootstrap' ? 'mac2jb-send' : 'mac2jb-commands');
    const args = kind === 'bootstrap' ? ['assets/bootstrap.bas', '--delay-ms', String(delay)] : ['--auto', '--delay-ms', String(delay)];
    current = spawn(executable, args, {cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {...process.env, MAC2JB_AUTO_WORKER: '1', MAC2JB_CONTROLLER: candidate}});
    const child = current;
    let output = '', typing = false, timedOut = false, announced = false;
    const observe = line => {
      output += line + '\n';
      if (/Keyboard enumerated\. Sending|Sent line \d+|^Sending: /.test(line)) {
        typing = true; clearTimeout(timer);
        if (!announced) {announced = true; emit('typing', {message: 'USB keyboard connected. Sending input…'});}
      }
      const progress = /Sent line (\d+)/.exec(line);
      if (progress) emit('progress', {completed: Number(progress[1]), total: totalLines});
      if (line.startsWith('Sending: ')) emit('command', {message: redact(line)});
      else emit('log', {message: redact(line)});
    };
    lines(child.stdout, observe); lines(child.stderr, observe);
    // Once terminated, wait for close (both output streams drained) before
    // deciding whether another controller is safe. Buffered typing evidence
    // must never be missed by a timeout race.
    const timer = setTimeout(() => {
      if (!typing) {
        timedOut = true; signalGroup(child, 'SIGTERM');
        stopTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), 2000); stopTimer.unref();
      }
    }, 4000);
    const {code, signal} = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));
    });
    clearTimeout(timer); clearTimeout(stopTimer);
    if (stopping) break;
    if (code === 0 && !signal) {emit('transfer-complete', {kind, message: 'Keyboard transfer completed. Check the Switch screen.'}); return 0;}
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
  emit('failed', {message: 'No controller connected. Reconnect a data cable, check power direction, or choose a controller manually.'}); return 1;
}
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--self-test') {
    const crypto = require('node:crypto');
    const address = '192.0.2.1';
    const values = Array.from({length: 4}, () => crypto.randomBytes(6).readUIntLE(0, 6));
    const value = 'V=START(' + [39380, ...address.split('.'), ...values].join(',') + ')';
    if (!validStart(value, address) || validStart(value, '192.0.2.2') ||
        redact('Sending: ' + value) !== 'Sending: V=START(<private session>)' ||
        verifiedResult({verified: true}) || !verifiedResult({verified: true,
          fs: {verified: true, restored: true, cleanup: {cleanedUp: true}}}))
      throw Error('GUI adapter self-test failed.');
    emit('self-test', {message: 'Pairing validation, private logging and result verification checks passed. No USB input sent.'});
    return 0;
  }
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (args[0] === 'host' && args.length === 2) return host(args[1]);
  if (args[0] === 'hid' && args.length >= 3 && args.length <= 4) return hid(args[1], args[2], Number(args[3] || 50));
  throw Error('Usage: gui-host.cjs host IPv4 | hid bootstrap|commands auto|usb-drdN [delay-ms]');
}
module.exports = {redact, validStart, verifiedResult, lines, main};
if (require.main === module) main().then(code => {process.exitCode = code;}).catch(error => {
  signalGroup(current, 'SIGTERM'); emit('failed', {message: redact(error.message)}); process.exitCode = 1;
});
