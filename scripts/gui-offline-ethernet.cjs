#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateDir = '/Library/Application Support/mac2jb/offline-ethernet';
const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'integrations/offline-ethernet/helper.sh');
const responder = path.join(root, 'integrations/offline-ethernet/Responder.pl');
const parentDir = path.dirname(stateDir);
const installDir = path.join(parentDir, 'offline-ethernet-runtime');
const installedHelper = path.join(installDir, 'helper.sh');
const installedResponder = path.join(installDir, 'Responder.pl');
const daemonLabel = 'io.github.cpypwn.mac2jb.offline-ethernet';
const daemonPlist = path.join('/Library/LaunchDaemons', daemonLabel + '.plist');

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
  const logPath = path.join(dir, 'ethernet.log');
  let log = '';
  try {
    const stat = fs.statSync(logPath);
    const fd = fs.openSync(logPath, 'r');
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

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
}

function renderDaemonPlist(name) {
  const programArguments = ['/bin/bash', installedHelper, 'start', name, stateDir];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + xmlEscape(daemonLabel) + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>'
  ];
  for (const argument of programArguments) lines.push('    <string>' + xmlEscape(argument) + '</string>');
  lines.push(
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    '  <string>' + xmlEscape(path.join(stateDir, 'daemon.out.log')) + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + xmlEscape(path.join(stateDir, 'daemon.err.log')) + '</string>',
    '</dict>',
    '</plist>',
    ''
  );
  return lines.join('\n');
}

// Create or adopt a directory that must be root-owned, refusing symlinks and
// non-root ownership so the privileged install never follows a planted path.
function ensureRootDir(dir) {
  let info = null;
  try { info = fs.lstatSync(dir); } catch {}
  if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Refusing to use an unsafe path: ' + dir);
    if (info.uid !== 0) throw new Error('Directory must be owned by root: ' + dir);
  } else {
    fs.mkdirSync(dir, { mode: 0o755 });
  }
  fs.chownSync(dir, 0, 0);
  fs.chmodSync(dir, 0o755);
}

function installRuntimeFile(source, destination, mode) {
  // Write to a sibling temp file and rename into place so a concurrent reader never
  // sees a half-written script, and a running copy keeps its old inode until it exits.
  const temp = destination + '.tmp.' + process.pid;
  fs.writeFileSync(temp, fs.readFileSync(source), { mode });
  fs.chmodSync(temp, mode);
  fs.chownSync(temp, 0, 0);
  fs.renameSync(temp, destination);
}

// Copy the responder out of the user-owned, per-launch runtime tree into a stable
// root-owned directory, so the launchd job points at files the user cannot rewrite.
function installRuntime() {
  ensureRootDir(parentDir);
  ensureRootDir(installDir);
  ensureRootDir(stateDir);
  installRuntimeFile(helper, installedHelper, 0o755);
  installRuntimeFile(responder, installedResponder, 0o644);
}

function writeDaemonPlist(name) {
  fs.writeFileSync(daemonPlist, renderDaemonPlist(name), { mode: 0o644 });
  fs.chownSync(daemonPlist, 0, 0);
  fs.chmodSync(daemonPlist, 0o644);
}

function launchctl(args, { ignoreFailure = false } = {}) {
  const result = childProcess.spawnSync('/bin/launchctl', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (!ignoreFailure && result.status !== 0) {
    throw new Error('launchctl ' + args[0] + ' failed with status ' + result.status);
  }
  return result.status;
}

// Unload the daemon and remove its plist. The plist must not linger in
// /Library/LaunchDaemons, or RunAtLoad would silently restart the responder on the
// next boot after the user has stopped or restored. Start re-creates it on demand.
function removeDaemon() {
  launchctl(['bootout', 'system/' + daemonLabel], { ignoreFailure: true });
  fs.rmSync(daemonPlist, { force: true });
}

function runPrivileged(action, options) {
  if (process.platform !== 'darwin') throw new Error('Offline Ethernet requires macOS');
  if (process.getuid?.() !== 0) throw new Error(action + ' requires macOS administrator access');
  requireStateDir(options['state-dir']);
  if (action === 'start') {
    const name = options.interface;
    if (!/^en[0-9]+$/.test(name || '')) throw new Error('Choose a physical enN Ethernet adapter');
    // Run the responder as a LaunchDaemon so launchd owns it. The privileged step then
    // just installs and bootstraps and returns; it no longer has to stay alive itself.
    // On macOS 26/27 a `nohup ... &` process started under `do shell script ... with
    // administrator privileges` is reaped when the Security authorization session ends.
    installRuntime();
    writeDaemonPlist(name);
    launchctl(['bootout', 'system/' + daemonLabel], { ignoreFailure: true });
    launchctl(['bootstrap', 'system', daemonPlist]);
    return;
  }
  // Boot out and remove the daemon first: launchd SIGTERMs helper.sh and its existing
  // cleanup runs (kill responder, release lock, write status). Then let the helper settle
  // the lock, alias and saved state. bootout is preferred over helper.sh's owns_pid match,
  // which keys on "$BASE/helper.sh start " and is fragile now the daemon runs from a copy.
  removeDaemon();
  const result = childProcess.spawnSync('/bin/bash', [helper, action, stateDir], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac2jb-offline-ethernet-plist-'));
  try {
    const plistFile = path.join(dir, 'daemon.plist');
    fs.writeFileSync(plistFile, renderDaemonPlist('en5'));
    const lint = childProcess.spawnSync('/usr/bin/plutil', ['-lint', plistFile], { encoding: 'utf8' });
    if (lint.status !== 0) throw new Error('Offline Ethernet daemon plist is malformed: ' + lint.stdout + lint.stderr);
    const json = childProcess.spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistFile], { encoding: 'utf8' });
    if (json.status !== 0) throw new Error('Could not read the daemon plist: ' + json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.Label, daemonLabel);
    assert.equal(parsed.RunAtLoad, true);
    assert.equal(parsed.KeepAlive, false);
    assert.deepEqual(parsed.ProgramArguments, ['/bin/bash', installedHelper, 'start', 'en5', stateDir]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  parseHardwarePorts, processAlive, readStatus, requireStateDir, stateDir,
  renderDaemonPlist, daemonLabel, daemonPlist, installDir, installedHelper
};
