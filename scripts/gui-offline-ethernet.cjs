#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const stateDir = '/Library/Application Support/mac2jb/offline-ethernet';
const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'integrations/offline-ethernet/helper.sh');
const responder = path.join(root, 'integrations/offline-ethernet/Responder.pl');
const startupLog = path.join(stateDir, 'startup.log');

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!key || !key.startsWith('--') || i + 1 >= args.length) {
      throw new Error('Expected --interface enN or --state-dir PATH');
    }
    options[key.slice(2)] = args[i + 1];
  }
  return options;
}

function requireStateDir(value) {
  if (value !== stateDir) {
    throw new Error('The offline Ethernet state directory must be ' + stateDir);
  }
  return value;
}

function parseHardwarePorts(output, inspect) {
  const adapters = [];
  let label = '';
  for (const line of output.split(/\r?\n/)) {
    const port = /^Hardware Port:\s*(.+)$/.exec(line);
    if (port) {
      label = port[1].trim();
      continue;
    }
    const device = /^Device:\s*(en[0-9]+)$/.exec(line);
    if (!device || /Wi-?Fi|AirPort|Bluetooth|Bridge|^Thunderbolt\s+[0-9]+$/i.test(label)) continue;
    const name = device[1];
    let info;
    try { info = inspect(name); } catch { continue; }
    if (!/^\s*ether\s+[0-9a-f:]+/im.test(info)) continue;
    adapters.push({
      interface: name,
      label: label || name,
      active: /^\s*status:\s*active\s*$/im.test(info)
    });
  }
  return adapters.sort((a, b) => Number(a.interface.slice(2)) - Number(b.interface.slice(2)));
}

function listAdapters() {
  if (process.platform !== 'darwin') throw new Error('Offline Ethernet requires macOS');
  const output = childProcess.execFileSync('/usr/sbin/networksetup', ['-listallhardwareports'], {
    encoding: 'utf8', timeout: 5000
  });
  return parseHardwarePorts(output, name => childProcess.execFileSync('/sbin/ifconfig', [name], {
    encoding: 'utf8', timeout: 3000
  }));
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function processAlive(pid, check = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { check(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function readStatus(dir) {
  const state = readText(path.join(dir, 'network-original.txt'));
  const status = readText(path.join(dir, 'status.txt')).split(/\r?\n/);
  const recordedPhase = status[0] || 'idle';
  const pid = Number(readText(path.join(dir, '.run.lock/pid')).trim());
  const active = processAlive(pid);
  const phase = (recordedPhase === 'ready' || recordedPhase === 'starting') && !active
    ? 'stale' : recordedPhase;
  const responderLog = path.join(dir, 'ethernet.log');
  const launchLog = path.join(dir, 'startup.log');
  const logPath = (phase === 'ready' && active && fs.existsSync(responderLog))
    ? responderLog : fs.existsSync(launchLog) ? launchLog : fs.existsSync(responderLog) ? responderLog : '';
  let log = '';
  try {
    const stat = fs.statSync(responderLog);
    const fd = fs.openSync(responderLog, 'r');
    try {
      const bytes = Math.min(stat.size, 65536);
      const buffer = Buffer.alloc(bytes);
      fs.readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes));
      log = buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  const requests = log.split(/\r?\n/).filter(line => /(?:DNS\/(?:UDP|TCP)|HTTP) 192\.168\.2\.1\b/.test(line));
  const lastSwitchRequest = requests.at(-1) || '';
  return {
    phase,
    message: status[1] || (phase === 'idle' ? 'Offline Ethernet is not configured' : ''),
    interface: state.split(/\r?\n/)[0] || '',
    active,
    needsRestore: Boolean(state),
    switchSeen: requests.length > 0,
    connectionCheckPassed: requests.some(line => /HTTP 192\.168\.2\.1\b.*-> 200 CTEST OK/.test(line)),
    lastSwitchRequest,
    logPath
  };
}

function startupError(prefix, logFile = startupLog) {
  const detail = readText(logFile).trim().split(/\r?\n/).slice(-12).join('\n');
  return new Error(detail ? `${prefix}\n${detail}` : prefix);
}

async function waitForStartup(child, token, logFile = startupLog, read = readText, sleep = delay) {
  let spawnError;
  child.once('error', error => { spawnError = error; });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await sleep(250);
    if (spawnError) throw startupError(`Offline Ethernet launch failed: ${spawnError.message}`, logFile);
    const [phase, message, reportedToken] = read(path.join(stateDir, 'status.txt')).split(/\r?\n/);
    if (reportedToken === token && phase === 'failed') {
      throw startupError(`Offline Ethernet helper failed: ${message}`, logFile);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw startupError(`Offline Ethernet helper exited before ready (exit ${child.exitCode ?? child.signalCode})`, logFile);
    }
    if (reportedToken === token && phase === 'ready') return;
  }
  child.kill('SIGTERM');
  throw startupError('Offline Ethernet did not become ready within 60 seconds', logFile);
}

async function runPrivileged(action, options) {
  if (process.platform !== 'darwin') throw new Error('Offline Ethernet requires macOS');
  if (process.getuid?.() !== 0) throw new Error(action + ' requires macOS administrator access');
  requireStateDir(options['state-dir']);
  const args = [helper, action];
  if (action === 'start') {
    const name = options.interface;
    if (!/^en[0-9]+$/.test(name || '')) throw new Error('Choose a physical enN Ethernet adapter');
    args.push(name);
  }
  args.push(stateDir);
  if (action !== 'start') {
    const result = childProcess.spawnSync('/bin/bash', args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${action} failed (exit ${result.status ?? result.signal}): ${result.stderr.trim()}`);
    return;
  }

  const prepared = childProcess.spawnSync('/bin/bash', [helper, 'prepare', stateDir], { encoding: 'utf8' });
  if (prepared.error) throw prepared.error;
  if (prepared.status !== 0) {
    throw new Error(`Offline Ethernet preparation failed (exit ${prepared.status ?? prepared.signal}): ${prepared.stderr.trim()}`);
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(startupLog, flags, 0o644);
  fs.fchmodSync(fd, 0o644);
  const token = crypto.randomUUID();
  const invocation = `/bin/bash ${args.map(value => JSON.stringify(value)).join(' ')}`;
  fs.writeSync(fd, `Launching ${invocation}\n`);
  let child;
  try {
    child = childProcess.spawn('/bin/bash', args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, MAC2JB_OFFLINE_LAUNCH_TOKEN: token }
    });
  } finally {
    fs.closeSync(fd);
  }
  await waitForStartup(child, token);
  child.unref();
  console.log(`Offline Ethernet ready on ${options.interface}; helper PID ${child.pid}; startup log ${startupLog}`);
}

function selfTest() {
  const fixture = [
    'Hardware Port: Wi-Fi', 'Device: en0', 'Ethernet Address: aa:bb:cc:dd:ee:00',
    'Hardware Port: USB LAN', 'Device: en7', 'Ethernet Address: aa:bb:cc:dd:ee:07',
    'Hardware Port: Thunderbolt 1', 'Device: en8', 'Ethernet Address: aa:bb:cc:dd:ee:08'
  ].join('\n');
  assert.deepEqual(parseHardwarePorts(fixture, name =>
    'ether aa:bb:cc:dd:ee:07\nstatus: ' + (name === 'en7' ? 'active' : 'inactive')), [
    { interface: 'en7', label: 'USB LAN', active: true }
  ]);
  const bash = childProcess.spawnSync('/bin/bash', ['-n', helper], { encoding: 'utf8' });
  if (bash.status !== 0) throw new Error('Offline Ethernet helper syntax: ' + bash.stderr);
  const perl = childProcess.spawnSync('/usr/bin/perl', ['-c', responder], { encoding: 'utf8' });
  if (perl.status !== 0) throw new Error('Offline Ethernet responder syntax: ' + perl.stderr);
  console.log('Offline Ethernet self-test passed');
}

function main(args) {
  const action = args[0];
  if (action === '--self-test') return selfTest();
  if (action === 'list') return console.log(JSON.stringify({ adapters: listAdapters() }));
  const options = parseOptions(args.slice(1));
  if (action === 'status') {
    requireStateDir(options['state-dir']);
    return console.log(JSON.stringify(readStatus(stateDir)));
  }
  if (action === 'start' || action === 'stop' || action === 'restore') {
    return runPrivileged(action, options);
  }
  throw new Error('Usage: gui-offline-ethernet.cjs list|status|start|stop|restore|--self-test');
}

if (require.main === module) {
  Promise.resolve().then(() => main(process.argv.slice(2))).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseHardwarePorts, processAlive, readStatus, requireStateDir, stateDir, waitForStartup };
